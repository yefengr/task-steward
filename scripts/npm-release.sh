#!/usr/bin/env bash
set -euo pipefail

readonly launcher_manifest=apps/launcher/package.json
readonly launcher_name=@pi-steward/launcher
readonly package_name=@yefengr/steward
readonly repository=yefengr/task-steward
readonly registry=https://registry.npmjs.org
readonly package_url="$registry/@yefengr%2fsteward"
readonly main_ref=refs/heads/main
readonly stable_version='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly min_stage_npm=11.15.0

fail() { printf '%s\n' "$*" >&2; exit 1; }
summary() { printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; }
output() { printf '%s\n' "$*" >> "$GITHUB_OUTPUT"; }

require_main() {
  [[ ${GITHUB_REF:-} == "$main_ref" ]] || fail 'npm release checks can only run on main.'
}

require_source() {
  [[ ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ && $(git rev-parse HEAD 2>/dev/null) == "$GITHUB_SHA" ]] \
    || fail 'Checkout does not match the workflow source SHA.'
}

manifest_version() {
  local version
  version=$(jq -er --arg name "$1" 'select(.name == $name) | .version' 2>/dev/null) || return 1
  [[ $version =~ $stable_version ]] || return 1
  printf '%s\n' "$version"
}

source_version() {
  git show "$1:$launcher_manifest" 2>/dev/null | manifest_version "$launcher_name"
}

version_status() {
  local status
  status=$(curl -q -s --max-time 15 -o /dev/null -w '%{http_code}' "$package_url/$1") \
    || fail 'Could not reach the npm registry to check the version.'
  case "$status" in
    200|404) printf '%s\n' "$status" ;;
    [0-9][0-9][0-9]) fail "Could not check the npm version (HTTP $status)." ;;
    *) fail 'Unexpected response while checking the npm version.' ;;
  esac
}

preflight() {
  local version previous before=${PUSH_BEFORE:-}
  version=$(source_version "$GITHUB_SHA") || fail 'Cannot determine the launcher version at the workflow source SHA.'
  case ${GITHUB_EVENT_NAME:-} in
    push)
      [[ $before =~ ^[0-9a-f]{40}$ && $before != "$GITHUB_SHA" ]] \
        && git merge-base --is-ancestor "$before" "$GITHUB_SHA" >/dev/null 2>&1 \
        && previous=$(source_version "$before") \
        || fail 'Cannot determine the previous launcher version from the push baseline.'
      if [[ $previous == "$version" ]]; then
        summary "Launcher version remains $version. Running verification on Linux without packing."
        output 'pack_required=false'
        return
      fi
      ;;
    workflow_dispatch) ;;
    *) fail 'Unsupported npm release event.' ;;
  esac

  local status
  status=$(version_status "$version") || exit 1
  if [[ $status == 200 ]]; then
    summary "$package_name@$version is already published. Running verification on Linux without packing."
    output 'pack_required=false'
  else
    output "version=$version"
    output 'pack_required=true'
  fi
}

