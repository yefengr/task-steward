import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LauncherSessionDirective } from '@pi-steward/contract';
import { acquireExecutionLock } from '@pi-steward/execution-runtime';
import { SessionControl } from '../src/session-control.js';
import { validateForegroundWorkspace } from '../src/foreground-workspace.js';
import type { State } from '../src/state.js';
import type { Tmux } from '../src/tmux.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'steward-fg-control-')));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  const configFile = join(path, 'config.json');
  writeFileSync(configFile, '{}', { mode: 0o600 });
  const id = randomUUID(), attemptId = randomUUID(), replacementId = randomUUID(), goalId = randomUUID();
  const sourcePid = 123456, nextPid = 234567;
  const locator = { path, sessionId: randomUUID(), sessionFile: join(path, 'native.jsonl') };
  writeFileSync(locator.sessionFile, `${JSON.stringify({ type: 'session', id: locator.sessionId, cwd: path })}\n`);
  const state: State = { version: 1, executions: [], outbox: [] };
  const processStatus = vi.fn<Tmux['processStatus']>((pid) => pid === nextPid ? 'alive' : 'dead');
  const tmux: Tmux = { check: vi.fn(), inspect: vi.fn().mockResolvedValue('absent'), panePid: vi.fn(), processStatus,
    launch: vi.fn(), launchResume: vi.fn().mockResolvedValue(nextPid), cancel: vi.fn(), hasResumeIdentity: vi.fn() };
  const control = new SessionControl({ state, tmux, save: vi.fn(), now: () => 100, monotonicNow: () => 100,
    extraArgs: [], started: vi.fn(), configFile });
  cleanups.push(() => control.reconcileForegroundLocks(new Set()));
  const base = { id, attemptId, mode: 'background' as const, locator, validForMs: 1000,
    foregroundOwner: { goalId, pid: sourcePid }, foregroundGit: { kind: 'non_git' as const, branch: null } };
  const stop: LauncherSessionDirective = { ...base, step: 'stop', sourceEnded: false };
  const launch: LauncherSessionDirective = { ...base, step: 'launch', replacementId };
  const apply = (directive: LauncherSessionDirective) => control.apply(directive, { wall: 100, monotonic: 100 });
  return { path, state, tmux, control, configFile, goalId, base, stop, launch, apply, processStatus, locator, replacementId };
}
it.each(['alive', 'unavailable'] as const)('前台源PID为%s不能接管，也不发停止信号', async (status) => {
  const x = fixture(); x.processStatus.mockReturnValue(status);
  await x.apply(x.stop);
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'failed',
    failure: status === 'alive' ? 'session_source_alive' : 'session_ownership_unavailable' });
  expect(x.tmux.cancel).not.toHaveBeenCalled();
  expect(x.tmux.launchResume).not.toHaveBeenCalled();
});
it('即使源PID已死，前台恢复进程已持目标锁也不得后台接管', async () => {
  const x = fixture(); const release = acquireExecutionLock(x.configFile, x.goalId);
  try {
    await x.apply(x.stop);
    expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'failed', failure: 'session_ownership_unavailable' });
    expect(x.tmux.launchResume).not.toHaveBeenCalled();
  } finally { release(); }
});
it('确认死亡并持锁后接回原会话，只发接续提示，重复launch不启动第二份', async () => {
  const x = fixture();
  await x.apply(x.stop);
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'stopped', step: 'stop' });
  expect(() => acquireExecutionLock(x.configFile, x.goalId)).toThrow('execution_owned');
  await x.apply(x.launch); await x.apply(x.launch);
  expect(x.tmux.launchResume).toHaveBeenCalledExactlyOnceWith(`steward-${x.replacementId}`, x.replacementId, x.locator, true);
  expect(x.tmux.cancel).not.toHaveBeenCalled();
  x.control.reconcileForegroundLocks(new Set());
  acquireExecutionLock(x.configFile, x.goalId)();
});
it('launcher重启后的launch仍要重新取得目标锁并复查源PID', async () => {
  const x = fixture();
  x.processStatus.mockReturnValue('alive');
  await x.apply(x.launch);
  expect(x.tmux.launchResume).not.toHaveBeenCalled();
});
it('主目录存在未提交改动时停止；分支与快照不匹配也停止', async () => {
  const x = fixture();
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', x.path]);
  const dirty: LauncherSessionDirective = { ...x.stop, step: 'stop', sourceEnded: false,
    foregroundGit: { kind: 'primary', branch: 'main' } };
  await x.apply(dirty);
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'failed', failure: 'session_workspace_unavailable' });
  expect(x.tmux.launchResume).not.toHaveBeenCalled();
  const mismatch = fixture();
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', mismatch.path]);
  await mismatch.apply({ ...mismatch.stop, step: 'stop', sourceEnded: false, foregroundGit: { kind: 'linked', branch: 'task' } });
  expect(mismatch.state.sessionOperations?.[0]?.report).toMatchObject({ failure: 'session_workspace_unavailable' });
});
it('无 Git 快照不额外核对现场；原 linked 树干净分支变更可交由扩展登记，脏变更拒绝', async () => {
  const x = fixture();
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', x.path]);
  expect(await validateForegroundWorkspace({ ...x.stop, foregroundGit: undefined })).toBeUndefined();
  execFileSync('git', ['-C', x.path, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'base']);
  const linked = join(x.path, 'linked');
  execFileSync('git', ['-C', x.path, 'worktree', 'add', '-qb', 'feature/new', linked]);
  const directive = { ...x.stop, locator: { ...x.locator, path: linked }, foregroundGit: { kind: 'linked' as const, branch: 'feature/old' } };
  expect(await validateForegroundWorkspace(directive)).toBeUndefined();
  writeFileSync(join(linked, 'unknown'), 'keep');
  expect(await validateForegroundWorkspace(directive)).toBe('session_workspace_unavailable');
});

