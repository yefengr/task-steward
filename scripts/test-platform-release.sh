#!/usr/bin/env bash
# 本地 fixture：实际打包、校验、暂存；不连接网络或真实 Docker。
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
scripts=$(cd "$(dirname "$0")" && pwd)
source "$scripts/platform-image-archive.sh"
mkdir -p "$scratch/bin" "$scratch/pi-steward"
export PATH="$scratch/bin:$PATH" HOME="$scratch" SCRIPTS="$scripts"
export LOG="$scratch/commands" WIRE="$scratch/wire" MAIN_CHECKS="$scratch/main-checks"
export SSH_KEY_FIXTURE="$scratch/deploy key" SSH_HOSTS_FIXTURE="$scratch/known hosts"
export REV=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export PRIOR=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export LIVE=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export IMAGE="pi-steward-platform:sha-$REV-123-1" PRIOR_IMAGE="pi-steward-platform:sha-$PRIOR-122-1"
export HEAD_REV=$REV STATUS=ok CURRENT_ID=$LIVE HOLD_LOCK=none

cat > "$scratch/bin/fixture" <<'SH'
#!/usr/bin/env bash
set -eu
case "${0##*/} $*" in
  'git ls-remote '*)
    echo main >> "$MAIN_CHECKS"
    if [[ "$STATUS" == advance ]] && grep -q '^upload ' "$WIRE"; then head=$PRIOR; else head=$HEAD_REV; fi
    printf '%s\trefs/heads/main\n' "$head"
    ;;
  'git rev-parse HEAD') printf '%s\n' "$REV" ;;
  "git archive --format=tar $REV") printf 'source build context' ;;
  "git merge-base --is-ancestor $PRIOR $REV") [[ "$STATUS" != divergent ]] ;;
  'gh api repos/yefengr/task-steward/environments/production') printf '%s\n' "$POLICY" ;;
  'ssh '*)
    expected=(-i "$SSH_KEY_FIXTURE" -p 2222 -o BatchMode=yes -o IdentitiesOnly=yes
      -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSH_HOSTS_FIXTURE" steward@release.example)
    [[ $# == $(( ${#expected[@]} + 1 )) ]]
    for arg in "${expected[@]}"; do [[ "$1" == "$arg" ]]; shift; done
    printf '%s\n' "$1" >> "$WIRE"
    [[ "$STATUS" != missing-wrapper ]] || exit 127
    SSH_ORIGINAL_COMMAND=$1 /bin/bash "$SCRIPTS/platform-deploy-ssh.sh"
    ;;
  'flock -n 8') [[ "$HOLD_LOCK" != staging ]] ;;
  'flock -n 9') [[ "$HOLD_LOCK" != deploy ]] ;;
  "docker build --platform linux/amd64 --label org.opencontainers.image.revision=$REV -f docker/platform.Dockerfile -t $IMAGE -")
    [[ $(< /dev/stdin) == 'source build context' ]]
    ;;
  "docker image inspect --format {{.Id}} $IMAGE") printf '%s\n' "$BUILDER_ID" ;;
  "docker image save --platform linux/amd64 $IMAGE") gzip -dc "$SOURCE_ARCHIVE" ;;
  'docker image load --quiet')
    cmp -s - "$SOURCE_ARCHIVE"
    echo load >> "$LOG"
    ;;
  'docker image inspect -f '*) printf '%s linux/amd64 %s\n' "$LOADED_ID" "$REV" ;;
  'docker inspect --format '*'.Config.Labels'*' pi-steward-platform-1') printf '%s %s\n' "$CURRENT_ID" "$PRIOR" ;;
  'docker inspect -f {{.Image}} pi-steward-platform-1')
    if grep -qx switch "$LOG"; then printf '%s\n' "$LOADED_ID"; else printf '%s\n' "$CURRENT_ID"; fi
    ;;
  'docker inspect -f {{.Config.Image}} pi-steward-platform-1') printf '%s\n' "$PRIOR_IMAGE" ;;
  'docker inspect -f {{range .Mounts}}'*) echo pi-steward_steward-data ;;
  'docker inspect -f {{.State.Health.Status}} pi-steward-platform-1') echo healthy ;;
  'docker port pi-steward-platform-1 3000/tcp') echo 127.0.0.1:3000 ;;
  'docker exec pi-steward-platform-1 node dist/admin.js backup '*) echo backup >> "$LOG" ;;
  'docker exec pi-steward-platform-1 node --input-type=module -e '*) true ;;
  'docker run -d --network none --volumes-from pi-steward-platform-1:ro '*) echo candidate ;;
  'docker exec candidate node -e '*) true ;;
  'docker exec candidate node --input-type=module -e '*) echo preflight >> "$LOG" ;;
  'docker rm -f candidate') true ;;
  'docker-compose -p pi-steward --env-file .env -f '*' config --images') awk '/image:/ { print $2 }' "$6" ;;
  'docker-compose -p pi-steward --env-file .env -f '*' config --volumes') echo steward-data ;;
  'docker-compose -p pi-steward --env-file .env -f compose.yml up -d --no-deps --no-build platform') echo switch >> "$LOG" ;;
  'curl -fsS --max-time 5 http://127.0.0.1:3000/health') printf '{"ok":true}\n' ;;
  'curl -fsS --max-time 5 http://127.0.0.1:3000/pair') true ;;
  *) echo "Unexpected fixture command: $0 $*" >&2; exit 88 ;;
