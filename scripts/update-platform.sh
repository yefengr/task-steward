#!/usr/bin/env bash
# 从本机将当前提交的平台镜像部署到指定 SSH 别名。
set -euo pipefail

if [[ $# != 1 || ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo '用法：bash scripts/update-platform.sh <SSH 别名>' >&2
  exit 2
fi
cd "$(git rev-parse --show-toplevel)"
worktree_status=$(git status --porcelain --untracked-files=normal)
if [[ -n "$worktree_status" ]]; then
  echo '部署前请确保 Git 工作区干净。' >&2
  exit 1
fi
if ! docker info >/dev/null; then
  echo '无法连接 Docker，请先启动本机 Docker 服务。' >&2
  exit 1
fi

revision=$(git rev-parse HEAD)
image="pi-steward-platform:sha-$revision"
platform=linux/amd64
ssh_command=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$1")

local_image() {
  docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image"
}

metadata_pattern="^(sha256:[a-f0-9]{64}) $platform $revision$"
started=$SECONDS
metadata=$(local_image 2>/dev/null || true)
if [[ "$metadata" =~ $metadata_pattern ]]; then
  printf '复用本机镜像：%s\n' "$image"
else
  # 只构建与镜像标签对应的 Git 快照，排除本地生成物。
  git archive --format=tar "$revision" | docker build --progress=plain --platform "$platform" \
    --label "org.opencontainers.image.revision=$revision" -f docker/platform.Dockerfile -t "$image" -
  metadata=$(local_image)
fi
if [[ ! "$metadata" =~ $metadata_pattern ]]; then
  echo '本机镜像的提交标记、架构或镜像 ID 不符合预期。' >&2
  exit 1
fi
image_id=${BASH_REMATCH[1]}
printf '构建或复用镜像：%s 秒\n' "$((SECONDS - started))"

started=$SECONDS
remote_id=$("${ssh_command[@]}" "docker image ls --no-trunc --quiet '$image'")
if [[ "$remote_id" == "$image_id" ]]; then
  printf '复用服务器上已加载的镜像：%s\n' "$image"
else
  docker image save "$image" | gzip -1 | "${ssh_command[@]}" 'docker image load --quiet'
fi
printf '传输或复用服务器镜像：%s 秒\n' "$((SECONDS - started))"

started=$SECONDS
git show "$revision:scripts/deploy-platform.sh" | "${ssh_command[@]}" "bash -s -- '$image' '$image_id'"
printf '服务器部署与健康检查：%s 秒\n' "$((SECONDS - started))"
