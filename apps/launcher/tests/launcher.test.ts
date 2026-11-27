import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimedAttempt, LocalConfig } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { Launcher } from '../src/launcher.js';
import { PlatformError } from '../src/platform.js';
import type { Platform } from '../src/platform.js';
import { loadState, saveState } from '../src/state.js';
import { targetFor } from '../src/tmux.js';
import type { Tmux } from '../src/tmux.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(warn?: (message: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'steward-state-'));
  dirs.push(directory);
  const path = join(directory, 'state.json');
  const id = randomUUID();
  const target = targetFor(id);
  const config: LocalConfig = { platformUrl: 'https://steward.example', machineToken: `stm_${randomBytes(32).toString('base64url')}`,
    slots: 1, projects: [{ id: 'test', name: 'Project', path: '/tmp/中文 project' }], path: ['/usr/bin'], pi: { command: 'pi', extraArgs: [] } };
  const attempt: ClaimedAttempt = { id, taskId: randomUUID(), projectId: 'test', agent: 'pi', sessionId: targetFor(randomUUID()),
    restoreSession: false, displayName: '项目', kind: 'new' };
  let now = 1_800_000_000_000;
  let active = false;
  let cancelled = false;
  let session: Awaited<ReturnType<Tmux['inspect']>> = 'absent';
  const claim = vi.fn<Platform['claim']>(async (requestId) => {
    expect(loadState(path).claimRequestId).toBe(requestId);
    active = true;
    return { attempt };
  });
  const report = vi.fn<Platform['report']>(async (event) => {
    expect(loadState(path).outbox).toContainEqual(event);
    if (event.kind === 'exited') active = false;
    return { ok: true };
  });
  const heartbeat = vi.fn<Platform['heartbeat']>(async ({ attempts }) => ({ directives: active ? [{ attemptId: id, tmuxSession: target,
    action: cancelled ? 'cancel' : attempts.some((item) => item.id === id) ? 'continue' : 'unknown' }] : [] }));
  const check = vi.fn<Tmux['check']>(async () => 'ready');
  const inspect = vi.fn<Tmux['inspect']>(async () => session);
  const launch = vi.fn<Tmux['launch']>(async () => {
    expect(loadState(path).executions).toMatchObject([{ target, phase: 'launching' }]);
    session = 'present';
  });
  const cancel = vi.fn<Tmux['cancel']>(async () => { session = 'absent'; });
  return { path, id, target, attempt, claim, report, heartbeat, check, inspect, launch, cancel, setActive: () => { active = true; },
    setCancelled: () => { cancelled = true; }, setSession: (value: typeof session) => { session = value; },
    advance: (ms: number) => { now += ms; },
    restart: () => new Launcher({ config, version: 'test', state: loadState(path), save: (state) => saveState(path, state),
      platform: { claim, report, heartbeat, reportSession: vi.fn(), reportGit: vi.fn() },
      tmux: { check, inspect, launch, cancel, panePid: vi.fn(), hasResumeIdentity: vi.fn(), processStatus: vi.fn(), launchResume: vi.fn() },
      now: () => now, warn }),
  };
}

it.each(['valid', 'no-locator', 'directory', 'file', 'id', 'cwd'])(
  '返修只使用精确工作树会话，失败不回退：%s', async (mode) => {
    const warn = vi.fn();
    const x = fixture(warn);
    const path = realpathSync(join(x.path, '..'));
    const locator = { path, sessionId: randomUUID(), sessionFile: join(path, 'session.jsonl') };
    writeFileSync(locator.sessionFile, JSON.stringify({ type: 'session', id: mode === 'id' ? 'other' : locator.sessionId,
      cwd: mode === 'cwd' ? '/not-the-worktree' : path }) + '\n');
    if (mode === 'directory') locator.path = join(path, 'missing');
    if (mode === 'file') locator.sessionFile = join(path, 'missing.jsonl');
    Object.assign(x.attempt, { kind: 'rework', restoreSession: true, sessionId: locator.sessionId,
      ...(mode === 'no-locator' ? {} : { sessionLocator: locator }) });
    await x.restart().tick();
    if (mode === 'valid') {
      expect(x.launch).toHaveBeenCalledExactlyOnceWith(x.target, x.attempt, path);
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(x.launch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('未回退'));
      expect(x.report).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exited' }));
    }
  },
);

