# Task Steward — 跨电脑 Agent 任务管家

Task Steward 是面向个人的跨电脑任务清单与执行协调系统。你在清单里安排任务，项目所在的 Mac 自动领取并启动 Agent 执行。你可以在同一条任务记录里查看进展、接收交付和完成验收。首版接入 Pi，Claude Code 接入在规划中。

## 当前范围

首版的任务平台、网页、Mac 启动器和 Pi 扩展可在本机验证。目标服务器和真实 Pi 的联调进度见下方路线图。

## 文档入口

| 文档 | 职责 |
| --- | --- |
| [产品背景与术语](docs/CONTEXT.md) | 说明要解决的问题、基本思路、自建清单的使用方式、各角色及领域概念 |
| [首版技术方案](docs/plans/active/20261112-initial-design.md) | 保存已确认的职责边界与决策、任务状态、领取与执行、两种 Agent 的接入、Git、通知，并列出技术基线、真机验证、实施顺序与待设计项 |

产品背景以 CONTEXT 为准。首版技术方案保存产品决策，[首版实施方案](docs/plans/active/20261119-first-version-implementation.md)说明工程范围和验收标准。当前里程碑见 [ROADMAP](docs/ROADMAP.md)，后续候选见 [BACKLOG](docs/BACKLOG.md)。

## 本地开发

在仓库根目录用 Node 24.20.0 或同一 Node 24 系列的更高版本、pnpm 11.20.0 运行 `pnpm install --frozen-lockfile`，再运行 `pnpm verify`。构建后可运行 `node scripts/smoke-launcher.mjs` 验证假 Agent 和 tmux 链路，或运行 `pnpm --filter @pi-steward/web test:e2e` 执行浏览器测试。要验证真实 Pi 的两种讨论收尾入口，可运行 `node scripts/smoke-launcher.mjs --real-pi <Pi 可执行文件的绝对路径>`；该命令使用独立 tmux、本机测试平台和确定性测试模型，不调用远端模型。工作树迁移后的会话定位可运行 `node scripts/smoke-session-locator.mjs <Pi 可执行文件的绝对路径>` 验证，覆盖重启、恢复、返修及现场缺失；[事故与回归说明](docs/plans/active/20261124-session-locator-regression.md)保留人工恢复参照。发布及启动器配置见[部署与 Mac 接入](docs/DEPLOYMENT.md)。

## 前端公共规范

网页精确消费公开 npm `@yefengr/pwa-foundation@0.0.4` 的安全区、主题/控件/表面、通用动效、触控按压与系统字号读取，不另维护一份公共设计规范。共享颜色、字体、间距、表面、确认顺序、关闭回焦与可访问性引用包内 [DESIGN.md](https://github.com/yefengr/pi-reach/blob/main/packages/pwa-foundation/DESIGN.md)，消费方法见包 [README](https://github.com/yefengr/pi-reach/blob/main/packages/pwa-foundation/README.md)。DESIGN.md 自 `0.0.3` 随包分发，上游源码已合入；旧版 `0.0.2` 不含此文档，不回写旧发布制品。

宿主负责 Provider 与真实 Portal 作用域、按布局生成确认区 DOM、Modal 关闭生命周期、busy 门禁和有效焦点后备。任务表单与确认入口保持既有关闭/草稿保护；品牌、业务状态映射、权限/API、路由/history、任务草稿的内存持久期与 PWA 策略不变。

导航内提供系统／浅色／深色外观与三档字号，能实测系统字号时增加跟随系统；偏好存储键和启动/返回时恢复由宿主维护，不扩建完整设置框架。导航 Drawer 与按钮/导航行/summary 显式接入公共过渡和按压；发丝线与表面按公共角色消费，控件仍保持独立轮廓。当前没有 Menu/Popover 无罩浮层，原生下拉不安装外点按保护。复制保留真实成功/失败反馈，原生 details/summary 保持键盘披露语义，不新增 Mantine 薄包装或业务折叠层。

## 阅读重点

本系统是一个任务台账，加上每台 Mac 上自动领取任务的启动器。平台部署在私人服务器，以单 Docker 容器运行，负责清单、领取条件、交付记录和通知，不接模型，也不托管 Agent 进程。任务怎么完成交给项目 Agent 和项目已有规范，源码与工作现场保留在执行电脑。

创建任务时可选择「实现」（默认）或「讨论」。讨论不会在一轮结束时自动交付；在原 Pi 会话发送「结束讨论」，或在工作台点击「结束讨论」，Pi 会保存结论和未决事项后退出。执行电脑离线时，工作台保留结束请求，恢复连接后再处理。两种任务都只在 Pi 明确提出问题且等待满 3 分钟时显示一条提醒；在原会话回复即可撤下提醒，聊天不会同步到工作台。

启动器按本机空闲名额自动领取任务。Pi 已确认在后台 tmux 会话中以交互模式启动，Claude Code 的启动方式待验证。名额等于本机运行中的 Agent 进程数，默认 1；Agent 等待用户回应时进程仍在运行并占用名额，进程退出即释放。Pi 经任务扩展、Claude Code 经通用技能回报进展、问题、决定与交付，Claude Code 经 ccx 启动并通过系统提示词获得任务背景。Agent 保存交付时，任务进入待验收；启动器确认进程退出后才释放名额。需要修改时用户发起返修，任务优先重新领取。进程退出而没有交付时任务进入已中断，由用户决定是否恢复或重新安排。

Pi 任务可在详情中手动「重启 Pi 会话」或「恢复原会话」。两者都需要原 Mac 在线、启动器支持该功能，且仍能找到原工作目录与会话记录。成功后在 Pi Reach 向原对话发送新消息继续；「重新安排」则开启新执行，不接旧对话。离线时不会排队执行重启或恢复。

对话通过各 Agent 的远程入口进行：任务记录执行电脑、Agent 类型与会话标识，Pi 会话在 Pi Reach 打开，Claude Code 会话经 Remote Control 打开，精确会话深链作为后续增强。首版先接 Pi，任务在创建时指定 Agent。Agent 还可以在用户要求时代为查看、创建和修改任务，安排开始与验收仍由用户在平台操作。依赖默认等待前项验收通过，也可选择交付后继续；待验收超过上限时暂停领取普通任务，返修不受限制。

Pi 的 tmux 启动、退出与返修恢复已经过预研真机验证。首个可用版本按路线图开发平台、Mac 启动器和 Pi 接入，Claude Code 的验证随其接入进行。
