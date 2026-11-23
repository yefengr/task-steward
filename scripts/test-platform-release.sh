#!/usr/bin/env bash
# 本地测试：所有网络、生产 Docker 和远端操作均通过 fixture 模拟。
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
scripts=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$scratch/bin" "$scratch/image" "$scratch/pi-steward"
export PATH="$scratch/bin:$PATH" HOME="$scratch" LOG="$scratch/commands"
export REV=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export PRIOR=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export ID=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export LIVE=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export IMAGE="pi-steward-platform:sha-$REV-123-1"
export HEAD_REV=$REV STATUS=ok LOADED_ID=$ID CURRENT_ID=$LIVE

cat > "$scratch/bin/fixture" <<'SH'
#!/usr/bin/env bash
set -eu
case "${0##*/} $*" in
  'git ls-remote '*)
    if [[ "$STATUS" == advance ]] && [[ -s "$LOG" ]]; then head=$PRIOR; else head=$HEAD_REV; fi
    printf '%s\trefs/heads/main\n' "$head"
    ;;
  "git merge-base --is-ancestor $PRIOR $REV") [[ "$STATUS" != divergent ]] ;;
  'gh api repos/yefengr/task-steward/environments/production') printf '%s\n' "$POLICY" ;;
  'ssh docker inspect '*) printf '%s %s\n' "$LIVE" "$PRIOR" ;;
  'ssh docker image load --quiet')
    [[ $(< /dev/stdin) == 'fixture archive' ]]
    echo upload >> "$LOG"
    ;;
  "ssh bash -s -- '$IMAGE' '$ID' '$REV' '$LIVE'")
    [[ $(< /dev/stdin) == *snapshot_preflight* ]]
    echo switch-request >> "$LOG"
    ;;
  'flock -n 9') true ;;
  'docker image inspect '*) printf '%s linux/amd64 %s\n' "$LOADED_ID" "$REV" ;;
  'docker inspect -f {{.Image}} pi-steward-platform-1') printf '%s\n' "$CURRENT_ID" ;;
  *) echo "Unexpected fixture command: $0 $*" >&2; exit 88 ;;
esac
SH
chmod +x "$scratch/bin/fixture"
for command in git gh ssh flock docker; do ln -s fixture "$scratch/bin/$command"; done

reject() {
  local message=$1
  shift
  if "$@" > "$scratch/rejected" 2>&1; then
    echo "Should have refused: $*" >&2
    exit 1
  fi
  grep -Fq -- "$message" "$scratch/rejected" || { printf '%s\n' "$(< "$scratch/rejected")" >&2; exit 1; }
}

release=(bash "$scripts/platform-release.sh")
deploy=("${release[@]}" deploy "$scratch/image" "$REV" ssh)
remote=(bash "$scripts/deploy-platform.sh" "$IMAGE" "$ID" "$REV" "$LIVE")
printf 'fixture archive' > "$scratch/image/platform.tar.gz"
digest=$(shasum -a 256 < "$scratch/image/platform.tar.gz")
jq -n --arg revision "$REV" --arg image "$IMAGE" --arg image_id "$ID" \
  --arg archive_sha256 "${digest%% *}" '$ARGS.named' > "$scratch/image/release.json"
: > "$LOG"

export GITHUB_REF=refs/heads/topic
reject '只允许从 main' "${release[@]}" build "$scratch/unused" "$REV" 123 1
export POLICY='{"can_admins_bypass":true,"protection_rules":[{"type":"required_reviewers","reviewers":[{}]}]}'
reject '禁止管理员绕过' "${release[@]}" require-policy
export POLICY='{"can_admins_bypass":false,"protection_rules":[]}'
reject '必须配置审批人' "${release[@]}" require-policy
export POLICY='{"can_admins_bypass":false,"protection_rules":[{"type":"required_reviewers","reviewers":[{}]}]}'
"${release[@]}" require-policy

printf 'tampered' >> "$scratch/image/platform.tar.gz"
reject '归档校验失败' "${deploy[@]}"
printf 'fixture archive' > "$scratch/image/platform.tar.gz"
export HEAD_REV=$PRIOR
reject '不是远端 main' "${deploy[@]}"
export HEAD_REV=$REV STATUS=divergent
reject '不是候选的祖先' "${deploy[@]}"
[[ ! -s "$LOG" ]]
export STATUS=advance
reject '不是远端 main' "${deploy[@]}"
[[ $(< "$LOG") == upload ]]
: > "$LOG"
export STATUS=ok
"${deploy[@]}"
[[ $(< "$LOG") == $'upload\nswitch-request' ]]

export LOADED_ID=$LIVE
reject '镜像 ID、架构或源码标记' "${remote[@]}"
export LOADED_ID=$ID CURRENT_ID=$ID
reject '线上镜像已经变化' "${remote[@]}"
[[ ! -e "$scratch/pi-steward/compose.yml" ]]
printf 'Platform release gates: passed\n'
