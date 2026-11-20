'use strict';
/*
 * Pi Steward 任务平台 UX 原型。
 * 所有数据与操作均为模拟：不接真实接口，状态只保存在当前标签页的 sessionStorage 中。
 */

const STATE_KEY = 'steward-proto-state-v1';
const LANG_KEY = 'steward-proto-lang';
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const TOAST_MS = 2600;

/* ---------- 文案 ---------- */

const MESSAGES = {
  zh: {
    appName: 'Pi Steward',
    newTask: '新建任务',
    nav: '导航',
    inbox: '需要我处理',
    projects: '项目',
    machines: '电脑',
    machinesOnline: '{a}/{b} 在线',
    switchLang: 'English',
    switchLangLabel: '切换到英文',
    openMenu: '打开导航',
    closeMenu: '关闭导航',
    resetDemo: '重置原型数据',
    resetDone: '已恢复初始模拟数据',
    state_unscheduled: '未安排',
    state_queued: '待领取',
    state_running: '进行中',
    state_review: '待验收',
    state_done: '已完成',
    state_interrupted: '已中断',
    state_canceled: '已取消',
    needsReply: '待回答',
    wait_dependency: '等待依赖：{x}',
    wait_slots: '等待名额：{x} 已满',
    wait_offline: '等待电脑上线：{x}',
    wait_backlog: '待验收已达上限，暂停领取普通任务',
    wait_revision: '返修，将优先领取',
    wait_ready: '条件已满足，等待启动器领取',
    justNow: '刚刚',
    minAgo: '{n} 分钟前',
    hourAgo: '{n} 小时前',
    dayAgo: '{n} 天前',
    inboxEmptyTitle: '目前没有需要你处理的事',
    inboxEmptyBody: '有任务提问、交付或中断时，会出现在这里并通知你。',
    kind_reply: '待回答',
    kind_review: '待验收',
    kind_interrupted: '已中断',
    otherWork: '其余进行中的工作',
    runningCount: '进行中 {n}',
    queuedCount: '待领取 {n}',
    reviewLine: 'v{v} 待验收 · {summary}',
    interruptedLine: '进程退出，未提交交付',
    machinesOfProject: '登记电脑：{x}',
    groupEmpty: '暂无任务',
    back: '返回',
    agent: 'Agent',
    machine: '电脑',
    machineAuto: '上次使用：{x}',
    createdByAgent: '由 Agent 创建 · 会话 {x}',
    act_schedule: '安排开始',
    act_edit: '编辑',
    act_unschedule: '撤回到未安排',
    act_openPi: '在 Pi Reach 中打开',
    act_openClaude: '在 Remote Control 中打开',
    act_answer: '去回答',
    act_accept: '验收 v{v}',
    act_revise: '返修',
    act_reschedule: '重新安排',
    act_cancel: '取消任务',
    sec_attention: '需要你处理',
    sec_goal: '目标与约定',
    sec_progress: '当前进展',
    sec_delivery: '已有交付',
    sec_records: '执行记录',
    goal: '目标',
    acceptance: '验收要求',
    dependency: '依赖',
    dep_accepted: '验收后继续',
    dep_delivered: '交付后继续',
    dep_met: '已满足',
    dep_unmet: '未满足',
    decisions: '已有决定',
    confirmed: '已确认',
    suggested: 'Agent 建议',
    noProgress: '还没有进展回报。',
    noDelivery: '还没有交付。',
    latest: '最新',
    deliveredAt: '交付于 {t}',
    d_done: '本次做了什么',
    d_notCovered: '没有覆盖',
    d_verification: '验证结果',
    d_howTo: '如何验收',
    d_issues: '已知问题',
    d_commit: '提交',
    history: '历史版本（{n}）',
    reviseFeedback: '返修反馈',
    acceptedNote: '已于 {t}验收 v{v}',
    r_attempt: '执行编号',
    r_machine: '电脑',
    r_session: '会话',
    r_time: '时间',
    r_result: '结果',
    r_running: '运行中',
    r_delivered: '已交付',
    r_exited: '退出未交付',
    changes: '修改记录',
    attentionQuestion: 'Agent 的问题',
    attentionReview: 'v{v} 等待你确认',
    attentionInterrupted: 'Pi 进程在 {t}退出，本次执行没有提交交付。进展和工作现场已保留。',
    openConversationToast: '原型中不实际跳转：将打开 {x} 中的会话 {s}',
    scheduledToast: '已安排开始，任务进入待领取',
    unscheduledToast: '已撤回到未安排',
    acceptedToast: '已验收 v{v}，任务完成',
    revisedToast: '已提交返修，任务将优先领取',
    rescheduledToast: '已重新安排，任务进入待领取',
    canceledToast: '任务已取消',
    editToast: '原型未包含编辑页',
    reviseTitle: '返修 v{v}',
    reviseHint: '说明哪里需要修改。Agent 会优先回到原会话继续。',
    reviseSubmit: '提交返修',
    cancelTitle: '取消这个任务？',
    cancelBody: '取消后任务不再领取，已有进展与交付记录保留。',
    cancelConfirm: '取消任务',
    keep: '保留',
    close: '关闭',
    cancel: '取消',
    newTaskTitle: '新建任务',
    f_title: '标题',
    f_titlePh: '例如：补充导出功能的错误提示',
    f_project: '项目',
    f_agent: '执行 Agent',
    f_machine: '执行电脑',
    f_machineAny: '跟随上次使用（{x}）',
    f_desc: '说明',
    f_descHint: '可选，之后可以补充',
    f_submit: '添加到清单',
    f_titleRequired: '请填写标题',
    createdToast: '已添加到「{p}」的未安排',
    machinesTitle: '电脑',
    m_online: '在线',
    m_offline: '离线',
    m_lastSeen: '最近连接：{t}',
    m_slots: '名额 {a}/{b}',
    m_running: '正在执行',
    m_idle: '没有正在执行的任务',
    m_projects: '登记项目',
    loginTitle: '登录',
    loginHint: '输入访问密码以打开任务平台。',
    password: '访问密码',
    loginSubmit: '登录',
    loginError: '请输入访问密码',
    projectTasks: '{p} · 任务',
    taskNotFound: '找不到这个任务'
  },
  en: {
    appName: 'Pi Steward',
    newTask: 'New task',
    nav: 'Navigation',
    inbox: 'Needs me',
    projects: 'Projects',
    machines: 'Computers',
    machinesOnline: '{a}/{b} online',
    switchLang: '中文',
    switchLangLabel: 'Switch to Chinese',
    openMenu: 'Open navigation',
    closeMenu: 'Close navigation',
    resetDemo: 'Reset prototype data',
    resetDone: 'Mock data restored',
    state_unscheduled: 'Not scheduled',
    state_queued: 'Waiting',
    state_running: 'In progress',
    state_review: 'In review',
    state_done: 'Done',
    state_interrupted: 'Interrupted',
    state_canceled: 'Canceled',
    needsReply: 'Needs reply',
    wait_dependency: 'Waiting on dependency: {x}',
    wait_slots: 'Waiting for a slot: {x} is full',
    wait_offline: 'Waiting for computer: {x}',
    wait_backlog: 'Review queue is full; new tasks are paused',
    wait_revision: 'Revision, picked up first',
    wait_ready: 'Ready, waiting for the launcher',
    justNow: 'Just now',
    minAgo: '{n} min ago',
    hourAgo: '{n} h ago',
    dayAgo: '{n} d ago',
    inboxEmptyTitle: 'Nothing needs you right now',
    inboxEmptyBody: 'Questions, deliveries and interruptions show up here, and you get notified.',
    kind_reply: 'Needs reply',
    kind_review: 'In review',
    kind_interrupted: 'Interrupted',
    otherWork: 'Other work',
    runningCount: '{n} in progress',
    queuedCount: '{n} waiting',
    reviewLine: 'v{v} in review · {summary}',
    interruptedLine: 'Process exited without a delivery',
    machinesOfProject: 'Computers: {x}',
    groupEmpty: 'No tasks',
    back: 'Back',
    agent: 'Agent',
    machine: 'Computer',
    machineAuto: 'Last used: {x}',
    createdByAgent: 'Created by an agent · session {x}',
    act_schedule: 'Schedule',
    act_edit: 'Edit',
    act_unschedule: 'Move back to not scheduled',
    act_openPi: 'Open in Pi Reach',
    act_openClaude: 'Open in Remote Control',
    act_answer: 'Reply',
    act_accept: 'Accept v{v}',
    act_revise: 'Request changes',
    act_reschedule: 'Schedule again',
    act_cancel: 'Cancel task',
    sec_attention: 'Needs you',
    sec_goal: 'Goal and agreements',
    sec_progress: 'Progress',
    sec_delivery: 'Deliveries',
    sec_records: 'Run history',
    goal: 'Goal',
    acceptance: 'Acceptance criteria',
    dependency: 'Dependency',
    dep_accepted: 'after acceptance',
    dep_delivered: 'after delivery',
    dep_met: 'met',
    dep_unmet: 'not met',
    decisions: 'Decisions',
    confirmed: 'Confirmed',
    suggested: 'Agent suggestion',
    noProgress: 'No progress reported yet.',
    noDelivery: 'No delivery yet.',
    latest: 'Latest',
    deliveredAt: 'Delivered {t}',
    d_done: 'What was done',
    d_notCovered: 'Not covered',
    d_verification: 'Verification',
    d_howTo: 'How to review',
    d_issues: 'Known issues',
    d_commit: 'Commit',
    history: 'Earlier versions ({n})',
    reviseFeedback: 'Change request',
    acceptedNote: 'v{v} accepted {t}',
    r_attempt: 'Run',
    r_machine: 'Computer',
    r_session: 'Session',
    r_time: 'Time',
    r_result: 'Result',
    r_running: 'Running',
    r_delivered: 'Delivered',
    r_exited: 'Exited, no delivery',
    changes: 'Changes',
    attentionQuestion: 'Question from the agent',
    attentionReview: 'v{v} is waiting for your review',
    attentionInterrupted: 'The Pi process exited {t} without a delivery. Progress and the working tree are kept.',
    openConversationToast: 'Prototype only: would open session {s} in {x}',
    scheduledToast: 'Scheduled; the task is now waiting',
    unscheduledToast: 'Moved back to not scheduled',
    acceptedToast: 'v{v} accepted; task done',
    revisedToast: 'Change request sent; the task is picked up first',
    rescheduledToast: 'Scheduled again; the task is now waiting',
    canceledToast: 'Task canceled',
    editToast: 'Editing is not part of this prototype',
    reviseTitle: 'Request changes to v{v}',
    reviseHint: 'Describe what needs to change. The agent resumes the original session.',
    reviseSubmit: 'Send request',
    cancelTitle: 'Cancel this task?',
    cancelBody: 'The task will no longer be picked up. Progress and deliveries are kept.',
    cancelConfirm: 'Cancel task',
    keep: 'Keep',
    close: 'Close',
    cancel: 'Cancel',
    newTaskTitle: 'New task',
    f_title: 'Title',
    f_titlePh: 'e.g. Improve error messages in export',
    f_project: 'Project',
    f_agent: 'Agent',
    f_machine: 'Computer',
    f_machineAny: 'Follow last used ({x})',
    f_desc: 'Description',
    f_descHint: 'Optional; you can add it later',
    f_submit: 'Add to list',
    f_titleRequired: 'Enter a title',
    createdToast: 'Added to "{p}" as not scheduled',
    machinesTitle: 'Computers',
    m_online: 'Online',
    m_offline: 'Offline',
    m_lastSeen: 'Last seen {t}',
    m_slots: 'Slots {a}/{b}',
    m_running: 'Running',
    m_idle: 'Nothing running',
    m_projects: 'Projects',
    loginTitle: 'Sign in',
    loginHint: 'Enter the access password to open the task console.',
    password: 'Access password',
    loginSubmit: 'Sign in',
    loginError: 'Enter the access password',
    projectTasks: '{p} · Tasks',
    taskNotFound: 'Task not found'
  }
};

