# Task Steward 项目协作指南

## 职责与入口

- `apps/platform`：任务、领取、租约、回报、访问认证和 SQLite，由同一个进程托管 API 与静态前端。
- `apps/web`：React 任务控制台，中英切换、桌面与移动布局；消费公开 PWA 基础包，保留业务状态、路由与草稿管理。
- `apps/launcher`：macOS CLI、配对与项目登记、LaunchAgent、独立 tmux server 中的 Pi 启停、租约与会话恢复。
- `packages/contract`：共享接口的 Zod schema、状态、错误码和本机配置；直接消费者为 platform、web、launcher、platform-http、pi-extension。保持浏览器可用，不引入 Node 专用接口、React、Pi SDK 或连接状态。
- `packages/platform-http`：launcher 与 pi-extension 共用的平台 HTTP 传输；macOS 系统代理模式使用 Swift 原生组件，直连与显式代理使用 Node 传输。不供浏览器或平台服务端依赖。
- `packages/pi-extension`：普通 Pi 的任务查、建、改；已绑定执行的任务背景、现场登记、回报、讨论控制和收尾。

当前模块与链路见 [ARCHITECTURE](docs/ARCHITECTURE.md)。历史范围、评审与首版验收依据见[已归档的首版实施方案](docs/plans/completed/20261119-first-version-implementation.md)，不以历史目录或版本代替当前代码。

## 开发和验证

所有开发命令从仓库根目录运行。Node 与 pnpm 版本以 `.node-version`、根 `package.json` 的 engines/packageManager 为准；先运行 `pnpm install --frozen-lockfile`。macOS 构建 platform-http（包括 `typecheck`、`test` 的前置构建和 `verify`）需要 Xcode 或 Xcode Command Line Tools，使用系统 `xcrun`、Swift、`lipo` 与 `codesign`；不要绕过原生组件构建来声称验证通过。

`pnpm typecheck`、`pnpm test` 会先构建 contract 与 platform-http；`pnpm build` 按依赖顺序构建全部包，`pnpm lint` 独立执行。直接运行子包测试前，先确保其依赖已构建。提交前运行 `pnpm verify`，修改后执行 `git diff --check`。改 contract 时验证所有直接消费者，改 platform-http 时验证 launcher 与 pi-extension。额外冒烟与前置条件见 [README](README.md#本地开发)；隔离回归不替代真实 LaunchAgent、Pi Reach 或正式部署验收。

## Git 与授权

- 分支用 `<类别>/<YYMMDD>-<主题>`，类别取 `feature`、`bugfix`、`chore`、`docs`。
- 提交用 `<type>(<scope>): <中文摘要>`。scope 取 `platform`、`web`、`launcher`、`extension`、`contract`、`deploy`、`docs`，跨包时省略。
- 合并 `main`、推送和部署需用户另行授权。安装或升级宿主机工具前先确认。访问密码和机器令牌由用户设置，避免进入仓库、日志、对话或命令行参数。
- 改动限本仓库。Pi Reach、agent-tools 和 ccx 保持只读。前端优先消费已锁定的公开基础包；历史复制范围见[首版实施方案第 10.1 节](docs/plans/completed/20261119-first-version-implementation.md#101-从-pi-reach-复制)，保留 [THIRD_PARTY_NOTICES](apps/web/THIRD_PARTY_NOTICES.md) 中的来源与完整 MIT 许可，不借复用扩大外仓写入。

## Pull Request 审查

本仓库使用 Dot 做 GitHub PR 代码审查，不再用 `@codex review` 触发此流程。

- **自动审查**：新开非草稿 PR 时审查完整改动。向打开的非草稿 PR 推送新提交时，优先审查新增改动，并复查之前指出的问题；草稿、仅由草稿转为正式、普通评论等不触发审查。不主动补审旧 PR。
- **手动复审**：需要按需复审时，由维护者使用 `yefengr` 账号在该 PR 的 **Conversation** 中新发一条正文仅为 `@dot review` 的顶层评论。Dot 重审当前版本的完整改动，即使该版本已经自动审过。其他账号、行内评论或编辑已有评论不触发；协作 agent 不代发口令。
- **审查输出**：在对应代码行发表评论，语言跟随 PR 标题和描述。只报告有证据、值得修的问题，说明触发条件、影响和建议；同一问题不重复发布，无发现则不发评论。Dot 不修改代码、不提交批准或要求修改，也不合并 PR。
- **合并判断**：没有 Dot 评论不代表审查完成或通过；Dot 不替代仓库现有的 CI 检查和维护者的合并判断。

## 文档

`README.md` 是入口，[CONTEXT](docs/CONTEXT.md) 保存产品背景与术语，[ARCHITECTURE](docs/ARCHITECTURE.md) 保存当前模块边界与链路，[DEPLOYMENT](docs/DEPLOYMENT.md) 保存部署、接入与运维操作。[ROADMAP](docs/ROADMAP.md) 是已确定事项及状态的唯一权威来源，[BACKLOG](docs/BACKLOG.md) 只收录候选事项。Steward 是辅助工具，回报不替代项目要求的记录更新，写入仍受本次授权约束；只读任务不擅自改记录。

`docs/plans/active/` 只放未结束方案；结束时先提炼仍有效的事实，再移入 `completed/` 并迁移直接引用。历史方案、`docs/prototypes/` 与 `spikes/` 保留设计和预研证据，不代表当前实现或状态。`.task-context.md` 只作对应会话的临时恢复材料，不入长期状态体系，不覆盖其他会话仍使用的材料。
