# 当前架构与模块边界

本文保存当前代码的结构与运行链路，承接已结束的首版方案中仍有效的架构事实。产品含义见 [CONTEXT](CONTEXT.md)，事项及验收状态只看 [ROADMAP](ROADMAP.md)，安装和运维操作见 [DEPLOYMENT](DEPLOYMENT.md)。合入仓库不代表已发布或已部署。

## 1. 系统边界

Task Steward 是任务台账与 Mac 启动器，不是中心 Agent。平台不接模型、不托管 Agent 进程，也不读取对话推断任务完成。模型、项目规范、源码、Git 工作区和 Pi 原生会话留在执行 Mac。

- 浏览器通过 HTTPS 访问同一个平台进程提供的 API 与静态网页。
- Mac 启动器主动向平台心跳、领取、续租和报告退出，无需开放 Mac 公网端口。
- 启动器在独立的 tmux server `steward` 中启动交互式 Pi。Pi 扩展直接向平台读取任务与回报。
- 对话仍在 Pi Reach 或本机终端完成。任务链路不替代 Pi Reach 的配对、Relay 和会话存储。
- 当前执行端只接 Pi。Claude Code、Web Push、依赖调度与验收积压门禁仍是 [BACKLOG](BACKLOG.md) 中的候选，不能从旧方案的完整产品设计推定已实现。

## 2. 模块及直接消费者

| 模块 | 当前职责 | 直接消费者或运行入口 |
| --- | --- | --- |
| `packages/contract` | Zod schema、任务状态、错误码、时间参数与本机配置；保持浏览器可用 | platform、web、launcher、platform-http、pi-extension |
| `apps/platform` | Hono API、访问认证、配对、任务管理、领取与租约、讨论控制、会话操作、SQLite 与静态前端 | 浏览器、launcher、Pi 扩展；`dist/index.js` 与 `dist/admin.js` |
| `apps/web` | React / Vite / Mantine 控制台；登录、项目、任务、电脑与配对页面，中英切换 | platform 托管构建产物；浏览器执行 |
| `packages/platform-http` | 平台 HTTP 传输；macOS 系统代理交给 Swift / URLSession，其他模式使用 Node | launcher、pi-extension；不是浏览器依赖 |
| `apps/launcher` | `stew` CLI、配对、项目登记、LaunchAgent、tmux 生命周期、本机状态与恢复 | Mac 用户、LaunchAgent；与扩展共同打入 npm 包 |
| `packages/pi-extension` | 普通 Pi 查、建、改任务；绑定执行时注册背景、现场、回报、讨论与收尾工具 | Pi；由启动器加载，或由用户在普通会话配置 |

