# Task Steward — 跨电脑 Agent 任务管家

Task Steward 是面向个人的任务清单与执行协调系统。你在工作台安排任务，项目所在 Mac 自动领取并启动 Pi；你在原 Pi 会话交流，在任务记录中查看进展、交付和验收。平台不接模型、不托管 Agent 进程，源码和工作现场留在执行电脑。Claude Code 接入仍在规划中。

## 当前范围

首版平台、网页、Mac 启动器和 Pi 接入已完成，Mac 真机验收已获用户确认。后续迭代的交付、用户验收、合并、发包和部署分别记录，准确状态只看 [ROADMAP](docs/ROADMAP.md)，不能从本地测试通过推定线上版本。

当前代码支持实现／讨论任务、明确提问后的回复提醒、普通 Pi 任务代管、实际工作现场登记与会话重启／恢复。讨论由用户主动请求结束；提醒仅在明确等待回复满三分钟后显示。依赖调度、验收积压门禁、Web Push 和 Claude Code 仍是候选，不是当前能力。使用边界见 [CONTEXT](docs/CONTEXT.md)。

## 文档入口

| 文档 | 职责 |
| --- | --- |
| [CONTEXT](docs/CONTEXT.md) | 产品背景、术语、当前使用路径与权限边界 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 当前模块、直接消费者、执行及会话链路 |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | 安装、配对、部署、发布、备份与恢复 |
| [ROADMAP](docs/ROADMAP.md) | 已确定事项及状态的唯一权威来源；Steward 仅作辅助 |
| [BACKLOG](docs/BACKLOG.md) | 尚未确认开发的候选事项 |
| [首版设计](docs/plans/completed/20261112-initial-design.md)、[首版实施方案](docs/plans/completed/20261119-first-version-implementation.md) | 历史产品决策、评审、分期与验收依据，不作当前操作入口 |
| [会话恢复回归记录](docs/plans/completed/20261124-session-locator-regression.md) | 历史事故、人工恢复参照与隔离验证边界 |
| [任务控制台原型](docs/prototypes/20261119-task-console/index.html)、[Pi 启动预研](spikes/pi-launch/README.md) | 历史界面评审与真机预研材料，不冒充当前实现 |

## 本地开发

所有命令从仓库根目录执行：

- 使用 Node 24.20.0 或同一 Node 24 系列的更高版本、pnpm 11.20.0；版本真源为 `.node-version` 与根 `package.json`。
- macOS 上需要已安装 Xcode 或 Xcode Command Line Tools。`platform-http` 会用 `xcrun`、Swift、`lipo`、`codesign` 构建双架构原生 HTTP 辅助程序；这也是根 `typecheck`、`test` 和 `verify` 的前置，不只打包时才需要。
- 运行启动器／Pi 冒烟还需要 `tmux`、`git`，真实 Pi 冒烟需要已有的 Pi 可执行文件。浏览器测试使用已安装的 Google Chrome，也可通过 `STEWARD_TEST_CHROME` 指定已有兼容浏览器路径，见 `apps/web/playwright.config.ts`。

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 依次执行全量构建、类型检查、lint 和各包测试。分开检查可运行 `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test`；其中 `typecheck` 与 `test` 均先构建 contract 和 platform-http。直接跑子包测试前也须先构建依赖，不能把缺少 `dist` 当作代码回归。

完成构建后按改动风险选择额外验证：

| 命令 | 覆盖与边界 |
| --- | --- |
| `node scripts/smoke-launcher.mjs` | 隔离平台、假 Agent 与 tmux 的领取／交付／返修链路；没有 tmux 会跳过，不等于通过 |
| `pnpm --filter @pi-steward/web test:e2e` | 隔离平台上的真实浏览器任务流程、布局与交互 |
| `node scripts/smoke-launcher.mjs --real-pi <Pi绝对路径>` | 真实 Pi 的两种讨论结束入口；独立 tmux、本机平台、确定性测试模型，不调用远端模型 |
| `node scripts/smoke-session-locator.mjs <Pi绝对路径>` | 真实 Pi 工作树迁移后的重启、恢复、返修及现场缺失；覆盖边界见[回归记录](docs/plans/completed/20261124-session-locator-regression.md) |

这些隔离测试不替代 LaunchAgent 安装升级、Pi Reach 连接和正式部署验收，也不要求为补文档重跑已完成的验收。发布与 Mac 接入操作只使用 [DEPLOYMENT](docs/DEPLOYMENT.md)，未经授权不推送、发布或部署。

## 前端公共规范

网页精确消费公开 npm `@yefengr/pwa-foundation`，版本以 `apps/web/package.json` 和锁文件为准，不另维护公共设计规范。共享颜色、字体、间距、表面、确认顺序、关闭回焦与可访问性引用包内 [DESIGN.md](https://github.com/yefengr/pi-reach/blob/main/packages/pwa-foundation/DESIGN.md)，消费方法见包 [README](https://github.com/yefengr/pi-reach/blob/main/packages/pwa-foundation/README.md)。DESIGN.md 自 `0.0.3` 随包分发；旧版 `0.0.2` 不含此文档，不回写旧发布制品。

宿主负责 Provider 与真实 Portal 作用域、按布局生成确认区 DOM、Modal 关闭生命周期、busy 门禁和有效焦点后备。任务表单与确认入口保持既有关闭／草稿保护；品牌、业务状态映射、权限／API、路由／history、任务草稿的内存持久期与 PWA 策略由宿主维护。

导航提供系统／浅色／深色外观与三档字号，能实测系统字号时增加跟随系统；偏好存储和启动／返回时恢复由宿主维护，不扩建完整设置框架。Drawer 与按钮／导航行／summary 显式接入公共过渡和按压，发丝线与表面按公共角色消费，控件保持独立轮廓。当前没有 Menu／Popover 无罩浮层，原生下拉不安装外点按保护。复制保留真实成功／失败反馈，原生 details／summary 保持键盘披露语义，不新增 Mantine 薄包装或业务折叠层。历史复制来源及完整 MIT 许可见 [THIRD_PARTY_NOTICES](apps/web/THIRD_PARTY_NOTICES.md)。
