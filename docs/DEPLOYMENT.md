# Task Steward 部署与 Mac 接入

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

## 自动部署和 npm 发布

Steward 在 GitHub Actions 中提供两个手动触发的工作流，从 `main` 运行。

- [Deploy Task Steward platform](../.github/workflows/deploy.yml) 先运行 `pnpm verify`，构建 `linux/amd64` 镜像并保留镜像 ID。`production` 作业通过 SSH 上传同一镜像，在服务器上备份 SQLite，用快照副本验证迁移与配对页，再更新原 Compose 服务。工作流检查正式站点的 HTTPS 健康响应和配对入口。
- [Stage Task Steward on npm](../.github/workflows/release.yml) 先在 macOS 验证并打包，再用 GitHub OIDC 将 `@yefengr/steward` 提交到 npm 待审区。维护者在 npmjs.com 审核并完成双因素认证后，版本才会公开。批准需要新版平台支持的 CLI 前，先确认平台已部署。

启用前，将项目推送到 GitHub，在 `production` 环境设置 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY` 和 `DEPLOY_KNOWN_HOSTS`。SSH 主机公钥应从可信渠道核对。端口默认 22，其他端口通过环境变量 `DEPLOY_PORT` 配置。部署账号需要访问 `~/pi-steward` 和该项目的 Docker Compose 服务。生产审批可以在 `production` 环境配置。

在 npm 配置 Trusted Publisher，绑定 GitHub 仓库、工作流文件 `release.yml` 与环境 `npm-release`，授予 staged publish 权限。如果该包的 npm 配置入口需要已有公开版本，先在维护者终端发布首版，再配置 Trusted Publisher。日常工作流通过 OIDC 认证。

部署脚本会打印对应的 Compose 备份和数据库快照路径。服务器使用同一份生产卷。数据库格式升级后，如需回退旧镜像，先核对旧镜像支持的格式以及升级后新增的数据，再选恢复方式。部署失败时保留现有数据和备份供核对。

## 登记 Mac

Mac 需要 Node 24.20.0 或同系列更高版本，以及可在终端执行的 `pi`、`tmux` 和 `git`。平台升级到支持电脑配对的版本、npm 包发布后，按首页指引接入。

1. 运行 `npm install -g @yefengr/steward` 安装 `stew`。
2. 运行 `stew pair` 获取配对码。手动打开任务平台的 `/pair` 页面并登录，输入配对码，核对电脑名，再确认接入。终端显示已配对后即可继续。配对码十分钟内有效。若确认后退出或断网，再次运行同一命令可以继续配对。
3. 运行 `stew start`，启动当前用户的 LaunchAgent。启动前会检查 `pi` 和 `tmux`。稍后在网页电脑页确认它已上线。以后登录 Mac 时服务会自动启动。
4. 在要登记的 Git 项目目录运行 `stew add`。启动器在下次心跳同步项目列表，重复登记同一目录会复用原记录。

`stew status` 会显示平台连接和本机 tmux 的状态。tmux 无法运行或无法查询 Steward 的会话时，服务继续发送心跳，并暂停领取新任务。tmux 恢复后会自动继续领取。

直接运行 `stew` 可以查看接入进度。首次配对默认连接 `https://steward.yefengr.cn`。自托管平台用 `stew pair --url https://你的域名` 指定地址。

配对成功后，Mac 将平台地址、机器令牌和启动器配置保存在 `~/pi-steward/config.json`，文件权限为 `0600`。可通过 `STEWARD_CONFIG` 指定其他路径。升级时，如果新位置还没有配置，启动器会沿用 `~/.config/pi-steward/config.json` 中的原配置。要迁移已有配置，等任务结束后用 `stew uninstall` 停止已安装的服务，将文件移到新位置并保留 `0600` 权限，再用 `stew start` 安装服务，使它读取新位置。网页平台在 SQLite 中保存电脑登记信息和机器令牌的哈希，确认后删除配对码。

Steward 在 macOS 上默认按系统代理设置连接任务平台，包括 PAC 自动配置和排除列表。配对、后台心跳和 Pi 的 Steward 工具共用这套设置。需要覆盖时运行以下命令之一，连接成功后会保存选择。已经配对的 Mac 可以沿用现有登记。

```bash
stew pair --proxy direct                  # 直连
stew pair --proxy http://127.0.0.1:7890    # 指定无认证的 HTTP 代理
stew pair --proxy system                  # 恢复跟随系统
```

已有配置也可以直接编辑 `proxy` 字段，分别使用 `{"mode":"direct"}`、`{"mode":"custom","url":"http://127.0.0.1:7890"}` 或 `{"mode":"system"}`。省略 `proxy` 等同于跟随系统。系统代理模式仅适用于 macOS。显式代理要求 Steward 和运行 Pi 的 Node 均为 24.20.0 或更高版本。TUN、VPN 和 Fake IP 仍由系统网络及代理客户端控制。

开发时在安装了 Xcode 或 Xcode Command Line Tools 的 Mac 上运行 `pnpm pack:stew`，会在 `.pi/tmp` 生成适用于 Apple Silicon 和 Intel Mac 的 npm 安装包。运行安装包时只需前面列出的工具。可在 Mac 的临时目录用 `npm install /绝对路径/包名.tgz` 验证安装，再通过该目录下的 `node_modules/.bin/stew` 使用命令。

### 旧版和手动登记

1. 在私密终端使用 `docker compose exec platform node dist/admin.js machine:add <名称>`。该命令在交互终端只显示机器令牌一次，也允许从标准输入接收操作者提供的令牌。给 `docker compose` 加上部署时使用的 `--env-file` 和 `-f`。
2. 在 Mac 上完成锁文件安装和 `pnpm build`，从仓库根运行 `node apps/launcher/dist/index.js init`。新安装会生成 `~/pi-steward/config.json`，由操作者填写平台 Origin、机器令牌、项目绝对路径和名额。
3. 启动器可用 `run` 前台运行，或由操作者运行 `node apps/launcher/dist/index.js install` 安装用户级 LaunchAgent。`status` 检查本机状态，`uninstall` 停止并移除对应 LaunchAgent。
4. 在平台电脑页确认电脑在线且项目已登记。安排一项测试任务并在 Pi Reach 用显示名称找到会话。Mac 本机可用 `tmux -L steward ls` 查找会话。

撤销机器时使用同一管理入口运行 `machine:revoke <名称>`。回报、交付、返修等验收步骤见[首版实施方案](plans/active/20261119-first-version-implementation.md#123-真机验收宿主机-mac)。
