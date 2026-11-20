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

## 文档

`README.md` 是入口，[CONTEXT](docs/CONTEXT.md) 保存产品背景和术语。`docs/plans/` 保存设计、实施和验收依据，`docs/prototypes/` 保存界面评审材料。[ROADMAP](docs/ROADMAP.md) 维护已确定事项的唯一状态，[BACKLOG](docs/BACKLOG.md) 收录候选事项。