function readStore(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeStore(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* 隐私模式下忽略 */ }
}
function readLang() {
  try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

let lang = readLang();

function t(key, vars = {}) {
  const text = MESSAGES[lang][key] ?? MESSAGES.zh[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

function ago(minutes) {
  if (minutes < 1) return t('justNow');
  if (minutes < MINUTES_PER_HOUR) return t('minAgo', { n: minutes });
  if (minutes < MINUTES_PER_DAY) return t('hourAgo', { n: Math.floor(minutes / MINUTES_PER_HOUR) });
  return t('dayAgo', { n: Math.floor(minutes / MINUTES_PER_DAY) });
}

/* ---------- 模拟数据（用户与 Agent 写的内容原样显示，不翻译） ---------- */

const MACHINES = [
  { id: 'mbp', name: 'MacBook Pro', online: true, slots: 2, lastSeenMin: 0, projects: ['pi-steward', 'pi-reach'] },
  { id: 'mini', name: 'Mac mini', online: false, slots: 1, lastSeenMin: 135, projects: ['pi-steward', 'agent-tools'] }
];

const PROJECTS = [
  { id: 'pi-steward', machines: ['mbp', 'mini'], lastMachine: 'mbp', lastAgent: 'pi' },
  { id: 'pi-reach', machines: ['mbp'], lastMachine: 'mbp', lastAgent: 'pi' },
  { id: 'agent-tools', machines: ['mini'], lastMachine: 'mini', lastAgent: 'claude' }
];

const AGENTS = { pi: 'Pi', claude: 'Claude Code' };

const SEED_TASKS = [
  {
    id: 't1', project: 'pi-steward', title: '实现任务领取接口', agent: 'pi', machine: 'mbp', state: 'running',
    goal: '实现启动器调用的领取、续租与进程报告接口，领取必须原子完成并带租约。',
    acceptance: '并发领取同一任务只有一方成功；租约过期标为待核对；自动化测试覆盖。',
    decisions: [
      { text: '领取接口使用机器令牌认证，执行编号由平台生成。', by: 'user' },
      { text: '租约时长先取 90 秒，续租间隔 30 秒。', by: 'agent' }
    ],
    progress: [
      { min: 8, text: '领取与续租接口已完成，正在补并发领取的测试。' },
      { min: 22, text: '已建好 attempts 表与唯一约束，开始写领取事务。' }
    ],
    deliveries: [],
    attempts: [{ id: 'a-t1-1', machine: 'mbp', session: 'steward-t1-a1', startMin: 25, endMin: null, result: 'running' }]
  },
  {
    id: 't2', project: 'pi-steward', title: '平台数据表设计', agent: 'pi', machine: 'mbp', state: 'review',
    goal: '设计任务、执行尝试、交付与通知的数据表，支撑首版主路径。',
    acceptance: '覆盖第 4.1 节全部主状态；给出迁移脚本与字段说明。',
    decisions: [{ text: '首版使用 SQLite，迁移用纯 SQL 文件管理。', by: 'user' }],
    progress: [
      { min: 40, text: '已按返修意见补充索引说明并重新生成迁移脚本，提交交付 v2。' },
      { min: 1500, text: '完成表结构与迁移脚本，提交交付 v1。' }
    ],
    deliveries: [
      {
        v: 2, min: 40, summary: '补充索引说明',
        done: ['新增 tasks、attempts、deliveries、notifications 四张表', '为领取查询补充复合索引并写明理由'],
        notCovered: ['附件存储尚未设计'],
        verification: ['迁移脚本在空库上执行通过', '字段与第 4.1 节状态逐项对照通过'],
        howTo: ['阅读 docs/data-model.md', '运行 pnpm db:migrate 后查看生成的表'],
        commit: 'a3f9c12', issues: []
      },
      {
        v: 1, min: 1500, summary: '首版表结构',
        done: ['新增四张表与迁移脚本'], notCovered: ['索引说明'], verification: ['迁移脚本执行通过'],
        howTo: ['阅读 docs/data-model.md'], commit: '7be2d04', issues: ['未说明索引取舍'],
        feedback: '请补充领取查询用到的索引和理由。'
      }
    ],
    attempts: [
      { id: 'a-t2-1', machine: 'mbp', session: 'steward-t2', startMin: 1580, endMin: 1500, result: 'delivered' },
      { id: 'a-t2-2', machine: 'mbp', session: 'steward-t2', startMin: 70, endMin: 40, result: 'delivered' }
    ]
  },
  {
    id: 't3', project: 'pi-steward', title: '启动器 LaunchAgent 安装脚本', agent: 'pi', machine: 'mbp', state: 'queued',
    wait: { type: 'dependency', ref: 't1' },
    deps: [{ task: 't1', cond: 'accepted' }],
    goal: '为启动器提供用户级 LaunchAgent 安装与卸载脚本。',
    acceptance: '安装后重新登录仍自动运行；卸载后无残留。',
    decisions: [], progress: [], deliveries: [], attempts: []
  },
  {
    id: 't4', project: 'pi-steward', title: '任务详情页前端', agent: 'pi', machine: 'mbp', state: 'queued',
    wait: { type: 'slots', ref: 'mbp' },
    goal: '按原型实现任务详情页。', acceptance: '与原型一致，中英文案齐全。',
    decisions: [], progress: [], deliveries: [], attempts: []
  },
  {
    id: 't5', project: 'pi-steward', title: '整理 Web Push 订阅流程', agent: 'pi', machine: null, state: 'unscheduled',
    createdBy: 'pi-chat-0412',
    goal: '梳理订阅登记、撤销与失效清理的流程，供实现前评审。', acceptance: '',
    decisions: [], progress: [], deliveries: [], attempts: [],
    changes: [{ min: 300, text: '由 Agent 创建（会话 pi-chat-0412）' }]
  },
  {
    id: 't6', project: 'pi-steward', title: '评估 SQLite 备份方案', agent: 'pi', machine: null, state: 'unscheduled',
    goal: '', acceptance: '', decisions: [], progress: [], deliveries: [], attempts: []
  },
  {
    id: 't7', project: 'pi-steward', title: '初始化仓库与项目说明', agent: 'pi', machine: 'mbp', state: 'done',
    acceptedMin: 10080, goal: '建立 README 与方案文档。', acceptance: '',
    decisions: [], progress: [],
    deliveries: [{ v: 1, min: 10100, summary: '初始化文档', done: ['新增 README、CONTEXT 与首版方案'], notCovered: [], verification: ['文档链接检查通过'], howTo: ['阅读 README'], commit: '4ca124b', issues: [] }],
    attempts: [{ id: 'a-t7-1', machine: 'mbp', session: 'steward-t7', startMin: 10200, endMin: 10100, result: 'delivered' }]
  },
  {
    id: 't8', project: 'pi-reach', title: '会话深链参数设计', agent: 'pi', machine: 'mbp', state: 'running',
    question: { min: 14, text: '深链里要不要带电脑标识？带上可以直接定位电脑，但链接会暴露电脑名。', context: '只带会话标识时，需要先在所有已配对电脑里查找。' },
    goal: '设计从任务平台打开指定 Pi Reach 会话的链接参数。', acceptance: '给出参数表、校验规则与失败提示。',
    decisions: [{ text: '链接不携带任何凭据。', by: 'user' }],
    progress: [{ min: 14, text: '已整理两种参数方案，等待确认是否携带电脑标识。' }],
    deliveries: [],
    attempts: [{ id: 'a-t8-1', machine: 'mbp', session: 'reach-t8-a1', startMin: 50, endMin: null, result: 'running' }]
  },
  {
    id: 't9', project: 'pi-reach', title: '设置页字号档位', agent: 'pi', machine: 'mbp', state: 'interrupted',
    interruptedMin: 190,
    goal: '设置页增加标准、大、特大三档字号。', acceptance: '三档在桌面与触控下都正确换算。',
    decisions: [],
    progress: [{ min: 200, text: '已完成桌面三档，正在调整触控基准。' }],
    deliveries: [],
    attempts: [{ id: 'a-t9-1', machine: 'mbp', session: 'reach-t9-a1', startMin: 260, endMin: 190, result: 'exited' }]
  },
  {
    id: 't10', project: 'agent-tools', title: 'ccx 增加环境变量透传', agent: 'claude', machine: 'mini', state: 'queued',
    wait: { type: 'offline', ref: 'mini' },
    goal: '允许 ccx 把指定的宿主机环境变量带入容器会话。', acceptance: '只透传显式指定的变量；有测试。',
    decisions: [], progress: [], deliveries: [], attempts: []
  }
];

function loadState() {
  const saved = readStore(STATE_KEY);
  if (saved) {
    try { return JSON.parse(saved); } catch { /* 损坏时回到初始数据 */ }
  }
  return { tasks: JSON.parse(JSON.stringify(SEED_TASKS)) };
}
let state = loadState();
function saveState() { writeStore(STATE_KEY, JSON.stringify(state)); }

const tasks = () => state.tasks;
const taskById = (id) => tasks().find((task) => task.id === id);
const machineById = (id) => MACHINES.find((m) => m.id === id);
const projectById = (id) => PROJECTS.find((p) => p.id === id);
const machineName = (id) => machineById(id)?.name ?? '';
const needsMe = (task) => (task.state === 'running' && task.question) || task.state === 'review' || task.state === 'interrupted';
const latestDelivery = (task) => task.deliveries[0];

/* ---------- 通用渲染 ---------- */

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'
};
function icon(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function stateChip(task) {
  return `<span class="chip s-${task.state}">${t('state_' + task.state)}</span>`;
}
function replyChip(task) {
  return task.state === 'running' && task.question ? `<span class="chip reply">${t('needsReply')}</span>` : '';
}
function waitText(task) {
  const wait = task.wait;
  if (!wait) return t('wait_ready');
  if (wait.type === 'dependency') return t('wait_dependency', { x: taskById(wait.ref)?.title });
  if (wait.type === 'slots') return t('wait_slots', { x: machineName(wait.ref) });
  if (wait.type === 'offline') return t('wait_offline', { x: machineName(wait.ref) });
  return t('wait_' + wait.type);
}

function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, TOAST_MS);
}

function setLang(next) {
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* 忽略 */ }
  render();
}

