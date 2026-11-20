# 首版实施方案：平台、启动器与 Pi 接入

记录日期：2026-11-19。评审记录见第 16 节，里程碑状态以 `docs/ROADMAP.md` 为准。

本文是[首版技术方案](20261112-initial-design.md)第 9.3 节第 2 步「首个可用版本」的实施方案，补齐其第 9.4 节中首版必须先定下的设计（数据表、状态转换、领取协议、回报字段、本机配置、访问认证、部署）。产品决策 D01–D25 以首版技术方案为准，本文不改动；两者冲突时先指出，由用户决定。

本文中的「建议」是实施前可以调整的技术选择，「已确认」指用户已拍板的内容。

## 0. 评审与实施方式

1. **先评审，后实施。** 评审者通读本文和首版技术方案，核对本文引用的事实（版本、Pi 扩展接口、tmux 行为、Node 内置 SQLite 的状态），把发现的问题写进第 16 节「评审记录」，每条写明依据、影响和建议改法。涉及产品决策或会改变范围的问题，先交用户决定，再动手。
2. **按里程碑实施（第 13 节）。** 每个里程碑在功能分支上完成，跑通该里程碑的验证后再进入下一个。每个里程碑可以单独提交；合并到 `main`、推送远程、部署到服务器，都需要用户另行授权。
3. **授权边界。**
   - 只修改本仓库。
   - 不改动 Pi Reach、agent-tools、ccx。
   - 安装或升级 Pi、tmux、Node 等宿主机工具前，先问用户。
   - 服务器地址、域名、反向代理等部署参数向用户索取，不自行猜测。
   - 访问密码、机器令牌只由用户本人设置或保存，不写进仓库、日志或对话。

## 1. 目标与范围

**目标**：在一台 Mac 和一台私人服务器上，跑通「记录 → 安排 → 自动领取 → Pi 工作 → 交付 → 验收或返修」整条路径。

**包含**：

| 部分 | 内容 |
| --- | --- |
| 平台 | 项目、任务、执行尝试、交付与验收的数据和接口；领取与租约；访问密码登录；机器令牌；托管前端静态文件；单个 Docker 镜像 |
| 启动器 | 读取本机配置，登记本机项目，按名额领取，在独立 tmux server 中启动 Pi，续租，报告启动与退出，响应取消；以用户级 LaunchAgent 托管 |
| Pi 任务扩展 | 读取任务背景，回报进展、问题、决定、交付；在交付已保存后才允许结束 |
| 前端 | 按[任务平台原型](../../prototypes/20261119-task-console/index.html)实现：登录、项目任务列表、任务详情（含验收与返修）、新建任务、电脑页面；中英双语 |
| 工程 | 单仓库多包、共用的接口定义包、自动化测试、项目规则文件、事项状态清单 |

**不包含**（按首版技术方案第 9.3 节放到后续步骤）：

- `steward` 命令行与个人访问令牌（第 3 步）；
- Claude Code 接入与 ccx 改造（第 4 步）。数据模型保留 Agent 类型字段，新建任务时 Claude Code 选项显示为"暂不支持"；
- Web Push 与 Service Worker（第 5 步）；
- 依赖、验收积压上限、多台 Mac 并用（第 6 步）。数据表允许登记多台电脑，但首版只按第 6.1 节的规则选电脑，不做跨机协调；
- 「需要我处理」首页、独立的任务编辑页、拖动排序、搜索与归档。首版在详情页用弹窗编辑任务，用项目列表作首页。「需要我处理」放到首版之后第一批加。

## 2. 工程结构

```
pi-steward/
├── apps/
│   ├── platform/        任务平台：HTTP 接口、领取与租约、托管前端；管理命令（添加电脑、备份）
│   ├── web/             管家 PWA（React + Vite + Mantine）
│   └── launcher/        Mac 启动器（Node 进程，LaunchAgent 托管）
├── packages/
│   ├── contract/        接口定义：zod schema、状态枚举、错误码；不依赖 Node 专用接口，前端可用
│   └── pi-extension/    Pi 任务扩展
├── docker/              平台镜像与 Compose 示例
├── docs/  spikes/
├── AGENTS.md  CLAUDE.md
└── package.json  pnpm-workspace.yaml  .node-version  .npmrc
```

包名统一用 `@pi-steward/<目录名>`。共享接口只改 `packages/contract`，其他包不复制定义。`contract` 与 Pi Reach 的 `packages/protocol` 规则一致：不引入 SDK、Node 专用接口、React 或连接生命周期。它用 `tsc` 编译到 `dist`，根目录的 `typecheck`、`test`、`build` 命令先构建它。

## 3. 技术与版本

版本与 Pi Reach（提交 `0230224`）对齐，复制过来的前端代码可以直接使用。依赖版本写成精确版本，公共版本放进 `pnpm-workspace.yaml` 的 catalog。

