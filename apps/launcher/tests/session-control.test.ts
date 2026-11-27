import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LauncherSessionDirective, LocalConfig, PiSessionLocator } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { Launcher } from '../src/launcher.js';
import { PlatformError } from '../src/platform.js';
import type { Platform } from '../src/platform.js';
import { validateLocator } from '../src/session-control.js';
import { loadState, saveState } from '../src/state.js';
import { targetFor, TmuxError } from '../src/tmux.js';
import type { Tmux } from '../src/tmux.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sourcePid = 111;
const replacementPid = 222;

function fixture(extraArgs: string[] = []) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'steward-control-')));
  dirs.push(path);
  const file = join(path, 'state.json');
  const attemptId = randomUUID(), replacementId = randomUUID(), id = randomUUID();
  const oldTarget = targetFor(attemptId), newTarget = targetFor(replacementId);
  const locator = { path, sessionId: randomUUID(), sessionFile: join(path, 'old session.jsonl') };
  const writeHeader = (fields: object = {}) => writeFileSync(locator.sessionFile, `${JSON.stringify({ type: 'session', id: locator.sessionId,
    cwd: path, ...fields })}\n正文不是 JSON；核对时不能要求读正文。\n`);
  writeHeader();
  const stop = (sourceEnded = false): LauncherSessionDirective => ({ id, attemptId, mode: 'restart', step: 'stop', locator, validForMs: 1000, sourceEnded });
  const resume = (): LauncherSessionDirective => ({ id, attemptId, mode: 'restart', step: 'launch', replacementId, locator, validForMs: 1000 });
  const cleanup = (): LauncherSessionDirective => ({ id, attemptId, mode: 'restart', step: 'cleanup', replacementId });
  const config: LocalConfig = { platformUrl: 'https://steward.example', machineToken: 'unused', slots: 1, projects: [], path: ['/usr/bin'],
    pi: { command: 'pi', extraArgs } };
  let now = 0;
  let wall = 100_000;
  let directives: LauncherSessionDirective[] = [stop()];
  const sessions = new Map([[oldTarget, sourcePid]]);
  const live = new Set([sourcePid]);
  const inspect = vi.fn<Tmux['inspect']>(async (target) => sessions.has(target) ? 'present' : 'absent');
  const panePid = vi.fn<Tmux['panePid']>(async (target) => sessions.get(target));
  const processStatus = vi.fn<Tmux['processStatus']>((pid) => live.has(pid) ? 'alive' : 'dead');
  const launchResume = vi.fn<Tmux['launchResume']>(async () => {
    expect(loadState(file).executions).toContainEqual(expect.objectContaining({ id: replacementId, phase: 'launching' }));
    sessions.set(newTarget, replacementPid);
    live.add(replacementPid);
    return replacementPid;
  });
  const cancel = vi.fn<Tmux['cancel']>(async (target) => {
    const pid = sessions.get(target);
    if (pid) live.delete(pid);
    sessions.delete(target);
  });
  const hasResumeIdentity = vi.fn<Tmux['hasResumeIdentity']>(async () => true);
  const tmux: Tmux = { check: vi.fn().mockResolvedValue('ready'), inspect, launch: vi.fn(), cancel, panePid, processStatus,
    hasResumeIdentity, launchResume };
  const heartbeat = vi.fn<Platform['heartbeat']>(async () => ({ directives: [], sessionOperations: directives }));
  const claim = vi.fn<Platform['claim']>(async () => ({ attempt: null }));
  const report = vi.fn<Platform['report']>(async () => ({ ok: true }));
  const reportSession = vi.fn<Platform['reportSession']>(async (_id, body) => {
    expect(loadState(file).sessionOperations).toContainEqual(expect.objectContaining({ id, report: body }));
    return { ok: true };
  });
  const start = () => new Launcher({ config, version: 'test', state: loadState(file), save: (state) => saveState(file, state),
    platform: { heartbeat, claim, report, reportSession, reportGit: vi.fn() }, tmux, now: () => wall, monotonicNow: () => now });
  return { file, id, path, locator, attemptId, replacementId, oldTarget, newTarget, writeHeader, stop, resume, cleanup,
    sessions, live, tmux, cancel, claim, heartbeat, report, reportSession, inspect, panePid, processStatus, hasResumeIdentity, launchResume, start,
    advance: (ms: number) => { now += ms; }, advanceWall: (ms: number) => { wall += ms; },
    directives: (...value: LauncherSessionDirective[]) => { directives = value; } };
}

