import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import type { agentClient } from '../src/client.js';
import { registerSessionReport } from '../src/session-report.js';
import { currentSessionLocator } from '../src/workspace.js';

vi.mock('../src/workspace.js', () => ({ currentSessionLocator: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
const locator = { path: '/worktree', sessionId: 'actual', sessionFile: '/sessions/actual.jsonl' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const handlers = new Map<string, () => void>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) =>
    handlers.set(name, () => handler({}, {} as ExtensionContext)) } as unknown as ExtensionAPI;
  const request = vi.fn().mockResolvedValue({ ok: true });
  const controller = registerSessionReport(pi, request as ReturnType<typeof agentClient>, false);
  return { request, controller, fire: (name: string) => handlers.get(name)!() };
}
it('shutdown 发生于异步定位期间时不发送过期报告', async () => {
  const pending = deferred<typeof locator>();
  vi.mocked(currentSessionLocator).mockReturnValueOnce(pending.promise);
  const x = fixture();
  x.fire('session_start');
  await Promise.resolve();
  x.fire('session_shutdown');
  pending.resolve(locator);
  await pending.promise;
  await Promise.resolve();
  expect(x.request).not.toHaveBeenCalled();
});
it('workspace 等异步 startup locator 完成后再写，旧定位不能晚于现场记录', async () => {
  const pending = deferred<typeof locator>();
  vi.mocked(currentSessionLocator).mockReturnValueOnce(pending.promise);
  const x = fixture();
  x.fire('session_start');
  const order: string[] = [];
  x.request.mockImplementation(async () => { order.push('session'); return { ok: true }; });
  const save = vi.fn(async () => { order.push('workspace'); return 'saved'; });
  const saving = x.controller.workspace(save);
  await Promise.resolve();
  expect(save).not.toHaveBeenCalled();
  pending.resolve(locator);
  expect(await saving).toBe('saved');
  expect(order).toEqual(['session', 'workspace']);
});
it('已发出的 startup 写入结束之后才写 workspace，且不能中止 loaded 确认', async () => {
  vi.mocked(currentSessionLocator).mockResolvedValueOnce(locator);
  const pending = deferred<{ ok: true }>();
  const x = fixture();
  x.request.mockReturnValueOnce(pending.promise);
  x.fire('session_start');
  await vi.waitFor(() => expect(x.request).toHaveBeenCalledOnce());
  const signal = x.request.mock.calls[0]?.[4] as AbortSignal;
  const save = vi.fn().mockResolvedValue(undefined);
  const saving = x.controller.workspace(save);
  await Promise.resolve();
  expect(save).not.toHaveBeenCalled();
  expect(signal.aborted).toBe(false);
  pending.resolve({ ok: true });
  await saving;
  expect(save).toHaveBeenCalledOnce();
});
it('恢复上报暂时失败时，workspace 不取消重试，loaded 成功后再保存现场', async () => {
  vi.useFakeTimers();
  vi.mocked(currentSessionLocator).mockResolvedValueOnce(locator);
  const x = fixture();
  x.request.mockRejectedValueOnce({ code: 'network_error' });
  const order: string[] = [];
  x.request.mockImplementation(async () => { order.push('loaded'); return { ok: true }; });
  x.fire('session_start');
  const save = vi.fn(async () => { order.push('workspace'); });
  const saving = x.controller.workspace(save);
  await vi.advanceTimersByTimeAsync(0);
  expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3_000);
  await saving;
  expect(x.request).toHaveBeenCalledTimes(2);
  expect(order).toEqual(['loaded', 'workspace']);
});
