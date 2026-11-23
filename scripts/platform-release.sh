#!/usr/bin/env bash
# Validate and transfer an immutable Actions release artifact. Never builds on the deploy path.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/platform-image-archive.sh"

repo=https://github.com/yefengr/task-steward.git
platform=linux/amd64

fail() { echo "$*" >&2; exit 1; }

require_main() {
  local head
  head=$(git ls-remote --exit-code "$repo" refs/heads/main)
  [[ "$head" == "$1"$'\t'refs/heads/main ]] || fail "候选不是远端 main 的最新提交；请重新准备产物。"
}

read_bundle() {
  local bundle=$1
  revision=$(jq -er '.revision | select(test("\\A[0-9a-f]{40}\\z"))' "$bundle/release.json")
  image=$(jq -er '.image | select(test("\\Api-steward-platform:sha-[0-9a-f]{40}-[0-9]+-[0-9]+\\z"))' "$bundle/release.json")
  [[ "$image" == "pi-steward-platform:sha-$revision-"* ]] || fail '镜像标签与源码提交不符。'
  image_id=$(jq -er '.image_id | select(test("\\Asha256:[0-9a-f]{64}\\z"))' "$bundle/release.json")
  archive_digest=$(jq -er '.archive_sha256 | select(test("\\A[0-9a-f]{64}\\z"))' "$bundle/release.json")
  [[ $(platform_archive_sha256 "$bundle/platform.tar.gz") == "$archive_digest" ]] || fail '镜像归档校验失败。'
  [[ $(platform_archive_config_id "$bundle/platform.tar.gz" "$image" "$revision") == "$image_id" ]] ||
    fail '镜像归档的标签、config ID、平台或源码标记与发布清单不符。'
}

build() {
  local bundle=$1 revision=$2 run_id=$3 attempt=$4 image image_id builder_image_id archive_digest
  [[ "${GITHUB_REF:-}" == refs/heads/main ]] || fail '平台镜像发布只允许从 main 运行。'
  [[ "$revision" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]]
  [[ $(git rev-parse HEAD) == "$revision" ]]
  image="pi-steward-platform:sha-$revision-$run_id-$attempt"
  mkdir "$bundle"
  git archive --format=tar "$revision" | docker build --platform "$platform" \
    --label "org.opencontainers.image.revision=$revision" -f docker/platform.Dockerfile -t "$image" -
  builder_image_id=$(docker image inspect --format '{{.Id}}' "$image")
  [[ "$builder_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
  docker image save --platform "$platform" "$image" | gzip -1 > "$bundle/platform.tar.gz"
  image_id=$(platform_archive_config_id "$bundle/platform.tar.gz" "$image" "$revision") ||
    fail '无法确认构建归档的单一镜像标签、config ID、平台与源码标记。'
  archive_digest=$(platform_archive_sha256 "$bundle/platform.tar.gz")
  jq -n --arg revision "$revision" --arg image "$image" --arg image_id "$image_id" \
    --arg builder_image_id "$builder_image_id" --arg archive_sha256 "$archive_digest" '$ARGS.named' > "$bundle/release.json"
}

# 环境被删除后 GitHub 可以自动建一个无审批的同名环境；缺少审批配置时不接触服务器。
require_policy() {
  gh api repos/yefengr/task-steward/environments/production | jq -e '
    .can_admins_bypass == false and
    any(.protection_rules[]; .type == "required_reviewers" and (.reviewers | length) > 0)
  ' >/dev/null || fail 'production 必须配置审批人，并禁止管理员绕过。'
}

deploy() {
  local bundle=$1 expected_revision=$2 revision image image_id archive_digest
  shift 2
  read_bundle "$bundle"
  [[ "$revision" == "$expected_revision" ]] || fail '产物不是本次选定的源码提交。'
  require_main "$revision"

  local live live_id live_revision
  live=$("$@" status </dev/null) || fail '无法查询线上状态；请确认服务器已启用受限部署入口。'
  read -r live_id live_revision <<< "$live"
  [[ "$live_id" =~ ^sha256:[a-f0-9]{64}$ && "$live_revision" =~ ^[a-f0-9]{40}$ && "$live" == "$live_id $live_revision" ]] ||
    fail '无法确认当前线上镜像的来源，停止自动部署。'
  git merge-base --is-ancestor "$live_revision" "$revision" ||
    fail '当前线上提交不是候选的祖先；先对齐 main 和线上历史。'

  # 上传只暂存归档；再次确认 main 新鲜度之后才请求服务端加载和切换。
  "$@" "upload $archive_digest" < "$bundle/platform.tar.gz"
  require_main "$revision"
  "$@" "deploy $image $image_id $revision $live_id $archive_digest" </dev/null
}

case ${1:-} in
  build) shift; build "$@" ;;
  require-policy) require_policy ;;
  deploy) shift; deploy "$@" ;;
  *) fail '用法：platform-release.sh build|require-policy|deploy …' ;;
esac
