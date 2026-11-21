#!/usr/bin/env bash
# 从个人服务器上的 Compose 目录运行，或由 CI 通过 SSH 将此脚本送入 bash。
set -euo pipefail
umask 077

release_image=${1:?Provide the locally loaded release image}
release_id=${2:?Provide the expected Docker image ID}
[[ "$release_image" =~ ^pi-steward-platform:[a-zA-Z0-9][a-zA-Z0-9.-]{0,100}$ ]]
[[ "$release_id" =~ ^sha256:[a-f0-9]{64}$ ]]
cd "$HOME/pi-steward"
exec 9>.steward-deploy.lock
flock -n 9
compose=(docker-compose -p pi-steward --env-file .env -f compose.yml)
live=pi-steward-platform-1

[[ "$(docker image inspect -f '{{.Id}} {{.Os}}/{{.Architecture}}' "$release_image")" == "$release_id linux/amd64" ]]
prior_image=$("${compose[@]}" config --images)
[[ "$prior_image" == "$(docker inspect -f '{{.Config.Image}}' "$live")" ]]
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$live")" == pi-steward_steward-data ]]

verify_live() {
  local attempt
  for attempt in $(seq 1 45); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$live")" == healthy ]]; then
      [[ "$(docker inspect -f '{{.Image}}' "$live")" == "$release_id" ]]
      curl -fsS --max-time 5 http://127.0.0.1:3004/health
      printf '\n'
      curl -fsS --max-time 5 http://127.0.0.1:3004/pair >/dev/null
      return
    fi
    sleep 1
  done
  echo '新版容器未通过健康检查。请查看容器日志和部署备份。' >&2
  return 1
}

if [[ "$prior_image" == "$release_image" ]]; then
  verify_live
  exit
fi
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$live")" == healthy ]]

stamp=$(date -u +%Y%m%dT%H%M%SZ)
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
stage="pi-steward-candidate-$stamp"
next_file=$(mktemp ./compose.next.XXXXXX)
stage_id=''
cleanup() {
  if [[ -n "$stage_id" ]]; then docker rm -f "$stage_id" >/dev/null || true; fi
  rm -f "$next_file"
}
trap cleanup EXIT
docker run -d --name "$stage" --volumes-from "$live:ro" \
  -e STEWARD_ALLOW_LOCAL_HTTP=1 -e STEWARD_PUBLIC_ORIGIN=http://127.0.0.1:3000 -e STEWARD_DATA_DIR=/tmp/steward-candidate \
  --entrypoint sh "$release_image" -ec '
    install -d -m 700 "$STEWARD_DATA_DIR"
    cp "$1" "$STEWARD_DATA_DIR/steward.sqlite"
    STEWARD_ACCESS_PASSWORD_HASH=$(node --input-type=module -e '\''import { randomBytes } from "node:crypto"; import { hashPassword } from "/app/dist/auth.js"; console.log(await hashPassword(randomBytes(32).toString("hex")));'\'')
    export STEWARD_ACCESS_PASSWORD_HASH
    exec node dist/index.js
  ' candidate "$snapshot" >/dev/null
stage_id=$(docker inspect -f '{{.Id}}' "$stage")

for attempt in $(seq 1 15); do
  if docker exec "$stage_id" node -e 'fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(1000) }).then(r => { if (!r.ok) process.exitCode = 1; }, () => { process.exitCode = 1; });' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$stage_id" node --input-type=module -e '
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const page = await fetch("http://127.0.0.1:3000/pair", { signal: AbortSignal.timeout(3000) });
if (!page.ok || !(await page.text()).includes("Task Steward")) process.exit(1);
const db = new DatabaseSync(join(process.env.STEWARD_DATA_DIR, "steward.sqlite"), { readOnly: true });
const version = readdirSync("/app/migrations").filter(name => /^\d{4}-[\w-]+\.sql$/.test(name)).length;
if (db.prepare("PRAGMA user_version").get().user_version !== version || db.prepare("PRAGMA quick_check").get().quick_check !== "ok") process.exit(1);
'
printf '候选镜像与快照预检：%s 秒\n' "$((SECONDS - candidate_started))" >&2

switch_started=$SECONDS
awk -v old="$prior_image" -v image="$release_image" '
$1 == "image:" && $2 == old { sub(/[^[:space:]]+$/, image); count++ }
{ print }
END { if (count != 1) exit 1 }
' compose.yml > "$next_file"
[[ "$(docker-compose -p pi-steward --env-file .env -f "$next_file" config --images)" == "$release_image" ]]
[[ "$(docker-compose -p pi-steward --env-file .env -f "$next_file" config --volumes)" == steward-data ]]
cp -p compose.yml "$compose_backup"
printf 'Compose backup: %s\n' "$compose_backup"
mv "$next_file" compose.yml
"${compose[@]}" up -d --no-deps --no-build platform
verify_live
printf '容器切换与健康检查：%s 秒\n' "$((SECONDS - switch_started))" >&2
