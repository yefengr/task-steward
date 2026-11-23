#!/usr/bin/env bash
# 使用独立 Docker 卷验证从候选的上一版 schema 启动，不连接生产。
set -euo pipefail
candidate=${1:?expected candidate image ID}
volume=$(docker volume create)
fixture="steward-migration-fixture-$volume"
trap 'docker rm -f "$fixture" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null' EXIT

# 由候选镜像自带的 SQL 构造上一版，再生成与生产备份同格式的 SQLite 快照。
docker run --network none --name "$fixture" --volume "$volume:/data" --entrypoint node "$candidate" --input-type=module -e '
import { DatabaseSync, backup } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
const migrations = readdirSync("/app/migrations").filter(name => /^\d{4}-[\w-]+\.sql$/.test(name)).sort();
const db = new DatabaseSync("/data/steward.sqlite");
const prior = migrations.slice(0, -1);
if (!prior.length) throw new Error("Expected at least one prior migration");
for (const name of prior) db.exec(readFileSync(`/app/migrations/${name}`, "utf8"));
db.exec(`PRAGMA user_version=${prior.length}`);
await backup(db, "/data/fixture.sqlite");
console.log(`Prepared SQLite schema ${prior.length}`);
'
script_dir=$(dirname "$0")
bash "$script_dir/deploy-platform.sh" --snapshot-preflight "$candidate" "$fixture" /data/fixture.sqlite

# 再确认快照仍为旧版本。预检必须迁移副本，不能改写挂载的快照。
docker run --rm --network none --volumes-from "$fixture:ro" --entrypoint node "$candidate" --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
const db = new DatabaseSync("/data/fixture.sqlite", {readOnly: true});
const prior = readdirSync("/app/migrations").filter(name => /^\d{4}-[\w-]+\.sql$/.test(name)).length - 1;
if (db.prepare("PRAGMA user_version").get().user_version !== prior) process.exit(1);
console.log(`Original snapshot remains at schema ${prior}`);
'