it('领取前落盘，启动前记下目标与时刻，报告成功后清理 outbox', async () => {
  const x = fixture();
  await x.restart().tick();
  expect(x.launch).toHaveBeenCalledExactlyOnceWith(x.target, x.attempt, '/tmp/中文 project');
  expect(x.report.mock.calls[0]?.[0]).toMatchObject({ kind: 'started', id: x.id, body: { tmuxSession: x.target } });
  expect(loadState(x.path)).toMatchObject({ outbox: [], executions: [{ phase: 'observed' }] });
});

it('tmux 不可用时继续发心跳并保留队列，恢复后自动领取', async () => {
  const warn = vi.fn();
  const x = fixture(warn);
  const launcher = x.restart();
  x.check.mockResolvedValue('missing');
  await launcher.tick();
  await launcher.tick();
  expect(x.heartbeat).toHaveBeenCalledTimes(2);
  expect(x.claim).not.toHaveBeenCalled();
  expect(loadState(x.path).claimRequestId).toBeUndefined();
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('找不到 tmux'));
  x.check.mockResolvedValue('ready');
  await launcher.tick();
  expect(x.claim).toHaveBeenCalledTimes(1);
  expect(x.launch).toHaveBeenCalledTimes(1);
});

it('tmux 不可用时保留未确认领取，恢复后用原请求 ID 核对并启动', async () => {
  const x = fixture();
  const launcher = x.restart();
  x.claim.mockImplementationOnce(async () => { x.setActive(); throw new PlatformError('network_error'); });
  await launcher.tick();
  const requestId = loadState(x.path).claimRequestId;
  expect(requestId).toBeDefined();
  x.check.mockResolvedValue('unavailable');
  await launcher.tick();
  expect(x.heartbeat).toHaveBeenCalledTimes(2);
  expect(loadState(x.path).claimRequestId).toBe(requestId);
  expect(x.claim).toHaveBeenCalledTimes(1);
  expect(x.report).not.toHaveBeenCalled();
  expect(x.launch).not.toHaveBeenCalled();
  x.check.mockResolvedValue('ready');
  await launcher.tick();
  expect(x.claim.mock.calls).toEqual([[requestId], [requestId]]);
  expect(x.launch).toHaveBeenCalledTimes(1);
});

it('领取响应连续丢失时保留 UUID，重启重放前不将缺失目标当作退出', async () => {
  const x = fixture();
  x.claim.mockImplementationOnce(async () => { x.setActive(); throw new PlatformError('network_error'); })
    .mockRejectedValueOnce(new PlatformError('network_error'));
  await x.restart().tick();
  await x.restart().tick();
  expect(x.report).not.toHaveBeenCalled();
  expect(x.launch).not.toHaveBeenCalled();
  await x.restart().tick();
  expect(new Set(x.claim.mock.calls.flat()).size).toBe(1);
  expect(x.launch).toHaveBeenCalledTimes(1);
});

it('平台不再列出已结束的尝试时，迟到的领取响应不会重新启动', async () => {
  const x = fixture();
  saveState(x.path, { version: 1, claimRequestId: randomUUID(), executions: [], outbox: [] });
  x.claim.mockResolvedValueOnce({ attempt: x.attempt });
  await x.restart().tick();
  expect(x.launch).not.toHaveBeenCalled();
  expect(x.report).not.toHaveBeenCalled();
  expect(loadState(x.path).executions).toEqual([]);
});

it('重启后已存在的 launching 会话补报 started，不重复启动', async () => {
  const x = fixture();
  x.setActive(); x.setSession('present');
  saveState(x.path, { version: 1, executions: [{ id: x.id, target: x.target, phase: 'launching', claim: x.attempt, startedAt: 100 }], outbox: [] });
  await x.restart().tick();
  expect(x.launch).not.toHaveBeenCalled();
  expect(x.report.mock.calls[0]?.[0]).toMatchObject({ kind: 'started', body: { startedAt: 100 } });
});

