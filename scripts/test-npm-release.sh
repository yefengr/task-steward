#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
release="$root/scripts/npm-release.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export GITHUB_REF=refs/heads/main GITHUB_EVENT_NAME=push GITHUB_REPOSITORY=yefengr/task-steward
export GITHUB_SHA=2222222222222222222222222222222222222222
export PUSH_BEFORE=1111111111111111111111111111111111111111
export GITHUB_OUTPUT="$tmp/outputs" GITHUB_STEP_SUMMARY="$tmp/summary" MOCK_LOG="$tmp/calls"
export ACTIONS_ID_TOKEN_REQUEST_URL=fixture-url ACTIONS_ID_TOKEN_REQUEST_TOKEN=fixture-token
export CURRENT_VERSION=0.2.1 PREVIOUS_VERSION=0.2.0 BASELINE_VALID=true
export REGISTRY_STATUS=404 LATEST_VERSION=0.2.0 LATEST_NAME=@yefengr/steward
export STAGE_REQUESTED=false STEWARD_NPM_HOLD_VERSION= REMOTE_SHA="$GITHUB_SHA" NPM_VERSION=11.19.1 NPM_FAIL=false

# Mock transport commands in child Bash processes. Unexpected arguments also fail offline.
git() {
  printf 'git %s\n' "$*" >> "$MOCK_LOG"
  case "$*" in
    'rev-parse HEAD') printf '%s\n' "$GITHUB_SHA" ;;
    "merge-base --is-ancestor $PUSH_BEFORE $GITHUB_SHA") [[ $BASELINE_VALID == true ]] ;;
    "show $GITHUB_SHA:apps/launcher/package.json")
      printf '{"name":"@pi-steward/launcher","version":"%s"}\n' "$CURRENT_VERSION" ;;
    "show $PUSH_BEFORE:apps/launcher/package.json")
      printf '{"name":"@pi-steward/launcher","version":"%s"}\n' "$PREVIOUS_VERSION" ;;
    'ls-remote --exit-code https://github.com/yefengr/task-steward.git refs/heads/main')
      printf '%s\trefs/heads/main\n' "$REMOTE_SHA" ;;
    *) return 99 ;;
  esac
}
curl() {
  printf 'curl %s\n' "$*" >> "$MOCK_LOG"
  case "$*" in
    "-q -s --max-time 15 -o /dev/null -w %{http_code} https://registry.npmjs.org/@yefengr%2fsteward/$CURRENT_VERSION")
      [[ $REGISTRY_STATUS != offline ]] || return 7
      printf '%s' "$REGISTRY_STATUS" ;;
    '-q -fs --max-time 15 https://registry.npmjs.org/@yefengr%2fsteward/latest')
      printf '{"name":"%s","version":"%s"}\n' "$LATEST_NAME" "$LATEST_VERSION" ;;
    *) return 99 ;;
  esac
}
npm() {
  printf 'npm %s\n' "$*" >> "$MOCK_LOG"
  case "$*" in
    --version) printf '%s\n' "$NPM_VERSION" ;;
    "stage publish ./yefengr-steward-$CURRENT_VERSION.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org")
      [[ -f $3 && $ACTIONS_ID_TOKEN_REQUEST_URL == fixture-url && $ACTIONS_ID_TOKEN_REQUEST_TOKEN == fixture-token ]] || return 99
      [[ $NPM_FAIL == false ]] || { printf 'sensitive-npm-diagnostics\n' >&2; return 1; } ;;
    *) return 99 ;;
  esac
}
export -f git curl npm

