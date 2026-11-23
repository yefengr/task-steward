#!/usr/bin/env bash
# Validate and transfer an immutable Actions release artifact. Never builds on the deploy path.
set -euo pipefail

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
  revision=$(jq -er '.revision | select(test("^[0-9a-f]{40}$"))' "$bundle/release.json")
  image=$(jq -er '.image | select(test("^pi-steward-platform:sha-[0-9a-f]{40}-[0-9]+-[0-9]+$"))' "$bundle/release.json")
  [[ "$image" == "pi-steward-platform:sha-$revision-"* ]] || fail '镜像标签与源码提交不符。'
  image_id=$(jq -er '.image_id | select(test("^sha256:[0-9a-f]{64}$"))' "$bundle/release.json")
  archive_digest=$(jq -er '.archive_sha256 | select(test("^[0-9a-f]{64}$"))' "$bundle/release.json")
  [[ $(shasum -a 256 < "$bundle/platform.tar.gz") == "$archive_digest "* ]] || fail '镜像归档校验失败。'
}

build() {
  local bundle=$1 revision=$2 run_id=$3 attempt=$4 image image_id archive_digest
  [[ "${GITHUB_REF:-}" == refs/heads/main ]] || fail '平台镜像发布只允许从 main 运行。'
  [[ "$revision" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]]
  [[ $(git rev-parse HEAD) == "$revision" ]]
  image="pi-steward-platform:sha-$revision-$run_id-$attempt"
  mkdir "$bundle"
  git archive --format=tar "$revision" | docker build --platform "$platform" \
    --label "org.opencontainers.image.revision=$revision" -f docker/platform.Dockerfile -t "$image" -
  image_id=$(docker image inspect --format '{{.Id}}' "$image")
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
  docker image save "$image" | gzip -1 > "$bundle/platform.tar.gz"
  archive_digest=$(shasum -a 256 < "$bundle/platform.tar.gz")
  jq -n --arg revision "$revision" --arg image "$image" --arg image_id "$image_id" \
    --arg archive_sha256 "${archive_digest%% *}" '$ARGS.named' > "$bundle/release.json"
}

# 环境被删除后 GitHub 可以自动建一个无审批的同名环境；缺少审批配置时不接触服务器。
require_policy() {
  gh api repos/yefengr/task-steward/environments/production | jq -e '
    .can_admins_bypass == false and
    any(.protection_rules[]; .type == "required_reviewers" and (.reviewers | length) > 0)
  ' >/dev/null || fail 'production 必须配置审批人，并禁止管理员绕过。'
}

deploy() {
  local bundle=$1 expected_revision=$2
  shift 2
  read_bundle "$bundle"
  [[ "$revision" == "$expected_revision" ]] || fail '产物不是本次选定的源码提交。'
  require_main "$revision"

  local live live_id live_revision extra
  live=$("$@" 'docker inspect --format '\''{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}'\'' pi-steward-platform-1')
  read -r live_id live_revision extra <<< "$live"
  [[ "$live_id" =~ ^sha256:[a-f0-9]{64}$ && "$live_revision" =~ ^[a-f0-9]{40}$ && -z "$extra" ]] ||
    fail '无法确认当前线上镜像的来源，停止自动部署。'
  git merge-base --is-ancestor "$live_revision" "$revision" ||
    fail '当前线上提交不是候选的祖先；先对齐 main 和线上历史。'

  # 不重新构建，也不通过可变的标签选择镜像。服务器加载后会复核 ID、架构和提交。
  "$@" 'docker image load --quiet' < "$bundle/platform.tar.gz"
  require_main "$revision"
  "$@" "bash -s -- '$image' '$image_id' '$revision' '$live_id'" < "$(dirname "$0")/deploy-platform.sh"
}

case ${1:-} in
  build) shift; build "$@" ;;
  require-policy) require_policy ;;
  deploy) shift; deploy "$@" ;;
  *) fail '用法：platform-release.sh build|require-policy|deploy …' ;;
esac
