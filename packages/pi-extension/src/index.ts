import { lifecycleBlocked, isReadTool, type Permission } from './lifecycle.js';
import { registerForeground } from './foreground.js';
import { claimInstance } from './instance-guard.js';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as c from '@pi-steward/contract';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerAttemptControl } from './attempt-control.js';
import { AgentError, agentClient, taskManagementClient, validatedBody } from './client.js';
import type { ClientOptions } from './client.js';
import { retryableWrites } from './retry-writes.js';
import { registerSessionReport } from './session-report.js';
import { registerTaskSession } from './task-session.js';
import { checkReworkWorkspace, currentSessionLocator } from './workspace.js';
import { prepareGit, proveWorkspace } from './git-lifecycle.js';

const text = () => Type.String({ maxLength: 100_000 });
const lines = () => Type.Array(text());
const preparedWorkspaceNext = '先检查 taskBranch 是否已有工作树；承接时用 Pi 已有切换能力复用原树和会话，否则将精确 baseRef 和 taskBranch 交给 Pi worktree_create。目标现场须干净且无他任务占用，切换后调用 steward_task 自动确认；确认前不在主目录写代码。';
const deliveryParameters = Type.Object({
  summary: text(), done: lines(), notCovered: lines(), verification: lines(), howTo: lines(), issues: lines(),
  baseCommit: Type.Optional(text()), commit: Type.Optional(text()), reportRef: Type.Optional(text()),
});

function result<T>(text: string, details: T) {
  return { content: [{ type: 'text' as const, text }], details };
}

async function report<T>(run: () => Promise<T>): Promise<AgentToolResult<T | { code: string }>> {
  try {
    const data = await run();
    return result(JSON.stringify(data), data);
  } catch (error) {
    const code = error instanceof AgentError ? error.code : 'request_failed';
    const guidance = code === 'session_in_use' ? '原 Pi 对话仍被另一项执行或交接占用，不得继续实施或换目标编号绕过。先处理原任务；独立目标请使用原生新会话或 fork。' :
      ['binding_required', 'session_source_alive', 'session_ownership_unavailable', 'foreground_fork_requires_handover'].includes(code) ? '当前未取得执行权。不得凭历史继续实施，也不能按新未纳管目标绕过竞争；核对旧进程、当前会话和平台状态后重试。' :
      code === 'goal_interrupt_required' ? '上一目标尚未结束。请先明确结束或调用 steward_interrupt_task 中断，不得静默替换目标。' :
      code === 'discussion_end_required' ? '讨论尚未登记结束请求。用户已明确表达结束意图时调用 steward_end_discussion；否则继续交流，不自动交付。' :
      code === 'discussion_required' ? '只有讨论任务可登记结束讨论；实现任务按目标执行和交付。' :
      code === 'goal_ended' ? '历史目标已结束，不自动恢复执行；独立目标请用 transition=new。' :
      code === 'cancelled' ? '请求已取消。' :
      code === 'helper_unavailable' ? '请重新安装 Steward。' :
      code === 'proxy_unsupported' ? '显式代理需要使用 Node 24.20.0 或更高版本运行 Pi。' :
      code === 'invalid_request' ? '请检查工具参数后重试。' :
      code === 'git_commit_required' ? '已准备的代码任务必须提供完整 HEAD SHA；运行 git rev-parse HEAD，将完整输出作为 commit 后交付。' :
      code === 'git_base_commit_invalid' ? '显式 baseCommit 必须是快照中的完整基线 SHA；读取 steward_task 核对，或省略以使用快照。' :
      code === 'git_configuration_required' ? '请用户先在项目 Git 设置中配置基准分支，再调用 steward_prepare_git。' :
      code === 'git_worktree_capability_required' ? '当前 Pi 缺少 worktree_create 能力；请恢复已有 Pi 工作树能力，不得在主目录写代码。' :
      code === 'git_repository_busy' ? '仓库正在执行其他 Git 操作；待其完成后重试，不要删除锁文件。' :
      code === 'git_upstream_diverged' ? '基准分支与上游分叉；请用户协调基准分支，不要 reset 或强制同步。' :
      code === 'git_dirty' ? '基准工作树有未提交修改；请保留并由其所有者处理后再准备。' :
      code === 'git_fetch_failed' ? '上游获取失败；检查远端配置、网络和权限后再准备。' :
      code === 'git_invalid_branch' || code === 'git_upstream_invalid' || code === 'git_invalid_ref' ? '分支或上游引用无效；核对 Git 配置和原生分支名称后再准备。' :
      code === 'git_worktree_locked' ? '工作树已锁定；请其所有者确认用途，不要强制解锁或删除。' :
      code === 'git_workspace_unverified' || code === 'git_snapshot_conflict' || code === 'git_dedicated_branch_required' ? '无法确认冻结 Git 现场：先核对原任务工作树、会话、分支归属与未提交改动，不创建替代现场或重设基线。同树干净分支变更可通过 steward_task 自动登记；来源不明的改动、现场缺失或无法切换时，用 steward_ask 请用户确认。' :
      code === 'git_implementation_required' ? '只为实现任务准备 Git；只读或讨论任务不要创建工作树。' :
      code === 'task_context_required' ? '请先调用 steward_task 确认任务类型；只为实现任务记录工作现场。' :
      code === 'workspace_unavailable' ? '无法核对当前目录、Git 或持久化 Pi 会话；请核对本机现场，必要时向用户确认。' :
      code === 'attempt_ended' ? '本次尝试已结束，请检查平台状态。' :
      code === 'session_handover_pending' ? '交接核对中，保持原绑定和轮询，稍后使用原参数重试。这不代表执行权限失效，不要另建任务或绕过交接写回。' :
      code === 'conflict' ? '请核对平台状态。交付请求重试时请保留原参数。' :
      code === 'pending_writes_full' ? '待确认的请求已达上限，请先使用原参数重试已有请求。' :
      code === 'invalid_config' ? '请检查本机配置及 0600 文件权限后重试。' : '请稍后使用相同参数重试。';
    return result(`Steward 请求失败（${code}）。${guidance}`, { code });
  }
}