| 项目 | 取值 | 依据与说明 |
| --- | --- | --- |
| Node | `engines: >=24.20.0 <25`，`.node-version` 写 `24.20.0`；镜像 `node:24.20.0-alpine` | 与 Pi Reach、Relay 相同。宿主机 Mac 上是 24.22.3，ccx 容器里是 24.21.0，都满足 |
| pnpm | `packageManager: pnpm@11.20.0`，`.npmrc` 设 `strict-dep-builds=true` | 与 Pi Reach 相同，用 `corepack enable` 启用 |
| TypeScript | 前端 5.9.3，其余 6.0.3 | 与 Pi Reach 相同：前端用 `catalogs.pwa`，其余用默认 catalog |
| 测试 | Vitest 4.1.12 | 与 Pi Reach 相同 |
| 校验 | zod 4.6.6 | 与 Pi Reach 相同 |
| 前端 | React 19.2.4、Mantine 9.5.2、Vite 8.2.4、`@vitejs/plugin-react` 6.1.1、lucide-react、ESLint 9 | 照搬 Pi Reach 前端的组合。复制的主题文件是普通 CSS，不需要 Tailwind |
| 服务端框架 | **建议** Hono 4.13.x 加 `@hono/node-server`，请求校验用 `@hono/zod-validator` | 接口较多，需要路由、中间件、静态托管和 zod 校验。2026-11-19 npm 上的最新版是 hono 4.13.19、@hono/node-server 2.1.9、@hono/zod-validator 0.9.1，实施时核对后锁定精确版本。Pi Reach 的依赖覆盖要求 hono 不低于 4.13.5、@hono/node-server 不低于 1.19.15，选版本时满足这个下限 |
| 数据库 | **建议** Node 内置 `node:sqlite`（`DatabaseSync`） | 不需要编译原生模块，alpine 镜像更简单。ccx 容器内的 Node 24.21.0 能直接加载，不打印实验性警告，自带 `backup()`。它在 Node 24 文档中还不是稳定级，所以所有数据库访问都封装在 `apps/platform` 的一个薄层里，出问题时可以换成 better-sqlite3（当前 13.2.0），不影响业务代码。评审时请核对 Node 24 文档里的稳定性标注 |
| 迁移 | `apps/platform/migrations/NNNN-<主题>.sql` 加一个小的执行器，用 `PRAGMA user_version` 记录版本 | 首版技术方案规定不引入 ORM |
| Pi 扩展 | 开发依赖 `@earendil-works/pi-coding-agent` 1.5.2（与宿主机 Pi 一致），`typebox` 作为对等依赖 | 写法参考验证用的探针扩展和 Pi Reach 扩展 |
| 前端路由 | **建议**用轻量路由库（如 wouter），或者自己写 | Pi Reach 只有设置页一条路由，是自己写的；本项目有五个页面且带参数，用库更省事。评审时决定 |

## 4. 数据模型

项目用短标识作主键。`machine_projects`、`request_log` 用复合键，`web_sessions` 用随机会话值的哈希。其余标识按对应表使用 UUID。时间存成毫秒时间戳整数。打开文件库时设置 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `projects` | `id`（短标识，如 `pi-steward`）、`name`、`last_machine_id`、`created_at` | 由启动器心跳自动登记，见第 6.4 节；首版不提供新建项目的页面 |
| `machines` | `id`、`name`（唯一）、`token_hash`、`revoked_at`、`slots`、`last_seen_at`、`launcher_version`、`created_at` | `token_hash` 是令牌的 SHA-256；`slots` 以心跳上报为准 |
| `machine_projects` | `machine_id`、`project_id`、`local_path`、`updated_at` | 哪个项目登记在哪台电脑、本机路径是什么；每次心跳整体覆盖 |
| `tasks` | `id`、`project_id`、`title`、`goal`、`acceptance`、`notes`、`agent`（`pi`/`claude`）、`machine_id`（可空）、`status`、`rework_pending`、`position`、`created_by`（`user`/`agent`）、`version`、`created_at`、`updated_at` | `version` 用于并发修改检查，每次写入加一；`position` 是清单顺序，新任务取当前最大值加一，首版不提供调整入口 |
| `attempts` | `id`、`task_id`、`machine_id`、`agent`、`kind`（`new`/`rework`）、`session_id`、`tmux_session`、`claimed_at`、`started_at`、`lease_expires_at`、`cancel_requested`、`ended_at`、`exit_code`、`result`（`delivered`/`interrupted`/`cancelled`） | `ended_at` 为空表示尚未结束；同一任务同一时间最多一条未结束的尝试 |
| `deliveries` | `id`、`task_id`、`attempt_id`、`version`、`summary`、`done`、`not_covered`、`verification`、`how_to`、`issues`（均为 JSON 字符串数组）、`base_commit`、`commit`、`report_ref`、`review`（空/`accepted`/`rework`）、`feedback`、`reviewed_at`、`created_at` | `version` 在任务内从 1 递增；验收和返修都指向具体某一版 |
| `decisions` | `id`、`task_id`、`attempt_id`（可空）、`text`、`confirmed_by_user`、`created_at` | 区分 Agent 的建议和用户已确认的决定 |
| `progress` | `id`、`task_id`、`attempt_id`、`text`、`created_at` | 只追加，不修改 |
| `questions` | `id`、`task_id`、`attempt_id`、`text`、`context`、`status`（`open`/`resolved`/`withdrawn`）、`created_at`、`updated_at` | 任务有 `open` 的问题时，页面显示「需要回应」 |
| `task_events` | `id`、`task_id`、`actor`（`user`/`launcher`/`agent`）、`attempt_id`、`kind`、`payload`、`created_at` | 状态变化与修改记录，任务详情的执行记录从这里取 |
| `web_sessions` | `id_hash`、`created_at`、`expires_at` | 登录会话；Cookie 里只放随机值，库里存它的哈希 |
| `request_log` | `machine_id`、`request_id`、`response`、`created_at` | 启动器和 Agent 写请求的幂等记录，主键是 (`machine_id`, `request_id`)；保留 7 天 |

「待核对」不单独存字段，按 `ended_at` 为空且 `lease_expires_at < 当前时间` 当场算出，不需要后台定时任务。电脑「在线」也按 `last_seen_at` 距今不超过 45 秒当场算出。

## 5. 任务状态转换

主状态取值：`unscheduled` 未安排、`queued` 待领取、`running` 进行中、`review` 待验收、`done` 已完成、`interrupted` 已中断、`cancelled` 已取消。

| 动作 | 发起方 | 从 | 到 | 附带变化 |
| --- | --- | --- | --- | --- |
| 新建 | 用户 | — | 未安排 | 首版只有用户能新建；Agent 新建属于第 3 步 |
| 修改内容 | 用户 | 除已完成、已取消外 | 不变 | 必须带上 `version`，不一致时返回冲突 |
| 安排开始 | 用户 | 未安排 | 待领取 | 校验能确定执行电脑（第 6.1 节），否则拒绝并说明原因 |
| 撤回 | 用户 | 普通待领取 | 未安排 | 已排队的返修保留取消入口，撤销返修延后 |
| 领取 | 启动器 | 待领取 | 进行中 | 新建尝试，原子完成（第 6.2 节） |
| 提交交付 | Agent | 进行中 | 待验收 | 新增一版交付；尝试仍未结束，等 Agent 收尾退出 |
| 进程退出 | 启动器 | 进行中 | 已中断 | 仅当本次尝试没有交付；有交付时任务状态不变，尝试记为 `delivered` |
| 验收通过 | 用户 | 待验收 | 已完成 | 必须指明交付版本，且只能是最新一版 |
| 返修 | 用户 | 待验收 | 待领取 | 置 `rework_pending=1`，反馈写到被返修的那一版 |
| 重新安排 | 用户 | 已中断 | 待领取 | — |
| 取消 | 用户 | 未安排、待领取、待验收、已中断、进行中 | 已取消 | 如有未结束的尝试，一并标记 `cancel_requested`。启动器关闭对应 tmux 会话并上报退出，尝试记为 `cancelled` |