it('先持久化精确旧目标的 PID，收到下一次心跳才打开原文件；重启 launcher 后不重复启动', async () => {
  const x = fixture(['-a', '-na', '--no-extensions', '-ne', '--no-context-files', '-nc', '--no-skills', '-ns',
    '--model', 'vendor/model', '-t', 'read,grep', '--theme', 'dark', '-e', '/tmp/e.js']);
  x.cancel.mockImplementationOnce(async (target) => {
    expect(target).toBe(x.oldTarget);
    expect(loadState(x.file).executions).toContainEqual(expect.objectContaining({ target, pid: sourcePid }));
    x.sessions.delete(target);
    x.live.delete(sourcePid);
  });
  await x.start().tick();
  expect(x.reportSession).toHaveBeenCalledExactlyOnceWith(x.id, { requestId: expect.any(String), step: 'stop', result: 'stopped' });
  expect(x.launchResume).not.toHaveBeenCalled();
  x.directives(x.resume());
  await x.start().tick();
  await x.start().tick();
  expect(x.launchResume).toHaveBeenCalledExactlyOnceWith(x.newTarget, x.replacementId, x.locator);
  expect(x.report.mock.calls.map(([event]) => [event.kind, event.id])).toContainEqual(['started', x.replacementId]);
  expect(loadState(x.file).executions).toContainEqual(expect.objectContaining({ id: x.replacementId, pid: replacementPid, phase: 'observed' }));
  expect(x.claim).not.toHaveBeenCalled();
  expect(x.tmux.launch).not.toHaveBeenCalled();
});

it.each(['missing', 'other-cwd', 'unsupported'] as const)('预检失败（%s）时不触碰旧会话', async (kind) => {
  const x = fixture(kind === 'unsupported' ? ['--session-id', 'other-session'] : []);
  if (kind === 'missing') rmSync(x.locator.sessionFile);
  if (kind === 'other-cwd') x.writeHeader({ cwd: '/' });
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  const failure = { missing: 'session_record_missing', 'other-cwd': 'session_workspace_unavailable', unsupported: 'session_config_unsupported' }[kind];
  expect(x.reportSession).toHaveBeenCalledWith(x.id, expect.objectContaining({ result: 'failed', step: 'stop', failure }));
});

it('会话文件不允许最终符号链接、错误会话 ID 或超出限制的首行', () => {
  const x = fixture();
  const locator: PiSessionLocator = { ...x.locator, sessionFile: join(x.path, 'linked.jsonl') };
  symlinkSync(x.locator.sessionFile, locator.sessionFile);
  expect(validateLocator(locator)).toBe('session_record_missing');
  symlinkSync(x.path, join(x.path, 'parent-link'));
  expect(validateLocator({ ...x.locator, sessionFile: join(x.path, 'parent-link', 'old session.jsonl') })).toBe('session_record_missing');
  expect(validateLocator({ ...x.locator, sessionId: 'different' })).toBe('session_record_missing');
  x.writeHeader({ metadata: '大'.repeat(2500) });
  expect(validateLocator(x.locator)).toBeUndefined();
  writeFileSync(x.locator.sessionFile, ' '.repeat(65_536));
  expect(validateLocator(x.locator)).toBe('session_record_missing');
});

it('旧目标消失但已记录的进程未退出时，不回报 exited，也拒绝重启', async () => {
  const x = fixture();
  x.cancel.mockImplementationOnce(async (target) => { x.sessions.delete(target); });
  await x.start().tick();
  expect(x.reportSession).toHaveBeenCalledWith(x.id, expect.objectContaining({ result: 'failed', step: 'stop', failure: 'session_stop_failed' }));
  x.directives(x.resume());
  await x.start().tick();
  expect(x.launchResume).not.toHaveBeenCalled();
  expect(x.reportSession).toHaveBeenCalledTimes(1);
  expect(x.report.mock.calls.map(([event]) => event.kind)).not.toContain('exited');
  x.live.delete(sourcePid);
  await x.start().tick();
  expect(x.launchResume).toHaveBeenCalledOnce();
});