esac
SH
chmod +x "$scratch/bin/fixture"
for command in git gh ssh flock docker docker-compose curl; do ln -s fixture "$scratch/bin/$command"; done

reject() {
  local message=$1
  shift
  if "$@" > "$scratch/rejected" 2>&1; then
    echo "Should have refused: $*" >&2
    exit 1
  fi
  grep -Fq -- "$message" "$scratch/rejected" || { printf '%s\n' "$(< "$scratch/rejected")" >&2; exit 1; }
}

archive_fixture() (
  local name=$1 layout=$2 tag=$3 arch=$4 label=$5 defect=${6:-} dir="$scratch/fixture-$1" config
  mkdir -p "$dir/blobs/sha256"
  jq -n --arg arch "$arch" --arg rev "$label" \
    '{os:"linux", architecture:$arch, config:{Labels:{"org.opencontainers.image.revision":$rev}}}' > "$dir/config"
  config=$(platform_archive_sha256 "$dir/config")
  if [[ "$layout" == classic ]]; then config="$config.json"; else config="blobs/sha256/$config"; fi
  mv "$dir/config" "$dir/$config"
  jq -n --arg tag "$tag" --arg config "$config" '[{RepoTags:[$tag],Config:$config,Layers:[]}]' > "$dir/manifest.json"
  printf '{"schemaVersion":2,"manifests":[]}\n' > "$dir/index.json"
  local members=(manifest.json "$config" index.json)
  case "$defect" in
    digest) printf '\n' >> "$dir/$config" ;;
    duplicate) members+=(./manifest.json) ;;
    extra-tag) jq '.[0].RepoTags += ["other:tag"]' "$dir/manifest.json" > "$dir/extra"; mv "$dir/extra" "$dir/manifest.json" ;;
    aliased-tag) jq '.[0].repotags = ["other:tag"]' "$dir/manifest.json" > "$dir/extra"; mv "$dir/extra" "$dir/manifest.json" ;;
    extra-config) jq '. + .' "$dir/manifest.json" > "$dir/extra"; mv "$dir/extra" "$dir/manifest.json" ;;
  esac
  tar -czf "$scratch/$name.tar.gz" -C "$dir" "${members[@]}"
  printf 'sha256:%s\n' "$(platform_archive_sha256 "$dir/$config")"
)

remote() { SSH_ORIGINAL_COMMAND=$1 bash "$scripts/platform-deploy-ssh.sh"; }
request_deploy() { remote "deploy $IMAGE $ID $REV $LIVE $1"; }
reset_logs() { : > "$LOG"; : > "$WIRE"; : > "$MAIN_CHECKS"; }

