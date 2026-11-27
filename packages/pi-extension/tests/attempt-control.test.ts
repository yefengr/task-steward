import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentControlResponse } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { registerAttemptControl } from '../src/attempt-control.js';
import { AgentError, agentClient } from '../src/client.js';

function fixture(type: AgentControlResponse['type'] = 'discussion', continuation = false) {
  vi.useFakeTimers();
  const state: AgentControlResponse = { type, waitId: null, discussionEndRequested: false, deliverySaved: false };
  const handlers = vi.fn<ExtensionAPI['on']>();
  const sendMessage = vi.fn();
  const entries: object[] = [];
  const appendEntry = vi.fn((customType, data: object) => entries.push({ type: 'custom', customType, data: structuredClone(data) }));
  const shutdown = vi.fn();
  const notify = vi.fn();
  const isIdle = vi.fn(() => true);
  const ctx = { isIdle, shutdown, hasUI: true, ui: { notify }, sessionManager: { getEntries: () => entries } } as unknown as ExtensionContext;
  let offline = false;
  let failNextReply = false;
  const request = vi.fn(async (_method, route, _schema, body) => {
    if (offline) throw new AgentError('network_error');
    if (route === 'control') return { ...state };
    if (route === 'end-discussion') state.discussionEndRequested = true;
    if (route === 'reply') {
      if (failNextReply) { failNextReply = false; throw new AgentError('network_error'); }
      if (body.waitId === state.waitId) state.waitId = null;
    }
    return { ok: true };
  });
  const attemptId = randomUUID();
  function register() {
    handlers.mockClear();
    return registerAttemptControl({ on: handlers, sendMessage, appendEntry } as unknown as ExtensionAPI,
      attemptId, request as unknown as ReturnType<typeof agentClient>, false, continuation);
  }
  const control = register();
  async function fire(name: string, event = {}) {
    const handler = handlers.mock.calls.find(([type]) => type === name)?.[1];
    if (!handler) throw new Error(`Missing ${name}`);
    await handler({ type: name, ...event } as never, ctx);
  }
  const tick = (ms = 5_000) => vi.advanceTimersByTimeAsync(ms);
  const start = async () => { await fire('session_start'); await tick(0); };
  return { state, sendMessage, shutdown, notify, isIdle, request, control, register, fire, tick, start,
    setOffline: (value: boolean) => { offline = value; }, failReply: () => { failNextReply = true; } };
}

afterEach(() => vi.useRealTimers());

it('后台接续等待平台启动及加载确认，空闲后仅一次发送；reload 不重放', async () => {
  const f = fixture('implementation', true);
  f.state.continuationReady = false;
  await f.start(); await f.tick(10_000);
  expect(f.sendMessage).not.toHaveBeenCalled();
  f.state.continuationReady = true; f.isIdle.mockReturnValue(false);
  await f.tick(); expect(f.sendMessage).not.toHaveBeenCalled();
  f.isIdle.mockReturnValue(true); await f.tick();
  expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ customType: 'steward-background-continue' }),
    { triggerTurn: true, deliverAs: 'followUp' });
  await f.tick(20_000); await f.fire('session_shutdown'); f.register(); await f.start();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  await f.fire('session_shutdown');
});
it('用户先输入时不在其后追加自动接续，发送结果未知也不重复消息', async () => {
  const f = fixture('implementation', true);
  f.state.continuationReady = false; await f.start();
  await f.fire('input', { source: 'interactive', text: '先等一下，我来核对' });
  f.state.continuationReady = true; await f.tick();
  expect(f.sendMessage).not.toHaveBeenCalled(); await f.fire('session_shutdown');
  const g = fixture('implementation', true); g.state.continuationReady = true;
  g.sendMessage.mockImplementationOnce(() => { throw new Error('unknown'); });
  await g.start(); await g.tick(20_000);
  expect(g.sendMessage).toHaveBeenCalledTimes(1); expect(g.notify).toHaveBeenCalledWith(expect.stringContaining('未重复发送'), 'warning');
  await g.fire('session_shutdown');
});
it('普通恢复即使收到 ready 字段也不自动发消息', async () => {
  const f = fixture('implementation'); f.state.continuationReady = true; await f.start(); await f.tick(10_000);
  expect(f.sendMessage).not.toHaveBeenCalled(); await f.fire('session_shutdown');
});

it('普通回合保持讨论运行，工作台请求在 Pi 空闲后只触发一次，并等平台确认交付', async () => {
  const f = fixture();
  await f.start();
  await f.fire('input', { source: 'interactive', text: '已有一个讨论结论' });
  await f.tick(20_000);
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.shutdown).not.toHaveBeenCalled();
  f.isIdle.mockReturnValue(false);
  f.state.discussionEndRequested = true;
  await f.tick();
  expect(f.sendMessage).not.toHaveBeenCalled();
  f.isIdle.mockReturnValue(true);
  await f.tick();
  expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: 'steward-end-discussion' }),
    { triggerTurn: true, deliverAs: 'followUp' });
  await f.tick(20_000);
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.shutdown).not.toHaveBeenCalled();
  f.state.deliverySaved = true;
  await f.tick();
  expect(f.shutdown).toHaveBeenCalledTimes(1);
  await f.fire('session_shutdown');
});