补充规则：

- 待验收任务的 Agent 进程可能还在收尾，这时用户就验收或返修是允许的。领取条件要求该任务没有未结束的尝试，所以返修不会和收尾中的旧进程同时运行。
- 平台只接受未结束尝试的新回报，任务已取消后也拒绝新的回报。已获授权的同一请求重放可以取回原结果。
- 每次状态变化都在同一事务里写一条 `task_events`。

## 6. 领取、租约与待核对

### 6.1 执行电脑

任务的执行电脑按顺序确定：

1. 任务指定了 `machine_id`，就用它。
2. 否则用项目的 `last_machine_id`。
3. 否则，如果项目只登记在一台电脑上，就用那台。
4. 以上都不满足时，不能安排开始，页面提示先指定电脑。

这对应 D08。指定的电脑离线时任务继续等待，不换电脑。

### 6.2 领取

启动器有空闲名额时调用领取接口。平台在 `BEGIN IMMEDIATE` 事务中：

1. 从 `queued` 任务中筛选出可由本机领取的：执行电脑是本机、项目登记在本机、任务没有未结束的尝试。
2. 按 `rework_pending` 降序、`position` 升序、`created_at` 升序排列，取第一项。
3. 新建尝试并设置租约，把任务改为 `running`，清除 `rework_pending`，把项目的 `last_machine_id` 更新为本机。
4. 记录 `request_log`，以便重发同一个 `requestId` 时返回同一结果。

**会话标识**：新任务用 `steward-<尝试编号>`。返修时沿用该任务在本机最近一次尝试的 `session_id`，`kind` 记为 `rework`；本机没有历史会话时按新会话处理。

**领取结果包含**：尝试编号、任务编号、项目标识、Agent 类型、会话标识、是否恢复原会话、尝试类型和显示名称。首条消息由启动器按第 8.2 节生成。

### 6.3 时间参数（建议）

| 参数 | 取值 |
| --- | --- |
| 心跳与续租间隔 | 15 秒 |
| 租约时长 | 90 秒 |
| 在线判定 | 最近 45 秒内有心跳 |
| 空闲时的领取间隔 | 跟心跳同一循环，每 15 秒一次 |

参数集中定义成常量，平台和启动器都从 `contract` 读取。

### 6.4 心跳

启动器每次心跳上报：启动器版本、名额、登记的项目（标识、名称、本机路径），以及本机记录的未结束尝试及其 tmux 会话是否仍在。平台据此：

- 更新电脑的 `last_seen_at` 和 `slots`，自动创建不存在的项目，整体覆盖 `machine_projects`；
- 对上报"仍在"的尝试续租；
- 返回每个尝试的处理指令：`continue` 或 `cancel`（用户已取消）。如果平台认为某个尝试未结束，启动器却没有上报它，返回 `unknown` 和对应 tmux 会话名，供启动器核对。确认会话不存在后，调用第 7.3 节的退出接口。

租约过期的尝试显示为「待核对」：不重新领取，不转给其他电脑，任务主状态不变。启动器重新上线并续租后，「待核对」自动消失；启动器上报退出后，按第 5 节处理。

## 7. 接口

全部接口在 `/api/v1` 下，收发 JSON。请求体和响应体都用 `contract` 中的 zod schema 校验。错误统一返回 `{ "error": { "code": "...", "message": "..." } }`。

| 错误码 | HTTP 状态 | 场景 |
| --- | --- | --- |
| `unauthorized` | 401 | 未登录，或令牌无效、已撤销 |
| `forbidden` | 403 | 凭据有效但无权操作，例如尝试不属于这台电脑 |
| `not_found` | 404 | 对象不存在 |
| `invalid_request` | 400 | 请求格式不符合 schema |
| `conflict` | 409 | 版本号不一致，或当前状态不允许该动作 |
| `attempt_ended` | 409 | 尝试已结束，或任务已取消 |
| `rate_limited` | 429 | 登录失败次数过多 |
| `internal_error` | 500 | 平台内部错误 |

### 7.1 三类凭据

| 调用方 | 凭据 | 范围 |
| --- | --- | --- |
| 浏览器 | 访问密码登录后得到的 Cookie：`HttpOnly`、`Secure`、`SameSite=Strict`，有效期 30 天 | `/api/v1/web/*` |
| 启动器 | `Authorization: Bearer <机器令牌>` | `/api/v1/launcher/*` |
| Agent | 机器令牌，加请求头 `X-Steward-Attempt-Id: <尝试编号>` | `/api/v1/agent/*`；平台核对该尝试属于这台电脑且尚未结束（D21） |

- 访问密码以 scrypt 哈希的形式放在环境变量 `STEWARD_ACCESS_PASSWORD_HASH` 中，用管理命令生成。
- 登录失败按来源 IP 限流：每分钟 5 次，计数放在内存里。
- 浏览器的写请求同时检查 `Origin` 必须等于平台地址，并且要求 `Content-Type: application/json`。
- 机器令牌格式为 `stm_` 加 32 字节随机数的 base64url，库里只存哈希。令牌由管理命令生成，只显示一次。

### 7.2 浏览器接口