inspect_bundle() {
  local artifact_dir=$1 manifest bundled_version
  shopt -s nullglob
  local bundles=("$artifact_dir"/yefengr-steward-*.tgz)
  [[ ${#bundles[@]} == 1 && -f ${bundles[0]} ]] || fail 'Expected exactly one Steward npm tarball.'
  bundle=${bundles[0]}
  version=$(source_version "$GITHUB_SHA") || fail 'Cannot determine the launcher version at the workflow source SHA.'
  manifest=$(tar -xOzf "$bundle" package/package.json 2>/dev/null) || fail 'Cannot read the tarball manifest.'
  bundled_version=$(manifest_version "$package_name" <<< "$manifest") || fail 'Invalid package identity or version in the tarball.'
  [[ $bundled_version == "$version" && ${bundle##*/} == "yefengr-steward-$version.tgz" ]] \
    || fail 'Tarball name or version does not match the launcher version at the workflow source SHA.'
  digest=$(shasum -a 256 < "$bundle")
  digest=${digest%% *}
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || fail 'Cannot determine tarball SHA-256.'
}

summarize_bundle() {
  summary "$1: \`$package_name@$version\`"
  summary "- Source SHA: \`$GITHUB_SHA\`"
  summary "- Tarball SHA-256: \`$digest\`"
}

version_gt() {
  jq -en --arg left "$1" --arg right "$2" '
    def parts: split(".") | map([length, .]);
    ($left | parts) > ($right | parts)
  ' >/dev/null
}

require_current_main() {
  local remote_main
  remote_main=$(GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "https://github.com/$repository.git" "$main_ref" 2>/dev/null) \
    || fail 'Could not confirm the current commit on the official main branch.'
  [[ $remote_main == "$GITHUB_SHA"$'\t'"$main_ref" ]] \
    || fail 'This run no longer matches the official main branch. Start a new workflow run from main.'
}

stage() {
  local artifact_dir=$1 expected_digest=$2 status latest npm_version
  [[ ${GITHUB_REPOSITORY:-} == "$repository" ]] || fail 'Only the official repository can stage Steward on npm.'
  case ${GITHUB_EVENT_NAME:-} in
    push) ;;
    workflow_dispatch) [[ ${STAGE_REQUESTED:-} == true ]] || fail 'Manual staging requires the stage input.' ;;
    *) fail 'Unsupported npm release event.' ;;
  esac

  inspect_bundle "$artifact_dir"
  [[ $digest == "$expected_digest" ]] || fail 'Tarball SHA-256 differs from the verified pack job.'
  if [[ ${STEWARD_NPM_HOLD_VERSION:-} == "$version" ]]; then
    summarize_bundle 'Held by STEWARD_NPM_HOLD_VERSION; skipping npm staging'
    return
  fi
  status=$(version_status "$version") || exit 1
  if [[ $status == 200 ]]; then
    summarize_bundle 'Already published; skipping npm staging'
    return
  fi
  latest=$(curl -q -fs --max-time 15 "$package_url/latest" | manifest_version "$package_name") \
    || fail 'Could not confirm the npm latest version.'
  version_gt "$version" "$latest" || fail "Version $version must be newer than npm latest ($latest)."
  npm_version=$(npm --version 2>/dev/null) || fail 'Could not determine the bundled npm version.'
  [[ $npm_version =~ $stable_version ]] && ! version_gt "$min_stage_npm" "$npm_version" \
    || fail "npm stage publish requires npm $min_stage_npm or newer."
  [[ -n ${ACTIONS_ID_TOKEN_REQUEST_URL:-} && -n ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-} ]] \
    || fail 'GitHub did not provide OIDC request credentials.'
  if [[ $GITHUB_EVENT_NAME == workflow_dispatch ]]; then
    require_current_main
  fi

  # Run outside the checkout and do not print npm output, which may contain OIDC diagnostics.
  (cd "$artifact_dir" && npm stage publish "./${bundle##*/}" --access public --ignore-scripts --registry="$registry" >/dev/null 2>&1) \
    || fail 'npm staging failed. Check the npm Trusted Publisher configuration and Staged Packages before retrying.'
  summarize_bundle 'Submitted to npm Staged Packages (not yet public)'
  summary 'Before approving with 2FA on npmjs.com, check the version and confirm that the deployed platform is compatible with this macOS launcher and Pi extension.'
}

require_main
require_source
case ${1:-} in
  preflight) preflight ;;
  inspect)
    inspect_bundle "$2"
    summarize_bundle 'Verified macOS npm package'
    output "sha256=$digest"
    ;;
  stage) stage "$2" "$3" ;;
  *) fail 'Usage: npm-release.sh preflight | inspect <artifact-dir> | stage <artifact-dir> <sha256>' ;;
esac