function langButton() {
  return `<button class="nav-item" type="button" data-action="lang" aria-label="${t('switchLangLabel')}" style="border:0;background:none;width:100%;cursor:pointer;text-align:left">${icon('globe')}<span>${t('switchLang')}</span></button>`;
}

function renderSidebar(active) {
  const inboxCount = tasks().filter(needsMe).length;
  const online = MACHINES.filter((m) => m.online).length;
  const projectItems = PROJECTS.map((p) => {
    const open = tasks().filter((task) => task.project === p.id && !['done', 'canceled'].includes(task.state)).length;
    const current = active === 'project:' + p.id ? ' aria-current="page"' : '';
    return `<a class="nav-item" href="project.html?p=${p.id}"${current}>${icon('folder')}<span>${esc(p.id)}</span><span class="count">${open}</span></a>`;
  }).join('');
  return `
    <div class="brand"><span class="brand-mark" aria-hidden="true">S</span><span>${t('appName')}</span>
      <button class="icon-btn close-menu" type="button" data-action="close-menu" aria-label="${t('closeMenu')}">${icon('x')}</button></div>
    <button class="btn btn-primary" type="button" data-action="new-task" style="margin:8px 4px 0">${icon('plus', 'icon icon-sm')}${t('newTask')}</button>
    <nav class="nav-section" aria-label="${t('inbox')}">
      <a class="nav-item" href="inbox.html"${active === 'inbox' ? ' aria-current="page"' : ''}>${icon('inbox')}<span>${t('inbox')}</span>${inboxCount ? `<span class="badge">${inboxCount}</span>` : ''}</a>
    </nav>
    <nav class="nav-section" aria-label="${t('projects')}">
      <div class="nav-label">${t('projects')}</div>${projectItems}
    </nav>
    <div class="sidebar-footer">
      <a class="nav-item" href="machines.html"${active === 'machines' ? ' aria-current="page"' : ''}>${icon('laptop')}<span>${t('machines')}</span><span class="count">${t('machinesOnline', { a: online, b: MACHINES.length })}</span></a>
      ${langButton()}
      <button class="nav-item" type="button" data-action="reset" style="border:0;background:none;width:100%;cursor:pointer;text-align:left;color:var(--secondary)">${icon('reset')}<span>${t('resetDemo')}</span></button>
    </div>`;
}

