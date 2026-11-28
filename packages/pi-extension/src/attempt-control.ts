import { randomUUID } from 'node:crypto';
import * as c from '@pi-steward/contract';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AgentError, agentClient } from './client.js';

type Request = ReturnType<typeof agentClient>;
const POLL_MS = 5_000;
const CLOSE_RETRY_MS = 30_000;
const MAX_CLOSE_TURNS = 3;
const CONTROL_ENTRY = 'steward-attempt-control';
const CONTINUE_ENTRY = 'steward-background-continue-issued';
const pendingSchema = c.requestIdSchema.extend({ waitId: c.uuidSchema.nullable() });
type PendingReply = { requestId: string; waitId: string | null };

export function registerAttemptControl(pi: ExtensionAPI, attemptId: string, request: Request, manual = false, continuation = false) {
  let control: c.AgentControlResponse | undefined;
  let taskType: c.TaskType | undefined;
  let pendingReply: PendingReply | undefined;
  let pendingEnd: string | undefined;
  let pendingEndRevision = 0;
  let uncertainWait = true;
  let closingTurns = 0;
  let nextClosingAt = 0;
  let shutdownRequested = false;
  let context: ExtensionContext | undefined;
  let lifetime: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operations = Promise.resolve();
  let userInputPending = 0;
  let inputSequence = 0;

  function accept(next: Partial<c.AgentControlResponse>) {
    if (next.workRevision !== undefined && next.workRevision !== control?.workRevision) {
      control = undefined;
      closingTurns = 0;
      nextClosingAt = 0;
      uncertainWait = true;
    }
    control = { ...control, ...next } as c.AgentControlResponse;
    if (next.type) taskType = next.type;
  }

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = operations.then(run);
    operations = next.then(() => undefined, () => undefined);
    return next;
  }

  function remember() {
    if (context) pi.appendEntry(CONTROL_ENTRY, { attemptId, pendingReply, pendingEnd, pendingEndRevision });
  }

  async function read(signal?: AbortSignal) {
    const inputAtStart = userInputPending;
    const next = await request('GET', 'control', c.agentControlResponseSchema, undefined, signal);
    if (signal?.aborted) return next;
    accept(next);
    // 输入前已在途的旧读取不能消费新输入，否则会把抑制记到旧段。
    if (inputAtStart && inputAtStart === userInputPending && context) {
      if (!continuationIssued(context)) pi.appendEntry(CONTINUE_ENTRY, continuationKey());
      userInputPending = 0;
    }
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
      content: '用户已请求结束讨论。先说明「将保存以下结论并结束」及结论摘要，不另行提问；用 steward_deliver 保存简短结论和未决事项（结论写在 summary 或 done，未决事项写在 issues）。不要继续执行未决事项，不要取消或验收任务。保存确认后调用 steward_finish。',
    }, { triggerTurn: true, deliverAs: 'followUp' });
  }

  async function flushEnd(signal?: AbortSignal) {
    if (!pendingEnd || !taskType) return;
    if (taskType === 'discussion' && pendingEndRevision === (control?.workRevision ?? 0)) {
      await request('POST', 'end-discussion', c.okResponseSchema, { requestId: pendingEnd }, signal);
      if (signal?.aborted) return;
      if (control) control = { ...control, discussionEndRequested: true };
    }
    pendingEnd = undefined;
    remember();
  }

  function continuationKey() { return control?.workRevision ? `${attemptId}:${control.workRevision}` : attemptId; }
  function continuationIssued(ctx: ExtensionContext) {
    return ctx.sessionManager.getEntries().some((entry) => entry.type === 'custom' &&
      entry.customType === CONTINUE_ENTRY && entry.data === continuationKey());
  }

  function startContinuation(ctx: ExtensionContext, state: c.AgentControlResponse) {
    if (userInputPending || (!continuation && !state.workRevision) || manual || !state.continuationReady || state.deliverySaved || state.discussionEndRequested ||
        !ctx.isIdle() || continuationIssued(ctx)) return;
    // 先保存一次性发送意图；发送结果未知时不自动重放有副作用的接续。
    pi.appendEntry(CONTINUE_ENTRY, continuationKey());
    try {
      pi.sendMessage({ customType: 'steward-background-continue', display: true,
        content: '用户已授权在原会话接续本任务。先调用 steward_task 读取最新目标与授权，核对原会话、工作现场、实际进展及中断操作结果，再判断继续执行还是提问等待。不得重放初次开工指令或旧工具请求，不扩大授权。',
      }, { triggerTurn: true, deliverAs: 'followUp' });
    } catch {
      if (ctx.hasUI) ctx.ui.notify('自动接续消息发送未确认，未重复发送。请在原会话核对实际进展后继续。', 'warning');
    }
  }

  async function sync(ctx: ExtensionContext, signal: AbortSignal) {
    if (signal.aborted || shutdownRequested) return;
    try {
      const state = await read(signal);
      if (signal.aborted) return;
      await flushEnd(signal);
      await flushReply(signal);
      if (signal.aborted) return;
      if (state.pauseRequested || (!manual && state.closeRequested)) { finish(ctx); return; }
      if (!state.deliverySaved) { startClosingTurn(ctx); startContinuation(ctx, state); }
    } catch (error) {
      if (error instanceof AgentError && error.code === 'attempt_ended' && !signal.aborted) lifetime?.abort();
      // 离线不丢待确认操作；下次轮询会重试同一请求编号。
    }
  }

  function activate(ctx: ExtensionContext, id = attemptId, nextRequest = request) {
    request = nextRequest;
    deactivate();
    attemptId = id;
    control = undefined;
    taskType = undefined;
    pendingReply = undefined;
    pendingEnd = undefined;
    uncertainWait = true;
    userInputPending = 0;
    closingTurns = 0;
    shutdownRequested = false;
    context = ctx;
    const controller = new AbortController();
    lifetime = controller;
    for (const entry of ctx.sessionManager.getEntries().toReversed()) {
      if (entry.type !== 'custom' || entry.customType !== CONTROL_ENTRY) continue;
      const saved = entry.data as { attemptId?: string; pendingReply?: unknown; pendingEnd?: unknown; pendingEndRevision?: number } | undefined;
      if (saved?.attemptId !== attemptId) continue;
      const reply = pendingSchema.safeParse(saved.pendingReply);
      const end = c.uuidSchema.safeParse(saved.pendingEnd);
      pendingReply = reply.success ? reply.data : undefined;
      pendingEnd = end.success ? end.data : undefined;
      pendingEndRevision = saved?.pendingEndRevision ?? 0;
      break;
    }
    async function poll() {
      await serial(() => sync(ctx, controller.signal));
      if (!controller.signal.aborted && !shutdownRequested) timer = setTimeout(() => void poll(), POLL_MS).unref();
    }
    void poll();
  }
  function deactivate() {
    lifetime?.abort();
    clearTimeout(timer);
    context = undefined;
  }
  if (!manual) pi.on('session_start', (_event, ctx) => activate(ctx));
  pi.on('session_shutdown', deactivate);

  pi.on('input', async (event) => {
    if (!context || (!event.text.trim() && !event.images?.length)) return;
    // 原生用户输入优先于尚未发送的自动接续，不在其后另开一轮旧目标指令。
    userInputPending = ++inputSequence;
    const signal = lifetime?.signal;
    void serial(async () => {
      if (signal?.aborted) return;
      if ((uncertainWait || control?.waitId) && !pendingReply) {
        pendingReply = { requestId: randomUUID(), waitId: uncertainWait ? null : control?.waitId ?? null };
        remember();
      }
      await flushReply(signal);
      // 保持普通输入不等待网络；下一次控制读取前先登记用户优先意图。
      await read(signal);
    }).catch(() => undefined);
    // 输入不按关键词结束任务；由 Agent 判断语义并显式登记。
    // 保留原用户消息。Pi Reach 通过 SDK 投递用户输入，并使用该消息的开始事件确认投递。
  });

  pi.on('before_agent_start', (event) => {
    if (!context) return;
    if (control?.type === 'discussion' && control.discussionEndRequested) {
      event.systemPromptOptions.promptGuidelines.push(
        'Steward 已确认用户请求结束本次讨论。先说明「将保存以下结论并结束」及摘要，不另行提问；用 steward_deliver 保存简短结论与未决事项（未决事项写在 issues），确认后调用 steward_finish，不继续执行未决事项。',
      );
    }
  });

  return {
    activate, deactivate, accept,
    endDiscussion(signal?: AbortSignal) {
      return serial(async () => {
        const state = await read(signal);
        if (signal?.aborted) throw new AgentError('cancelled');
        if (state.type !== 'discussion') throw new AgentError('discussion_required');
        if (pendingEndRevision !== (state.workRevision ?? 0)) pendingEnd = undefined;
        if (!state.discussionEndRequested) {
          pendingEnd ??= randomUUID();
          pendingEndRevision = state.workRevision ?? 0;
          closingTurns = 0;
          nextClosingAt = 0;
          remember();
          await flushEnd(signal);
          if (signal?.aborted) throw new AgentError('cancelled');
        }
        return { ok: true, discussionEndRequested: true };
      });
    },
    get discussionEndConfirmed() { return control?.discussionEndRequested === true; },
    finish,
    get deliverySaved() { return control?.deliverySaved === true; },
    noteTaskType(type: c.TaskType) { taskType = type; },
    ask<T extends { waitId?: string }>(send: () => Promise<T>, signal?: AbortSignal) {
      const lifetimeSignal = lifetime?.signal;
      const requestSignal = lifetimeSignal && signal ? AbortSignal.any([lifetimeSignal, signal]) : lifetimeSignal ?? signal;
      return serial(async () => {
        if (requestSignal?.aborted) throw new AgentError('binding_changed');
        await flushReply(requestSignal);
        if (requestSignal?.aborted) throw new AgentError('binding_changed');
        try {
          const asked = await send();
          if (requestSignal?.aborted) throw new AgentError('binding_changed');
          if (asked.waitId && control) control = { ...control, waitId: asked.waitId };
          uncertainWait = !asked.waitId || !control;
          return asked;
        } catch (error) {
          if (!requestSignal?.aborted) uncertainWait = true;
          throw error;
        }
      });
    },
  };
}