const editableTask = {
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  goal: Type.Optional(text()), acceptance: Type.Optional(text()), notes: Type.Optional(text()),
  priority: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('normal'), Type.Literal('low')])),
  difficulty: Type.Optional(Type.Union([
    Type.Literal('unassessed'), Type.Literal('simple'), Type.Literal('medium'), Type.Literal('complex'),
  ])),
  baseBranch: Type.Optional(Type.Union([Type.String(), Type.Null()])),
};

function registerTaskManagement(pi: ExtensionAPI, options: ClientOptions) {
  const request = taskManagementClient(options);
  const write = retryableWrites({ cancelledMayHaveSaved: true });
  const projectIdParameter = Type.String({ minLength: 1, maxLength: 128 });
  pi.registerTool({
    name: 'steward_list_projects', label: '列出 Steward 项目', description: '列出任务平台的项目。可先查项目 ID，再列出或新建任务。',
    parameters: Type.Object({}),
    execute: (_id, _args, signal) => report(() => request('GET', 'projects', c.webProjectsResponseSchema, undefined, signal)),
  });
  pi.registerTool({
    name: 'steward_list_tasks', label: '列出 Steward 任务', description: '按项目列出任务和当前状态。',
    parameters: Type.Object({ projectId: projectIdParameter }),
    execute: (_id, { projectId }, signal) => report(() => request('GET',
      `projects/${validatedBody(c.projectIdSchema, projectId)}/tasks`, c.webProjectTasksResponseSchema, undefined, signal)),
  });
  pi.registerTool({
    name: 'steward_get_task', label: '查看 Steward 任务', description: '按任务 ID 查看说明、状态、进展和交付，修改前可读取当前版本。',
    parameters: Type.Object({ taskId: Type.String() }),
    execute: (_id, { taskId }, signal) => report(() => request('GET',
      `tasks/${validatedBody(c.uuidSchema, taskId)}`, c.webTaskDetailResponseSchema, undefined, signal)),
  });
  pi.registerTool({
    name: 'steward_create_task', label: '新建 Steward 待办', description: '应用户要求新建待办，不安排执行。选择 discussion（讨论）或 implementation（实现，默认）；可设置 priority（high/normal/low，默认 normal）和 difficulty（unassessed/simple/medium/complex，默认 unassessed，仅供人工参考，不选择智能体）。网络请求结果未知时使用原参数重试。',
    parameters: Type.Object({ ...editableTask, projectId: projectIdParameter, title: Type.String({ minLength: 1, maxLength: 500 }),
      type: Type.Optional(Type.Union([Type.Literal('discussion'), Type.Literal('implementation')])) }),
    execute: (_id, args, signal, _update, ctx) => report(() => {
      const input = { ...args, sessionId: ctx.sessionManager.getSessionId() };
      return write('POST', 'tasks', input, (requestId) => request('POST', 'tasks', c.webTaskMutationResponseSchema,
        validatedBody(c.managedCreateTaskRequestSchema, { ...input, requestId }), signal));
    }),
  });
  pi.registerTool({
    name: 'steward_update_task', label: '修改 Steward 任务', description: '应用户要求修改标题、目标、验收要求、备注、优先级或难度（仅供人工参考）。传入读到的版本；若版本冲突，先重新读取并核对差异。',
    parameters: Type.Object({ ...editableTask, taskId: Type.String(), version: Type.Integer({ minimum: 1 }) }),
    execute: (_id, { taskId, ...args }, signal, _update, ctx) => report(() => {
      const route = `tasks/${validatedBody(c.uuidSchema, taskId)}`;
      const input = { ...args, sessionId: ctx.sessionManager.getSessionId() };
      return write('PATCH', route, input, (requestId) => request('PATCH', route, c.webTaskMutationResponseSchema,
        validatedBody(c.managedUpdateTaskRequestSchema, { ...input, requestId }), signal));
    }),
  });
}

