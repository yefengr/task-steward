import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as c from '@pi-steward/contract';
import { acquireExecutionLock, processStatus } from '@pi-steward/execution-runtime';
import { AgentError, agentClient, loadConfigWithPath, taskManagementClient } from './client.js';
import type { ClientOptions } from './client.js';
import { currentSessionLocator, currentWorkspace } from './workspace.js';

const ENTRY = 'steward-foreground-goal';
const OWNER = Symbol.for('pi-steward.foreground-owner');
const globals = globalThis as typeof globalThis & { [OWNER]?: string };
const ownerId = globals[OWNER] ??= randomUUID();
// 仅保存不可逆摘要，用于区分同一进程 reload 与 PID 复用；绝不保存 ownerId。
const ownerTag = createHash('sha256').update(ownerId).digest('hex');
type Start = Pick<c.ForegroundStartRequest, 'title' | 'goal' | 'acceptance' | 'notes' | 'type'>;
type Payload = Omit<c.ForegroundStartRequest, 'ownerId' | 'requestId'>;
type Saved = { goalId: string; start: Start; requestId: string; binding?: c.ForegroundBinding; ended?: boolean;
  endReason?: 'settle' | 'interrupt' | 'detach'; denied?: boolean; deniedSession?: string;
  sent?: boolean; pending?: boolean; deliveryKnown?: boolean; ownerTag?: string; payload?: Payload; closeIds?: Partial<Record<'settle' | 'interrupt', string>>; sessionId: string };