fail() { printf '%s\n' "$*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "Expected '$2' in ${1##*/}"; }
excludes() { if grep -Fq -- "$2" "$1"; then fail "Unexpected '$2' in ${1##*/}"; fi; }
run() {
  local expected=$1 actual=0
  shift
  : > "$GITHUB_OUTPUT"
  : > "$GITHUB_STEP_SUMMARY"
  : > "$MOCK_LOG"
  bash "$release" "$@" > "$tmp/result" 2>&1 || actual=$?
  [[ $actual == "$expected" ]] || { printf 'Unexpected exit (%s; expected %s)\n' "$actual" "$expected" >&2; fail "Invocation: $*"; }
}

GITHUB_REF=refs/heads/topic GITHUB_EVENT_NAME=workflow_dispatch run 1 preflight
contains "$tmp/result" 'only run on main'
[[ ! -s $MOCK_LOG && ! -s $GITHUB_OUTPUT ]] || fail 'Non-main preflight started release checks'

PREVIOUS_VERSION=$CURRENT_VERSION run 0 preflight
contains "$GITHUB_OUTPUT" 'pack_required=false'
contains "$GITHUB_STEP_SUMMARY" 'Launcher version remains 0.2.1'
excludes "$MOCK_LOG" 'curl '

PUSH_BEFORE=0000000000000000000000000000000000000000 BASELINE_VALID=false run 1 preflight
contains "$tmp/result" 'push baseline'
[[ ! -s $GITHUB_OUTPUT ]] || fail 'Missing baseline allowed a pack'
BASELINE_VALID=false run 1 preflight
contains "$tmp/result" 'push baseline'
PREVIOUS_VERSION=invalid run 1 preflight
contains "$tmp/result" 'push baseline'

REGISTRY_STATUS=200 run 0 preflight
contains "$GITHUB_OUTPUT" 'pack_required=false'
contains "$GITHUB_STEP_SUMMARY" 'already published'
REGISTRY_STATUS=503 run 1 preflight
contains "$tmp/result" 'HTTP 503'
[[ ! -s $GITHUB_OUTPUT ]] || fail 'Registry error allowed a pack'
REGISTRY_STATUS=offline run 1 preflight
contains "$tmp/result" 'Could not reach the npm registry'

run 0 preflight
contains "$GITHUB_OUTPUT" 'pack_required=true'
contains "$GITHUB_OUTPUT" 'version=0.2.1'
contains "$MOCK_LOG" "git show $PUSH_BEFORE:apps/launcher/package.json"
GITHUB_EVENT_NAME=workflow_dispatch PUSH_BEFORE=invalid run 0 preflight
contains "$GITHUB_OUTPUT" 'pack_required=true'
excludes "$MOCK_LOG" 'merge-base'
excludes "$MOCK_LOG" 'npm '

mkdir "$tmp/artifacts" "$tmp/package"
bundle="$tmp/artifacts/yefengr-steward-$CURRENT_VERSION.tgz"
manifest_fixture() {
  jq -cn --arg name "$1" --arg version "$2" '{
    name: $name,
    version: $version,
    dependencies: { zod: "4.6.6" },
    peerDependencies: { typebox: "*" },
    peerDependenciesMeta: { typebox: { optional: true } }
  }'
}
pack_manifest() {
  printf '%s\n' "$1" > "$tmp/package/package.json"
  tar -czf "$bundle" -C "$tmp" package/package.json
}
pack_fixture() { pack_manifest "$(manifest_fixture "$1" "$2")"; }
tarball_digest() {
  local checksum
  checksum=$(shasum -a 256 < "$bundle")
  printf '%s\n' "${checksum%% *}"
}
pack_fixture @not-steward/tool "$CURRENT_VERSION"
run 1 inspect "$tmp/artifacts"
contains "$tmp/result" 'Invalid package identity or version'
pack_fixture @yefengr/steward "$PREVIOUS_VERSION"
run 1 inspect "$tmp/artifacts"
contains "$tmp/result" 'does not match the launcher version'

typebox_gate_case() {
  local scenario=$1 filter=$2 expected=$3
  pack_manifest "$(manifest_fixture @yefengr/steward "$CURRENT_VERSION" | jq -c "$filter")"
  run 1 inspect "$tmp/artifacts"
  contains "$tmp/result" "$expected"
  run 1 stage "$tmp/artifacts" "$(tarball_digest)"
  contains "$tmp/result" "$expected"
  excludes "$MOCK_LOG" 'npm stage publish '
  printf 'Rejected typebox manifest: %s\n' "$scenario"
}
typebox_gate_case 'production dependency' '.dependencies.typebox = "1.3.27"' 'must not be listed in dependencies'
typebox_gate_case 'optional production dependency' '.optionalDependencies.typebox = "1.3.27"' 'must not be listed in optionalDependencies'
typebox_gate_case 'missing peer dependency' 'del(.peerDependencies.typebox)' 'must be declared as a peer dependency with version "*"'
typebox_gate_case 'exact peer version' '.peerDependencies.typebox = "1.3.27"' 'must be declared as a peer dependency with version "*"'
typebox_gate_case 'missing optional peer metadata' 'del(.peerDependenciesMeta)' 'must be marked optional'
typebox_gate_case 'non-optional peer metadata' '.peerDependenciesMeta.typebox.optional = false' 'must be marked optional'

pack_fixture @yefengr/steward "$CURRENT_VERSION"
STEWARD_NPM_HOLD_VERSION=$CURRENT_VERSION run 0 inspect "$tmp/artifacts"
IFS= read -r digest_line < "$GITHUB_OUTPUT"
digest=${digest_line#sha256=}
[[ $digest =~ ^[0-9a-f]{64}$ ]] || fail 'Missing tarball digest'
contains "$GITHUB_STEP_SUMMARY" "$GITHUB_SHA"
contains "$GITHUB_STEP_SUMMARY" "$digest"

GITHUB_REF=refs/heads/topic GITHUB_EVENT_NAME=workflow_dispatch STAGE_REQUESTED=true run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'only run on main'
GITHUB_REPOSITORY=someone/task-steward run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'Only the official repository'
GITHUB_EVENT_NAME=workflow_dispatch run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'requires the stage input'
excludes "$MOCK_LOG" 'npm '
run 1 stage "$tmp/artifacts" mismatch
contains "$tmp/result" 'differs from the verified pack job'
excludes "$MOCK_LOG" 'curl '
for event in push workflow_dispatch; do
  GITHUB_EVENT_NAME=$event STAGE_REQUESTED=true STEWARD_NPM_HOLD_VERSION=$CURRENT_VERSION run 0 stage "$tmp/artifacts" "$digest"
  contains "$GITHUB_STEP_SUMMARY" 'Held by STEWARD_NPM_HOLD_VERSION; skipping npm staging'
  excludes "$MOCK_LOG" 'curl '
  excludes "$MOCK_LOG" 'npm '
done
REGISTRY_STATUS=200 run 0 stage "$tmp/artifacts" "$digest"
contains "$GITHUB_STEP_SUMMARY" 'Already published; skipping npm staging'
excludes "$MOCK_LOG" 'npm '
LATEST_NAME=@not-steward/tool run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'Could not confirm the npm latest version'
LATEST_VERSION=0.2.10 run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'must be newer than npm latest'
NPM_VERSION=11.14.0 run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'requires npm 11.15.0 or newer'
ACTIONS_ID_TOKEN_REQUEST_TOKEN= run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'did not provide OIDC request credentials'
excludes "$MOCK_LOG" 'npm stage publish '

GITHUB_EVENT_NAME=workflow_dispatch STAGE_REQUESTED=true REMOTE_SHA=$PUSH_BEFORE run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'no longer matches the official main branch'
excludes "$MOCK_LOG" 'npm stage publish '
GITHUB_EVENT_NAME=workflow_dispatch STAGE_REQUESTED=true run 0 stage "$tmp/artifacts" "$digest"
contains "$MOCK_LOG" 'git ls-remote --exit-code https://github.com/yefengr/task-steward.git refs/heads/main'
contains "$MOCK_LOG" "npm stage publish ./yefengr-steward-$CURRENT_VERSION.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org"
contains "$GITHUB_STEP_SUMMARY" 'not yet public'
contains "$GITHUB_STEP_SUMMARY" '2FA'
contains "$GITHUB_STEP_SUMMARY" 'deployed platform is compatible'
contains "$GITHUB_STEP_SUMMARY" "$digest"
STEWARD_NPM_HOLD_VERSION=$PREVIOUS_VERSION run 0 stage "$tmp/artifacts" "$digest"
contains "$MOCK_LOG" 'npm stage publish '
excludes "$MOCK_LOG" 'git ls-remote'
excludes "$MOCK_LOG" 'npm publish '
NPM_FAIL=true run 1 stage "$tmp/artifacts" "$digest"
contains "$tmp/result" 'npm staging failed'
excludes "$tmp/result" 'sensitive-npm-diagnostics'
excludes "$GITHUB_STEP_SUMMARY" 'Submitted to npm'

printf 'npm release fixtures passed (no network or npm writes).\n'