function deliveryId(attemptId: string, revision = 0) {
  // 每工作段的实施交付使用派生 UUID，Pi 重载后也能重放同一请求。
  const hex = createHash('sha256').update(`pi-steward:delivery:${attemptId}${revision ? `:${revision}` : ''}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function registerSteward(pi: ExtensionAPI, options: ClientOptions = { env: process.env }) {
  registerTaskManagement(pi, options);
  const attempt = c.uuidSchema.safeParse(options.env.STEWARD_ATTEMPT_ID);
  let activeId = attempt.success ? attempt.data : undefined;
  let epoch = 0;
  let workRevision = 0;
  let permission: Permission = {};
  function adopt(state: Permission) {
    if (state.workRevision !== undefined && state.workRevision !== workRevision) {
      epoch++;
      workRevision = state.workRevision;
      write = retryableWrites({ generation: () => epoch });
      requestId = activeId ? deliveryId(activeId, workRevision) : '';
      delivered = false;
      taskContext = undefined;
      foreground.setWorkRevision(workRevision);
    }
    permission = state;
    control.accept(state);
  }
  const request: ReturnType<typeof agentClient> = async (...args) => {
    if (!activeId) throw new AgentError('binding_required');
    const id = activeId;
    const generation = epoch;
    try {
      const data = await agentClient(id, options, foreground?.binding ? foreground.ownerId : undefined, workRevision)(...args);
      if (generation !== epoch || id !== activeId) throw new AgentError('binding_changed');
      if (args[0] === 'GET' && ['context', 'control'].includes(args[1])) adopt(data as Permission);
      return data;
    } catch (error) {
      // 交接核对中的可重试错误不在失权列表内，保留原绑定及 control 轮询。
      if (generation === epoch && id === activeId && foreground.binding && error instanceof AgentError &&
          ['forbidden', 'attempt_ended', 'session_in_use'].includes(error.code)) foreground.suspend(true, error.code === 'session_in_use');
      throw error;
    }
  };
  function scopedRequest(): ReturnType<typeof agentClient> {
    const generation = epoch;
    return (...args) => generation === epoch ? request(...args) : Promise.reject(new AgentError('binding_changed'));
  }
  const sessionReport = registerSessionReport(pi, request, options.env.STEWARD_RESUME === '1', !attempt.success);
  const control = registerAttemptControl(pi, activeId ?? '', request, !attempt.success, options.env.STEWARD_CONTINUATION === '1');
  let write = retryableWrites({ generation: () => epoch });
  const recordWrite = retryableWrites();
  let requestId = activeId ? deliveryId(activeId) : '';
  const foreground = registerForeground(pi, options, (binding, ctx) => {
    epoch++;
    activeId = binding.attemptId;
    delivered = false;
    taskContext = undefined;
    workRevision = foreground.workRevision;
    permission = {};
    write = retryableWrites({ generation: () => epoch });
    requestId = deliveryId(activeId, workRevision);
    const id = activeId;
    const boundRequest: ReturnType<typeof agentClient> = (...args) => activeId === id ? request(...args) : Promise.reject(new AgentError('binding_changed'));
    control.activate(ctx, activeId, boundRequest);
    sessionReport.activate(ctx, boundRequest);
  }, () => {
    if (attempt.success) return;
    epoch++;
    activeId = undefined;
    control.deactivate();
    sessionReport.deactivate();
    delivered = false;
    taskContext = undefined;
  });
  pi.on('tool_call', async (event) => {
    if (!activeId || isReadTool(event.toolName)) return;
    let state: c.AgentControlResponse;
    try { state = await request('GET', 'control', c.agentControlResponseSchema); }
    catch (error) {
      const reason = error instanceof AgentError && error.code === 'session_handover_pending'
        ? 'Steward 交接核对中（session_handover_pending），保持原绑定，稍后使用原参数重试；当前不允许写回。'
        : '无法确认当前工作段权限，禁止执行可能写入的工具；本地只读工具仍可使用。';
      return { block: true, reason };
    }
    if (lifecycleBlocked(event.toolName, state)) return { block: true, reason: '当前工作段已交付、结算或冻结，禁止隐性实施。仅可读取、收尾或经用户明确授权调用 steward_continue / steward_revise_delivery。' };
  });
  pi.on('user_bash', async () => {
    if (!activeId) return;
    let state: c.AgentControlResponse;
    try { state = await request('GET', 'control', c.agentControlResponseSchema); }
    catch { return { result: { output: '无法确认当前工作段权限，禁止执行 shell 命令。', exitCode: 1, cancelled: false, truncated: false } }; }
    if (lifecycleBlocked('bash', state)) return { result: { output: '当前工作段无实施权限。', exitCode: 1, cancelled: false, truncated: false } };
  });
  registerTaskSession(pi, () => activeId ? (foreground.binding ? 'foreground' : 'background') : false);
  pi.registerTool({
    name: 'steward_begin_task', executionMode: 'sequential', label: '开始前台目标',
    description: '明确目标时自动调用登记并取得前台执行权；普通随口问答不调用。continue 复用当前目标；new 必须先结束或明确中断旧目标。离线新目标尚未纳管，不享有平台权限；历史纳管目标恢复失败不得继续写入。网络未知用 continue 原参数重试。',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), goal: text(),
      acceptance: Type.Optional(text()), notes: Type.Optional(text()),
      type: Type.Union([Type.Literal('discussion'), Type.Literal('implementation')]),
      transition: Type.Union([Type.Literal('continue'), Type.Literal('new')]) }),
    execute: (_id, args, signal, _update, ctx) => report(async () => {
      if (attempt.success) throw new AgentError('already_bound');
      try {
        return await foreground.begin({ ...args, acceptance: args.acceptance ?? '', notes: args.notes ?? '' }, ctx, signal);
      } catch (error) {
        if (error instanceof AgentError && ['network_error', 'unauthorized', 'internal_error', 'invalid_config', 'project_not_registered'].includes(error.code)) {
          const message = foreground.managedHistory ? '历史目标当前未取得执行权，不得继续实施或离线绕过。' :
            '本目标尚未纳管，没有平台执行权限。可按用户本地授权工作；纳管重试请保留同一目标，不能声称平台已保存。';
          return { code: error.code, managed: foreground.managedHistory, bound: false, message };
        }
        throw error;
      }
    }),
  });
  pi.registerTool({
    name: 'steward_interrupt_task', executionMode: 'sequential', label: '中断前台目标', description: '用户明确切换或放弃当前目标时调用，不关 Pi、不回滚。当前有执行权时中断平台执行；fork或失权历史仅解除本地关联，并明确平台任务未改变。等待回复不要调用。',
    parameters: Type.Object({}), execute: (_id, _args, signal) => report(() => foreground.close('interrupt', signal)),
  });
  let delivered = false;
  let taskContext: c.AgentContextResponse | undefined;

  async function autoWorkspace(ctx: ExtensionContext, data: c.AgentContextResponse, signal?: AbortSignal) {
    const scoped = scopedRequest();
    if (data.task.type !== 'implementation' || !data.git || !data.implementationAllowed) return 'not_required';
    // 准备仅冻结基线；迁移前不在主树登记，尚未落盘的 Pi 会话也不能冒充已保存。
    if (!data.git.worktreePath && ctx.cwd === data.git.repositoryPath) return 'prepared';
    if (data.git.worktreePath && ctx.cwd !== data.git.worktreePath && !ctx.cwd.startsWith(`${data.git.worktreePath}/`)) return 'switch_required';
    if (data.git.worktreePath && await realpath(data.git.worktreePath).catch(() => undefined) !== data.git.worktreePath) {
      throw new AgentError('git_workspace_unverified');
    }
    const locator = await currentSessionLocator(ctx, true).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new AgentError('workspace_unavailable');
    });
    if (!locator) return 'pending_session';
    try {
      await sessionReport.workspace(async () => {
        const workspace = await proveWorkspace(ctx, data);
        await write('POST', 'workspace', workspace, (requestId) => scoped('POST', 'workspace', c.okResponseSchema,
          validatedBody(c.agentWorkspaceRequestSchema, { workspace, requestId }), signal));
      });
    } catch (error) {
      if (error instanceof AgentError && error.code === 'conflict') throw new AgentError('git_workspace_unverified');
      throw error;
    }
    return 'confirmed';
  }
  pi.on('session_start', async (_event, ctx) => {
    if (!activeId) return;
    try {
      const data = await request('GET', 'context', c.agentContextResponseSchema);
      await autoWorkspace(ctx, data);
    } catch { /* 工具下一次读取会重新核验并明确返回错误，不把后台失败当作已登记。 */ }
  });

  pi.registerTool({
    name: 'steward_task', label: '读取 Steward 任务', description: '读取本次任务的目标、验收要求、决定、交付、返修反馈及工作现场核对结果。',
    parameters: Type.Object({}),
    execute: (_id, _args, signal, _update, ctx) => report(async () => {
      taskContext = undefined;
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      control.noteTaskType(data.task.type);
      const workspaceStatus = await autoWorkspace(ctx, data, signal);
      const current = workspaceStatus === 'confirmed' ? await request('GET', 'context', c.agentContextResponseSchema, undefined, signal) : data;
      taskContext = current;
      const reworkWorkspace = workspaceStatus === 'switch_required' ? 'switch_required' : await checkReworkWorkspace(ctx, current);
      const next = workspaceStatus === 'switch_required' ? '用 Pi 已有能力切回 git.worktreePath 对应的原会话，再调用 steward_task；无法切换或原现场缺失时 steward_ask，不创建替代工作树。' :
        workspaceStatus === 'pending_session' ? '持久会话尚未落盘，暂不写代码或交付；首条消息保存后重读 steward_task，仍无法确认时 steward_ask。' :
          reworkWorkspace && reworkWorkspace !== 'confirmed' ? '原 Git 返修现场尚未确认，暂停写入并核对快照、原工作树和会话；用 steward_ask 请用户确认，不创建替代现场或重设基线。' :
            workspaceStatus === 'prepared' ? preparedWorkspaceNext : undefined;
      return { ...current, workspaceStatus, ...(reworkWorkspace ? { reworkWorkspace } : {}), ...(next ? { next } : {}) };
    }),
  });
  pi.registerTool({
    name: 'steward_prepare_git', label: '准备任务 Git 基线',
    description: '代码写入前显式同步并固定基线。返回 baseRef 后交给现有 Pi worktree_create；不自行创建或迁移会话。',
    parameters: Type.Object({ taskBranch: Type.String() }),
    execute: (_id, { taskBranch }, signal, _update, ctx) => report(async () => {
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      if (!data.git && !pi.getAllTools().some((tool) => tool.name === 'worktree_create')) throw new AgentError('git_worktree_capability_required');
      const scoped = scopedRequest();
      const prepared = await prepareGit(data, taskBranch);
      let snapshot: c.TaskGit;
      if ('phase' in prepared) snapshot = prepared;
      else {
        const saved = await write('POST', 'git/prepare', prepared, (id) => scoped('POST', 'git/prepare', c.agentPrepareGitResponseSchema,
          validatedBody(c.agentPrepareGitRequestSchema, { ...prepared, requestId: id }), signal));
        snapshot = saved.git;
      }
      taskContext = { ...data, git: snapshot };
      const workspaceStatus = await autoWorkspace(ctx, taskContext, signal);
      if (workspaceStatus === 'confirmed') {
        taskContext = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
        snapshot = taskContext.git!;
      }
      return { git: snapshot, baseRef: snapshot.baseCommit, taskBranch: snapshot.taskBranch, workspaceStatus,
        next: workspaceStatus === 'prepared' ? preparedWorkspaceNext :
          workspaceStatus === 'pending_session' ? '持久会话尚未落盘；首条消息保存后调用 steward_task 自动确认，不得声称现场已保存。' :
            workspaceStatus === 'switch_required' ? '使用 Pi 已有能力复用 git.worktreePath 和原会话，切换后 steward_task 自动确认；无法接回时 steward_ask，不创建替代现场。' :
              workspaceStatus === 'confirmed' ? '现场已自动确认，可按授权继续。' : '当前无须登记现场；按 steward_task 返回的授权执行。' };
    }),
  });
  pi.registerTool({
    name: 'steward_record_workspace', label: '记录 Steward 工作现场',
    description: '手动重试保存当前实际目录、Git 分支和会话定位；通常由 Git 准备、会话切换及 steward_task 自动登记，无需单独调用。',
    parameters: Type.Object({}),
    execute: (_id, _args, signal, _update, ctx) => report(async () => {
      if (taskContext?.task.type !== 'implementation') throw new AgentError('task_context_required');
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      taskContext = data;
      const scoped = scopedRequest();
      return sessionReport.workspace(async () => {
        const workspace = await proveWorkspace(ctx, data);
        await write('POST', 'workspace', workspace, (requestId) => scoped('POST', 'workspace', c.okResponseSchema,
          validatedBody(c.agentWorkspaceRequestSchema, { workspace, requestId }), signal));
        return { ok: true, workspace };
      });
    }),
  });
  pi.registerTool({
    name: 'steward_progress', label: '记录 Steward 进展', description: '在关键节点回报可核验的进展和剩余步骤。',
    parameters: Type.Object({ text: text() }),
    execute: (_id, args, signal) => report(() => write('POST', 'progress', args, (id) => request('POST', 'progress', c.agentProgressResponseSchema,
      validatedBody(c.agentProgressRequestSchema, { ...args, requestId: id }), signal))),
  });
  pi.registerTool({
    name: 'steward_ask', label: '提出 Steward 问题', description: '记录需要用户回应的问题，随后在 Pi 会话中等待。',
    parameters: Type.Object({ text: text(), context: text() }),
    execute: (_id, args, signal) => report(() => control.ask(() => write('POST', 'questions', args, (id) => request('POST', 'questions', c.agentCreateQuestionResponseSchema,
      validatedBody(c.agentCreateQuestionRequestSchema, { ...args, requestId: id }), signal)), signal)),
  });
  pi.registerTool({
    name: 'steward_question_update', label: '更新 Steward 问题', description: '将已经回答或不再需要的本次任务问题标为已解决或撤销。',
    parameters: Type.Object({ questionId: Type.String(), status: Type.Union([Type.Literal('resolved'), Type.Literal('withdrawn')]) }),
    execute: (_id, { questionId, status }, signal) => report(() => {
      const route = `questions/${validatedBody(c.uuidSchema, questionId)}`;
      return write('PATCH', route, { status }, (id) => request('PATCH', route, c.agentUpdateQuestionResponseSchema,
        validatedBody(c.agentUpdateQuestionRequestSchema, { requestId: id, status }), signal));
    }),
  });
  pi.registerTool({
    name: 'steward_decision', label: '记录 Steward 决定', description: '记录决定，并标明该决定是否已得到用户确认。',
    parameters: Type.Object({ text: text(), confirmedByUser: Type.Boolean() }),
    execute: (_id, args, signal) => report(() => write('POST', 'decisions', args, (id) => request('POST', 'decisions', c.agentDecisionResponseSchema,
      validatedBody(c.agentDecisionRequestSchema, { ...args, requestId: id }), signal))),
  });
  pi.registerTool({
    name: 'steward_end_discussion', executionMode: 'sequential', label: '登记结束讨论',
    description: '仅当用户明确表达结束本次讨论时，由 Agent 结合上下文判断并登记。可包括「结束当前任务」「就到这吧」；已有结论、无人回复或回合结束不算结束。确认后先说明将保存的结论摘要，不另行提问，再 steward_deliver 和 steward_finish。误判后可按已有 steward_continue 流程续做。',
    parameters: Type.Object({ reason: text(), authorizedByUser: Type.Literal(true) }),
    execute: (_id, _args, signal) => report(() => control.endDiscussion(signal)),
  });
  pi.registerTool({
    name: 'steward_deliver', label: '保存 Steward 交付', description: '保存本次交付。已准备 Git 的代码任务必须传完整 HEAD SHA 作为 commit；baseCommit 可省略并使用冻结快照，显式传入必须完全一致。只读任务不要求提交。仅网络结果未知时使用完全相同的参数重试。',
    parameters: deliveryParameters,
    execute: (_id, args, signal, _update, ctx) => report(async () => {
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      if (data.task.type === 'discussion' && !control.discussionEndConfirmed) throw new AgentError('discussion_end_required');
      const scoped = scopedRequest();
      const id = requestId;
      if (data.git) {
        await proveWorkspace(ctx, data, args);
        // 交付不能只信继承的 confirmed 字段，必须让平台看到当前实际会话。
        if (data.implementationAllowed && await autoWorkspace(ctx, data, signal) !== 'confirmed') throw new AgentError('git_workspace_unverified');
      }
      const saved = await scoped('POST', 'deliveries', c.agentDeliveryResponseSchema,
        validatedBody(c.agentDeliveryRequestSchema, { ...args, ...(data.git ? { baseCommit: args.baseCommit ?? data.git.baseCommit } : {}), requestId: id }), signal);
      delivered = true;
      foreground.noteDelivered();
      return saved;
    }),
  });
  function recordRequest(): ReturnType<typeof agentClient> {
    const binding = foreground.recordBinding;
    const id = activeId ?? binding?.attemptId;
    if (!id || (!attempt.success && !binding)) throw new AgentError('binding_required');
    return agentClient(id, options, binding ? foreground.ownerId : undefined, activeId ? workRevision : foreground.workRevision);
  }
  pi.registerTool({
    name: 'steward_continue', executionMode: 'sequential', label: '授权原会话继续实施',
    description: '仅当用户在原会话明确授权实质续做时调用。在原 attempt、会话和现场开启新工作段，不是恢复历史，不另建任务。',
    parameters: Type.Object({ deliveryId: Type.String(), reason: text(), authorizedByUser: Type.Literal(true) }),
    execute: (_id, args, signal, _update, ctx) => report(async () => {
      const request = recordRequest();
      const id = activeId ?? foreground.recordBinding!.attemptId;
      const nonce = deliveryId(`${id}:continue:${JSON.stringify([args.deliveryId, args.reason, args.authorizedByUser])}`);
      const entryType = 'steward-continue-intent';
      const replay = ctx.sessionManager.getEntries().some((entry) => entry.type === 'custom' &&
        entry.customType === entryType && entry.data === nonce);
      const run = async () => {
        if (!replay) {
          const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
          if (data.recordAllowed === false) throw new AgentError('forbidden');
          // 只结算本次授权指向的已交付段，绝不结算重放时的新工作段。
          if (data.latestDeliveryId !== args.deliveryId || !['delivered', 'settled'].includes(data.phase ?? '')) throw new AgentError('conflict');
          if (!data.settled) await recordWrite('POST', 'settle', { attemptId: id, workRevision: data.workRevision },
            (requestId) => request('POST', 'settle', c.okResponseSchema, { requestId }, signal));
          pi.appendEntry(entryType, nonce);
        }
        const saved = await request('POST', 'continue', c.agentContinueResponseSchema,
          validatedBody(c.agentContinueRequestSchema, { ...args, requestId: nonce }), signal);
        // 回执不授予权限；即使原 nonce 成功重放，也必须重新读取当前权限。
        const state = await request('GET', 'control', c.agentControlResponseSchema, undefined, signal);
        adopt(state);
        if (lifecycleBlocked('write', state)) throw new AgentError('forbidden');
        return saved;
      };
      return attempt.success ? run() : foreground.continueWork(ctx, run);
    }),
  });
  pi.registerTool({
    name: 'steward_revise_delivery', executionMode: 'sequential', label: '仅修订交付记录',
    description: '仅当用户明确授权补记录时提交完整新版报告。保留原 SHA/base 和旧版本，不重开实施、不重新验证现场。',
    parameters: Type.Object({ ...deliveryParameters.properties, deliveryId: Type.String(), reason: text(), authorizedByUser: Type.Literal(true) }),
    execute: (_id, args, signal) => report(async () => {
      const request = recordRequest();
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      if (data.recordAllowed === false) throw new AgentError('forbidden');
      const source = data.deliveries.find((delivery) => delivery.id === args.deliveryId);
      if (!source) throw new AgentError('conflict');
      // schema 固定字段顺序；同值参数以不同 JSON 键顺序重试也必须重放同一修订。
      const content = validatedBody(c.agentDeliveryRevisionRequestSchema.omit({ requestId: true }),
        { ...args, commit: source.commit, baseCommit: source.baseCommit });
      const requestId = deliveryId(`${data.attempt.id}:record:${JSON.stringify(content)}`);
      return request('POST', 'delivery-revisions', c.agentDeliveryResponseSchema,
        validatedBody(c.agentDeliveryRevisionRequestSchema, { ...content, requestId }), signal);
    }),
  });
  pi.registerTool({
    name: 'steward_finish', executionMode: 'sequential', label: '结束 Steward 执行', description: '交付已保存且实施、验证和必要回报全部收尾后结算本工作段。普通 Pi 解绑，专用 Pi 保持绑定与轮询；均不退出。',
    parameters: Type.Object({}),
    async execute(_id, _args, signal): Promise<AgentToolResult<{ code: string } | { ok: boolean }>> {
      return report(async () => {
        await request('GET', 'control', c.agentControlResponseSchema, undefined, signal);
        if (!delivered && !control.deliverySaved) throw new AgentError('delivery_required');
        if (!attempt.success) return foreground.close('settle', signal);
        const saved = await write('POST', 'settle', {}, (id) => request('POST', 'settle', c.okResponseSchema, { requestId: id }, signal));
        permission = { ...permission, settled: true, implementationAllowed: false };
        return saved;
      });
    },
  });
}

export default function (pi: ExtensionAPI) {
  if (claimInstance(pi, import.meta.url)) registerSteward(pi);
}
