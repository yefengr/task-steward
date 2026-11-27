import { execFileSync, spawn } from 'node:child_process';
import * as runtime from '@pi-steward/execution-runtime';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LauncherGitOperation, LocalConfig } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { GitLifecycle } from '../src/git-lifecycle.js';
import { cleanupAccepted, mergeAccepted, verifySource } from '../src/git-native.js';
import { PlatformError, type Platform } from '../src/platform.js';
import { loadState, saveState } from '../src/state.js';
const race = vi.hoisted(() => ({ beforeUpdate: undefined as (() => void) | undefined }));
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return { ...actual, promisify: (fn: Parameters<typeof actual.promisify>[0]) => {
    const run = actual.promisify(fn);
    return (...args: unknown[]) => {
      if (Array.isArray(args[1]) && args[1].includes('update-ref') && race.beforeUpdate) {
        const action = race.beforeUpdate; race.beforeUpdate = undefined; action();
      }
      return run(...args);
    };
  } };
});
const dirs: string[] = [];
afterEach(() => { race.beforeUpdate = undefined; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function g(root: string, ...args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }).trim(); }
function commit(root: string, name: string) { writeFileSync(join(root, name), name); g(root, 'add', name); g(root, 'commit', '-qm', name); return g(root, 'rev-parse', 'HEAD'); }
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'steward-finalize-'))); dirs.push(dir);
  const root = join(dir, 'repo'); mkdirSync(root); g(root, 'init', '-qb', 'main');
  g(root, 'config', 'user.name', 'test'); g(root, 'config', 'user.email', 'test@example.invalid');
  const base = commit(root, 'base'); const source = join(dir, 'source');
  g(root, 'checkout', '-qb', 'maintenance');
  g(root, 'worktree', 'add', '-b', 'feature/task', source, base);
  const marker = join(g(source, 'rev-parse', '--absolute-git-dir'), 'pi-worktree-manager.json');
  writeFileSync(marker, JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() }));
  const accepted = commit(source, 'accepted');
  const operation: LauncherGitOperation = { id: randomUUID(), taskId: randomUUID(), projectId: 'p', deliveryId: randomUUID(),
    baseBranch: 'main', baseCommit: base, taskBranch: 'feature/task', repositoryPath: root, worktreePath: source,
    approvedCommit: accepted, mergedCommit: null, phase: 'merge' };
  const config = { projects: [{ id: 'p', path: root }] } as LocalConfig;
  const file = join(dir, 'state.json'); const state = loadState(file);
  const reportGit = vi.fn<Platform['reportGit']>(async () => ({ ok: true }));
  const platform = { reportGit } as unknown as Platform;
  const start = () => { const state = loadState(file); return new GitLifecycle({ state, config, platform, save: () => saveState(file, state) }); };
  saveState(file, state);
  return { dir, root, source, marker, operation, accepted, base, file, reportGit, start };
}
it('前台目标已结算也不代表普通 Pi 已退出，无法确认时不合并或清理', async () => {
  const x = fixture(); x.operation.foregroundOwner = { goalId: randomUUID(), pid: process.pid };
  const status = vi.spyOn(runtime, 'processStatus').mockReturnValue('alive');
  try {
    await x.start().apply(x.operation, false);
    expect(x.reportGit.mock.lastCall?.[1]).toMatchObject({ outcome: 'blocked', message: 'git_foreground_session_active' });
    expect(g(x.root, 'rev-parse', 'main')).toBe(x.base); expect(existsSync(x.source)).toBe(true);
    status.mockReturnValue('unavailable'); await x.start().apply(x.operation, false);
    expect(g(x.root, 'rev-parse', 'main')).toBe(x.base);
    status.mockReturnValue('dead'); await x.start().apply(x.operation, false);
    expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('merged');
    expect(g(x.root, 'rev-parse', 'main')).toBe(x.accepted);
  } finally { status.mockRestore(); }
});
it.each(['changed', 'dirty', 'locked', 'unowned', 'primary'])( 'source gate rejects %s', async (mode) => {
  const x = fixture();
  if (mode === 'changed') commit(x.source, 'late');
  if (mode === 'dirty') writeFileSync(join(x.source, 'dirty'), 'dirty');
  if (mode === 'locked') g(x.root, 'worktree', 'lock', x.source);
  if (mode === 'unowned') rmSync(x.marker);
  if (mode === 'primary') x.operation.worktreePath = x.root;
  await expect(verifySource(x.operation)).rejects.toBeDefined();
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.base);
});
it('ignored build artifacts follow native Git cleanup semantics without deleting original project files', async () => {
  const x = fixture();
  writeFileSync(join(x.root, '.git', 'info', 'exclude'), 'artifact\n');
  writeFileSync(join(x.source, 'artifact'), 'disposable task build output');
  writeFileSync(join(x.root, 'artifact'), 'original project copy');
  await expect(verifySource(x.operation)).resolves.toBe(true);
  await x.start().apply(x.operation, false);
  await x.start().apply({ ...x.operation, phase: 'cleanup', mergedCommit: x.accepted }, false);
  expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('complete');
  expect(existsSync(x.source)).toBe(false);
  expect(existsSync(join(x.root, 'artifact'))).toBe(true);
});
it('in-use process blocks source cleanup', async () => {
  const x = fixture(); const child = spawn('/bin/sleep', ['30'], { cwd: x.source });
  await new Promise<void>((resolve) => child.once('spawn', resolve));
  try { await expect(verifySource(x.operation)).rejects.toMatchObject({ reason: 'git_worktree_in_use' }); }
  finally { child.kill(); await new Promise<void>((resolve) => child.once('exit', () => resolve())); }
});
it('exact FF succeeds and an already accepted ancestor preserves later base commits', async () => {
  const x = fixture(); await mergeAccepted(x.operation); expect(g(x.root, 'rev-parse', 'main')).toBe(x.accepted);
  g(x.root, 'checkout', 'main'); const later = commit(x.root, 'later'); g(x.root, 'checkout', 'maintenance');
  await mergeAccepted(x.operation); expect(g(x.root, 'rev-parse', 'main')).toBe(later);
  await cleanupAccepted(x.operation, false, () => {}); expect(existsSync(x.source)).toBe(false);
  expect(g(x.root, 'rev-parse', 'main')).toBe(later);
});
it('checked-out base blocks advancement without changing refs or checkout files; already merged is a no-op', async () => {
  const x = fixture(); g(x.root, 'checkout', 'main');
  await x.start().apply(x.operation, false);
  expect(x.reportGit.mock.lastCall?.[1]).toMatchObject({ outcome: 'blocked', message: 'git_target_checked_out' });
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.base);
  expect(g(x.root, 'rev-parse', 'feature/task')).toBe(x.accepted);
  expect(g(x.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  expect(g(x.root, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(x.root, 'accepted'))).toBe(false);
  g(x.root, 'merge', '--ff-only', x.accepted);
  await expect(mergeAccepted(x.operation)).resolves.toBeUndefined();
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.accepted);
});
it('explicit ref update never changes the maintenance branch or its files', async () => {
  const x = fixture(); const maintenance = commit(x.root, 'maintenance-only');
  await mergeAccepted(x.operation);
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.accepted);
  expect(g(x.root, 'rev-parse', 'HEAD')).toBe(maintenance);
  expect(g(x.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/maintenance');
  expect(g(x.root, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(x.root, 'maintenance-only'))).toBe(true);
  expect(existsSync(join(x.root, 'accepted'))).toBe(false);
});
it('CAS rejects a concurrent base ref advance without overwriting it or the checkout', async () => {
  const x = fixture(); const concurrent = commit(x.root, 'concurrent');
  race.beforeUpdate = () => g(x.root, 'update-ref', 'refs/heads/main', concurrent, x.base);
  await expect(mergeAccepted(x.operation)).rejects.toMatchObject({ reason: 'git_command_failed' });
  expect(race.beforeUpdate).toBeUndefined();
  expect(g(x.root, 'rev-parse', 'main')).toBe(concurrent);
  expect(g(x.root, 'rev-parse', 'feature/task')).toBe(x.accepted);
  expect(g(x.root, 'rev-parse', 'HEAD')).toBe(concurrent);
  expect(g(x.root, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(x.root, 'accepted'))).toBe(false);
});
it('diverged target requests rework without modifying either branch', async () => {
  const x = fixture(); g(x.root, 'checkout', 'main'); const head = commit(x.root, 'diverge'); g(x.root, 'checkout', 'maintenance');
  await x.start().apply(x.operation, false);
  expect(x.reportGit.mock.calls[0]?.[1]).toMatchObject({ outcome: 'needs_rework', message: 'git_target_diverged' });
  expect(g(x.root, 'rev-parse', 'main')).toBe(head); expect(existsSync(x.source)).toBe(true);
});
it('durable merged HTTP unknown replay keeps same body across restart and never cleans before ack', async () => {
  const x = fixture(); x.reportGit.mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost'));
  await x.start().apply(x.operation, false); const first = x.reportGit.mock.calls[0]![1];
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.accepted); expect(existsSync(x.source)).toBe(true);
  await x.start().apply(x.operation, false); expect(x.reportGit.mock.calls[1]![1]).toEqual(first); expect(existsSync(x.source)).toBe(true);
  await x.start().apply(x.operation, false); expect(x.reportGit.mock.calls[2]![1]).toEqual(first); expect(existsSync(x.source)).toBe(true);
  await x.start().apply({ ...x.operation, phase: 'cleanup', mergedCommit: x.accepted }, false);
  expect(existsSync(x.source)).toBe(false); expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('complete');
});
it('crash after merge before journal recovers without a new merge tree', async () => {
  const x = fixture(); await mergeAccepted(x.operation);
  await x.start().apply(x.operation, false);
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.accepted); expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('merged');
});
it('partial cleanup can transfer to exact new operation but never deletes changed branch', async () => {
  const x = fixture(); await x.start().apply(x.operation, false);
  const state = loadState(x.file); state.gitOperations![0]!.cleanupIssued = true; saveState(x.file, state);
  g(x.root, 'worktree', 'remove', x.source);
  const retry = { ...x.operation, id: randomUUID(), phase: 'cleanup' as const, mergedCommit: x.accepted };
  await x.start().apply(retry, false); expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('complete');
  expect(g(x.root, 'for-each-ref', '--format=%(objectname)', 'refs/heads/feature/task')).toBe('');
});
it('cleanup absent without local removal intent blocks; replaced directory and late source survive', async () => {
  const x = fixture(); await mergeAccepted(x.operation); g(x.root, 'worktree', 'remove', x.source);
  const op = { ...x.operation, phase: 'cleanup' as const, mergedCommit: x.accepted };
  await x.start().apply(op, false); expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('blocked');
  mkdirSync(x.source); writeFileSync(join(x.source, 'keep'), 'keep');
  await expect(cleanupAccepted(op, true, () => {})).rejects.toMatchObject({ reason: 'git_worktree_replaced' });
  expect(existsSync(join(x.source, 'keep'))).toBe(true);
});
it('partial cleanup never deletes a branch changed after removal', async () => {
  const x = fixture(); await x.start().apply(x.operation, false);
  const state = loadState(x.file); state.gitOperations![0]!.cleanupIssued = true; saveState(x.file, state);
  g(x.root, 'worktree', 'remove', x.source);
  g(x.root, 'checkout', 'main'); const later = commit(x.root, 'late-base'); g(x.root, 'checkout', 'maintenance');
  g(x.root, 'update-ref', 'refs/heads/feature/task', later, x.accepted);
  await x.start().apply({ ...x.operation, id: randomUUID(), phase: 'cleanup', mergedCommit: x.accepted }, false);
  expect(x.reportGit.mock.lastCall?.[1]).toMatchObject({ outcome: 'blocked', message: 'git_branch_changed' });
  expect(g(x.root, 'rev-parse', 'refs/heads/feature/task')).toBe(later);
});
it.each(['busy', 'claim', 'execution', 'session'] as const)('no Git actions while %s is pending', async (mode) => {
  const x = fixture(); const state = loadState(x.file);
  if (mode === 'claim') state.claimRequestId = randomUUID();
  if (mode === 'execution') { const id = randomUUID(); state.executions.push({ id, target: `steward-${id}`, phase: 'observed' }); }
  if (mode === 'session') state.sessionOperations = [{ id: randomUUID(), attemptId: randomUUID(), step: 'stop' }];
  saveState(x.file, state); await x.start().apply(x.operation, mode === 'busy');
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.base);
  expect(existsSync(x.source)).toBe(true); expect(x.reportGit).not.toHaveBeenCalled();
});
it('merged checkpoint and report are saved together; legacy missing report recovers', async () => {
  const x = fixture(); const state = loadState(x.file); const snapshots: typeof state[] = [];
  const runner = new GitLifecycle({ state, config: { projects: [{ id: 'p', path: x.root }] } as LocalConfig,
    platform: { reportGit: x.reportGit } as unknown as Platform, save: () => { snapshots.push(structuredClone(state)); saveState(x.file, state); } });
  await runner.apply(x.operation, false);
  expect(snapshots.filter((s) => s.gitOperations?.[0]?.merged).every((s) => !!s.gitOperations![0]!.report)).toBe(true);
  const legacy = loadState(x.file); delete legacy.gitOperations![0]!.report;
  delete legacy.gitOperations![0]!.reportAcknowledged; delete legacy.gitOperations![0]!.mergeAcknowledged;
  saveState(x.file, legacy); x.reportGit.mockClear();
  await x.start().apply(x.operation, false);
  expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('merged'); expect(existsSync(x.source)).toBe(true);
});
it.each(['conflict', 'not_found', 'forbidden', 'invalid_request'] as const)('terminal %s stops report replay and cleanup', async (code) => {
  const x = fixture(); x.reportGit.mockRejectedValue(new PlatformError(code));
  await x.start().apply(x.operation, false);
  await x.start().apply({ ...x.operation, phase: 'cleanup', mergedCommit: x.accepted }, false);
  expect(x.reportGit).toHaveBeenCalledTimes(1); expect(existsSync(x.source)).toBe(true);
  expect(loadState(x.file).gitOperations![0]).toMatchObject({ reportRejected: true });
  expect(loadState(x.file).gitOperations![0]!.mergeAcknowledged).not.toBe(true);
});
it('terminal journal is bounded while unknown reports and partial cleanup survive', async () => {
  const x = fixture(); const state = loadState(x.file);
  const pending = { operation: { ...x.operation, id: randomUUID() }, report: { requestId: randomUUID(), outcome: 'merged' as const, mergedCommit: x.accepted } };
  const partial = { operation: { ...x.operation, id: randomUUID() }, cleanupIssued: true, mergeAcknowledged: true };
  state.gitOperations = [pending, partial]; saveState(x.file, state);
  for (let i = 0; i < 40; i++) {
    const saved = loadState(x.file);
    // 已持久确认的成功和返修终态，与被拒终态共用相同安全裁剪规则。
    for (const outcome of ['complete', 'needs_rework'] as const) saved.gitOperations!.push({
      operation: { ...x.operation, id: randomUUID(), taskId: randomUUID() },
      report: { requestId: randomUUID(), outcome, mergedCommit: x.accepted }, reportAcknowledged: true,
      ...(outcome === 'complete' ? { cleanupIssued: true, cleaned: true } : {}),
    });
    saveState(x.file, saved);
    x.reportGit.mockRejectedValueOnce(new PlatformError('not_found'));
    await x.start().apply({ ...x.operation, id: randomUUID(), taskId: randomUUID(), projectId: 'missing' }, false);
  }
  const entries = loadState(x.file).gitOperations!;
  expect(entries.length).toBeLessThanOrEqual(34);
  expect(entries).toContainEqual(pending); expect(entries).toContainEqual(partial);
});
it('accepted source modified after merge is never cleaned', async () => {
  const x = fixture(); await x.start().apply(x.operation, false); commit(x.source, 'late');
  await x.start().apply({ ...x.operation, phase: 'cleanup', mergedCommit: x.accepted }, false);
  expect(x.reportGit.mock.lastCall?.[1].outcome).toBe('blocked'); expect(existsSync(x.source)).toBe(true);
});
