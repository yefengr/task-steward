import { createHash } from 'node:crypto';
import * as c from '@pi-steward/contract';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerAttemptControl } from './attempt-control.js';
import { AgentError, agentClient, taskManagementClient, validatedBody } from './client.js';
import type { ClientOptions } from './client.js';
import { retryableWrites } from './retry-writes.js';

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
  if (!attempt.success) return;
  const request = agentClient(attempt.data, options);
  const control = registerAttemptControl(pi, attempt.data, request);
  const write = retryableWrites();
  const requestId = deliveryId(attempt.data);
  let delivered = false;

  pi.registerTool({
    name: 'steward_task', label: '读取 Steward 任务', description: '读取本次任务的目标、验收要求、决定、交付与返修反馈。',
    parameters: Type.Object({}),
    execute: (_id, _args, signal) => report(async () => {
      const data = await request('GET', 'context', c.agentContextResponseSchema, undefined, signal);
      control.noteTaskType(data.task.type);
      return data;
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
    name: 'steward_deliver', label: '保存 Steward 交付', description: '保存本次交付。网络失败时使用完全相同的参数重试。',
    parameters: deliveryParameters,
    execute: (_id, args, signal) => report(async () => {
      const saved = await request('POST', 'deliveries', c.agentDeliveryResponseSchema,
        validatedBody(c.agentDeliveryRequestSchema, { ...args, requestId }), signal);
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