| 方法与路径 | 用途 |
| --- | --- |
| `POST /web/auth/login`、`POST /web/auth/logout`、`GET /web/auth/me` | 登录、退出、查询登录状态 |
| `GET /web/projects` | 项目列表，附各状态任务数 |
| `GET /web/projects/:id/tasks` | 项目任务列表。待领取的任务附 `waiting` 字段，取值为 `machine_offline`、`slots_full`、`machine_unassigned`、`machine_project_unregistered`、`previous_attempt_active` 或 `null` |
| `POST /web/tasks` | 新建任务 |
| `GET /web/tasks/:id` | 任务详情：内容、决定、进展、问题、全部交付、尝试、执行记录；每次尝试附执行电脑、Agent 类型、会话标识、tmux 会话名 |
| `PATCH /web/tasks/:id` | 修改标题、目标、验收要求、说明、Agent 类型、执行电脑；带 `version` |
| `POST /web/tasks/:id/{schedule,unschedule,reschedule,cancel}` | 状态动作 |
| `POST /web/tasks/:id/accept` | 请求体为 `{ deliveryId }` |
| `POST /web/tasks/:id/rework` | 请求体为 `{ deliveryId, feedback }` |
| `GET /web/machines` | 电脑列表：在线状态、名额与占用、正在执行的任务、登记的项目、最后心跳时间 |

### 7.3 启动器接口

启动器的写请求都带 `requestId`（UUID），重发时返回第一次的结果。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /launcher/heartbeat` | 见第 6.4 节 |
| `POST /launcher/claim` | 领取；没有可领取的任务时返回 `{ "attempt": null }` |
| `POST /launcher/attempts/:id/started` | 请求体为 `{ requestId, tmuxSession, startedAt }` |
| `POST /launcher/attempts/:id/exited` | 请求体为 `{ requestId, exitCode, endedAt }`，`exitCode` 可以为空；按第 5 节决定任务状态 |

### 7.4 Agent 接口

Agent 的写请求同样带 `requestId`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /agent/context` | 本次任务的完整背景：标题、目标、验收要求、说明、已确认决定、历次交付与返修反馈、未解决的问题、尝试类型、工作区要求 |
| `POST /agent/progress` | 请求体为 `{ requestId, text }` |
| `POST /agent/questions` | 请求体为 `{ requestId, text, context }`，返回问题编号 |
| `PATCH /agent/questions/:id` | 请求体为 `{ requestId, status }`，`status` 取 `resolved` 或 `withdrawn` |
| `POST /agent/decisions` | 请求体为 `{ requestId, text, confirmedByUser }` |
| `POST /agent/deliveries` | 请求体为 `{ requestId, summary, done[], notCovered[], verification[], howTo[], issues[], baseCommit?, commit?, reportRef? }`，返回交付版本 |

## 8. Pi 任务扩展

### 8.1 加载与配置

- 启动器用 `-e <仓库路径>/packages/pi-extension/dist/index.js` 加载扩展。首版启动器和扩展都从本仓库的检出目录运行，不发布 npm 包。
- 扩展只在环境变量 `STEWARD_ATTEMPT_ID` 存在时注册工具；手工打开的 Pi 会话不受影响。
- 平台地址和机器令牌从本机配置读取，见第 9.1 节。

### 8.2 首条消息模板

启动器根据尝试类型选择固定的开工或返修指令。指令引导 Pi 先调用 `steward_task` 读取标题、目标、验收要求、决定和此前的返修反馈。按项目规则和任务授权工作，在关键节点调用 `steward_progress`，需要用户决定时调用 `steward_ask` 并在会话中等待。交付通过 `steward_deliver` 保存，收尾后调用 `steward_finish`。完整任务文本通过 Agent 接口传输。

### 8.3 工具

| 工具 | 对应接口 | 说明 |
| --- | --- | --- |
| `steward_task` | `GET /agent/context` | 读取完整背景 |
| `steward_progress` | `POST /agent/progress` | 回报进展 |
| `steward_ask`、`steward_question_update` | 问题的创建与更新接口 | 提出问题；按后续交流标记已解决或撤销 |
| `steward_decision` | `POST /agent/decisions` | 记录决定，注明是否已经用户确认 |
| `steward_deliver` | `POST /agent/deliveries` | 提交交付；成功后扩展在内存中记下"本次已交付" |
| `steward_finish` | — | 本次已交付时才调用 `ctx.shutdown()`；否则拒绝，并提示：没有交付不能结束，用户要放弃任务时，请用户在平台上取消或在 Pi 中直接退出 |

`steward_finish` 的这条限制来自首版技术方案第 9.2 节的验证结果：Pi 在没收到结束指令时也会自己调用退出工具。只靠提示词约束不可靠，所以直接在工具里拦住。

接口请求失败时，工具返回可重试的错误码和净化后的说明，请 Pi 稍后重试。Agent 的回报同步发送，符合首版技术方案第 5.3 节。

## 9. 启动器

### 9.1 本机配置

配置文件为 `~/.config/pi-steward/config.json`，权限 `600`，可以用环境变量 `STEWARD_CONFIG` 改路径。启动器和扩展共用这份配置。

```json
{
  "platformUrl": "https://steward.example.com",
  "machineToken": "stm_...",
  "slots": 1,
  "projects": [{ "id": "pi-steward", "name": "Pi Steward", "path": "/Users/me/Code/pi-steward" }],
  "pi": { "command": "pi", "extraArgs": [] },
  "path": ["/Users/me/.nvm/versions/node/v24.22.3/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
}
```

`path` 由安装命令按当前终端里 `pi`、`node`、`tmux` 的位置生成，这是首版技术方案第 9.2 节 P-1 验证得出的要求。配置读取时用 zod 校验，失败时给出明确的报错。

### 9.2 主循环

每 15 秒执行一次：

1. 先把本地待报告事件发给平台；平台确认保存后再从本地删除。
2. 核对本机记录的每个尝试的 tmux 会话是否还在。已不在的，记一条退出事件。
3. 发送心跳，执行平台返回的 `cancel` 指令。
4. 运行中的尝试数少于名额时请求领取；领到后启动 Pi，再上报 `started`。

本地状态保存在 `~/Library/Application Support/pi-steward/launcher-state.json`。发出领取请求前先记录 `requestId`，收到领取结果后先记录尝试和确定的 tmux 会话名。重启时重试未确认的请求，核对会话和待报告事件。写入采用临时文件加原子改名。

### 9.3 启动 Pi

使用独立的 tmux server `-L steward`，会话名为 `steward-<尝试编号>`：

