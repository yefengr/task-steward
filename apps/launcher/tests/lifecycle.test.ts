import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LauncherHeartbeatResponse, LauncherSessionDirective, LocalConfig } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { Launcher } from '../src/launcher.js';
import type { Platform } from '../src/platform.js';
import { PlatformError } from '../src/platform.js';
import { SessionControl } from '../src/session-control.js';
import { loadState, saveState, type State } from '../src/state.js';
import { targetFor, type Tmux } from '../src/tmux.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const id = randomUUID();
  const state: State = { version: 1, executions: [{ id, target: targetFor(id), phase: 'observed', pid: 123 }], outbox: [] };
  const response: LauncherHeartbeatResponse = { directives: [{ attemptId: id, tmuxSession: targetFor(id), action: 'continue', occupiesSlot: false }] };
  const tmux: Tmux = { check: vi.fn().mockResolvedValue('ready'), inspect: vi.fn().mockResolvedValue('present'),
    panePid: vi.fn().mockResolvedValue(123), processStatus: vi.fn().mockReturnValue('alive'),
    launch: vi.fn(), launchResume: vi.fn(), cancel: vi.fn(), hasResumeIdentity: vi.fn() };
  const platform = { heartbeat: vi.fn().mockResolvedValue(response), claim: vi.fn().mockResolvedValue({ attempt: null }),
    report: vi.fn().mockResolvedValue({ ok: true }), reportSession: vi.fn(), reportGit: vi.fn() };
  const launcher = new Launcher({ state, config: { slots: 1, projects: [], pi: { extraArgs: [] } } as unknown as LocalConfig,
    version: 'test', platform: platform as unknown as Platform, tmux, save: vi.fn() });
  return { id, state, response, tmux, platform, launcher };
}
it('retained Pi releases its slot even through observed early return and remains observed on every tick', async () => {
  const x = fixture();
  await x.launcher.tick(); await x.launcher.tick();
  expect(x.platform.claim).toHaveBeenCalledTimes(2);
  expect(x.state.executions).toHaveLength(1);
  expect(x.state.executions[0]).toMatchObject({ phase: 'observed', occupiesSlot: false });
  expect(x.platform.heartbeat.mock.calls[1]?.[0].attempts).toEqual([{ id: x.id, tmuxSession: targetFor(x.id), running: true }]);
  x.tmux.inspect = vi.fn().mockResolvedValue('absent');
  x.tmux.processStatus = vi.fn().mockReturnValue('dead');
  await x.launcher.tick();
  expect(x.platform.report).toHaveBeenCalledWith(expect.objectContaining({ id: x.id, kind: 'exited' }));
  expect(x.state.executions).toHaveLength(0);
});
it('foreground exemption from slots is not proof of settlement; retained identity must be freshly verified', async () => {
  const x = fixture();
  await x.launcher.tick();
  expect(x.state.executions[0]).toMatchObject({ occupiesSlot: false, workSettled: false, identityVerified: false });
  x.response.directives[0]!.workSettled = true;
  await x.launcher.tick();
  expect(x.state.executions[0]).toMatchObject({ workSettled: true, identityVerified: true });
  x.tmux.panePid = vi.fn().mockResolvedValue(999);
  await x.launcher.tick();
  expect(x.state.executions[0]).toMatchObject({ pid: 123, identityVerified: false });
});
it.each(['legacy', 'unknown', 'missing', 'prepared'] as const)('%s never releases a slot from an old or uncertain record', async (mode) => {
  const x = fixture();
  x.state.executions[0]!.occupiesSlot = false;
  if (mode === 'legacy') delete x.response.directives[0]!.occupiesSlot;
  if (mode === 'unknown') x.response.directives[0]!.action = 'unknown';
  if (mode === 'missing') x.response.directives = [];
  if (mode === 'prepared') {
    // 启动结果尚未知，即使平台确认工作已结算也仍保留本地启动名额。
    x.state.executions[0]!.phase = 'launching';
    x.state.executions[0]!.sessionOperationId = randomUUID();
    x.tmux.panePid = vi.fn().mockResolvedValue(undefined);
  }
  await x.launcher.tick();
  expect(x.platform.claim).not.toHaveBeenCalled();
  expect(x.state.executions).toHaveLength(1);
});
it('cancel of retained Pi only stops its exact target and never launches a replacement', async () => {
  const x = fixture(); x.state.executions[0]!.occupiesSlot = false;
  x.response.directives[0]!.action = 'cancel';
  x.tmux.cancel = vi.fn().mockImplementation(async () => {
    x.tmux.inspect = vi.fn().mockResolvedValue('absent'); x.tmux.processStatus = vi.fn().mockReturnValue('dead');
  });
  await x.launcher.tick();
  expect(x.tmux.cancel).toHaveBeenCalledExactlyOnceWith(targetFor(x.id));
  expect(x.platform.report).toHaveBeenCalledWith(expect.objectContaining({ id: x.id, kind: 'exited' }));
  expect(x.tmux.launch).not.toHaveBeenCalled(); expect(x.tmux.launchResume).not.toHaveBeenCalled();
});
it('unsettled exempt work blocks Git even when local records are missing', async () => {
  const x = fixture(); x.state.executions = [];
  x.response.directives[0]!.workSettled = false;
  x.tmux.inspect = vi.fn().mockResolvedValue('unavailable');
  x.response.gitOperations = [{ id: randomUUID(), taskId: randomUUID(), projectId: 'missing', deliveryId: randomUUID(),
    baseBranch: 'main', taskBranch: 'feature/task', baseCommit: 'a'.repeat(40), approvedCommit: 'b'.repeat(40),
    repositoryPath: '/fixture/repo', worktreePath: '/fixture/worktree', mergedCommit: null, phase: 'merge' }];
  await x.launcher.tick();
  expect(x.platform.reportGit).not.toHaveBeenCalled();
  expect(x.state.gitOperations).toHaveLength(1);
  expect(x.state.gitOperations?.[0]?.mergeIssued).not.toBe(true);
});
it('offline heartbeat cannot release or remove retained execution records', async () => {
  const x = fixture(); x.platform.heartbeat.mockRejectedValue(new PlatformError('network_error'));
  await x.launcher.tick();
  expect(x.platform.claim).not.toHaveBeenCalled(); expect(x.state.executions).toHaveLength(1);
});
it('legacy state stays fail-closed, and explicit retained confirmation survives persistence', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'steward-lifecycle-'))); dirs.push(dir);
  const file = join(dir, 'state.json'); const x = fixture(); saveState(file, x.state);
  expect(loadState(file).executions[0]!.occupiesSlot).toBeUndefined();
  x.state.executions[0]!.occupiesSlot = false; saveState(file, x.state);
  expect(loadState(file).executions[0]!.occupiesSlot).toBe(false);
});
function sessionFixture() {
  const x = fixture(); const path = realpathSync(mkdtempSync(join(tmpdir(), 'steward-session-lifecycle-'))); dirs.push(path);
  const locator = { path, sessionId: randomUUID(), sessionFile: join(path, 'session.jsonl') };
  writeFileSync(locator.sessionFile, JSON.stringify({ type: 'session', id: locator.sessionId, cwd: path }) + '\n');
  const started = vi.fn();
  const control = new SessionControl({ state: x.state, tmux: x.tmux, save: vi.fn(), now: () => 100,
    monotonicNow: () => 100, extraArgs: [], started });
  const directive = { id: randomUUID(), attemptId: x.id, mode: 'pause' as const, step: 'stop' as const,
    sourceEnded: false, locator, validForMs: 1000 };
  const apply = (d: LauncherSessionDirective) => control.apply(d, { wall: 100, monotonic: 100 });
  return { ...x, directive, apply, started, locator };
}
it.each(['pause', 'finalize'] as const)('%s stops only the precise dedicated Pi, reports success only after PID death, and never launches', async (mode) => {
  const x = sessionFixture();
  x.tmux.cancel = vi.fn().mockImplementation(async () => {
    x.tmux.inspect = vi.fn().mockResolvedValue('absent'); x.tmux.processStatus = vi.fn().mockReturnValue('dead');
  });
  const directive = { ...x.directive, mode };
  await x.apply(directive); await x.apply(directive);
  expect(x.tmux.cancel).toHaveBeenCalledExactlyOnceWith(targetFor(x.id));
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'stopped' });
  await x.apply({ ...directive, step: 'launch', replacementId: randomUUID() });
  expect(x.tmux.launchResume).not.toHaveBeenCalled();
});
it.each(['pause', 'finalize'] as const)('%s cannot report stopped when target disappears but PID status is unknown', async (mode) => {
  const x = sessionFixture();
  x.tmux.cancel = vi.fn().mockImplementation(async () => {
    x.tmux.inspect = vi.fn().mockResolvedValue('absent'); x.tmux.processStatus = vi.fn().mockReturnValue('unavailable');
  });
  await x.apply({ ...x.directive, mode });
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'failed', failure: 'session_stop_failed' });
  expect(x.tmux.launchResume).not.toHaveBeenCalled();
});
it.each(['pause', 'finalize'] as const)('%s needs recorded PID death even when platform says source ended', async (mode) => {
  const x = sessionFixture(); x.state.executions = [];
  x.tmux.inspect = vi.fn().mockResolvedValue('absent');
  await x.apply({ ...x.directive, mode, sourceEnded: true });
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'failed', failure: 'session_stop_failed' });
  expect(x.tmux.cancel).not.toHaveBeenCalled();
});
it.each(['continue', 'restart', 'restore'] as const)('%s resumes exact locator once and only continue requests the continuation message', async (mode) => {
  const x = sessionFixture(); const replacementId = randomUUID();
  x.tmux.inspect = vi.fn().mockResolvedValue('absent'); x.tmux.processStatus = vi.fn().mockReturnValue('dead');
  x.tmux.launchResume = vi.fn().mockResolvedValue(456);
  const d: LauncherSessionDirective = { ...x.directive, mode, step: 'launch', replacementId };
  await x.apply(d); await x.apply(d);
  expect(x.tmux.launchResume).toHaveBeenCalledTimes(1);
  expect(x.tmux.launchResume).toHaveBeenCalledWith(targetFor(replacementId), replacementId, x.locator, ...(mode === 'continue' ? [true] : []));
});
it('pending stop still reserves a slot for a retained Pi', async () => {
  const x = sessionFixture();
  x.response.sessionOperations = [x.directive];
  await x.launcher.tick();
  expect(x.platform.claim).not.toHaveBeenCalled();
});
