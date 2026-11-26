# Task Steward 部署与 Mac 接入

本文是当前安装与运维入口，命令供已获相应授权的操作者使用；阅读文档或完成本地验证不授予部署、发布或修改公共运行时的权限。产品与会话规则见 [CONTEXT](CONTEXT.md)，当前模块见 [ARCHITECTURE](ARCHITECTURE.md)，各事项状态只看 [ROADMAP](ROADMAP.md)。

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

## 合并前检查

[PR 检查](../.github/workflows/ci.yml)对每个以 `main` 为目标的 Pull Request 运行 `pnpm verify` 和两个发布门禁测试，不访问部署凭据。首次启用时，先等 GitHub 出现 `verify` 检查结果，再在 `main` 的保护规则中要求通过 PR 合并、分支与 `main` 保持最新、`verify` 通过后才能合并。保护规则也应约束管理员，不允许强推或删除 `main`。选择 GitHub Actions 作为 `verify` 的检查来源。PR 可以修改它自己的工作流或测试，因此这类改动不能只看绿灯，还要审核实际跳过或新增了什么；有独立维护者时，为检查定义及脚本要求非作者审核。生产审批仍是合并后的独立操作，不设为 PR 必过项。

## 平台生产部署

网站和 API 随同一个 `linux/amd64` 镜像上线。[平台工作流](../.github/workflows/deploy.yml)在相关改动推送到 `main` 后验证代码、构建镜像，并用隔离的 SQLite 快照验证迁移、`/health` 和 `/pair`。运行摘要分别列出源码 SHA、归档里的单平台镜像配置摘要、构建器报告的镜像 ID 和归档 SHA-256。构建器 ID 用于在同一构建环境运行迁移预检；服务器校验单平台镜像配置摘要，不与构建器 ID 比较。**Artifacts** 保存镜像七天。需要只验证、不申请上线时，在 Actions 手动运行该工作流，选择 `main`，保持 `deploy` 未勾选。手动从其他分支运行会失败。

首次上线前，在 GitHub 仓库 **Settings → Environments → production** 添加 required reviewers，关闭管理员绕过，并将部署分支限制为 `main`。启用 Prevent self-review 时，操作人和审批人必须不同。把 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、经核实的 `DEPLOY_KNOWN_HOSTS` 放在该环境的 Secrets 中，不放在仓库级 Secrets。非默认 SSH 端口通过该环境的 `DEPLOY_PORT` 变量配置。服务器沿用 `~/pi-steward` 的 Compose 布局，应用环境文件和数据库不交给 GitHub。

### 限制生产部署密钥

切换到新工作流前，服务器管理员从已审查的版本把 `scripts/platform-deploy-ssh.sh`、`scripts/platform-image-archive.sh` 和 `scripts/deploy-platform.sh` 安装到 `/usr/local/libexec/steward/`。目录和脚本由 root 所有，部署账号可以读取和运行，但不能修改。这三个脚本有更新时，也要先更新服务器副本，再批准新候选。服务器沿用经典 Docker 镜像存储和现有 Compose 目录，需要 Bash、Docker、`docker-compose`、`flock`、`jq`、`gzip`、`tar` 和系统 SHA-256 工具。

把部署公钥在该账号 `authorized_keys` 中的原条目替换为以下格式，确保同一公钥没有另一条无限制记录。固定命令使用受信的系统 PATH；对部署账号确认 `PermitUserEnvironment no`，`AcceptEnv` 不允许 `PATH`、`BASH_ENV`、`ENV` 或 `DOCKER_*` 等改变命令行为的变量。管理员另用自己的 SSH 密钥维护服务器。

```text
restrict,command="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash /usr/local/libexec/steward/platform-deploy-ssh.sh" ssh-ed25519 <部署公钥> steward-deploy
```