function topbar(title, backHref) {
  const lead = backHref
    ? `<a class="icon-btn" href="${backHref}" aria-label="${t('back')}">${icon('back')}</a>`
    : `<button class="icon-btn" type="button" data-action="open-menu" aria-label="${t('openMenu')}">${icon('menu')}</button>`;
  return `<header class="topbar">${lead}<span class="title">${esc(title)}</span>
    <button class="icon-btn" type="button" data-action="new-task" aria-label="${t('newTask')}">${icon('plus')}</button></header>`;
}

/* ---------- 页面：需要我处理 ---------- */

function inboxItem(task) {
  let kind = 'interrupted';
  let line = t('interruptedLine');
  let minutes = task.interruptedMin ?? 0;
  if (task.state === 'running') {
    kind = 'reply'; line = task.question.text; minutes = task.question.min;
  } else if (task.state === 'review') {
    const d = latestDelivery(task);
    kind = 'review'; line = t('reviewLine', { v: d.v, summary: d.summary }); minutes = d.min;
  }
  const chipClass = kind === 'interrupted' ? 's-interrupted' : 'reply';
  return { minutes, html: `
    <a class="row" href="task.html?id=${task.id}">
      <span class="row-title">${esc(task.title)}</span>
      <span class="row-side"><span class="chip ${chipClass}">${t('kind_' + kind)}</span></span>
      <span class="row-sub"><span>${esc(task.project)}</span><span class="line">${esc(line)}</span><span class="num">${ago(minutes)}</span></span>
    </a>` };
}