export function registerForeground(pi: ExtensionAPI, options: ClientOptions,
  activate: (binding: c.ForegroundBinding, ctx: ExtensionContext) => void, deactivate: () => void) {
  const disabled = c.uuidSchema.safeParse(options.env.STEWARD_ATTEMPT_ID).success;
  let saved: Saved | undefined;
  let bound: c.ForegroundBinding | undefined;
  let release: (() => void) | undefined;
  let busy = false;
  let generation = 0;
  let forked = false;
  let localDetachAllowed = false;
  let context: ExtensionContext | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const management = taskManagementClient(options);
  function remember() { pi.appendEntry(ENTRY, saved); }
  function suspend(allowDetach = true, sessionInUse = false) {
    localDetachAllowed ||= allowDetach;
    if (allowDetach && saved) {
      saved.denied = true;
      if (sessionInUse) saved.deniedSession = context?.sessionManager.getSessionId();
      remember();
    }
    generation++;
    clearInterval(heartbeat); heartbeat = undefined;
    bound = undefined;
    deactivate();
    // 网络/权限失败不释放本进程的锁，更不构造退出证明。
  }
  function clear() { suspend(false); release?.(); release = undefined; }
  async function begin(input: Start & { transition: 'continue' | 'new' }, ctx: ExtensionContext, signal?: AbortSignal) {
    if (disabled) throw new AgentError('already_bound');
    if (busy) throw new AgentError('foreground_busy');
    busy = true;
    context = ctx;
    const currentGeneration = generation;
    const checkCurrent = () => { if (currentGeneration !== generation) throw new AgentError('binding_changed'); };
    try {
      if (input.transition === 'new' && saved && !saved.ended) throw new AgentError('goal_interrupt_required');
      if (saved?.ended && input.transition !== 'new') {
        if (saved.endReason !== 'interrupt') throw new AgentError('goal_ended');
        saved = { ...saved, ended: false, endReason: undefined, closeIds: undefined, requestId: randomUUID() };
        remember();
      }
      if (!saved || input.transition === 'new') {
        const start: Start = { title: input.title, goal: input.goal, acceptance: input.acceptance, notes: input.notes, type: input.type };
        const deniedSession = saved?.deniedSession === ctx.sessionManager.getSessionId() ? saved.deniedSession : undefined;
        saved = { goalId: randomUUID(), requestId: randomUUID(), start, sessionId: ctx.sessionManager.getSessionId(),
          ...(deniedSession ? { deniedSession } : {}) };
        remember();
      }
      const locator = await currentSessionLocator(ctx, true);
      checkCurrent();
      if (!locator) throw new AgentError('workspace_unavailable');
      if (forked && (saved.binding || saved.sent)) throw new AgentError('foreground_fork_requires_handover');
      const { config, configPath } = loadConfigWithPath(options.env);
      let project: typeof config.projects[number] | undefined;
      for (const candidate of config.projects) {
        try { await currentWorkspace(ctx, candidate.path); project = candidate; break; } catch { /* 不同仓库不匹配 */ }
      }
      checkCurrent();
      if (!project) throw new AgentError('project_not_registered');
      // lookup 仅定位，不授予执行权；包括响应丢失且 binding 尚未保存的情况。
      let previous = saved.binding;
      if (saved.sent || previous) {
        const found = await management('GET', `foreground/${saved.goalId}`, c.foregroundLookupResponseSchema, undefined, signal);
        checkCurrent();
        previous = found.binding ?? previous;
        if (found.binding) { saved.binding = found.binding; remember(); }
      }
      if (previous && (previous.pid === process.pid ? saved.ownerTag !== ownerTag : processStatus(previous.pid) !== 'dead')) {
        throw new AgentError('session_source_alive');
      }
      if (!release) {
        try { release = acquireExecutionLock(configPath, saved.goalId); }
        catch { throw new AgentError('session_ownership_unavailable'); }
      }
      const lastLocator = saved.payload?.locator;
      const replacing = previous && (!bound || !lastLocator || lastLocator.path !== locator.path ||
        lastLocator.sessionId !== locator.sessionId || lastLocator.sessionFile !== locator.sessionFile);
      let payload: Payload = { ...saved.start, goalId: saved.goalId, pid: process.pid,
        projectId: project.id, projectName: project.name, registeredPath: project.path, locator,
        ...(replacing && previous ? { previousAttemptId: previous.attemptId, previousOwnerPid: previous.pid } : {}) };
      // 同 owner 的未知请求必须重放原正文，不能因 lookup 新增 previous 字段而改变。
      if (saved.pending && saved.ownerTag === ownerTag && saved.payload && !bound &&
          JSON.stringify({ ...payload, previousAttemptId: saved.payload.previousAttemptId,
            previousOwnerPid: saved.payload.previousOwnerPid }) === JSON.stringify(saved.payload) && !saved.closeIds) payload = saved.payload;
      if (saved.ownerTag !== ownerTag || JSON.stringify(saved.payload) !== JSON.stringify(payload)) saved.requestId = randomUUID();
      saved.payload = payload;
      saved.ownerTag = ownerTag;
      saved.sent = true;
      saved.pending = true;
      remember();
      const body = c.foregroundStartRequestSchema.parse({ ...payload, requestId: saved.requestId, ownerId });
      const starting = saved;
      const data = await management('POST', 'foreground/start', c.foregroundStartResponseSchema, body, signal).catch((error: unknown) => {
        // 交接核对是明确未应用 start 的拒绝，不按网络未知结果重放；迟到响应不能改写新目标。
        if (currentGeneration === generation && saved === starting && error instanceof AgentError && error.code === 'session_handover_pending') {
          starting.pending = false;
          remember();
        }
        throw error;
      });
      checkCurrent();
      saved.pending = false;
      saved.denied = false; saved.deniedSession = undefined;
      saved.binding = data.binding;
      saved.sessionId = locator.sessionId;
      remember();
      const changed = bound?.attemptId !== data.binding.attemptId;
      bound = data.binding;
      localDetachAllowed = false;
      if (changed) { clearInterval(heartbeat); heartbeat = undefined; activate(bound, ctx); }
      if (!heartbeat) {
        const request = agentClient(bound.attemptId, options, ownerId);
        heartbeat = setInterval(() => {
          // session_handover_pending 仅阻止当前写回；继续心跳等待交接核对结果，不撤销绑定。
          void request('POST', 'foreground/heartbeat', c.okResponseSchema, { requestId: randomUUID() }).catch((error: unknown) => {
            if (bound?.attemptId === data.binding.attemptId && error instanceof AgentError && ['forbidden', 'attempt_ended', 'conflict'].includes(error.code)) suspend();
          });
        }, 15_000).unref();
      }
      return data;
    } catch (error) {
      if (error instanceof AgentError && ['forbidden', 'attempt_ended', 'conflict', 'session_in_use'].includes(error.code)) suspend(true, error.code === 'session_in_use');
      throw error;
    } finally { busy = false; }
  }
  async function close(route: 'settle' | 'interrupt', signal?: AbortSignal) {
    if (disabled) throw new AgentError('already_bound');
    if (!saved || saved.ended) throw new AgentError('binding_required');
    if (!bound && route === 'interrupt' && (forked || localDetachAllowed)) {
      saved.ended = true; saved.endReason = 'detach'; remember(); clear();
      return { ok: true, localOnly: true, message: '仅解除当前会话的历史关联；平台原任务及真正执行者未改变，也未声称已中断远端执行。可为独立目标使用 transition=new。' };
    }
    const localOwner = !forked && saved.ownerTag === ownerTag ? saved.binding : undefined;
    const replay = localOwner && (saved.closeIds?.[route] || route === 'settle') ? localOwner : undefined;
    if (!bound && !replay) {
      if (route === 'interrupt' && !saved.sent && !saved.binding) {
        saved.ended = true; saved.endReason = 'interrupt'; remember(); clear(); return { ok: true };
      }
      if (!context) throw new AgentError('binding_required');
      // 网络未知必须查询并重新取得当前所有权后才能封闭，不能静默丢弃。
      await begin({ ...saved.start, transition: 'continue' }, context, signal);
    }
    const ids = saved.closeIds ??= {};
    ids[route] ??= randomUUID();
    remember();
    const closing = saved;
    const closeGeneration = generation;
    try {
      await agentClient((bound ?? replay)!.attemptId, options, ownerId)('POST', `foreground/${route}`, c.okResponseSchema,
        { requestId: ids[route] }, signal);
    } catch (error) {
      if (closeGeneration === generation && saved === closing && error instanceof AgentError &&
          ['forbidden', 'attempt_ended', 'conflict'].includes(error.code)) suspend();
      throw error;
    }
    if (generation !== closeGeneration || saved !== closing) throw new AgentError('binding_changed');
    saved.ended = true;
    saved.endReason = route;
    remember(); clear();
    return { ok: true };
  }
  pi.on('session_start', (event, ctx) => {
    if (disabled) return;
    forked = event.reason === 'fork'; context = ctx;
    clear(); localDetachAllowed = forked; saved = undefined;
    for (const entry of ctx.sessionManager.getBranch().toReversed()) {
      if (entry.type !== 'custom' || entry.customType !== ENTRY) continue;
      const data = entry.data as Saved | undefined;
      if (data && c.uuidSchema.safeParse(data.goalId).success && c.uuidSchema.safeParse(data.requestId).success) saved = data;
      break;
    }
  });
  pi.on('session_shutdown', () => { if (!disabled) clear(); });
  const needsOwnership = () => Boolean(saved?.deniedSession === context?.sessionManager.getSessionId() && saved?.deniedSession) ||
    Boolean(saved && !saved.ended && (saved.binding || saved.denied || (saved.sent && saved.ownerTag !== ownerTag)));
  const recoveryTools = new Set(['read', 'grep', 'find', 'ls', 'steward_begin_task', 'steward_interrupt_task', 'steward_finish',
    'steward_list_projects', 'steward_list_tasks', 'steward_get_task', 'steward_create_task', 'steward_update_task']);
  pi.on('tool_call', (event) => {
    if (!disabled && !bound && needsOwnership() && !recoveryTools.has(event.toolName)) {
      return { block: true, reason: '当前目标未取得执行权（或请求结果未知）。先调用 steward_begin_task 恢复，失败不得绕过所有权继续写入、委派或切换工作树。' };
    }
  });
  return { begin, close, suspend,
    noteDelivered() { if (saved && bound) { saved.deliveryKnown = true; remember(); } },
    get deliveryKnown() { return !forked && saved?.ownerTag === ownerTag && saved?.deliveryKnown === true; },
    get ownerId() { return ownerId; }, get binding() { return bound; },
    get managedHistory() { return needsOwnership(); } };
}