it('对 launching 目标查询失败时保留本地记录，之后确认缺失才报告退出', async () => {
  const x = fixture();
  x.setActive(); x.setSession('unavailable');
  saveState(x.path, { version: 1, executions: [{ id: x.id, target: x.target, phase: 'launching', claim: x.attempt, startedAt: 100 }], outbox: [] });
  await x.restart().tick();
  expect(x.report).not.toHaveBeenCalled();
  expect(loadState(x.path).executions).toHaveLength(1);
  x.setSession('absent');
  await x.restart().tick();
  expect(x.launch).not.toHaveBeenCalled();
  expect(x.report.mock.calls[0]?.[0]).toMatchObject({ kind: 'exited', body: { exitCode: null } });
});

it('本地状态丢失时根据平台目标核对活会话，再接受取消并报告退出', async () => {
  const x = fixture();
  x.setActive(); x.setSession('unavailable');
  await x.restart().tick();
  expect(x.inspect).toHaveBeenCalledWith(x.target);
  expect(x.report).not.toHaveBeenCalled();
  x.setSession('present');
  await x.restart().tick();
  expect(loadState(x.path).executions).toMatchObject([{ id: x.id, phase: 'observed' }]);
  expect(x.report).not.toHaveBeenCalled();
  x.setCancelled();
  await x.restart().tick();
  expect(x.cancel).toHaveBeenCalledExactlyOnceWith(x.target);
  expect(x.report.mock.calls[0]?.[0]).toMatchObject({ kind: 'exited', id: x.id });
});

it('平台确认开始响应丢失时重发同一事件，然后按顺序报告退出', async () => {
  const x = fixture();
  x.report.mockRejectedValueOnce(new PlatformError('network_error'));
  await x.restart().tick();
  const pending = loadState(x.path).outbox[0];
  expect(pending?.kind).toBe('started');
  x.setSession('absent');
  await x.restart().tick();
  expect(x.report.mock.calls.map(([event]) => event.kind)).toEqual(['started', 'started', 'exited']);
  expect(x.report.mock.calls[1]?.[0]).toEqual(pending);
  expect(loadState(x.path).outbox).toEqual([]);
});

it('平台明确返回 attempt_ended 时清理迟到报告', async () => {
  const x = fixture();
  x.setActive();
  saveState(x.path, { version: 1, executions: [{ id: x.id, target: x.target, phase: 'exited' }],
    outbox: [{ id: x.id, kind: 'exited', body: { requestId: randomUUID(), exitCode: null, endedAt: 100 } }] });
  x.report.mockRejectedValueOnce(new PlatformError('attempt_ended'));
  x.claim.mockResolvedValueOnce({ attempt: null });
  await x.restart().tick();
  expect(loadState(x.path)).toMatchObject({ executions: [], outbox: [] });
});

it.each(['forbidden', 'not_found', 'invalid_request'] as const)('旧事件被 %s 拒绝后仍发送后续退出和领取', async (code) => {
  const warn = vi.fn();
  const x = fixture(warn);
  const oldId = randomUUID();
  saveState(x.path, { version: 1, executions: [{ id: oldId, target: targetFor(oldId), phase: 'exited' },
    { id: x.id, target: x.target, phase: 'exited' }], outbox: [
    { id: oldId, kind: 'exited', body: { requestId: randomUUID(), exitCode: null, endedAt: 100 } },
    { id: x.id, kind: 'exited', body: { requestId: randomUUID(), exitCode: null, endedAt: 200 } },
  ] });
  x.report.mockRejectedValueOnce(new PlatformError(code));
  x.claim.mockResolvedValueOnce({ attempt: null });
  await x.restart().tick();
  expect(x.report.mock.calls.map(([event]) => event.id)).toEqual([oldId, x.id]);
  expect(loadState(x.path)).toMatchObject({ executions: [], outbox: [] });
  expect(warn.mock.calls.flat()).toEqual([`平台终态拒绝事件 exited（${oldId}，${code}）。`]);
  expect(x.claim).toHaveBeenCalledTimes(1);
});