function renderInbox() {
  const items = tasks().filter(needsMe).map(inboxItem).sort((a, b) => b.minutes - a.minutes);
  const running = tasks().filter((task) => task.state === 'running').length;
  const queued = tasks().filter((task) => task.state === 'queued').length;
  const list = items.length
    ? `<div class="list">${items.map((item) => item.html).join('')}</div>`
    : `<div class="empty"><strong>${t('inboxEmptyTitle')}</strong>${t('inboxEmptyBody')}</div>`;
  return `${topbar(t('inbox'))}<div class="content">
    <div class="page-head"><div><h1>${t('inbox')}</h1></div></div>
    ${list}
    <div class="group-head" style="margin-top:32px">${t('otherWork')}</div>
    <div class="summary-bar">
      <a href="project.html?p=pi-steward">${icon('clock', 'icon icon-sm')}${t('runningCount', { n: running })}</a>
      <a href="project.html?p=pi-steward">${t('queuedCount', { n: queued })}</a>
    </div></div>`;
}

/* ---------- 页面：项目任务列表 ---------- */

const GROUP_ORDER = ['running', 'review', 'interrupted', 'queued', 'unscheduled'];
const FOLDED_GROUPS = ['done', 'canceled'];

function taskRow(task, { showState = true } = {}) {
  let sub = '';
  if (task.state === 'queued') sub = waitText(task);
  else if (task.state === 'running') sub = task.question ? task.question.text : (task.progress[0]?.text ?? '');
  else if (task.state === 'review') sub = t('reviewLine', { v: latestDelivery(task).v, summary: latestDelivery(task).summary });
  else if (task.state === 'interrupted') sub = t('interruptedLine');
  else if (task.createdBy) sub = t('createdByAgent', { x: task.createdBy });
  const machine = task.machine ? `<span>${esc(machineName(task.machine))}</span>` : '';
  return `<a class="row" href="task.html?id=${task.id}">
    <span class="row-title">${esc(task.title)}</span>
    <span class="row-side">${replyChip(task)}${showState ? stateChip(task) : ''}</span>
    <span class="row-sub"><span>${AGENTS[task.agent]}</span>${machine}${sub ? `<span class="line">${esc(sub)}</span>` : ''}</span></a>`;
}

function renderProject() {
  const params = new URLSearchParams(location.search);
  const project = projectById(params.get('p')) ?? PROJECTS[0];
  const own = tasks().filter((task) => task.project === project.id);
  const groups = GROUP_ORDER.map((key) => {
    const rows = own.filter((task) => task.state === key);
    if (!rows.length) return '';
    return `<section class="group" aria-label="${t('state_' + key)}"><div class="group-head">${t('state_' + key)}<span class="num">${rows.length}</span></div>
      <div class="list">${rows.map((row) => taskRow(row, { showState: false })).join('')}</div></section>`;
  }).join('');
  const folded = FOLDED_GROUPS.map((key) => {
    const rows = own.filter((task) => task.state === key);
    if (!rows.length) return '';
    return `<details class="group"><summary class="group-head">${icon('chev', 'icon icon-sm chev')}${t('state_' + key)}<span class="num">${rows.length}</span></summary>
      <div class="list">${rows.map((row) => taskRow(row, { showState: false })).join('')}</div></details>`;
  }).join('');
  const machines = project.machines.map(machineName).join('、');
  document.title = `${project.id} · ${t('appName')}`;
  return `${topbar(project.id)}<div class="content">
    <div class="page-head"><div><h1>${esc(project.id)}</h1><div class="sub">${t('machinesOfProject', { x: machines })}</div></div></div>
    ${groups || `<div class="empty">${t('groupEmpty')}</div>`}${folded}</div>`;
}

/* ---------- 页面：任务详情 ---------- */

function primaryActions(task) {
  const delivery = latestDelivery(task);
  const open = task.agent === 'claude' ? t('act_openClaude') : t('act_openPi');
  switch (task.state) {
    case 'unscheduled':
      return `<button class="btn btn-primary" data-action="schedule">${t('act_schedule')}</button><button class="btn btn-secondary" data-action="edit">${t('act_edit')}</button>`;
    case 'queued':
      return `<button class="btn btn-secondary" data-action="unschedule">${t('act_unschedule')}</button>`;
    case 'running':
      return `<button class="btn btn-primary" data-action="open">${icon('message', 'icon icon-sm')}${open}</button>`;
    case 'review':
      return `<button class="btn btn-primary" data-action="accept">${t('act_accept', { v: delivery.v })}</button><button class="btn btn-secondary" data-action="revise">${t('act_revise')}</button><button class="btn btn-text" data-action="open">${open}</button>`;
    case 'interrupted':
      return `<button class="btn btn-primary" data-action="reschedule">${t('act_reschedule')}</button><button class="btn btn-danger" data-action="cancel">${t('act_cancel')}</button><button class="btn btn-text" data-action="open">${open}</button>`;
    default:
      return '';
  }
}