release=(bash "$scripts/platform-release.sh")
bundle="$scratch/image"
# 与生产 workflow 一样保留 SSH 选项、地址和独立的远程指令参数。
deploy=("${release[@]}" deploy "$bundle" "$REV" ssh -i "$SSH_KEY_FIXTURE" -p 2222
  -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$SSH_HOSTS_FIXTURE" steward@release.example)
ID=$(archive_fixture valid modern "$IMAGE" amd64 "$REV")
export ID
export BUILDER_ID="sha256:$(platform_archive_sha256 "$scratch/fixture-valid/index.json")"
export SOURCE_ARCHIVE="$scratch/valid.tar.gz" LOADED_ID=$ID
[[ "$ID" != "$BUILDER_ID" ]]
legacy_id=$(archive_fixture legacy classic "$IMAGE" amd64 "$REV")
[[ "$legacy_id" == "$ID" && $(platform_archive_config_id "$scratch/legacy.tar.gz" "$IMAGE" "$REV") == "$ID" ]]
staged="$scratch/pi-steward/.steward-release/platform.tar.gz"
reset_logs

export GITHUB_REF=refs/heads/topic
reject '只允许从 main' "${release[@]}" build "$bundle" "$REV" 123 1
export GITHUB_REF=refs/heads/main
"${release[@]}" build "$bundle" "$REV" 123 1
jq -e --arg id "$ID" --arg builder "$BUILDER_ID" '.image_id == $id and .builder_image_id == $builder' "$bundle/release.json" >/dev/null
digest=$(platform_archive_sha256 "$bundle/platform.tar.gz")
[[ $(jq -er .archive_sha256 "$bundle/release.json") == "$digest" ]]

export POLICY='{"can_admins_bypass":true,"protection_rules":[{"type":"required_reviewers","reviewers":[{}]}]}'
reject '禁止管理员绕过' "${release[@]}" require-policy
export POLICY='{"can_admins_bypass":false,"protection_rules":[]}'
reject '必须配置审批人' "${release[@]}" require-policy
export POLICY='{"can_admins_bypass":false,"protection_rules":[{"type":"required_reviewers","reviewers":[{}]}]}'
"${release[@]}" require-policy

cp "$bundle/platform.tar.gz" "$scratch/built.tar.gz"
printf 'tampered' >> "$bundle/platform.tar.gz"
reject '归档校验失败' "${deploy[@]}"
cp "$scratch/built.tar.gz" "$bundle/platform.tar.gz"
cp "$bundle/release.json" "$scratch/release.json"
jq '.image_id = .builder_image_id' "$scratch/release.json" > "$bundle/release.json"
reject 'config ID' "${deploy[@]}"
cp "$scratch/release.json" "$bundle/release.json"
export HEAD_REV=$PRIOR
reject '不是远端 main' "${deploy[@]}"
[[ ! -s "$WIRE" && ! -s "$LOG" ]]
export HEAD_REV=$REV STATUS=missing-wrapper
reject '已启用受限部署入口' "${deploy[@]}"
[[ $(< "$WIRE") == status && ! -e "$staged" && ! -s "$LOG" ]]
reset_logs
export STATUS=divergent
reject '不是候选的祖先' "${deploy[@]}"
[[ $(< "$WIRE") == status && ! -s "$LOG" ]]
reset_logs
export STATUS=advance
reject '不是远端 main' "${deploy[@]}"
[[ $(< "$WIRE") == $'status\nupload '"$digest" && $(< "$MAIN_CHECKS") == $'main\nmain' ]]
[[ $(platform_archive_sha256 "$staged") == "$digest" && ! -s "$LOG" ]]

export STATUS=ok HOLD_LOCK=staging
reject '正在上传或部署' remote "upload $digest" < "$bundle/platform.tar.gz"
reject '正在上传或部署' request_deploy "$digest"
export HOLD_LOCK=none
reject '上传归档校验失败' remote "upload $digest" <<< 'wrong bytes'
[[ $(platform_archive_sha256 "$staged") == "$digest" && ! -e "${staged%/*}/incoming" ]]
reject '暂存归档校验失败' request_deploy "${LIVE#sha256:}"
[[ $(platform_archive_sha256 "$staged") == "$digest" && ! -s "$LOG" ]]
for command in '' shell 'docker ps' 'status now' $'status\r' $'status\nstatus' "upload $digest extra" \
  "upload  $digest" $'upload\t'"$digest" "deploy $IMAGE $ID $REV $LIVE $digest extra" \
  "deploy $IMAGE '$ID' $REV $LIVE $digest" "deploy $IMAGE $ID $PRIOR $LIVE $digest"; do
  reject '不允许的 SSH 部署指令' remote "$command"
done
[[ $(remote status) == "$LIVE $PRIOR" && ! -s "$LOG" ]]

for defect in tag platform revision digest duplicate extra-tag aliased-tag extra-config; do
  tag=$IMAGE arch=amd64 label=$REV
  case "$defect" in
    tag) tag="$PRIOR_IMAGE" ;;
    platform) arch=arm64 ;;
    revision) label="$PRIOR" ;;
  esac
  bad_id=$(archive_fixture "$defect" modern "$tag" "$arch" "$label" "$defect")
  bad_archive="$scratch/$defect.tar.gz"
  bad_digest=$(platform_archive_sha256 "$bad_archive")
  remote "upload $bad_digest" < "$bad_archive"
  reject 'config ID' remote "deploy $IMAGE $bad_id $REV $LIVE $bad_digest"
  [[ ! -s "$LOG" && ! -e "$staged" ]]
done
remote "upload $digest" < "$bundle/platform.tar.gz"
export CURRENT_ID=$ID
reject '线上镜像已经变化' request_deploy "$digest"
[[ ! -s "$LOG" && ! -e "$staged" ]]
export CURRENT_ID=$LIVE
remote "upload $digest" < "$bundle/platform.tar.gz"
export LOADED_ID=$LIVE SOURCE_ARCHIVE="$bundle/platform.tar.gz"
reject '镜像 ID、架构或源码标记' request_deploy "$digest"
[[ $(< "$LOG") == load && ! -e "$staged" && ! -e "$scratch/pi-steward/compose.yml" ]]

reset_logs
export LOADED_ID=$ID
printf 'services:\n  platform:\n    image: %s\n' "$PRIOR_IMAGE" > "$scratch/pi-steward/compose.yml"
"${deploy[@]}"
[[ $(< "$WIRE") == $'status\nupload '"$digest"$'\ndeploy '"$IMAGE $ID $REV $LIVE $digest" ]]
[[ $(< "$MAIN_CHECKS") == $'main\nmain' && $(< "$LOG") == $'load\nbackup\npreflight\nswitch' ]]
[[ ! -e "$staged" && ! -e "${staged%/*}/incoming" ]]
grep -Fq "image: $IMAGE" "$scratch/pi-steward/compose.yml"
reject '没有可用的暂存归档' request_deploy "$digest"
printf 'Platform release gates: passed\n'