it.each(['interactive', 'extension'] as const)('用户的结束讨论输入持久化后续恢复，保留原用户消息（%s）', async (source) => {
  const f = fixture();
  await f.start();
  f.setOffline(true);
  await f.fire('input', { source, text: '结束讨论' });
  const original = f.request.mock.calls.find(([, route]) => route === 'end-discussion')?.[3];
  expect(original).toEqual({ requestId: expect.any(String) });
  expect(f.sendMessage).not.toHaveBeenCalled();
  await f.fire('session_shutdown');
  f.register();
  f.setOffline(false);
  await f.start();
  expect(f.request.mock.calls.filter(([, route]) => route === 'end-discussion').map(([, , , body]) => body))
    .toEqual([original, original]);
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  await f.fire('session_shutdown');
});

it('首次读取任务类型前就离线，本地结束意图在重载后恢复且不会被误认作回复', async () => {
  const f = fixture();
  f.state.waitId = randomUUID();
  f.setOffline(true);
  await f.start();
  await f.fire('input', { source: 'extension', text: '结束讨论' });
  expect(f.state.discussionEndRequested).toBe(false);
  await f.fire('session_shutdown');
  f.register();
  f.setOffline(false);
  await f.start();
  expect(f.state.discussionEndRequested).toBe(true);
  expect(f.state.waitId).not.toBeNull();
  expect(f.request.mock.calls.some(([, route]) => route === 'reply')).toBe(false);
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  await f.fire('session_shutdown');
});

it('无交付的收尾回合有限重试，仍未完成时不关闭会话并告诉用户', async () => {
  const f = fixture();
  f.state.discussionEndRequested = true;
  await f.start();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  await f.tick(29_999);
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  await f.tick(1);
  expect(f.sendMessage).toHaveBeenCalledTimes(2);
  await f.tick(120_000);
  expect(f.sendMessage).toHaveBeenCalledTimes(3);
  expect(f.notify).toHaveBeenCalledTimes(1);
  expect(f.shutdown).not.toHaveBeenCalled();
  await f.fire('input', { source: 'interactive', text: '结束讨论' });
  await f.tick();
  expect(f.sendMessage).toHaveBeenCalledTimes(4);
  await f.fire('session_shutdown');
});

it.each(['implementation', 'discussion'] as const)('只同步同一等待的编号，不同步用户输入，失败后按原编号重试（%s）', async (type) => {
  const f = fixture(type);
  await f.start();
  const waitId = randomUUID();
  await f.control.ask(async () => { f.state.waitId = waitId; return { waitId }; });
  f.failReply();
  await f.fire('input', { source: 'extension', text: '用户的回复仅留在 Pi' });
  expect(f.state.waitId).toBe(waitId);
  await f.tick();
  expect(f.state.waitId).toBeNull();
  const replies = f.request.mock.calls.filter(([, route]) => route === 'reply').map(([, , , body]) => body);
  expect(replies).toEqual([{ waitId, requestId: expect.any(String) }, { waitId, requestId: replies[0].requestId }]);
  await f.fire('input', { source: 'interactive', text: '普通对话' });
  expect(f.request.mock.calls.filter(([, route]) => route === 'reply')).toHaveLength(2);
  expect(f.sendMessage).not.toHaveBeenCalled();
  await f.fire('session_shutdown');
});

it('普通输入无需等回复上报，下一次显式提问仍按顺序处理', async () => {
  const f = fixture();
  f.state.waitId = randomUUID();
  await f.start();
  let acknowledge: () => void = () => { throw new Error('回复请求未发送'); };
  f.request.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = () => resolve({ ok: true }); }));
  await f.fire('input', { source: 'interactive', text: '继续' });
  await f.tick(0);
  expect(f.request.mock.lastCall?.[1]).toBe('reply');
  const send = vi.fn(async () => ({ waitId: randomUUID() }));
  const next = f.control.ask(send);
  await f.tick(0);
  expect(send).not.toHaveBeenCalled();
  acknowledge();
  await next;
  expect(send).toHaveBeenCalledTimes(1);
  await f.fire('session_shutdown');
});

it('实现任务的结束讨论字样不是收尾指令', async () => {
  const f = fixture('implementation');
  await f.start();
  await f.fire('input', { source: 'interactive', text: '结束讨论' });
  await f.tick();
  expect(f.request.mock.calls.some(([, route]) => route === 'end-discussion')).toBe(false);
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.shutdown).not.toHaveBeenCalled();
  await f.fire('session_shutdown');
});
