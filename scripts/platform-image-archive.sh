#!/usr/bin/env bash
# 由构建任务、部署客户端和服务器共用；调用方启用 pipefail。

platform_archive_sha256() {
  local result
  if command -v sha256sum >/dev/null 2>&1; then
    result=$(sha256sum < "$1") || return
  else
    result=$(shasum -a 256 < "$1") || return
  fi
  printf '%s\n' "${result%% *}"
}

# 读取 Docker save 原始元数据字节，不将归档成员展开到文件系统。
platform_archive_metadata() {
  local archive=$1 member=$2 output=$3 max_bytes=$((1024 * 1024))
  tar -xOzf "$archive" "$member" | head -c "$((max_bytes + 1))" > "$output" || return
  (( $(wc -c < "$output") <= max_bytes ))
}

platform_archive_config_id() (
  local archive=$1 image=$2 revision=$3 scratch config digest
  scratch=$(mktemp -d) || exit 1
  trap 'rm -rf -- "$scratch"' EXIT
  # Docker classic store 导入的是 Docker manifest 中的 config，不是 OCI index。
  platform_archive_metadata "$archive" manifest.json "$scratch/manifest" || exit 1
  config=$(jq -ers --arg image "$image" '
    select(length == 1) | .[0]
    | select(type == "array" and length == 1) | .[0]
    | select(type == "object" and all(keys[];
        . == "Config" or . == "RepoTags" or . == "Layers" or . == "Parent" or . == "LayerSources"))
    | select(.RepoTags == [$image]) | .Config
    | select(type == "string" and test("\\A(blobs/sha256/[0-9a-f]{64}|[0-9a-f]{64}\\.json)\\z"))
  ' "$scratch/manifest") || exit 1
  # 禁止这些元数据存在多个版本（包括可能落到相同路径的别名）。
  tar -tzf "$archive" | LC_ALL=C awk -v config="$config" '
    {
      original = $0
      depth = 0
      n = split($0, parts, "/")
      for (i = 1; i <= n; i++) {
        if (parts[i] == "" || parts[i] == ".") continue
        if (parts[i] == "..") { if (depth > 0) depth--; continue }
        path[++depth] = parts[i]
      }
      canonical = ""
      for (i = 1; i <= depth; i++) canonical = canonical (i == 1 ? "" : "/") path[i]
      if (canonical == "manifest.json") { manifest_count++; if (original != canonical) bad = 1 }
      if (canonical == config) { config_count++; if (original != canonical) bad = 1 }
    }
    END { exit (bad || manifest_count != 1 || config_count != 1) }
  ' || exit 1
  platform_archive_metadata "$archive" "$config" "$scratch/config" || exit 1
  digest=$(platform_archive_sha256 "$scratch/config") || exit 1
  [[ "$config" == "blobs/sha256/$digest" || "$config" == "$digest.json" ]] || exit 1
  jq -es --arg revision "$revision" '
    length == 1 and (.[0] | .os == "linux" and .architecture == "amd64"
      and .config.Labels["org.opencontainers.image.revision"] == $revision)
  ' "$scratch/config" >/dev/null || exit 1
  printf 'sha256:%s\n' "$digest"
)
