import { randomUUID } from 'node:crypto';
import * as c from '@pi-steward/contract';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AgentError, agentClient } from './client.js';

type Request = ReturnType<typeof agentClient>;
const POLL_MS = 5_000;
const CLOSE_RETRY_MS = 30_000;
const MAX_CLOSE_TURNS = 3;
const CONTROL_ENTRY = 'steward-attempt-control';
const closeInput = /^(?:请\s*)?结束讨论[。.!！]?$/u;
const pendingSchema = c.requestIdSchema.extend({ waitId: c.uuidSchema.nullable() });
type PendingReply = { requestId: string; waitId: string | null };

export function registerAttemptControl(pi: ExtensionAPI, attemptId: string, request: Request) {
  let control: c.AgentControlResponse | undefined;
  let taskType: c.TaskType | undefined;
  let pendingReply: PendingReply | undefined;
  let pendingEnd: string | undefined;
  let uncertainWait = true;
  let closingTurns = 0;
  let nextClosingAt = 0;
  let shutdownRequested = false;
  let context: ExtensionContext | undefined;
  let lifetime: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operations = Promise.resolve();

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = operations.then(run);
    operations = next.then(() => undefined, () => undefined);
    return next;
  }

  function remember() {
    if (context) pi.appendEntry(CONTROL_ENTRY, { attemptId, pendingReply, pendingEnd });
  }

  async function read(signal?: AbortSignal) {
    const next = await request('GET', 'control', c.agentControlResponseSchema, undefined, signal);
    if (signal?.aborted) return next;
    control = next;
    taskType = next.type;
    uncertainWait = false;
    return next;
  }

  async function flushReply(signal?: AbortSignal) {
    if (!pendingReply) return;
    if (pendingReply.waitId === null) {
      pendingReply.waitId = (uncertainWait || !control ? await read(signal) : control).waitId;
      if (signal?.aborted) return;
      remember();
    }
    if (pendingReply.waitId !== null) {
      await request('POST', 'reply', c.okResponseSchema,
        { requestId: pendingReply.requestId, waitId: pendingReply.waitId }, signal);
    }
    if (signal?.aborted) return;
    if (control && control.waitId === pendingReply.waitId) control = { ...control, waitId: null };
    pendingReply = undefined;
    remember();
  }

  function finish(ctx: Pick<ExtensionContext, 'shutdown'>) {
    if (shutdownRequested) return;
    shutdownRequested = true;
    ctx.shutdown();
  }

  function startClosingTurn(ctx: ExtensionContext) {
    if (control?.type !== 'discussion' || !control.discussionEndRequested || !ctx.isIdle() || Date.now() < nextClosingAt) return;
    if (closingTurns >= MAX_CLOSE_TURNS) {
      if (closingTurns === MAX_CLOSE_TURNS) {
        closingTurns++;
        if (ctx.hasUI) ctx.ui.notify('讨论结论还未保存。请检查本轮结果，或再次发送「结束讨论」重试。', 'warning');
      }
      return;
    }
    closingTurns++;
    nextClosingAt = Date.now() + CLOSE_RETRY_MS;
    pi.sendMessage({ customType: 'steward-end-discussion', display: true,
      content: '用户已请求结束讨论。基于本次会话整理简短结论和未决事项，用 steward_deliver 保存（结论写在 summary 或 done，未决事项写在 issues）。不要继续执行未决事项；不要取消或验收任务。保存确认后调用 steward_finish。',
    }, { triggerTurn: true, deliverAs: 'followUp' });
  }

  async function flushEnd(signal?: AbortSignal) {
    if (!pendingEnd || !taskType) return;
    if (taskType === 'discussion') {
      await request('POST', 'end-discussion', c.okResponseSchema, { requestId: pendingEnd }, signal);
      if (signal?.aborted) return;
      if (control) control = { ...control, discussionEndRequested: true };
    }
    pendingEnd = undefined;
    remember();
  }

  async function sync(ctx: ExtensionContext, signal: AbortSignal) {
    if (signal.aborted || shutdownRequested) return;
    try {
      const state = await read(signal);
      if (signal.aborted) return;
      await flushEnd(signal);
      await flushReply(signal);
      if (signal.aborted) return;
      if (state.type === 'discussion' && control?.discussionEndRequested && state.deliverySaved && ctx.isIdle()) finish(ctx);
      else if (!state.deliverySaved) startClosingTurn(ctx);
    } catch (error) {
      if (error instanceof AgentError && error.code === 'attempt_ended' && !signal.aborted) lifetime?.abort();
      // 离线不丢待确认操作；下次轮询会重试同一请求编号。
    }
  }

  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    const controller = new AbortController();
    lifetime = controller;
    for (const entry of ctx.sessionManager.getEntries().toReversed()) {
      if (entry.type !== 'custom' || entry.customType !== CONTROL_ENTRY) continue;
      const saved = entry.data as { attemptId?: string; pendingReply?: unknown; pendingEnd?: unknown } | undefined;
      if (saved?.attemptId !== attemptId) continue;
      const reply = pendingSchema.safeParse(saved.pendingReply);
      const end = c.uuidSchema.safeParse(saved.pendingEnd);
      pendingReply = reply.success ? reply.data : undefined;
      pendingEnd = end.success ? end.data : undefined;
      break;
    }
    async function poll() {
      await serial(() => sync(ctx, controller.signal));
      if (!controller.signal.aborted && !shutdownRequested) timer = setTimeout(() => void poll(), POLL_MS).unref();
    }
    void poll();
  });
  pi.on('session_shutdown', () => {
    lifetime?.abort();
    clearTimeout(timer);
    context = undefined;
  });

  pi.on('input', async (event) => {
    if (!event.text.trim() && !event.images?.length) return;
    const end = closeInput.test(event.text.trim());
    const signal = lifetime?.signal;
    const operation = serial(async () => {
      if (signal?.aborted) return;
      if (end && taskType !== 'implementation') {
        pendingEnd ??= randomUUID();
        closingTurns = 0;
        nextClosingAt = 0;
        remember();
        await flushEnd(signal);
        return;
      }
      if ((uncertainWait || control?.waitId) && !pendingReply) {
        pendingReply = { requestId: randomUUID(), waitId: uncertainWait ? null : control?.waitId ?? null };
        remember();
      }
      await flushReply(signal);
    }).catch(() => undefined);
    // 普通输入不等网络；串行队列保证其回复确认先于下一次显式提问。
    if (end) await operation;
    // 保留原用户消息。Pi Reach 通过 SDK 投递用户输入，并使用该消息的开始事件确认投递。
  });

  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.promptGuidelines.push(
      'Steward：需要用户回答明确问题时调用 steward_ask，再在原 Pi 会话提问并等待；普通对话不要调用该工具。',
      '若 steward_task 显示讨论（discussion），只围绕讨论目标交流；普通回合结束、没有回复或已经形成结论，都不交付也不退出。只有收到 Steward 已确认的结束请求才整理简短结论与未决事项、交付并退出。',
    );
    if (control?.type === 'discussion' && control.discussionEndRequested) {
      event.systemPromptOptions.promptGuidelines.push(
        'Steward 已确认用户请求结束本次讨论。现在整理简短结论与未决事项，用 steward_deliver 保存（未决事项写在 issues），确认后调用 steward_finish，不继续执行未决事项。',
      );
    }
  });

  return {
    finish,
    get deliverySaved() { return control?.deliverySaved === true; },
    noteTaskType(type: c.TaskType) { taskType = type; },
    ask<T extends { waitId?: string }>(send: () => Promise<T>, signal?: AbortSignal) {
      return serial(async () => {
        await flushReply(signal);
        try {
          const asked = await send();
          if (asked.waitId && control) control = { ...control, waitId: asked.waitId };
          uncertainWait = !asked.waitId || !control;
          return asked;
        } catch (error) {
          uncertainWait = true;
          throw error;
        }
      });
    },
  };
}