it('普通 Pi 暂停后继续必须重新取目标锁，并恢复原 locator 为接续模式', async () => {
  const x = fixture(); const directive = { ...x.launch, mode: 'continue' as const };
  const release = acquireExecutionLock(x.configFile, x.goalId);
  await x.apply(directive);
  expect(x.tmux.launchResume).not.toHaveBeenCalled(); release();
  // 拒绝结果只能由平台新操作重试，不能在原幂等操作中改写。
  const retry = { ...directive, id: randomUUID() };
  await x.apply(retry); await x.apply(retry);
  expect(x.tmux.launchResume).toHaveBeenCalledExactlyOnceWith(`steward-${x.replacementId}`, x.replacementId, x.locator, true);
});
it.each(['pause', 'finalize'] as const)('普通 Pi 的 %s 不杀源进程，等待死亡和目标锁后才回报', async (mode) => {
  const x = fixture(); const directive = { ...x.stop, mode };
  x.processStatus.mockReturnValue('alive'); await x.apply(directive);
  expect(x.state.sessionOperations?.[0]?.report).toBeUndefined();
  x.processStatus.mockReturnValue('unavailable'); await x.apply(directive);
  expect(x.state.sessionOperations?.[0]?.report).toBeUndefined();
  x.processStatus.mockReturnValue('dead');
  const release = acquireExecutionLock(x.configFile, x.goalId);
  await x.apply(directive);
  expect(x.state.sessionOperations?.[0]?.report).toBeUndefined();
  release(); await x.apply(directive);
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ result: 'stopped' });
  expect(x.tmux.cancel).not.toHaveBeenCalled(); expect(x.tmux.launchResume).not.toHaveBeenCalled();
});
it('缺少现场文件或进程身份时失败，不创建替代对话', async () => {
  const x = fixture(); rmSync(x.locator.sessionFile);
  await x.apply(x.stop);
  expect(x.state.sessionOperations?.[0]?.report).toMatchObject({ failure: 'session_record_missing' });
  expect(x.tmux.launchResume).not.toHaveBeenCalled();
  const y = fixture();
  const noOwner = { ...y.stop, step: 'stop' as const, sourceEnded: false, foregroundOwner: undefined };
  await y.apply(noOwner);
  expect(y.state.sessionOperations?.[0]?.report).toMatchObject({ failure: 'session_ownership_unavailable' });
});