function attentionBlock(task) {
  if (task.state === 'running' && task.question) {
    return `<section class="section"><h2>${t('sec_attention')}</h2><div class="callout">
      <div class="callout-label">${t('attentionQuestion')} · ${ago(task.question.min)}</div>
      <p>${esc(task.question.text)}</p><p class="muted" style="margin:0">${esc(task.question.context)}</p></div></section>`;
  }
  if (task.state === 'review') {
    const d = latestDelivery(task);
    return `<section class="section"><h2>${t('sec_attention')}</h2><div class="callout">
      <div class="callout-label">${t('attentionReview', { v: d.v })}</div><p style="margin:0">${esc(d.summary)} · <span class="mono">${esc(d.commit)}</span></p></div></section>`;
  }
  if (task.state === 'interrupted') {
    return `<section class="section"><h2>${t('sec_attention')}</h2><div class="callout error">
      <div class="callout-label">${t('state_interrupted')}</div><p style="margin:0">${t('attentionInterrupted', { t: ago(task.interruptedMin) })}</p></div></section>`;
  }
  return '';
}

function goalBlock(task) {
  const deps = (task.deps ?? []).map((dep) => {
    const pre = taskById(dep.task);
    const met = dep.cond === 'accepted' ? pre?.state === 'done' : Boolean(pre?.deliveries.length);
    return `<a href="task.html?id=${dep.task}" style="color:var(--accent)">${esc(pre?.title)}</a>（${t('dep_' + dep.cond)} · ${t(met ? 'dep_met' : 'dep_unmet')}）`;
  }).join('<br>');
  const decisions = task.decisions.map((d) => `<div class="decision"><span class="chip ${d.by === 'user' ? 's-done' : ''}">${t(d.by === 'user' ? 'confirmed' : 'suggested')}</span><span>${esc(d.text)}</span></div>`).join('');
  return `<section class="section"><h2>${t('sec_goal')}</h2><dl class="kv">
    <dt>${t('goal')}</dt><dd>${esc(task.goal) || '—'}</dd>
    <dt>${t('acceptance')}</dt><dd>${esc(task.acceptance) || '—'}</dd>
    ${deps ? `<dt>${t('dependency')}</dt><dd>${deps}</dd>` : ''}
    </dl>${decisions ? `<h3>${t('decisions')}</h3>${decisions}` : ''}</section>`;
}

function progressBlock(task) {
  const items = task.progress.map((p) => `<li><time>${ago(p.min)}</time><span>${esc(p.text)}</span></li>`).join('');
  return `<section class="section"><h2>${t('sec_progress')}</h2>${items ? `<ul class="timeline">${items}</ul>` : `<p class="muted">${t('noProgress')}</p>`}</section>`;
}