用这把密钥验证 `ssh -T <部署别名> status` 只返回线上镜像 ID 和源码 SHA，无命令登录被拒绝。该密钥只可查询状态、上传候选归档和调用固定部署入口，但仍然能部署镜像，应按生产凭据保护。旧工作流不会使用这组命令；切换后不要重用旧候选。先确认新入口可用，再批准来自新工作流的候选。

准备通过后，在 Actions 核对摘要与镜像，再批准 `production`。审批配置缺失时不会连接生产。审批后上传本次构建的同一归档，不重新构建；上传前后都检查候选是否仍为远端 `main` 的最新提交，并要求线上提交是候选的祖先。服务器只暂存一份候选归档，归档上限为 512 MiB。归档校验通过后才加载镜像；在部署锁内复核加载后的镜像身份和线上容器是否已更换，再备份数据库、用实际备份的副本验证迁移，最后切换 Compose 并检查本机和公网的 API、网页。已经运行同一镜像 ID 时只检查健康，不重复切换。

### Actions 无法执行时

应急部署也要经过人工上线批准。先核对官方仓库的 Actions 运行确实来自 `main`，且构建与隔离迁移预检已通过；从那次运行下载对应归档。在已更新至当前 `main` 的仓库运行：

```bash
gh run download <run-id> --repo yefengr/task-steward --name <steward-platform-image-...> --dir ./release-image
bash scripts/update-platform.sh <SSH 别名> ./release-image <运行摘要中的完整源码SHA>
```

SSH 别名应使用配置了固定部署入口的密钥。应急命令不会从本机源码构建，也不能部署旧候选。不要在 Actions 正在部署时并行执行。

### 回滚与数据

记录部署日志中的 Compose 备份、SQLite 快照路径和前一镜像 ID。切换前预检失败时，原服务不变；切换后的健康检查失败时，不自动回滚。先确认库已迁移到哪一版，以及切换后有没有新写入。只有确认旧镜像能读取当前 schema 和数据时，才能考虑用原卷恢复旧镜像；否则先停止服务、保留当前卷，再从部署前快照建立新卷，核对关键记录和健康检查后再切换。恢复旧快照会缺少备份后的写入，须先决定如何保留或补回这些数据。不要把旧镜像直接启动在兼容性未知的生产卷上。

## npm 待审发布

更新 [`apps/launcher/package.json`](../apps/launcher/package.json) 的 `version` 后合入 `main`。[npm 工作流](../.github/workflows/release.yml) 检查版本，只为变更且未公开的版本自动在 macOS 上验证、打双架构包，再经 GitHub OIDC 运行 `npm stage publish`。版本未变或已公开时不提交待审。需要重试时，在 Actions 手动选择 `main`：默认仅验证并打包；核对 npm 尚无待审版本后，勾选 `stage` 才提交。安装包可从本次运行的 `steward-npm-package-*` 产物下载。

在 npm 将 `@yefengr/steward` 的 Trusted Publisher 绑定到 `yefengr/task-steward`、`release.yml` 和 `npm-release` 环境，取消允许直接 `npm publish`，不向工作流提供 npm Token。待审包不会成为 `latest`。维护者在 npm 的 **Staged Packages** 核对包、版本和 Actions 摘要中的源码提交；平台与扩展联动时，先核对线上平台已兼容该包，再用 2FA 批准。批准后核对公开 registry 中的版本和 `latest`。

### 版本暂停与历史切换

发布结果未知时，先由维护者查询 npm 的 **Staged Packages**（或已认证的 `npm stage list @yefengr/steward`）和公开 registry。404 只能说明未公开，不能证明没有待审包，不应直接重传或批准。需要暂停某个版本时，仓库变量 `STEWARD_NPM_HOLD_VERSION` 填待暂停的确切版本；验证与打包仍可运行。解除前重新核对目标版本、待审状态与兼容性。

早期 `0.2.1` 切换曾要求先对齐发布门禁，再让 `main` 保留 `a8470af` 的原提交关系。本地整合基线现已包含该提交，不再执行旧的「暂不纳入」步骤；这不证明旧待审版本或线上状态已核对。每次上线仍须比较实际线上源码与本次候选，不能拿历史版本号代替现场检查。npm 批准与平台上线始终分别授权。

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