it.each([false, true])('旧目标缺失且无本地 PID 时，仅已有平台退出记录可确认（%s）', async (sourceEnded) => {
  const x = fixture();
  x.sessions.delete(x.oldTarget);
  x.live.delete(sourcePid);
  x.directives(x.stop(sourceEnded));
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  expect(x.reportSession).toHaveBeenCalledWith(x.id, expect.objectContaining({ result: sourceEnded ? 'stopped' : 'failed', step: 'stop' }));
});

it('平台记录旧会话已结束却仍见精确目标时，不停它也不确认停止', async () => {
  const x = fixture();
  x.directives(x.stop(true));
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  expect(x.reportSession).toHaveBeenCalledWith(x.id, expect.objectContaining({ result: 'failed', step: 'stop', failure: 'session_stop_failed' }));
});

it('以心跳发出时刻计时，响应到达时已过期则不停止；本地核对耗时也计入启动授权', async () => {
  const x = fixture();
  x.heartbeat.mockImplementationOnce(async () => { x.advance(1000); return { directives: [], sessionOperations: [x.stop()] }; });
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  await x.start().tick();
  expect(x.cancel).toHaveBeenCalledTimes(1);
  x.directives(x.resume());
  x.inspect.mockImplementation(async () => { x.advance(600); return 'absent'; });
  await x.start().tick();
  expect(x.launchResume).not.toHaveBeenCalled();
  expect(loadState(x.file).executions.some(({ id }) => id === x.replacementId)).toBe(false);
});

it.each([1000, -1])('墙钟变化 %i ms 时，即使单调钟未过期也不得停止', async (elapsed) => {
  const x = fixture();
  x.panePid.mockImplementationOnce(async () => { x.advanceWall(elapsed); return sourcePid; });
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  expect(x.reportSession).not.toHaveBeenCalled();
});

it('替代目标不可核对或有无关本地记录时保留 pending，不回报 launch 失败', async () => {
  const x = fixture();
  x.sessions.clear();
  x.directives(x.resume());
  x.inspect.mockResolvedValueOnce('unavailable');
  await x.start().tick();
  expect(x.reportSession).not.toHaveBeenCalled();
  const state = loadState(x.file);
  state.executions.push({ id: x.replacementId, target: x.newTarget, phase: 'observed', pid: replacementPid });
  saveState(x.file, state);
  await x.start().tick();
  expect(x.reportSession).not.toHaveBeenCalled();
  expect(x.report).not.toHaveBeenCalled();
  expect(x.launchResume).not.toHaveBeenCalled();
});

it('同名拒绝时等精确目标消失再报启动失败，不重发 new-session', async () => {
  const x = fixture();
  x.sessions.clear();
  x.directives(x.resume());
  x.hasResumeIdentity.mockResolvedValue(false);
  x.launchResume.mockImplementationOnce(async () => {
    x.sessions.set(x.newTarget, replacementPid);
    throw new TmuxError(true);
  });
  await x.start().tick();
  await x.start().tick();
  expect(x.reportSession).not.toHaveBeenCalled();
  expect(x.report).not.toHaveBeenCalled();
  x.sessions.delete(x.newTarget);
  await x.start().tick();
  expect(x.launchResume).toHaveBeenCalledTimes(1);
  expect(x.reportSession).toHaveBeenCalledWith(x.id, expect.objectContaining({ step: 'launch', failure: 'session_launch_failed' }));
});

it.each([false, true])('启动命令出错时不重复启动（确定未发出：%s）', async (notStarted) => {
  const x = fixture();
  x.sessions.clear();
  x.live.clear();
  x.directives(x.resume());
  x.launchResume.mockRejectedValueOnce(new TmuxError(notStarted));
  await x.start().tick();
  await x.start().tick();
  expect(x.launchResume).toHaveBeenCalledTimes(1);
  expect(x.report).not.toHaveBeenCalled();
  if (notStarted) expect(x.reportSession).toHaveBeenCalledWith(x.id,
    expect.objectContaining({ result: 'failed', step: 'launch', failure: 'session_launch_failed' }));
  else expect(x.reportSession).not.toHaveBeenCalled();
});