根 workspace、各包 `package.json` 和 contract 是接口及依赖真源，不在文档复制完整 schema。contract 先编译到 `dist`；platform-http 构建 macOS 原生辅助程序，故根 `typecheck`、`test` 也有构建前置。开发环境见 [README](../README.md#本地开发)。

## 3. 执行、交付与验收

1. 用户或普通 Pi 记录待办，不自动安排开始。当前任务类型为实现（默认）或讨论；安排、取消、验收及返修由用户在工作台操作。
2. 平台在事务中为合适的在线电脑领取任务，生成带租约的执行尝试。返修优先，且同一任务的旧尝试未结束时不能再次领取。电脑选路与等待原因由平台判断，不由模型猜测。
3. 启动器先保存请求标识和待启动状态，再创建精确的 tmux 目标。固定首条消息要求 Pi 读取完整任务；任务正文与反馈走 API，不拼入命令行。
4. Pi 按项目规则与本次授权工作，回报进展、问题、决定和交付。项目原有记录仍应按授权更新，Steward 不能成为第二套项目状态真源。
5. 已保存交付使任务进入待验收，用户只能验收最新交付版本。现有实现要求 Agent 收尾并请求退出；启动器确认进程退出后结算尝试和释放名额。等待用户回复时进程仍占用名额。
6. 无交付退出记为中断；取消、退出报告和用户验收分别处理，迟到报告不覆盖新状态。租约过期显示待核对，不凭断线重派任务。

任务主状态是未安排、待领取、进行中、待验收、已完成、已中断、已取消；需要回应与待核对是附加信息，不是额外主状态。交付、验收、Git 合并、npm 发布及平台上线是不同事实。

### 讨论与提醒

讨论不会因为回合结束、已经有结论或暂时没有回复而自动交付。用户在原 Pi 会话发送「结束讨论」，或在工作台点击「结束讨论」；平台确认结束请求后，Pi 才整理结论和未决事项、保存交付并退出。工作台请求可在执行电脑离线时保留，恢复连接后处理。

两种任务都只有在 Pi 用 `steward_ask` 提出明确问题并等待回复满三分钟后，才显示一次工作台提醒。原会话收到回复会撤下提醒，但不自动解决问题；打开会话不算回复，普通聊天不触发提醒，也不向平台同步聊天内容。

### 工作现场与会话恢复

Git 实现默认使用独立分支与工作树，保留原目录的未提交改动；只读任务不创建工作树。Pi 在实际目标会话登记目录、Git 分支和原生会话定位，迁移后重新确认。返修基于被返修交付的同机实际定位恢复；现场缺失或不匹配时停止并确认，不猜测其他会话或创建替代现场。

用户可手动重启仍在运行的 Pi，或恢复已退出的原会话；要求原 Mac 在线、启动器支持且精确目录与会话文件可用。普通重启／恢复不重放开工指令，返修则带入新反馈。重新安排是新执行，不等同于恢复原对话。历史事故与隔离回归范围见[会话恢复回归记录](plans/completed/20261124-session-locator-regression.md)。

## 4. 数据、身份与故障边界

- 平台以 Node 内置 SQLite、SQL 迁移及 `PRAGMA user_version` 管理持久数据，文件库启用 WAL；数据库访问封装在 platform。迁移以 `apps/platform/migrations/` 为准，备份与回滚见部署文档，不凭旧表格手工改生产库。
- 浏览器使用密码登录和受保护 Cookie；写请求验证 Origin。启动器使用本机机器令牌；执行回报还绑定当前尝试，普通任务管理只使用机器令牌。令牌、密码与模型认证不进入仓库或提示词。
- 写请求用稳定请求标识做幂等回放；授权、归属和版本冲突仍须检查。请求结果未知时沿用原参数重试，不能当作从未写入。
- 启动器的本机状态、未确认事件与会话定位用于重启核对；tmux 查询失败不等于会话已经退出。已保存交付不因一次网络故障撤回。
- Mac 必须保持用户登录和可运行状态；不承诺休眠、退出登录时继续执行或自动唤醒。普通手工 Pi 不参与自动领取和名额统计，但可在用户授权下管理任务。

## 5. 前端复用与历史材料

前端消费公开的 `@yefengr/pwa-foundation`；精确版本以 `apps/web/package.json` 和锁文件为准。公共主题、控件、表面、安全区、动效和字号读取不在本仓库维护第二份设计系统；宿主仍负责业务状态、Provider / Portal 作用域、路由、草稿、busy 门禁和弹窗退出回焦。

公共设计与消费说明见包内 [DESIGN.md](https://github.com/yefengr/pi-reach/blob/main/packages/pwa-foundation/DESIGN.md) 与 [README](https://github.com/yefengr/pi-reach/blob/main/packages/pwa-foundation/README.md)。历史复制来源和完整许可保留在 [THIRD_PARTY_NOTICES](../apps/web/THIRD_PARTY_NOTICES.md)。

[首版设计](plans/completed/20261112-initial-design.md)与[实施方案](plans/completed/20261119-first-version-implementation.md)保留原决策、分期、评审和验收依据；其中旧版本、未实现设想及旧安装命令不再作为当前操作入口。`docs/prototypes/` 是历史界面评审材料，`spikes/` 是预研证据，不代表当前实现。后续变更更新本文及对应长期文档，事项状态只更新 ROADMAP。