撤销机器时使用同一管理入口运行 `machine:revoke <名称>`。首版验收标准与当时预验收快照保留在[已归档实施方案](plans/completed/20261119-first-version-implementation.md#123-真机验收宿主机-mac)，完成状态以 ROADMAP 为准，不为补文档重跑已确认的验收。

## 项目基准分支与验收后清理

平台、启动器和 Pi 扩展需配套升级；仅更新网页不能使旧启动器执行合并。旧扩展使用严格的响应校验，不能保证它在旧进程中读取新增字段；升级前先停止安排新任务，等待已有执行收尾，再按前文备份 SQLite 并保留 Mac 本地启动器状态，配套更新平台与执行端。已打开的网页刷新，Pi 按原生重载／重启流程加载新扩展，再恢复安排。迁移不为已有项目猜测默认分支，也不为旧交付补造 Git 快照。

1. 登记项目后，在任务台项目页打开 Git 设置，明确默认基准分支；已有项目也要补充确认。开工前同步上游默认开启，可以关闭。
2. 新建或编辑未开工任务时，可留空沿用项目默认，也可指定另一条基准分支。任务从该分支开始，验收后也合回它。首次领取时锁定已有的基准分支和同步选择，准备阶段同步后再记录起点提交；修改项目默认值不改变已开工任务。
3. 代码实现首次写入前，Pi 读取任务并调用 `steward_prepare_git`，按项目命名规范给出任务分支。同步开启且有上游时，程序先安全同步；没有上游记录跳过。认证、网络、分叉或既有改动导致失败时，先处理原因，不以强制重置继续。
4. 按准备结果给出的确切基线，使用 Pi 已有工作树能力创建、迁移，再在目标会话登记现场。没有可用工作树能力时暂停，不能退回主分支开发。交付须对应实际验证过的提交。
5. 用户在任务台验收指定交付。任务随后等待原 Mac 执行合并；离线时保留安排。若基准前进导致不能安全快进，回到原任务分支同步和修复，重新验证、交付和验收。
6. 合并成功后，启动器移除本任务工作树并删除任务分支。受阻时先查看任务详情原因；清理前确认未提交内容和占用，不手工强删目录。排除问题后使用任务台重试，已记录合并成功的任务只继续清理。

工作树干净状态沿用 Pi 原有移除能力和 Git 规则：受跟踪修改、未忽略的未跟踪文件会阻止交付或清理；已忽略的依赖、构建产物等随任务工作树移除。不要在任务工作树里存放需要长期保留文件的唯一副本；这些内容应另行保存。

本流程只执行本地 Git 操作，不自动推送、发布或部署。任务记录和原生会话历史保留，但已清理的任务工作树不再可用于恢复；如需新增修改，应从明确基线开始新任务，不能把历史会话恢复成仍拥有旧现场的假象。

## 会话定位与配套升级

工作树迁移后，Pi 应在实际目标会话读取任务并登记目录、分支和会话定位。返修复用上次交付的同机现场；找不到工作树或 JSONL 时先核对并暂停，不回退登记目录、不创建空会话。

网页的「重启 Pi 会话」「恢复原会话」要求原 Mac 在线、启动器支持且能验证精确目录和会话文件。成功后向原会话发送新消息继续；普通重启和恢复不会自动重放旧指令，返修才带入新反馈。离线时这两项操作不会排队执行，不能与可保留离线请求的「结束讨论」混为一谈。

平台、启动器和扩展的升级需配套核对；旧进程可能仍加载旧扩展，npm 已发布也不表示已运行新版。升级按用户实际安装前缀及 Pi 原生重载／重启流程操作，不为刷新版本直接关闭正式 tmux server。历史事故与配套边界见[会话恢复回归记录](plans/completed/20261124-session-locator-regression.md)。本地隔离测试不覆盖 LaunchAgent 安装升级或 Pi Reach 连接。
