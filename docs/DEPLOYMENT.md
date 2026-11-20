# Pi Steward 部署与 Mac 接入

## 构建和配置

从仓库根目录构建平台镜像。

```sh
docker build -f docker/platform.Dockerfile -t pi-steward-platform:local .
```

由部署操作者在私密终端运行 `docker run --rm -it pi-steward-platform:local node dist/admin.js hash-password`，输入自己设置的访问密码。把生成的哈希和其他参数保存在仓库外、权限为 `600` 的 Compose 环境文件中。`STEWARD_ACCESS_PASSWORD_HASH` 的值含 `$`，在 Compose 环境文件中用单引号包住整个值。

| 参数 | 取值 |
| --- | --- |
| `STEWARD_PUBLIC_ORIGIN` | HTTPS 域名对应的 Origin，不带路径或末尾斜线 |
| `STEWARD_ACCESS_PASSWORD_HASH` | 上述命令生成的哈希 |
| `STEWARD_BIND_PORT` | 反向代理访问平台的本机端口，示例默认 `3000` |
| `STEWARD_TRUST_PROXY_CLIENT_IP` | 默认 `0`，用连接来源限流。可在可信代理覆盖 `X-Steward-Client-IP` 且平台端口只对该代理开放时设为 `1` |

[Compose 示例](../docker/compose.example.yml) 将容器端口发布到宿主机回环地址，适用于和平台同机的反向代理。代理配置按实际环境将 HTTPS 域名转发到该回环端口。使用下面的命令检查和启动，替换环境文件路径。

```sh
docker compose --env-file /path/to/private-env -f docker/compose.example.yml config --quiet
docker compose --env-file /path/to/private-env -f docker/compose.example.yml up -d
```

平台使用 `/data` 下的 SQLite 文件和 WAL。Compose 命名卷保留任务和会话。确认容器 `/health` 正常后，从 HTTPS 域名登录。首次启动会自动应用已有迁移。备份时，在同一 Compose 服务里执行 `node dist/admin.js backup /data/<新的快照文件>`，再把生成的快照复制到受控存储。恢复旧数据前先停服务，保留当前卷，使用快照建立新卷并验证健康检查及关键记录后再切换。

## 登记 Mac

1. 在私密终端使用 `docker compose exec platform node dist/admin.js machine:add <名称>`。该命令在交互终端只显示机器令牌一次，也允许从标准输入接收操作者提供的令牌。给 `docker compose` 加上部署时使用的 `--env-file` 和 `-f`。
2. 在 Mac 上完成锁文件安装和 `pnpm build`，从仓库根运行 `node apps/launcher/dist/index.js init`。它生成 `~/.config/pi-steward/config.json`，由操作者填写平台 Origin、机器令牌、项目绝对路径和名额。
3. 启动器可用 `run` 前台运行，或由操作者运行 `node apps/launcher/dist/index.js install` 安装用户级 LaunchAgent。`status` 检查本机状态，`uninstall` 停止并移除对应 LaunchAgent。
4. 在平台电脑页确认电脑在线且项目已登记。安排一项测试任务并在 Pi Reach 用显示名称找到会话。Mac 本机可用 `tmux -L steward ls` 查找会话。

撤销机器时使用同一管理入口运行 `machine:revoke <名称>`。回报、交付、返修等验收步骤见[首版实施方案](plans/active/20261119-first-version-implementation.md#123-真机验收宿主机-mac)。
