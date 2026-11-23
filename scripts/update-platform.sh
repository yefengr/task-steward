#!/usr/bin/env bash
# 本机应急入口：只能使用已验证的 Actions 产物，不执行构建。
set -euo pipefail

if [[ $# != 3 || ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ || ! "$3" =~ ^[a-f0-9]{40}$ ]]; then
  echo '用法：bash scripts/update-platform.sh <SSH 别名> <已验证的 Actions 产物目录> <运行摘要的完整源码 SHA>' >&2
  exit 2
fi

script_dir=$(dirname "$0")
bash "$script_dir/platform-release.sh" deploy "$2" "$3" \
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes "$1"
curl --retry 3 -fsS --max-time 10 https://steward.yefengr.cn/health | jq -e '.ok == true'
page=$(curl -fsS --max-time 10 https://steward.yefengr.cn/pair)
[[ "$page" == *'Task Steward'* ]]