it('开始报告永久被拒绝时，仍运行或无法核对的本地会话继续占用名额', async () => {
  const x = fixture();
  x.setSession('present');
  saveState(x.path, { version: 1, executions: [{ id: x.id, target: x.target, phase: 'observed' }], outbox: [
    { id: x.id, kind: 'started', body: { requestId: randomUUID(), tmuxSession: x.target, startedAt: 100 } },
  ] });
  x.report.mockRejectedValueOnce(new PlatformError('forbidden'));
  await x.restart().tick();
  expect(loadState(x.path)).toMatchObject({ executions: [{ phase: 'observed' }], outbox: [] });
  x.setSession('unavailable');
  await x.restart().tick();
  expect(x.claim).not.toHaveBeenCalled();
  x.setSession('absent');
  x.claim.mockResolvedValueOnce({ attempt: null });
  await x.restart().tick();
  expect(x.report.mock.calls[1]?.[0].kind).toBe('exited');
  expect(x.claim).toHaveBeenCalledTimes(1);
});

it('确认已有旧的 started 记录后继续发送 exited', async () => {
  const warn = vi.fn();
  const x = fixture(warn);
  x.setActive();
  saveState(x.path, { version: 1, executions: [{ id: x.id, target: x.target, phase: 'exited' }], outbox: [
    { id: x.id, kind: 'started', body: { requestId: randomUUID(), tmuxSession: x.target, startedAt: 100 } },
    { id: x.id, kind: 'exited', body: { requestId: randomUUID(), exitCode: null, endedAt: 200 } },
  ] });
  x.report.mockRejectedValueOnce(new PlatformError('conflict', true));
  x.claim.mockResolvedValueOnce({ attempt: null });
  await x.restart().tick();
  expect(x.report.mock.calls.map(([event]) => event.kind)).toEqual(['started', 'exited']);
  expect(loadState(x.path)).toMatchObject({ executions: [], outbox: [] });
  expect(warn).not.toHaveBeenCalled();
});

it('平台仍列出被永久拒绝的退出尝试时，不重复生成同一事件', async () => {
  const x = fixture();
  x.setActive();
  saveState(x.path, { version: 1, executions: [{ id: x.id, target: x.target, phase: 'exited' }], outbox: [
    { id: x.id, kind: 'exited', body: { requestId: randomUUID(), exitCode: null, endedAt: 100 } },
  ] });
  x.report.mockRejectedValueOnce(new PlatformError('invalid_request'));
  await x.restart().tick();
  await x.restart().tick();
  expect(x.report).toHaveBeenCalledTimes(1);
  expect(loadState(x.path)).toMatchObject({ executions: [{ phase: 'exited' }], outbox: [] });
});

it.each(['unauthorized', 'network_error'] as const)('%s 保留原事件并退避，恢复后重发原 ID', async (code) => {
  const x = fixture();
  const event = { id: x.id, kind: 'exited' as const, body: { requestId: randomUUID(), exitCode: null, endedAt: 100 } };
  saveState(x.path, { version: 1, executions: [{ id: x.id, target: x.target, phase: 'exited' }], outbox: [event] });
  x.report.mockRejectedValueOnce(new PlatformError(code)).mockRejectedValueOnce(new PlatformError(code));
  x.claim.mockResolvedValueOnce({ attempt: null });
  const launcher = x.restart();
  await launcher.tick();
  expect(loadState(x.path).outbox).toEqual([event]);
  x.advance(14_999);
  await launcher.tick();
  expect(x.report).toHaveBeenCalledTimes(1);
  x.advance(1);
  await launcher.tick();
  x.advance(29_999);
  await launcher.tick();
  expect(x.report).toHaveBeenCalledTimes(2);
  x.advance(1);
  await launcher.tick();
  expect(x.report.mock.calls).toEqual([[event], [event], [event]]);
  expect(loadState(x.path).outbox).toEqual([]);
});