function deliveryBody(d) {
  const list = (key, values) => values.length ? `<h3>${t(key)}</h3><ul>${values.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : '';
  return `${list('d_done', d.done)}${list('d_notCovered', d.notCovered)}${list('d_verification', d.verification)}${list('d_howTo', d.howTo)}${list('d_issues', d.issues)}
    <h3>${t('d_commit')}</h3><p class="mono">${esc(d.commit)}</p>
    ${d.feedback ? `<div class="feedback"><strong>${t('reviseFeedback')}：</strong>${esc(d.feedback)}</div>` : ''}`;
}

function deliveryBlock(task) {
  if (!task.deliveries.length) return `<section class="section"><h2>${t('sec_delivery')}</h2><p class="muted">${t('noDelivery')}</p></section>`;
  const [latest, ...older] = task.deliveries;
  const accepted = task.state === 'done' ? `<span class="chip s-done">${t('acceptedNote', { v: latest.v, t: ago(task.acceptedMin) })}</span>` : '';
  const history = older.length ? `<details class="fold"><summary>${icon('chev', 'icon icon-sm')}${t('history', { n: older.length })}</summary><div class="fold-body">
    ${older.map((d) => `<div class="delivery-head"><strong>v${d.v} · ${esc(d.summary)}</strong><span class="muted">${t('deliveredAt', { t: ago(d.min) })}</span></div>${deliveryBody(d)}`).join('')}</div></details>` : '';
  return `<section class="section"><h2>${t('sec_delivery')}</h2><div class="delivery">
    <div class="delivery-head"><strong>v${latest.v} · ${esc(latest.summary)}</strong><span class="chip">${t('latest')}</span>${accepted}<span class="muted" style="font-size:var(--text-meta)">${t('deliveredAt', { t: ago(latest.min) })}</span></div>
    ${deliveryBody(latest)}</div>${history}</section>`;
}

function recordsBlock(task) {
  if (!task.attempts.length && !task.changes) return '';
  const rows = task.attempts.map((a) => `<tr><td class="mono">${esc(a.id)}</td><td>${esc(machineName(a.machine))}</td><td class="mono">${esc(a.session)}</td>
    <td class="num">${ago(a.startMin)}${a.endMin === null ? '' : ' → ' + ago(a.endMin)}</td><td>${t('r_' + a.result)}</td></tr>`).join('');
  const table = rows ? `<div class="table-wrap"><table class="records"><thead><tr><th>${t('r_attempt')}</th><th>${t('r_machine')}</th><th>${t('r_session')}</th><th>${t('r_time')}</th><th>${t('r_result')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : '';
  const changes = task.changes ? `<h3>${t('changes')}</h3><ul>${task.changes.map((c) => `<li>${ago(c.min)} · ${esc(c.text)}</li>`).join('')}</ul>` : '';
  return `<details class="fold section"><summary>${icon('chev', 'icon icon-sm')}${t('sec_records')}</summary><div class="fold-body">${table}${changes}</div></details>`;
}

function renderTask() {
  const task = currentTask();
  if (!task) return `${topbar(t('taskNotFound'), 'inbox.html')}<div class="content"><div class="empty"><strong>${t('taskNotFound')}</strong></div></div>`;
  document.title = `${task.title} · ${t('appName')}`;
  const backHref = `project.html?p=${task.project}`;
  const machine = task.machine ? machineName(task.machine) : t('machineAuto', { x: machineName(projectById(task.project).lastMachine) });
  const waitBanner = task.state === 'queued' ? `<div class="banner">${icon('clock')}<span>${esc(waitText(task))}</span></div>` : '';
  const created = task.createdBy ? `<span>${t('createdByAgent', { x: task.createdBy })}</span>` : '';
  return `${topbar(task.project, backHref)}<div class="content">
    <a class="back" href="${backHref}">${icon('back', 'icon icon-sm')}${esc(task.project)}</a>
    <header class="detail-head"><h1>${esc(task.title)}</h1>
      <div class="meta-line">${stateChip(task)}${replyChip(task)}<span>${t('agent')}：${AGENTS[task.agent]}</span><span>${t('machine')}：${esc(machine)}</span>${created}</div>
      <div class="action-bar">${primaryActions(task)}</div>${waitBanner}</header>
    ${attentionBlock(task)}${goalBlock(task)}${progressBlock(task)}${deliveryBlock(task)}${recordsBlock(task)}</div>`;
}

/* ---------- 页面：电脑 ---------- */

function renderMachines() {
  document.title = `${t('machinesTitle')} · ${t('appName')}`;
  const cards = MACHINES.map((m) => {
    const running = tasks().filter((task) => task.state === 'running' && task.machine === m.id);
    const slots = Array.from({ length: m.slots }, (_, i) => `<span class="slot${i < running.length ? ' used' : ''}"></span>`).join('');
    const status = m.online
      ? `<span class="chip"><span class="online-dot"></span>${t('m_online')}</span>`
      : `<span class="chip"><span class="offline-dot"></span>${t('m_offline')}</span>`;
    const runningList = running.length
      ? `<div class="list" style="margin-top:8px">${running.map((row) => taskRow(row)).join('')}</div>`
      : `<p class="muted" style="margin:4px 0 0">${t('m_idle')}</p>`;
    return `<section class="machine" aria-label="${esc(m.name)}"><div class="machine-head"><strong>${esc(m.name)}</strong>${status}
      <span class="muted num" style="font-size:var(--text-meta)">${t('m_lastSeen', { t: ago(m.lastSeenMin) })}</span></div>
      <div class="machine-head" style="margin-top:12px"><span style="font-size:var(--text-list)">${t('m_slots', { a: running.length, b: m.slots })}</span><span class="slots" aria-hidden="true">${slots}</span></div>
      <h3 style="margin:16px 0 0;font-size:var(--text-list)">${t('m_running')}</h3>${runningList}
      <h3 style="margin:16px 0 4px;font-size:var(--text-list)">${t('m_projects')}</h3><p class="muted" style="margin:0">${m.projects.join('、')}</p></section>`;
  }).join('');
  return `${topbar(t('machinesTitle'))}<div class="content"><div class="page-head"><div><h1>${t('machinesTitle')}</h1></div></div>${cards}</div>`;
}

/* ---------- 页面：登录 ---------- */

function renderLogin() {
  document.title = `${t('loginTitle')} · ${t('appName')}`;
  return `<div class="center-page"><form class="login-card" data-form="login" novalidate>
    <div class="brand"><span class="brand-mark" aria-hidden="true">S</span><span>${t('appName')}</span></div>
    <h1>${t('loginTitle')}</h1><p class="muted" style="margin:0">${t('loginHint')}</p>
    <label class="field"><span>${t('password')}</span><input class="input" type="password" name="password" autocomplete="current-password"></label>
    <p class="error-text" data-role="login-error" hidden>${t('loginError')}</p>
    <button class="btn btn-primary" type="submit" style="min-height:var(--hit-target)">${t('loginSubmit')}</button>
    <div class="login-foot"><button class="btn btn-text" type="button" data-action="lang" aria-label="${t('switchLangLabel')}">${icon('globe', 'icon icon-sm')}${t('switchLang')}</button></div>
  </form></div>`;
}

/* ---------- 弹层 ---------- */

function newTaskDialog(projectId) {
  const project = projectById(projectId) ?? PROJECTS[0];
  const options = PROJECTS.map((p) => `<option value="${p.id}"${p.id === project.id ? ' selected' : ''}>${esc(p.id)}</option>`).join('');
  return `<dialog id="dialog" aria-labelledby="dialog-title"><form data-form="new-task" novalidate>
    <div class="dialog-head"><h2 id="dialog-title">${t('newTaskTitle')}</h2><button class="icon-btn" type="button" data-action="close-dialog" aria-label="${t('close')}">${icon('x')}</button></div>
    <div class="dialog-body">
      <label class="field"><span>${t('f_title')}</span><input class="input" name="title" placeholder="${t('f_titlePh')}" autofocus></label>
      <p class="error-text" data-role="title-error" hidden>${t('f_titleRequired')}</p>
      <label class="field"><span>${t('f_project')}</span><select class="select" name="project" data-role="project">${options}</select></label>
      <div class="field"><span>${t('f_agent')}</span><div class="segmented" role="group" aria-label="${t('f_agent')}" data-role="agent">
        ${Object.entries(AGENTS).map(([id, name]) => `<button type="button" data-agent="${id}" aria-pressed="${id === project.lastAgent}">${name}</button>`).join('')}</div></div>
      <div data-role="machine-field">${machineField(project)}</div>
      <label class="field"><span>${t('f_desc')} <span class="hint">${t('f_descHint')}</span></span><textarea class="textarea" name="desc"></textarea></label>
    </div>
    <div class="dialog-foot"><button class="btn btn-secondary" type="button" data-action="close-dialog">${t('cancel')}</button><button class="btn btn-primary" type="submit">${t('f_submit')}</button></div>
  </form></dialog>`;
}

function machineField(project) {
  // 单机项目只能由该电脑领取，不显示选择
  if (project.machines.length < 2) return '';
  const last = machineName(project.lastMachine);
  const options = project.machines.map((id) => `<option value="${id}">${esc(machineName(id))}</option>`).join('');
  return `<label class="field"><span>${t('f_machine')}</span><select class="select" name="machine"><option value="">${t('f_machineAny', { x: last })}</option>${options}</select></label>`;
}

function reviseDialog(task) {
  const v = latestDelivery(task).v;
  return `<dialog id="dialog" aria-labelledby="dialog-title"><form data-form="revise" novalidate>
    <div class="dialog-head"><h2 id="dialog-title">${t('reviseTitle', { v })}</h2><button class="icon-btn" type="button" data-action="close-dialog" aria-label="${t('close')}">${icon('x')}</button></div>
    <div class="dialog-body"><p class="muted" style="margin:0">${t('reviseHint')}</p>
      <label class="field"><span>${t('reviseFeedback')}</span><textarea class="textarea" name="feedback" autofocus></textarea></label></div>
    <div class="dialog-foot"><button class="btn btn-secondary" type="button" data-action="close-dialog">${t('cancel')}</button><button class="btn btn-primary" type="submit">${t('reviseSubmit')}</button></div>
  </form></dialog>`;
}

function cancelDialog() {
  return `<dialog id="dialog" aria-labelledby="dialog-title"><form data-form="cancel">
    <div class="dialog-head"><h2 id="dialog-title">${t('cancelTitle')}</h2><button class="icon-btn" type="button" data-action="close-dialog" aria-label="${t('close')}">${icon('x')}</button></div>
    <div class="dialog-body"><p style="margin:0">${t('cancelBody')}</p></div>
    <div class="dialog-foot"><button class="btn btn-secondary" type="button" data-action="close-dialog">${t('keep')}</button><button class="btn btn-danger" type="submit">${t('cancelConfirm')}</button></div>
  </form></dialog>`;
}

function openDialog(html) {
  document.getElementById('dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('dialog').showModal();
}
function closeDialog() {
  const dialog = document.getElementById('dialog');
  if (dialog) { dialog.close(); dialog.remove(); }
}

/* ---------- 模拟操作 ---------- */

// 未带 id 直接打开详情页时展示示例任务，便于单独评审
const DEFAULT_TASK_ID = 't2';
function currentTask() { return taskById(new URLSearchParams(location.search).get('id') ?? DEFAULT_TASK_ID); }

function mutate(change, message) {
  change();
  saveState();
  render();
  toast(message);
}

const ACTIONS = {
  'open-menu': () => toggleMenu(true),
  'close-menu': () => toggleMenu(false),
  lang: () => setLang(lang === 'zh' ? 'en' : 'zh'),
  reset: () => { state = { tasks: JSON.parse(JSON.stringify(SEED_TASKS)) }; saveState(); render(); toast(t('resetDone')); },
  'new-task': (el) => { toggleMenu(false); openDialog(newTaskDialog(el.dataset.project ?? new URLSearchParams(location.search).get('p'))); },
  'close-dialog': closeDialog,
  edit: () => toast(t('editToast')),
  schedule: () => mutate(() => { const task = currentTask(); task.state = 'queued'; task.wait = null; }, t('scheduledToast')),
  unschedule: () => mutate(() => { const task = currentTask(); task.state = 'unscheduled'; task.wait = null; }, t('unscheduledToast')),
  reschedule: () => mutate(() => { const task = currentTask(); task.state = 'queued'; task.wait = null; }, t('rescheduledToast')),
  accept: () => {
    const task = currentTask();
    const v = latestDelivery(task).v;
    mutate(() => { task.state = 'done'; task.acceptedMin = 0; }, t('acceptedToast', { v }));
  },
  revise: () => openDialog(reviseDialog(currentTask())),
  cancel: () => openDialog(cancelDialog()),
  open: () => {
    const task = currentTask();
    const target = task.agent === 'claude' ? 'Remote Control' : 'Pi Reach';
    const session = task.attempts[task.attempts.length - 1]?.session ?? '—';
    toast(t('openConversationToast', { x: target, s: session }));
  }
};

const FORMS = {
  login: (form) => {
    const empty = !form.password.value.trim();
    form.querySelector('[data-role="login-error"]').hidden = !empty;
    if (!empty) location.href = 'inbox.html';
  },
  'new-task': (form) => {
    // form.title 会取到表单自身的 title 属性，必须经 elements 读取输入框
    const titleInput = form.elements.namedItem('title');
    const title = titleInput.value.trim();
    form.querySelector('[data-role="title-error"]').hidden = Boolean(title);
    if (!title) { titleInput.focus(); return; }
    const agent = form.querySelector('[aria-pressed="true"]')?.dataset.agent ?? 'pi';
    const project = form.project.value;
    state.tasks.push({
      id: 'n' + Date.now(), project, title, agent, machine: form.machine?.value || null, state: 'unscheduled',
      goal: form.desc.value.trim(), acceptance: '', decisions: [], progress: [], deliveries: [], attempts: []
    });
    closeDialog();
    mutate(() => {}, t('createdToast', { p: project }));
  },
  revise: (form) => {
    const feedback = form.feedback.value.trim();
    closeDialog();
    mutate(() => {
      const task = currentTask();
      latestDelivery(task).feedback = feedback || '—';
      task.state = 'queued';
      task.wait = { type: 'revision' };
    }, t('revisedToast'));
  },
  cancel: () => { closeDialog(); mutate(() => { currentTask().state = 'canceled'; }, t('canceledToast')); }
};

function toggleMenu(open) {
  document.getElementById('sidebar')?.classList.toggle('open', open);
  const scrim = document.getElementById('scrim');
  if (scrim) scrim.hidden = !open;
}

document.addEventListener('click', (event) => {
  const agentBtn = event.target.closest('[data-agent]');
  if (agentBtn) {
    agentBtn.parentElement.querySelectorAll('[data-agent]').forEach((b) => b.setAttribute('aria-pressed', String(b === agentBtn)));
    return;
  }
  if (event.target.id === 'scrim') { toggleMenu(false); return; }
  const el = event.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});

document.addEventListener('change', (event) => {
  if (event.target.dataset.role !== 'project') return;
  const project = projectById(event.target.value);
  event.target.form.querySelector('[data-role="machine-field"]').innerHTML = machineField(project);
  event.target.form.querySelectorAll('[data-agent]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.agent === project.lastAgent)));
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!FORMS[form.dataset.form]) return;
  event.preventDefault();
  FORMS[form.dataset.form](form);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') toggleMenu(false);
});

/* ---------- 入口 ---------- */

const PAGES = {
  inbox: { render: renderInbox, active: () => 'inbox' },
  project: { render: renderProject, active: () => 'project:' + (new URLSearchParams(location.search).get('p') ?? PROJECTS[0].id) },
  task: { render: renderTask, active: () => 'project:' + (currentTask()?.project ?? '') },
  machines: { render: renderMachines, active: () => 'machines' },
  login: { render: renderLogin, active: () => '' }
};

function render() {
  const page = PAGES[document.body.dataset.page];
  if (!page) return;
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  if (document.body.dataset.page === 'inbox') document.title = `${t('inbox')} · ${t('appName')}`;
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.innerHTML = renderSidebar(page.active());
    sidebar.setAttribute('aria-label', t('nav'));
  }
  document.getElementById('main').innerHTML = page.render();
}

render();
