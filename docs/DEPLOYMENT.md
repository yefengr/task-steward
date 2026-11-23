# Task Steward 部署与 Mac 接入

## 本地试用或自托管

以下构建命令用于本地试用或独立自托管，不用于更新 Steward 的正式站点。自托管时，从仓库根目录构建镜像。

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

## 平台生产部署

网站和 API 随同一个 `linux/amd64` 镜像上线。[平台工作流](../.github/workflows/deploy.yml) 在相关改动推送到 `main` 后验证代码、构建镜像，并用隔离的 SQLite 快照验证迁移、`/health` 和 `/pair`。通过后，运行摘要列出完整源码 SHA、镜像 ID 和归档 SHA-256，**Artifacts** 保存镜像七天。需要只验证、不申请上线时，在 Actions 手动运行该工作流，选择 `main`，保持 `deploy` 未勾选。手动从其他分支运行会失败。

首次上线前，在 GitHub 仓库 **Settings → Environments → production** 添加 required reviewers，关闭管理员绕过，并将部署分支限制为 `main`。启用 Prevent self-review 时，操作人和审批人必须不同。把 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、经核实的 `DEPLOY_KNOWN_HOSTS` 放在该环境的 Secrets 中，不放在仓库级 Secrets。非默认 SSH 端口通过该环境的 `DEPLOY_PORT` 变量配置。服务器沿用 `~/pi-steward` 的 Compose 布局，应用环境文件和数据库不交给 GitHub。

准备通过后，在 Actions 核对摘要与镜像，再批准 `production`。审批配置缺失时不会连接生产。审批后下载本次构建的归档，不重新构建；已过期的归档或不再是远端 `main` 最新提交的候选需要重新准备。部署还要求线上提交是候选的祖先。服务器在部署锁内核对镜像身份和线上容器是否已更换，再备份数据库、用实际备份的副本验证迁移，最后切换 Compose 并检查本机和公网的 API、网页。已经运行同一镜像 ID 时只检查健康，不重复切换。

### Actions 无法执行时

应急部署也要经过人工上线批准。先核对官方仓库的 Actions 运行确实来自 `main`，且构建与隔离迁移预检已通过；从那次运行下载对应归档。在已更新至当前 `main` 的仓库运行：

```bash
gh run download <run-id> --repo yefengr/task-steward --name <steward-platform-image-...> --dir ./release-image
bash scripts/update-platform.sh <SSH 别名> ./release-image <运行摘要中的完整源码SHA>
```

应急命令不会从本机源码构建，也不能部署旧候选。不要在 Actions 正在部署时并行执行。

### 回滚与数据

记录部署日志中的 Compose 备份、SQLite 快照路径和前一镜像 ID。切换前预检失败时，原服务不变；切换后的健康检查失败时，不自动回滚。先确认库已迁移到哪一版，以及切换后有没有新写入。只有确认旧镜像能读取当前 schema 和数据时，才能考虑用原卷恢复旧镜像；否则先停止服务、保留当前卷，再从部署前快照建立新卷，核对关键记录和健康检查后再切换。恢复旧快照会缺少备份后的写入，须先决定如何保留或补回这些数据。不要把旧镜像直接启动在兼容性未知的生产卷上。

## npm 待审发布

更新 [`apps/launcher/package.json`](../apps/launcher/package.json) 的 `version` 后合入 `main`。[npm 工作流](../.github/workflows/release.yml) 检查版本，只为变更且未公开的版本自动在 macOS 上验证、打双架构包，再经 GitHub OIDC 运行 `npm stage publish`。版本未变或已公开时不提交待审。需要重试时，在 Actions 手动选择 `main`：默认仅验证并打包；核对 npm 尚无待审版本后，勾选 `stage` 才提交。安装包可从本次运行的 `steward-npm-package-*` 产物下载。