```
tmux -L steward new-session -d -s steward-<尝试编号> -c <项目本机路径> \
  -e STEWARD_ATTEMPT_ID=<尝试编号> -e PATH=<配置的 path> \
  -- pi -e <扩展路径> --session-id <会话标识> -n <处理后的显示名称> -- <固定指令>
```

- 参数以数组形式传给 `execFile`。tmux 3.7c 的多参数模式直接执行子进程。调用 tmux 时还要给 `execFile` 设置包含 Pi、Node、tmux 目录的 `env.PATH`，使后台 pane 得到完整的搜索路径。显示名称按第 16 节第 04 条约束。
- 返修时用原 `--session-id` 在同一项目目录启动，已经验证可行（V4）。
- 不加 `-a`，验证显示测试项目不需要它。需要无人值守授权的项目，在 `pi.extraArgs` 里按项目配置。

### 9.4 取消、退出与重启

- 收到 `cancel` 指令时执行 `tmux -L steward kill-session`。验证 3-4 已确认强制关闭会触发 `session_shutdown`，且不会留下残留进程。
- tmux 会话不在了就视为退出。首版不取退出码，上报 `exitCode: null`。
- 启动器重启后读取本地状态，逐个核对 tmux 会话：还在的继续续租，不在的上报退出。不能只凭 PID 或超时下结论（首版技术方案第 5.3 节）。

### 9.5 命令与安装

启动器提供以下子命令：

| 子命令 | 作用 |
| --- | --- |
| `run` | 前台运行主循环，供 LaunchAgent 调用 |
| `init` | 生成配置模板并填入当前 PATH |
| `install`、`uninstall` | 写入或删除 `~/Library/LaunchAgents/dev.pi-steward.launcher.plist`，并用 `launchctl bootstrap` 或 `bootout` 加载、卸载 |
| `status` | 显示配置、在线状态、运行中的尝试 |

plist 设置 `RunAtLoad`、`KeepAlive`，日志写到 `~/Library/Logs/pi-steward/`。

## 10. 前端

### 10.1 从 Pi Reach 复制

来源：Pi Reach 提交 `0230224`，MIT 许可，Copyright (c) 2026 Jacob Moura。

复制的文件：

- `pwa/src/app/pwa-theme.css`（视觉 token）；
- `pwa/src/lib/ui/pi-reach-theme.ts`，改名为 `steward-theme.ts`，连同它依赖的 `motion-duration.ts`；
- `pwa/src/lib/ui/viewport-queries.ts`、`safe-area.ts`；
- `pwa/src/lib/i18n/` 的组织方式：`index.ts`、`locale.ts`、`messages/zh.ts`、`messages/en.ts`。文案按本项目重写。

复制时：

- 删去用不到的 token 和代码，不复制聊天与会话相关的代码；
- 在 `apps/web/THIRD_PARTY_NOTICES.md` 中记录来源提交、文件清单，以及 Pi Reach 的 MIT 许可全文；
- 不修改 Pi Reach 本身。

### 10.2 页面

以原型为评审依据：电脑端（宽度 ≥768px）用悬浮侧栏，手机端（宽度 <768px）用单栏加抽屉导航。

| 页面 | 首版内容 |
| --- | --- |
| 登录 | 访问密码；中英切换 |
| 项目任务列表（首页） | 按状态分组；待领取写明在等什么；已完成默认折叠；「需要回应」「待核对」标记 |
| 任务详情 | 独立页面。主操作随状态变化（安排开始、撤回、验收、返修、重新安排、取消），可用弹窗编辑。显示目标与约定、当前进展、需要处理、已有交付及历史版本、执行记录。提供执行电脑、会话标识和 tmux 会话名，便于在 Pi Reach 或终端找到会话 |
| 新建任务 | 只有标题必填；Agent 默认 Pi，Claude Code 显示为"暂不支持"；执行电脑默认"跟随上次使用" |
| 电脑 | 在线状态、名额占用、正在执行的任务、登记的项目 |

- 「在 Pi Reach 中打开」首版不做跳转，只显示会话名称供用户查找；精确深链是后续增强。
- 数据每 10 秒轮询一次，页面不可见时暂停。
- 只提供 Web App Manifest 和图标，不加 Service Worker，Service Worker 随 Web Push 一起做。
- 用户写的内容和 Agent 回报的内容在英文界面下原样显示，不翻译。

## 11. 部署

- **镜像**：`docker/platform.Dockerfile`，参照 Pi Reach Relay 的多阶段构建写法。构建阶段先构建 `contract` 和 `web`，再构建 `platform`，然后用 `pnpm deploy --prod` 产出运行文件，前端静态文件放进镜像。运行阶段用 `node` 用户，带 `/health` 健康检查。
- **持久化**：SQLite 数据库放在卷 `/data` 中。
- **环境变量**：`STEWARD_DATA_DIR`、`STEWARD_ACCESS_PASSWORD_HASH`、`STEWARD_PUBLIC_ORIGIN`（用于 Origin 检查和 Cookie）、`PORT`。本地测试可设置 `STEWARD_ALLOW_LOCAL_HTTP=1`，监听地址限回环。反向代理若会覆盖 `X-Steward-Client-IP` 为可信客户端地址，且平台端口仅由可信代理访问，可设置 `STEWARD_TRUST_PROXY_CLIENT_IP=1`，登录限流按该地址区分。
- **管理命令**：用 `docker compose exec platform node dist/admin.js <命令>` 执行：
  - `hash-password`：生成访问密码哈希；
  - `machine:add <名称>`：添加电脑，令牌只显示一次；
  - `machine:revoke <名称>`：撤销电脑令牌；
  - `backup <目标路径>`：用 `node:sqlite` 的 `backup()` 生成一致快照。定时备份交给服务器的 cron，首版只提供这个命令。
- **Compose**：`docker/compose.example.yml` 只作示例。真正的服务器配置、HTTPS 和反向代理沿用用户已有的环境，向用户索取参数后再写，不提交服务器地址等私人配置。

## 12. 验证

### 12.1 自动化

