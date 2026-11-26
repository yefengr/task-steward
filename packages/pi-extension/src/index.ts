import { createHash } from 'node:crypto';
import * as c from '@pi-steward/contract';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerAttemptControl } from './attempt-control.js';
import { AgentError, agentClient, taskManagementClient, validatedBody } from './client.js';
import type { ClientOptions } from './client.js';
import { retryableWrites } from './retry-writes.js';
import { registerSessionReport } from './session-report.js';
import { registerTaskSession } from './task-session.js';
import { checkReworkWorkspace } from './workspace.js';
import { prepareGit, proveWorkspace } from './git-lifecycle.js';

const text = () => Type.String({ maxLength: 100_000 });
const lines = () => Type.Array(text());
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
    const guidance = code === 'cancelled' ? '请求已取消。' :
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
      code === 'git_workspace_unverified' || code === 'git_snapshot_conflict' || code === 'git_dedicated_branch_required' ? '当前分支、HEAD 或现场与冻结快照不符；重新读取 steward_task 并切回原任务工作树与会话，不创建替代现场。' :
      code === 'git_implementation_required' ? '只为实现任务准备 Git；只读或讨论任务不要创建工作树。' :
      code === 'task_context_required' ? '请先调用 steward_task 确认任务类型；只为实现任务记录工作现场。' :
      code === 'workspace_unavailable' ? '无法核对当前目录、Git 或持久化 Pi 会话；请核对本机现场，必要时向用户确认。' :
      code === 'attempt_ended' ? '本次尝试已结束，请检查平台状态。' :
      code === 'conflict' ? '请核对平台状态。交付请求重试时请保留原参数。' :
      code === 'pending_writes_full' ? '待确认的请求已达上限，请先使用原参数重试已有请求。' :
      code === 'invalid_config' ? '请检查本机配置及 0600 文件权限后重试。' : '请稍后使用相同参数重试。';
    return result(`Steward 请求失败（${code}）。${guidance}`, { code });
  }
}

const editableTask = {
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  goal: Type.Optional(text()), acceptance: Type.Optional(text()), notes: Type.Optional(text()),
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
    name: 'steward_create_task', label: '新建 Steward 待办', description: '应用户要求新建待办，不安排执行。选择 discussion（讨论）或 implementation（实现，默认）。网络请求结果未知时使用原参数重试。',
    parameters: Type.Object({ ...editableTask, projectId: projectIdParameter, title: Type.String({ minLength: 1, maxLength: 500 }),
      type: Type.Optional(Type.Union([Type.Literal('discussion'), Type.Literal('implementation')])) }),
    execute: (_id, args, signal, _update, ctx) => report(() => {
      const input = { ...args, sessionId: ctx.sessionManager.getSessionId() };
      return write('POST', 'tasks', input, (requestId) => request('POST', 'tasks', c.webTaskMutationResponseSchema,
        validatedBody(c.managedCreateTaskRequestSchema, { ...input, requestId }), signal));
    }),
  });
  pi.registerTool({
    name: 'steward_update_task', label: '修改 Steward 任务', description: '应用户要求修改标题、目标、验收要求或备注。传入读到的版本；若版本冲突，先重新读取并核对差异。',
    parameters: Type.Object({ ...editableTask, taskId: Type.String(), version: Type.Integer({ minimum: 1 }) }),
    execute: (_id, { taskId, ...args }, signal, _update, ctx) => report(() => {
      const route = `tasks/${validatedBody(c.uuidSchema, taskId)}`;
      const input = { ...args, sessionId: ctx.sessionManager.getSessionId() };
      return write('PATCH', route, input, (requestId) => request('PATCH', route, c.webTaskMutationResponseSchema,
        validatedBody(c.managedUpdateTaskRequestSchema, { ...input, requestId }), signal));
    }),
  });
}

