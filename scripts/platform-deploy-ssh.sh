#!/usr/bin/env bash
# 由管理员安装到可信目录，通过 authorized_keys 的 restrict,command=… 运行。
set -euo pipefail
umask 077
export LC_ALL=C

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/platform-image-archive.sh"

live=pi-steward-platform-1
max_archive_bytes=$((512 * 1024 * 1024))
digest_re='[0-9a-f]{64}'
revision_re='[0-9a-f]{40}'
fail() { printf '%s\n' "$*" >&2; exit 1; }
invalid() { fail '不允许的 SSH 部署指令。'; }

status() {
  local info
  info=$(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$live")
  [[ "$info" =~ ^sha256:$digest_re\ $revision_re$ ]] || fail '无法确认当前线上镜像的来源。'
  printf '%s\n' "$info"
}

lock_stage() {
  local mode
  stage_dir="$HOME/pi-steward/.steward-release"
  if [[ ! -d "$stage_dir" ]]; then
    mkdir -m 700 -- "$stage_dir" 2>/dev/null || [[ -d "$stage_dir" ]] || fail '无法创建私有归档暂存目录。'
  fi
  [[ ! -L "$stage_dir" && -O "$stage_dir" ]] || fail '归档暂存目录必须属于部署用户且不能是符号链接。'
  mode=$(stat -c %a "$stage_dir" 2>/dev/null || stat -f %Lp "$stage_dir")
  [[ "$mode" == 700 ]] || fail '归档暂存目录权限必须是 0700。'
  [[ ! -L "$stage_dir/lock" && ( ! -e "$stage_dir/lock" || -f "$stage_dir/lock" ) ]] || fail '归档锁路径异常。'
  exec 8>>"$stage_dir/lock"
  flock -n 8 || fail '归档正在上传或部署。'
  archive="$stage_dir/platform.tar.gz"
  incoming="$stage_dir/incoming"
  # 清理上次异常退出留下的半成品；暂存槽至多保留一份完整归档。
  rm -f -- "$incoming"
}

upload() {
  [[ ! -L "$archive" && ( ! -e "$archive" || -f "$archive" ) ]] || fail '归档暂存槽路径异常。'
  trap 'rm -f -- "$incoming"' EXIT
  head -c "$((max_archive_bytes + 1))" > "$incoming"
  (( $(wc -c < "$incoming") <= max_archive_bytes )) || fail '镜像归档超出 512 MiB 暂存上限。'
  [[ $(platform_archive_sha256 "$incoming") == "$archive_digest" ]] || fail '上传归档校验失败。'
  mv -f -- "$incoming" "$archive"
}

deploy() {
  [[ -f "$archive" && ! -L "$archive" ]] || fail '没有可用的暂存归档；请重新上传。'
  [[ $(platform_archive_sha256 "$archive") == "$archive_digest" ]] || fail '暂存归档校验失败；请重新上传。'
  # 不删除其他连接提交的不同归档；匹配的这次部署尝试只消费一次。
  trap 'rm -f -- "$archive"' EXIT
  [[ $(platform_archive_config_id "$archive" "$image" "$revision") == "$image_id" ]] ||
    fail '暂存归档的标签、config ID、平台或源码标记与部署请求不符。'
  [[ $(docker inspect -f '{{.Image}}' "$live") == "$expected_live_id" ]] || fail '线上镜像已经变化，拒绝覆盖。'
  docker image load --quiet < "$archive"
  # 保留部署脚本原有的独立部署锁、加载后复核和生产快照检查。
  /bin/bash "$script_dir/deploy-platform.sh" "$image" "$image_id" "$revision" "$expected_live_id"
}

original=${SSH_ORIGINAL_COMMAND:-}
if [[ "$original" == status ]]; then
  status
  exit
fi
IFS=' ' read -r action first image_id revision expected_live_id archive_digest <<< "$original"
case "$action" in
  upload)
    [[ "$original" == "upload $first" && "$first" =~ ^$digest_re$ ]] || invalid
    archive_digest=$first
    ;;
  deploy)
    image=$first
    [[ "$original" == "deploy $image $image_id $revision $expected_live_id $archive_digest" &&
      "$revision" =~ ^$revision_re$ && "$image" =~ ^pi-steward-platform:sha-$revision-[0-9]+-[0-9]+$ &&
      "$image_id" =~ ^sha256:$digest_re$ && "$expected_live_id" =~ ^sha256:$digest_re$ &&
      "$archive_digest" =~ ^$digest_re$ ]] || invalid
    ;;
  *) invalid ;;
esac
trap 'exit 1' HUP INT TERM
lock_stage
if [[ "$action" == upload ]]; then upload; else deploy; fi