在 npm 将 `@yefengr/steward` 的 Trusted Publisher 绑定到 `yefengr/task-steward`、`release.yml` 和 `npm-release` 环境，取消允许直接 `npm publish`，不向工作流提供 npm Token。待审包不会成为 `latest`。维护者在 npm 的 **Staged Packages** 核对包、版本和 Actions 摘要中的源码提交；平台与扩展联动时，先核对线上平台已兼容该包，再用 2FA 批准。批准后核对公开 registry 中的版本和 `latest`。

### 首次对齐线上 0.2.1

1. 在 npm 确认 Trusted Publisher 配置并取消直接发布授权；确认旧流程没有正在发布的任务。先合入新的工作流，暂不纳入 `a8470af`，也不要批准平台上线。
2. 在维护者账户查 **Staged Packages**（也可用已认证的 `npm stage list @yefengr/steward`），再查公开 registry。公开 registry 返回 404 只能说明未公开，不能证明没有待审包。如果 `0.2.1` 已待审，或暂时无法确认，在 GitHub Actions 的仓库变量设 `STEWARD_NPM_HOLD_VERSION=0.2.1`；新工作流仍可验证和打包，但不会为该版本提交待审。若已有待审包，先核对它的来源和兼容性，不要重传或直接批准。
3. 让 `main` 纳入线上 `a8470af`，并保留该提交 ID 在 `main` 历史中，不把它 squash 或 rebase 成另一个提交。只追平仓库时不批准平台部署；保留构建和隔离预检证据。下次上线前再核对实际线上容器和 `main` 的祖先关系。
4. 手动运行取的是当时 `main` 上启动器清单里的版本。先确认它仍是要发的 `0.2.1`，并确认该版本既未待审也未公开，再解除版本暂停并勾选 `stage`；若已公开，流程会跳过。npm 的最终批准与平台上线分别操作。

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

### 在普通 Pi 会话中管理任务

先更新平台，再安装或升级到支持任务代管的 `@yefengr/steward`。已经配对的 Mac 不用重新配对，也不必启动后台服务。扩展与 `stew` 在同一个 npm 包里，不需要再用 `pi install` 安装一份。

1. 在安装 `stew` 时使用的终端运行 `printf '%s\n' "$(npm root -g)/@yefengr/steward/dist/extension.js"`，得到扩展的绝对路径。
2. 将这条路径追加到 Pi 用户设置 `~/.pi/agent/settings.json` 的 `extensions` 数组（如果不存在则新建该数组，保留其他设置）。不要把 Shell 表达式原样填入 JSON。
3. 重新打开 Pi。可以让它先列出项目，再查任务、创建待办或补充说明。新建任务不会自动执行；安排开始和验收仍在网页上操作。

普通 Pi 的工具复用电脑令牌，可读写同一平台上的任务清单。撤销这台 Mac 的电脑令牌后，自动接单和任务代管都会停用。使用自定义配对配置路径时，普通 Pi 也需要同一个 `STEWARD_CONFIG` 环境变量。

### 旧版和手动登记

1. 在私密终端使用 `docker compose exec platform node dist/admin.js machine:add <名称>`。该命令在交互终端只显示机器令牌一次，也允许从标准输入接收操作者提供的令牌。给 `docker compose` 加上部署时使用的 `--env-file` 和 `-f`。
2. 在 Mac 上完成锁文件安装和 `pnpm build`，从仓库根运行 `node apps/launcher/dist/index.js init`。新安装会生成 `~/pi-steward/config.json`，由操作者填写平台 Origin、机器令牌、项目绝对路径和名额。
3. 启动器可用 `run` 前台运行，或由操作者运行 `node apps/launcher/dist/index.js install` 安装用户级 LaunchAgent。`status` 检查本机状态，`uninstall` 停止并移除对应 LaunchAgent。
4. 在平台电脑页确认电脑在线且项目已登记。安排一项测试任务并在 Pi Reach 用显示名称找到会话。Mac 本机可用 `tmux -L steward ls` 查找会话。

撤销机器时使用同一管理入口运行 `machine:revoke <名称>`。回报、交付、返修等验收步骤见[首版实施方案](plans/active/20261119-first-version-implementation.md#123-真机验收宿主机-mac)。