function deliveryId(attemptId: string) {
  // 平台每个尝试只接受一份交付。使用派生 UUID，Pi 重载后也能重放同一请求。
  const hex = createHash('sha256').update(`pi-steward:delivery:${attemptId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function registerSteward(pi: ExtensionAPI, options: ClientOptions = { env: process.env }) {
  registerTaskManagement(pi, options);
  const attempt = c.uuidSchema.safeParse(options.env.STEWARD_ATTEMPT_ID);
  registerTaskSession(pi, attempt.success);
  if (!attempt.success) return;
  const request = agentClient(attempt.data, options);
  const sessionReport = registerSessionReport(pi, request, options.env.STEWARD_RESUME === '1');
  const control = registerAttemptControl(pi, attempt.data, request);
  const write = retryableWrites();
  const requestId = deliveryId(attempt.data);
  let delivered = false;
  let taskContext: c.AgentContextResponse | undefined;

  pi.registerTool({
    name: 'steward_task', label: '读取 Steward 任务', description: '读取本次任务的目标、验收要求、决定、交付、返修反馈及工作现场核对结果。',
    parameters: Type.Object({}),
    execute: (_id, _args, signal, _update, ctx) => report(async () => {
      taskContext = undefined;
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      control.noteTaskType(data.task.type);
      taskContext = data;
      const reworkWorkspace = await checkReworkWorkspace(ctx, data);
      return reworkWorkspace ? { ...data, reworkWorkspace } : data;
    }),
  });
  pi.registerTool({
    name: 'steward_prepare_git', label: '准备任务 Git 基线',
    description: '代码写入前显式同步并固定基线。返回 baseRef 后交给现有 Pi worktree_create；不自行创建或迁移会话。',
    parameters: Type.Object({ taskBranch: Type.String() }),
    execute: (_id, { taskBranch }, signal) => report(async () => {
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      if (!data.git && !pi.getAllTools().some((tool) => tool.name === 'worktree_create')) throw new AgentError('git_worktree_capability_required');
      const prepared = await prepareGit(data, taskBranch);
      let snapshot: c.TaskGit;
      if ('phase' in prepared) snapshot = prepared;
      else {
        const saved = await write('POST', 'git/prepare', prepared, (id) => request('POST', 'git/prepare', c.agentPrepareGitResponseSchema,
          validatedBody(c.agentPrepareGitRequestSchema, { ...prepared, requestId: id }), signal));
        snapshot = saved.git;
      }
      taskContext = { ...data, git: snapshot };
      return { git: snapshot, baseRef: snapshot.baseCommit, taskBranch: snapshot.taskBranch };
    }),
  });
  pi.registerTool({
    name: 'steward_record_workspace', label: '记录 Steward 工作现场',
    description: '实现任务确认工作空间后，保存当前 Pi 会话的实际工作目录、Git 分支和会话定位。迁移或切换后在目标会话调用。',
    parameters: Type.Object({}),
    execute: (_id, _args, signal, _update, ctx) => report(async () => {
      if (taskContext?.task.type !== 'implementation') throw new AgentError('task_context_required');
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      taskContext = data;
      return sessionReport.workspace(async () => {
        const workspace = await proveWorkspace(ctx, data);
        await write('POST', 'workspace', workspace, (requestId) => request('POST', 'workspace', c.okResponseSchema,
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
    name: 'steward_deliver', label: '保存 Steward 交付', description: '保存本次交付。已准备 Git 的代码任务必须传完整 HEAD SHA 作为 commit；baseCommit 可省略并使用冻结快照，显式传入必须完全一致。只读任务不要求提交。仅网络结果未知时使用完全相同的参数重试。',
    parameters: deliveryParameters,
    execute: (_id, args, signal, _update, ctx) => report(async () => {
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      if (data.git) await proveWorkspace(ctx, data, args);
      const saved = await request('POST', 'deliveries', c.agentDeliveryResponseSchema,
        validatedBody(c.agentDeliveryRequestSchema, { ...args, ...(data.git ? { baseCommit: args.baseCommit ?? data.git.baseCommit } : {}), requestId }), signal);
      delivered = true;
      return saved;
    }),
  });
  pi.registerTool({
    name: 'steward_finish', label: '结束 Steward 执行', description: '交付已确认保存且本次执行已收尾时，请求 Pi 结束。',
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx): Promise<AgentToolResult<{ code: string } | { ok: boolean }>> {
      if (!delivered && !control.deliverySaved) return result('尚未确认保存交付，不能结束。若用户要放弃任务，请用户在平台取消或在 Pi 中直接退出。',
        { code: 'delivery_required' });
      control.finish(ctx);
      return result('已请求 Pi 在本轮结束后退出。', { ok: true });
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerSteward(pi);
}