it('启动响应丢失后在 launcher 重启时根据精确 pane 补报，不再启动', async () => {
  const x = fixture();
  x.sessions.clear();
  x.directives(x.resume());
  x.launchResume.mockImplementationOnce(async () => {
    x.sessions.set(x.newTarget, replacementPid);
    x.live.add(replacementPid);
    throw new TmuxError();
  });
  await x.start().tick();
  await x.start().tick();
  expect(x.launchResume).toHaveBeenCalledTimes(1);
  expect(x.report.mock.calls[0]?.[0]).toMatchObject({ kind: 'started', id: x.replacementId });
  expect(loadState(x.file).executions).toContainEqual(expect.objectContaining({ id: x.replacementId, pid: replacementPid }));
});

it('操作报告丢失后重发同一 ID，不重复停止，也不对旧阶段提交新报告', async () => {
  const x = fixture();
  x.reportSession.mockRejectedValueOnce(new PlatformError('network_error'));
  await x.start().tick();
  await x.start().tick();
  expect(x.reportSession).toHaveBeenCalledTimes(2);
  expect(x.reportSession.mock.calls[0]).toEqual(x.reportSession.mock.calls[1]);
  expect(x.cancel).toHaveBeenCalledTimes(1);
  x.directives(x.resume());
  await x.start().tick();
  expect(x.reportSession).toHaveBeenCalledTimes(2);
});

it('清理只操作替代会话；目标消失后仍须等已记录的进程退出才确认', async () => {
  const x = fixture();
  x.sessions.clear();
  x.live.clear();
  x.directives(x.resume());
  await x.start().tick();
  x.sessions.set(x.oldTarget, sourcePid);
  x.live.add(sourcePid);
  x.directives(x.cleanup());
  x.cancel.mockImplementationOnce(async (target) => { x.sessions.delete(target); });
  await x.start().tick();
  expect(x.cancel).toHaveBeenCalledExactlyOnceWith(x.newTarget);
  expect(x.reportSession).not.toHaveBeenCalled();
  x.live.delete(replacementPid);
  await x.start().tick();
  expect(x.reportSession).not.toHaveBeenCalled();
  expect(x.report.mock.calls.map(([event]) => event.kind)).not.toContain('exited');
  expect(x.sessions.get(x.oldTarget)).toBe(sourcePid);
  x.sessions.delete(x.oldTarget);
  await x.start().tick();
  expect(x.reportSession).toHaveBeenCalledExactlyOnceWith(x.id, expect.objectContaining({ step: 'cleanup', failure: 'session_timeout' }));
  expect(x.cancel).toHaveBeenCalledTimes(1);
  expect(x.claim).not.toHaveBeenCalled();
});

it('本地状态丢失后，身份与两次 PID 都匹配才重建记录，允许再次精确停止', async () => {
  const x = fixture();
  x.sessions.clear();
  x.sessions.set(x.newTarget, replacementPid);
  x.live.add(replacementPid);
  x.directives(x.cleanup());
  x.hasResumeIdentity.mockResolvedValueOnce(false);
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  expect(loadState(x.file).executions).toEqual([]);
  x.panePid.mockResolvedValueOnce(replacementPid).mockResolvedValueOnce(replacementPid + 1);
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  x.cancel.mockRejectedValueOnce(new TmuxError());
  await x.start().tick();
  expect(loadState(x.file).executions).toContainEqual(expect.objectContaining({ id: x.replacementId, pid: replacementPid }));
  expect(x.reportSession).not.toHaveBeenCalled();
  x.sessions.set(x.newTarget, replacementPid + 1);
  await x.start().tick();
  expect(x.cancel).toHaveBeenCalledTimes(1);
  x.sessions.set(x.newTarget, replacementPid);
  await x.start().tick();
  expect(x.cancel.mock.calls).toEqual([[x.newTarget], [x.newTarget]]);
  expect(x.reportSession).toHaveBeenCalledExactlyOnceWith(x.id, expect.objectContaining({ step: 'cleanup', failure: 'session_timeout' }));
});

it('状态丢失且替代目标已消失时，不把没有 PID 当成没有进程', async () => {
  const x = fixture();
  x.sessions.clear();
  x.directives(x.cleanup());
  await x.start().tick();
  expect(x.cancel).not.toHaveBeenCalled();
  expect(x.reportSession).not.toHaveBeenCalled();
  expect(x.claim).not.toHaveBeenCalled();
});
