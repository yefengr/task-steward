# Task Steward 项目协作指南

## 职责与入口

- `apps/platform`：任务、领取、租约、回报、访问认证和 SQLite，由同一个进程托管 API 与静态前端。
- `apps/web`：按任务控制台原型实现网页，支持中英切换。
- `apps/launcher`：Mac 上的启动器，负责通过独立的 tmux server 启停 Pi，并报告会话状态。
- `packages/contract`：共享接口的 Zod schema、状态和错误码。保持浏览器可用，不引入 Node 专用接口、React、Pi SDK 或连接状态。
- `packages/pi-extension`：Pi 任务工具，负责读取任务背景和回报本次执行。

实现分期和验收要求见 [首版实施方案](docs/plans/active/20261119-first-version-implementation.md)。目录随里程碑落地。

## 开发和验证

从仓库根目录运行 `pnpm install --frozen-lockfile` 安装锁定依赖。Node 和 pnpm 版本以 `.node-version`、`package.json` 为准。使用 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 分别检查，提交前运行 `pnpm verify`。改动共享接口时同步验证其直接使用者。涉及真实 tmux、LaunchAgent 或 Pi Reach 的场景按对应里程碑在 Mac 验证。

## Git 与授权

- 分支用 `<类别>/<YYMMDD>-<主题>`，类别取 `feature`、`bugfix`、`chore`、`docs`。
- 提交用 `<type>(<scope>): <中文摘要>`。scope 取 `platform`、`web`、`launcher`、`extension`、`contract`、`deploy`、`docs`，跨包时省略。
- 合并 `main`、推送和部署需用户另行授权。安装或升级宿主机工具前先确认。访问密码和机器令牌由用户设置，避免进入仓库、日志、对话或命令行参数。
- 改动限本仓库。Pi Reach 仅按实施方案第 10.1 节复制指定的前端基础，完整保留来源 MIT 许可。Pi Reach、agent-tools 和 ccx 保持只读。

## Pull Request 审查

本仓库使用 Dot 做 GitHub PR 代码审查，不再用 `@codex review` 触发此流程。

- **自动审查**：新开非草稿 PR 时审查完整改动。向打开的非草稿 PR 推送新提交时，优先审查新增改动，并复查之前指出的问题；草稿、仅由草稿转为正式、普通评论等不触发审查。不主动补审旧 PR。
- **手动复审**：需要按需复审时，由维护者使用 `yefengr` 账号在该 PR 的 **Conversation** 中新发一条正文仅为 `@dot review` 的顶层评论。Dot 重审当前版本的完整改动，即使该版本已经自动审过。其他账号、行内评论或编辑已有评论不触发；协作 agent 不代发口令。
- **审查输出**：在对应代码行发表评论，语言跟随 PR 标题和描述。只报告有证据、值得修的问题，说明触发条件、影响和建议；同一问题不重复发布，无发现则不发评论。Dot 不修改代码、不提交批准或要求修改，也不合并 PR。
- **评审意见处理**：合并前逐条处理 Dot 提出的具体问题。采纳的意见应修复；不采纳的意见应在对应评审评论下简要说明理由，不要只点 Resolve。若决定延期，说明原因并链接跟踪 issue。没有指出问题的评审回执不必回复。
- **合并判断**：没有 Dot 评论不代表审查完成或通过；Dot 不替代仓库现有的 CI 检查和维护者的合并判断。

## 文档

`README.md` 是入口，[CONTEXT](docs/CONTEXT.md) 保存产品背景和术语。`docs/plans/` 保存设计、实施和验收依据，`docs/prototypes/` 保存界面评审材料。[ROADMAP](docs/ROADMAP.md) 维护已确定事项的唯一状态，[BACKLOG](docs/BACKLOG.md) 收录候选事项。
