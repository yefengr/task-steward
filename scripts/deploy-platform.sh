#!/usr/bin/env bash
# 生产服务器预装，由受限 SSH 入口在验证归档后调用。
set -euo pipefail
umask 077

fail() { echo "$*" >&2; exit 1; }
is_image_id() { [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]]; }

snapshot_preflight() (
  local image_id=$1 source_container=$2 snapshot=$3 stage_id=''
  trap 'if [[ -n "$stage_id" ]]; then docker rm -f "$stage_id" >/dev/null || true; fi' EXIT
  stage_id=$(docker run -d --network none --volumes-from "$source_container:ro" \
    -e STEWARD_ALLOW_LOCAL_HTTP=1 -e STEWARD_PUBLIC_ORIGIN=http://127.0.0.1:3000 -e STEWARD_DATA_DIR=/tmp/steward-candidate \
    --entrypoint sh "$image_id" -ec '
      install -d -m 700 "$STEWARD_DATA_DIR"
      cp "$1" "$STEWARD_DATA_DIR/steward.sqlite"
      STEWARD_ACCESS_PASSWORD_HASH=$(node --input-type=module -e '\''import { randomBytes } from "node:crypto"; import { hashPassword } from "/app/dist/auth.js"; console.log(await hashPassword(randomBytes(32).toString("hex")));'\'')
      export STEWARD_ACCESS_PASSWORD_HASH
      exec node dist/index.js
    ' candidate "$snapshot")

  local attempt
  for attempt in $(seq 1 15); do
    if docker exec "$stage_id" node -e 'fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(1000) }).then(r => { if (!r.ok) process.exitCode = 1; }, () => { process.exitCode = 1; });' >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$stage_id" node --input-type=module -e '
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const health = await fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(3000) });
if (!health.ok || (await health.json()).ok !== true) process.exit(1);
const page = await fetch("http://127.0.0.1:3000/pair", { signal: AbortSignal.timeout(3000) });
if (!page.ok || !(await page.text()).includes("Task Steward")) process.exit(1);
const db = new DatabaseSync(join(process.env.STEWARD_DATA_DIR, "steward.sqlite"), { readOnly: true });
const version = readdirSync("/app/migrations").filter(name => /^\d{4}-[\w-]+\.sql$/.test(name)).length;
if (db.prepare("PRAGMA user_version").get().user_version !== version || db.prepare("PRAGMA quick_check").get().quick_check !== "ok") process.exit(1);
console.log(`SQLite schema ${version}: quick_check ok; API /health and web /pair ok`);
'
)

if [[ ${1:-} == --snapshot-preflight ]]; then
  [[ $# == 4 ]] && is_image_id "$2" || fail 'Usage: --snapshot-preflight <image ID> <source container> <snapshot>'
  snapshot_preflight "$2" "$3" "$4"
  exit
fi

[[ $# == 4 ]] || fail 'Usage: deploy-platform.sh <image> <image ID> <revision> <expected live ID>'
release_image=$1 release_id=$2 revision=$3 expected_live_id=$4
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$release_image" =~ ^pi-steward-platform:sha-$revision-[0-9]+-[0-9]+$ ]]
is_image_id "$release_id" && is_image_id "$expected_live_id" || fail 'Invalid image ID.'

cd "$HOME/pi-steward"
exec 9>.steward-deploy.lock
flock -n 9 || fail '已有部署在运行。'
compose=(docker-compose -p pi-steward --env-file .env -f compose.yml)
live=pi-steward-platform-1

verify_release() {
  [[ $(docker image inspect -f '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$release_image") == "$release_id linux/amd64 $revision" ]] ||
    fail '服务器上的镜像 ID、架构或源码标记与已验证的产物不符。'
}

verify_expected_live() {
  [[ $(docker inspect -f '{{.Image}}' "$live") == "$expected_live_id" ]] || fail '线上镜像已经变化，拒绝覆盖。'
}

verify_live() {
  local attempt bind
  for attempt in $(seq 1 120); do
    if [[ $(docker inspect -f '{{.State.Health.Status}}' "$live") == healthy ]]; then
      [[ $(docker inspect -f '{{.Image}}' "$live") == "$release_id" ]]
      bind=$(loopback_bind)
      curl -fsS --max-time 5 "http://$bind/health"
      printf '\n'
      curl -fsS --max-time 5 "http://$bind/pair" >/dev/null
      return
    fi
    sleep 1
  done
  fail '新版容器未通过健康检查。请查看容器日志和部署备份。'
}

loopback_bind() {
  local bind
  bind=$(docker port "$live" 3000/tcp)
  [[ "$bind" =~ ^127\.0\.0\.1:[0-9]{1,5}$ ]] || fail '需要将平台容器端口发布到单一 IPv4 回环地址。'
  printf '%s\n' "$bind"
}

verify_release
verify_expected_live
prior_image=$("${compose[@]}" config --images)
[[ "$prior_image" == "$(docker inspect -f '{{.Config.Image}}' "$live")" ]]
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$live")" == pi-steward_steward-data ]]

if [[ "$release_id" == "$expected_live_id" ]]; then
  verify_live
  echo '该镜像已在线，无需切换。'
  exit
fi
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$live")" == healthy ]]
loopback_bind >/dev/null

# 秒级时间戳外加进程 ID，重试不覆盖已有备份。
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
backup_started=$SECONDS
snapshot="/data/before-deploy-$stamp.sqlite"
compose_backup="compose.before-deploy-$stamp.yml"
docker exec "$live" node dist/admin.js backup "$snapshot"
printf 'Database backup: %s\n' "$snapshot"
docker exec "$live" node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") process.exit(1);
' "$snapshot"
printf '数据库备份与完整性检查：%s 秒\n' "$((SECONDS - backup_started))" >&2

candidate_started=$SECONDS
snapshot_preflight "$release_id" "$live" "$snapshot"
printf '候选镜像与快照预检：%s 秒\n' "$((SECONDS - candidate_started))" >&2

switch_started=$SECONDS
next_file=$(mktemp ./compose.next.XXXXXX)
trap 'rm -f "$next_file"' EXIT
awk -v old="$prior_image" -v image="$release_image" '
$1 == "image:" && $2 == old { sub(/[^[:space:]]+$/, image); count++ }
{ print }
END { if (count != 1) exit 1 }
' compose.yml > "$next_file"
[[ "$(docker-compose -p pi-steward --env-file .env -f "$next_file" config --images)" == "$release_image" ]]
[[ "$(docker-compose -p pi-steward --env-file .env -f "$next_file" config --volumes)" == steward-data ]]
verify_expected_live
verify_release
cp -p compose.yml "$compose_backup"
printf 'Compose backup: %s\n' "$compose_backup"
mv "$next_file" compose.yml
"${compose[@]}" up -d --no-deps --no-build platform
verify_live
printf '容器切换与健康检查：%s 秒\n' "$((SECONDS - switch_started))" >&2