根目录提供 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`，以及把它们串起来的 `pnpm verify`。

| 包 | 至少覆盖 |
| --- | --- |
| `contract` | 每个 schema 的合法与非法样例 |
| `platform` | 用内存数据库加 Hono 的 `app.request` 测试：第 5 节转换表的每一行，包括不允许的动作返回 `conflict`；领取的排序与筛选；同一任务并发领取只有一方成功；同一 `requestId` 重发返回同一结果；用可注入的时钟测试租约过期后显示待核对、续租后恢复；三类凭据的越权访问；撤销后的令牌被拒绝；迁移在空库上能执行 |
| `launcher` | 用假 tmux 执行器和假平台测试主循环：领取、启动参数（重点核对参数数组和返修时的会话标识）、退出检测、取消、重启后的核对、待报告事件在平台失败时保留 |
| `pi-extension` | 参照 Pi Reach 的扩展测试，用模拟的 `ExtensionAPI` 测试：没有 `STEWARD_ATTEMPT_ID` 时不注册工具；没有交付时 `steward_finish` 拒绝；交付成功后才调用 `shutdown` |
| `web` | 类型检查、lint、构建；一条 Playwright 冒烟测试：登录 → 新建 → 安排开始 → 用接口模拟领取与交付 → 验收 |

### 12.2 端到端冒烟（无需真实 Pi）

启动器配置允许把 `pi.command` 换成测试脚本 `scripts/fake-agent.mjs`。这个脚本读取 `STEWARD_ATTEMPT_ID`，依次调用 Agent 接口回报进展和交付后退出。它在一台装有 tmux 的机器上跑通平台、启动器、tmux 和 Agent 接口之间的整条链路。ccx 容器里没有 tmux，这项冒烟在宿主机上运行；没有 tmux 时自动跳过，并在输出中注明。

### 12.3 真机验收（宿主机 Mac）

在一台 Mac 和服务器上按顺序确认：

| 编号 | 内容 | 通过证据 |
| --- | --- | --- |
| A1 | 部署 | 通过 HTTPS 打开 PWA 并登录；健康检查通过；容器重启后数据仍在 |
| A2 | 启动器安装 | `install` 后 LaunchAgent 运行；电脑页面显示在线；项目自动登记 |
| A3 | 自动领取 | 新建任务并安排开始，15 秒左右进入进行中；`tmux -L steward ls` 能看到会话；Pi Reach 能看到以任务标题命名的会话 |
| A4 | 回报 | 任务详情出现进展；Pi 提问后显示「需要回应」，在 Pi Reach 中回答后，Pi 把问题标为已解决 |
| A5 | 交付与结束 | Pi 提交交付后进入待验收；进程自行退出；名额释放 |
| A6 | 防误触 | 未交付时让 Pi 调用 `steward_finish`，被拒绝，进程不退出 |
| A7 | 返修 | 返修后任务优先领取，回到原会话，产生第 2 版交付；验收第 2 版后任务完成 |
| A8 | 中断与取消 | 在终端直接退出 Pi 后任务显示已中断，可以重新安排；进行中取消后 tmux 会话被关闭 |
| A9 | 离线与恢复 | 停掉启动器超过 90 秒后任务显示待核对；恢复后待核对消失 |

结果写在本节表格之后，新增「真机验收结果（日期，版本）」小节。

## 13. 里程碑

| 里程碑 | 内容 | 完成标准 |
| --- | --- | --- |
| M0 工程与规则 | 工作区、`contract` 包、根命令；`AGENTS.md`、`CLAUDE.md`；`docs/ROADMAP.md` 与 `docs/BACKLOG.md` | `pnpm verify` 在空骨架上通过 |
| M1 平台核心 | 迁移、数据访问层、第 5 节状态转换、第 7 节全部接口、管理命令 | 第 12.1 节平台部分的测试通过 |
| M2 启动器与扩展 | 第 8、9 节；假 Agent 脚本 | 第 12.1 节对应测试通过；第 12.2 节冒烟在宿主机通过 |
| M3 前端 | 第 10 节 | 第 12.1 节前端部分的测试通过；手机和电脑两种宽度下的截图与原型一致 |
| M4 部署与真机验收 | 第 11 节；第 12.3 节 | A1–A9 通过，或者如实记录未通过项及其原因 |

M1 完成后，M2 和 M3 可以并行。

## 14. 项目规则与事项状态

- **`AGENTS.md`**：记录目录与包的职责、根命令、验证要求、分支与提交规范、授权边界、文档职责。`CLAUDE.md` 只写一行 `@AGENTS.md` 引用它。
- **分支命名**：沿用 Pi Reach 的做法，`<类别>/<YYMMDD>-<主题>`，类别取 `feature`、`bugfix`、`chore`、`docs`。
- **提交信息**：`<type>(<scope>): <中文摘要>`，scope 取 `platform`、`web`、`launcher`、`extension`、`contract`、`deploy`、`docs`；跨多个包时省略 scope。
- **事项状态**：沿用 Pi Reach 的约定。`docs/ROADMAP.md` 是已确定事项的唯一状态来源，把首版的 M0–M4 登记进去，状态取 `待开始`、`进行中`、`待验收`、`阻塞`、`已完成`、`已取消`。`docs/BACKLOG.md` 放首版技术方案第 9.3 节第 3–7 步等候选事项，以及「需要我处理」首页。README 中「当前尚未建立事项状态表」的说明随之更新。
- **仓库没有远程**：本仓库目前没有配置远程仓库，CI 等建立远程时再加；在此之前，以本地 `pnpm verify` 为准。

## 15. 评审要点与已知风险

请评审时重点核对：

1. **`node:sqlite`**：在 Node 24 中的稳定性标注，以及在 `BEGIN IMMEDIATE` 事务和 WAL 模式下的行为。
2. **tmux 参数形式**：tmux 3.7c 的 `new-session` 收到多个参数时是否不经 shell 直接执行，以及 `-e` 设置的环境变量是否会传进 Pi 进程。
3. **Pi 1.5.2 的扩展接口**：`registerTool`、`ctx.shutdown()` 和工具参数写法，在 1.5.2 中是否与探针扩展一致。
4. **首条消息作为命令行参数**：长度和特殊字符是否有问题。如有，改为让 Pi 先读背景文件或调用 `steward_task`。
5. **`waiting` 字段**：首版只区分电脑离线、名额已满、未指定电脑三种原因，是否够用。
6. **会话 Cookie 的 `Secure` 属性**：生产模式固定开启。本机 HTTP 测试需显式启用，并绑定回环地址。

已知风险：

- **Pi 可能漏报交付就退出**：任务会进入已中断，不会被误判为完成；用户可以重新安排。
- **启动器依赖用户保持登录**：电脑休眠或退出登录期间不领取任务。这是首版技术方案已经接受的限制。
- **Agent 能读到机器令牌**：理论上可以代这台电脑领取任务或报告其他执行。这是首版技术方案第 6.1 节已经接受的代价，令牌泄露时撤销即可。

## 16. 评审记录

（评审者在此逐条追加：日期、问题、依据、影响、建议、处理结果。）

### 2026-11-20 首轮评审

本轮在 macOS 上用 Node 24.22.3、tmux 3.7c 和 Pi 1.5.2 验证。Pi 补测在独立的临时 tmux server 中加载现有探针，不提交模型请求。V1、V3、V4 的业务场景沿用首版技术方案第 9.2 节的记录。

#### 01. `node:sqlite` 可用，Node 24 的稳定性等级是候选发布

- **依据**　Node 从 24.15.0 起将模块标为 `1.2 — Release candidate`。在本机 24.22.3 上，文件库开启 WAL 后，第一条连接持有 `BEGIN IMMEDIATE` 时，第二条连接仍能读到提交前的数据，但无法取得写事务。提交后读取可见，`backup()` 生成的快照可重新打开读取。`:memory:` 的日志模式返回 `memory`。[Node 24.20.0 SQLite 文档](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html)
- **影响与建议**　保留 `node:sqlite` 和薄数据访问层，明确其稳定性等级。领取事务保持同步且短，事务中不等待网络。除了内存 API 测试，在 M1 加入临时文件库的双连接竞争、回滚和备份验证。M4 再验证 Alpine 镜像和持久卷。
- **处理结果**　建议采纳，待实施。

#### 02. tmux 多参数直接执行，`PATH` 要传给客户端进程

- **依据**　tmux 3.7c 本机手册写明，多参数形式直接执行，不走 `sh -c`。用 Node 收集子进程参数和环境，确认带空格的项目路径、多行中文、引号和字面 `$HOME` 保留，`-e STEWARD_ATTEMPT_ID=…` 到达子进程。只用 `-e PATH=…` 时，pane 实际拿到的是精简的客户端 `PATH`，Pi 未记录启动事件。给 `execFile` 的 `env.PATH` 一并补齐后，新建隔离 server 上的实际 Pi 探针记录了 `mode=tui`、执行编号和预期的会话 ID。
- **影响与建议**　保留参数数组。调用 tmux 时明确设置客户端环境中的 `PATH`，加入 Pi、Node 和 tmux 所在目录。继续用 session `-e` 传执行编号，并在配置路径被覆盖时明确传入 `STEWARD_CONFIG`。M2 用模拟 LaunchAgent 的精简环境验证，M4 再走实际 LaunchAgent 和 Pi Reach。
- **处理结果**　建议采纳，待实施。

#### 03. Pi 工具签名成立，退出和回报需要独立验证

- **依据**　Pi 1.5.2 随包扩展文档及仓库探针使用 `pi.registerTool({ name, label, description, parameters, execute })`。参数为 TypeBox schema，工具上下文是 `execute(toolCallId, params, signal, onUpdate, ctx)` 的第五个参数，结果含 `content` 和 `details`。TUI 的 `ctx.shutdown()` 请求会等 Agent 空闲后执行，再触发 `session_shutdown`。Pi 默认可并行调用工具。首轮 V1 已观察到模型主动调用过退出探针。[现有探针](../../../spikes/pi-launch/probe-extension.ts)
- **影响与建议**　扩展仅在有执行编号时注册。`steward_finish` 只依据当前尝试已确认的交付成功结果放行，测试交付失败、交付仍在请求中和误触退出。启动器以进程事实释放名额。回报失败时返回可重试的错误码和净化后的说明，避免原始响应和请求细节进入模型上下文、会话记录或日志。
- **处理结果**　建议采纳，待实施。

#### 04. 首条消息适合传固定指令，任务正文留在 API

- **依据**　V1 已用短文本自动开工。Pi 1.5.2 的 `dist/cli/args.js` 实测会把普通位置参数读为消息，Pi 自己的 `--` 可终止选项解析，开头是 `@` 时仍按文件参数解释。本机 tmux 3.7c 保留普通多行参数，但会把参数末尾分号裁掉。Node 的 `execFile` 拒绝内嵌 NUL，宿主机直接启动时 8 KiB 示例成功，1.1 MB 示例返回 `E2BIG`。本次没有测整条启动链的字节上限。
- **影响与建议**　首条消息固定为简短的开工或返修指令，要求先调用 `steward_task`。标题、目标、验收要求和返修反馈走 `/agent/context`。同步调整第 6.2、8.2、9.3 节的契约。`-n` 显示名从标题派生，设长度和字符约束，处理控制字符及 tmux 参数边界，完整标题仍在任务页显示。M2 验证长正文、中文多行、前导 `-`／`@`、末尾分号及返修背景。
- **处理结果**　建议采纳，待实施。

#### 05. 等待原因缺少「上次执行仍在收尾」

- **依据**　第 5 节允许旧进程未退出时返修，第 6.2 节禁止此时领取。第 7.2 节的 `waiting` 没有对应值。原型把空原因显示为可以领取，也展示了「返修，将优先领取」。[原型状态呈现](../../prototypes/20261119-task-console/index.html)
- **影响与建议**　旧执行仍存活时显示「等待上次执行退出」，失联时同时显示「待核对」。电脑未登记该项目时也要有明确提示。`waiting=null` 只表示当前没有已知的领取阻塞，返修优先从独立标记显示。电脑的占用数以未结束的本机执行事实计算，涵盖主状态已变成待验收或待领取、进程仍在收尾的情况。
- **处理结果**　建议采纳，待实施。

#### 06. 本地 HTTP 脱离生产 Cookie 配置

- **依据**　第 7.1 节要求 `Secure` Cookie 和精确 Origin 校验，第 15 节建议用环境变量关掉 `Secure`。第 11 节尚未指定反向代理如何提供可信的限流来源 IP。
- **影响与建议**　生产固定使用 HTTPS、`Secure` Cookie 和显式配置的公开 Origin。本地优先使用同源 HTTPS，HTTP 测试模式只允许显式启用并绑定回环地址。部署时根据实际代理配置可信来源 IP，覆盖 Cookie、Origin 和登录限流验证。密码哈希命令用交互式隐藏输入或标准输入，管理命令和日志过滤凭据。
- **处理结果**　建议采纳。真实反向代理配置在 M4 向用户索取。

#### 07. 从领取成功到启动落盘之间存在恢复缺口

- **依据**　第 6.2 节由平台先提交领取事务，第 9.2 节领到后才启动 Pi。两节未规定何时持久化领取请求标识和待启动记录。第 6.4 节又允许把本地缺记录的 `unknown` 直接视为退出，且退出接口实际在第 7.3 节。
- **影响与建议**　平台已领取但响应丢失时可能留下悬挂任务，Pi 已启动但本地记录丢失时可能报错退出。发请求前持久化同一 `requestId`，得到领取结果后先落盘尝试和确定的 tmux 目标再启动。重启先重放未确认的请求并核对隔离 server 中的精确目标。区分确认不存在和检查失败，本地缺记录本身只触发核对。增加领取响应丢失、启动前后崩溃、已结束尝试的迟到重放以及 tmux 查询失败测试。
- **处理结果**　建议采纳，待实施。

#### 08. 冻结 M1 数据约束和幂等规则

- **依据**　第 4 节的统一 UUID 与项目短标识、映射表及幂等表的复合键冲突。第 7 节承诺重发返回同一结果，但未规定请求绑定和验证顺序。第 5 节允许验收或返修发生在旧尝试退出前。
- **影响与建议**　列明各表主键类型，对每个任务最多一个未结束尝试、每个尝试最多一份交付、任务内交付版本唯一加数据库约束。幂等记录在同一事务写入，绑定调用方、操作、目标和请求内容。重放前核验身份和归属，经授权的同一请求返回原结果。退出报告只结算对应尝试，避免覆盖用户已验收、返修或取消后产生的状态。加入交付响应丢失、重复交付、验收与退出交错的测试。
- **处理结果**　建议采纳，待实施。

#### 09. 确认首个可用版本与产品决策的分期

- **依据**　D08、D09、D14、D16、D22、D24、D25 描述完整产品。首版技术方案第 9.3 节把 Agent 任务管理、Claude Code、Web Push、依赖、积压上限和多台 Mac 列在首个可用版本之后。实施方案第 6.1 节仍列出了多机选路，第 7.2 节却没有为项目登记关系变化定义提示。原型也包含已延期的「需要我处理」和依赖等场景。
- **影响与建议**　确认 M0–M4 以一台 Mac、Pi、用户通过网页安排和验收的闭环为范围。保留电脑和项目映射的数据结构，跨机行为留待后续验收。首版拒绝通过 API 新建或安排 Claude Code 的执行，页面保留禁用入口。M3 按原型的布局和首版场景对照，延期页面记入 BACKLOG。
- **处理结果**　确认按一台 Mac 与 Pi 的闭环实施，后续能力按既定顺序推进。

#### 10. 用户记录标题后如何补目标和验收要求

- **依据**　D01 和 CONTEXT 支持先记标题再补充。实施方案第 1 节排除任务编辑页，第 7.2 节又列出 `PATCH /web/tasks/:id`。原型的新建弹窗只有一处说明输入，详情的编辑操作仅弹提示。
- **影响与建议**　按现有范围先保留修改接口，在新建弹窗提供可选的目标、验收要求和说明。如果首版要支持先记标题再从网页补充，建议复用同一表单做详情页编辑弹窗，由用户决定是否纳入 M3。
- **处理结果**　M3 加入详情页编辑弹窗，复用新建表单。

#### 11. 明确返修撤回和收尾时取消的行为

- **依据**　第 5 节允许待领取任务撤回并清掉 `rework_pending`，但被返修的交付已标记并写入反馈，重新安排可能把这次返修变成普通执行。取消只对「进行中」设置取消标记，但「待验收」和返修后的「待领取」也可能有未退出的进程。原型详情只在「已中断」显示取消按钮，M4 的 A8 要验证进行中取消。
- **影响与建议**　建议普通待领取保留撤回，已排队的返修首版保留取消入口，将撤销返修延期。任务在允许取消的状态下若还有活动尝试，一并请求结束该尝试。详情页提供与转换表一致的取消入口和确认提示。
- **处理结果**　采纳建议，规则已写入第 5 节。

#### 12. 功能分支需要带入已评审的文档基线

- **依据**　本机 `main` 在 `5b010f5`，原型提交 `392b1d1` 只在 `docs/task-console-prototype`。实施方案目前未跟踪，README、首版设计和探针说明有工作区修改。Pi Reach 的 `0230224` 可读，第 10.1 节列出的基础文件齐全，来源 `LICENSE` 含两行版权声明。
- **影响与建议**　从 `main` 新建功能分支时，先在隔离工作树将当前方案、评审记录、原型及对应文档带入功能分支，再开始 M0，保留原工作区。M3 从指定提交复制第 10.1 节的基础文件，完整保留 `LICENSE` 两行版权声明及 MIT 条款。已核对 Pi Reach 的 Node、pnpm、React、Mantine、Vite 等基线，M0 锁定新增依赖时再核实 Registry 可解析版本。
- **处理结果**　按用户要求先合入本地 `main`，再从 `main` 创建实施分支。

#### 13. 前端需要支持直接重开任务详情

- **依据**　原型项目和任务详情有各自的带参数地址。实施方案第 3 节还未选定路由方式，第 11 节只有静态文件托管说明。
- **影响与建议**　选用轻量路由库（建议 wouter），让路径承载项目与任务标识。Hono 对已定义的页面路径提供 SPA 入口，API 和静态资源各自返回准确的错误。M3 验证直接打开任务详情、登录后回到原任务和浏览器刷新。
- **处理结果**　建议采纳，待实施。
