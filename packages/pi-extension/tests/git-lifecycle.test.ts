import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentContextResponse, TaskGit } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareGit, proveWorkspace, repositoryLock } from '../src/git-lifecycle.js';
import { lockRepository } from '../../../apps/launcher/src/git-native.js';

it('extension uses launcher SQLite lock path and releases on completion', async () => {
  const x = fixture();
  const release = await lockRepository(x.root);
  try {
    await expect(repositoryLock(x.root, async () => true)).rejects.toMatchObject({ code: 'git_repository_busy' });
  } finally { release(); }
  await repositoryLock(x.root, async () => {
    await expect(lockRepository(x.root)).rejects.toMatchObject({ reason: 'git_repository_busy' });
  });
  await expect(repositoryLock(x.root, async () => true)).resolves.toBe(true);
});
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
function g(root: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string, name: string) { writeFileSync(join(root, name), name); g(root, 'add', name); g(root, 'commit', '-qm', name); return g(root, 'rev-parse', 'HEAD'); }
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'steward-prepare-'))); dirs.push(dir);
  const root = join(dir, 'repo'); mkdirSync(root); g(root, 'init', '-qb', 'main');
  g(root, 'config', 'user.name', 'test'); g(root, 'config', 'user.email', 'test@example.invalid');
  const base = commit(root, 'base');
  g(root, 'checkout', '-qb', 'maintenance');
  const data: AgentContextResponse = { task: { id: randomUUID(), projectId: 'p', title: 't', goal: '', acceptance: '', notes: '', type: 'implementation' },
    attempt: { id: randomUUID(), kind: 'new', executionMode: 'background' }, workspace: { path: root, requirements: [] }, decisions: [], deliveries: [], questions: [],
    gitSettings: { baseBranch: 'main', syncBeforeStart: true } };
  return { dir, root, base, data };
}
it.each(['remote-ahead', 'local-ahead', 'diverged', 'no-upstream', 'disabled', 'fetch-failed', 'dirty'])( 'prepare safely handles %s', async (mode) => {
  const x = fixture(); let expected = x.base;
  if (mode !== 'no-upstream') {
    const bare = join(x.dir, 'upstream.git'); g(x.root, 'init', '--bare', bare);
    g(x.root, 'remote', 'add', 'origin', bare); g(x.root, 'push', '-u', 'origin', 'main');
    if (mode === 'remote-ahead' || mode === 'diverged') {
      const other = join(x.dir, 'other'); g(x.root, 'clone', '-b', 'main', bare, other);
      g(other, 'config', 'user.name', 'test'); g(other, 'config', 'user.email', 'test@example.invalid');
      expected = commit(other, 'remote'); g(other, 'push', 'origin', 'main');
    }
    if (mode === 'local-ahead' || mode === 'diverged') {
      g(x.root, 'checkout', 'main'); expected = commit(x.root, 'local'); g(x.root, 'checkout', 'maintenance');
    }
    if (mode === 'disabled') { x.data.gitSettings!.syncBeforeStart = false; }
    if (mode === 'disabled' || mode === 'fetch-failed') g(x.root, 'remote', 'set-url', 'origin', '/missing/local-upstream');
    if (mode === 'dirty') { g(x.root, 'checkout', 'main'); writeFileSync(join(x.root, 'dirty'), 'keep'); }
  }
  if (mode === 'fetch-failed' || mode === 'dirty') {
    await expect(prepareGit(x.data, 'feature/task')).rejects.toMatchObject({ code: mode === 'dirty' ? 'git_dirty' : 'git_fetch_failed' });
    expect(g(x.root, 'rev-parse', 'main')).toBe(expected); return;
  }
  if (mode === 'diverged') {
    await expect(prepareGit(x.data, 'feature/task')).rejects.toMatchObject({ code: 'git_upstream_diverged' });
    expect(g(x.root, 'rev-parse', 'main')).toBe(expected); return;
  }
  const prepared = await prepareGit(x.data, 'feature/task');
  expect(prepared.baseCommit).toBe(expected);
  expect(prepared.syncResult).toBe(mode === 'disabled' ? 'disabled' : mode === 'no-upstream' ? 'no_upstream' : 'synced');
  expect(g(x.root, 'rev-parse', 'main')).toBe(expected);
});
it.each(['main', 'linked'] as const)('remote advancement blocks when base is checked out in %s', async (checkout) => {
  const x = fixture(); const bare = join(x.dir, 'upstream.git'); g(x.root, 'init', '--bare', bare);
  g(x.root, 'remote', 'add', 'origin', bare); g(x.root, 'push', '-u', 'origin', 'main');
  const other = join(x.dir, 'other'); g(x.root, 'clone', '-b', 'main', bare, other);
  g(other, 'config', 'user.name', 'test'); g(other, 'config', 'user.email', 'test@example.invalid');
  const remote = commit(other, 'remote'); g(other, 'push', 'origin', 'main');
  const target = checkout === 'main' ? x.root : join(x.dir, 'base-checkout');
  if (checkout === 'main') g(x.root, 'checkout', 'main');
  else g(x.root, 'worktree', 'add', target, 'main');
  const maintenance = g(x.root, 'rev-parse', 'maintenance');
  await expect(prepareGit(x.data, 'feature/task')).rejects.toMatchObject({ code: 'git_base_checked_out' });
  expect(g(x.root, 'rev-parse', 'main')).toBe(x.base);
  expect(g(x.root, 'rev-parse', 'maintenance')).toBe(maintenance);
  expect(g(target, 'rev-parse', 'HEAD')).toBe(x.base);
  expect(g(target, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(target, 'remote'))).toBe(false);
  // 由维护者主动推进后，同一已检出目录允许安全 no-op。
  g(target, 'merge', '--ff-only', remote);
  await expect(prepareGit(x.data, 'feature/task')).resolves.toMatchObject({ baseCommit: remote, syncResult: 'synced' });
});
it('sync advances only the base ref, not an unrelated checked-out branch or its files', async () => {
  const x = fixture(); const bare = join(x.dir, 'upstream.git'); g(x.root, 'init', '--bare', bare);
  g(x.root, 'remote', 'add', 'origin', bare); g(x.root, 'push', '-u', 'origin', 'main');
  const other = join(x.dir, 'other'); g(x.root, 'clone', '-b', 'main', bare, other);
  g(other, 'config', 'user.name', 'test'); g(other, 'config', 'user.email', 'test@example.invalid');
  const remote = commit(other, 'remote'); g(other, 'push', 'origin', 'main');
  const maintenance = commit(x.root, 'maintenance-only');
  await expect(prepareGit(x.data, 'feature/task')).resolves.toMatchObject({ baseCommit: remote });
  expect(g(x.root, 'rev-parse', 'main')).toBe(remote);
  expect(g(x.root, 'rev-parse', 'HEAD')).toBe(maintenance);
  expect(g(x.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/maintenance');
  expect(g(x.root, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(x.root, 'maintenance-only'))).toBe(true);
  expect(existsSync(join(x.root, 'remote'))).toBe(false);
});
it('sync CAS rejects a concurrent base change without overwriting any branch or files', async () => {
  const x = fixture(); const bare = join(x.dir, 'upstream.git'); g(x.root, 'init', '--bare', bare);
  g(x.root, 'remote', 'add', 'origin', bare); g(x.root, 'push', '-u', 'origin', 'main');
  const other = join(x.dir, 'other'); g(x.root, 'clone', '-b', 'main', bare, other);
  g(other, 'config', 'user.name', 'test'); g(other, 'config', 'user.email', 'test@example.invalid');
  commit(other, 'remote'); g(other, 'push', 'origin', 'main');
  const concurrent = commit(x.root, 'concurrent');
  race.beforeUpdate = () => g(x.root, 'update-ref', 'refs/heads/main', concurrent, x.base);
  await expect(prepareGit(x.data, 'feature/task')).rejects.toBeDefined();
  expect(race.beforeUpdate).toBeUndefined();
  expect(g(x.root, 'rev-parse', 'main')).toBe(concurrent);
  expect(g(x.root, 'rev-parse', 'HEAD')).toBe(concurrent);
  expect(g(x.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/maintenance');
  expect(g(x.root, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(x.root, 'remote'))).toBe(false);
});
it('snapshot delivery proves canonical owned linked branch, exact SHA, clean tree and durable session', async () => {
  const x = fixture(); const linked = join(x.dir, 'linked');
  g(x.root, 'worktree', 'add', '-b', 'feature/task', linked, x.base);
  const dir = g(linked, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(dir, 'pi-worktree-manager.json'), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() }));
  x.data.git = { baseBranch: 'main', baseCommit: x.base, taskBranch: 'feature/task', repositoryPath: x.root, worktreePath: linked,
    machineId: randomUUID(), syncBeforeStart: false, syncResult: 'disabled', phase: 'ready', operationId: null, deliveryId: null,
    approvedCommit: null, mergedCommit: null, message: null } satisfies TaskGit;
  const session = SessionManager.create(linked, join(x.dir, 'sessions'));
  session.appendMessage({ role: 'user', content: 'test', timestamp: Date.now() });
  const ctx = { cwd: linked, sessionManager: session };
  // 安装依赖或构建生成的忽略文件不应让正常代码任务永远无法交付。
  writeFileSync(join(x.root, '.git', 'info', 'exclude'), 'build-output\n');
  writeFileSync(join(linked, 'build-output'), 'generated');
  await expect(proveWorkspace(ctx, x.data, { baseCommit: x.base, commit: x.base })).resolves.toMatchObject({ gitRoot: linked });
  for (const path of [linked, join(linked, 'sub')]) {
    mkdirSync(path, { recursive: true }); x.data.workspace.path = path;
    const resumed = SessionManager.create(path, join(x.dir, 'resumed'));
    resumed.appendMessage({ role: 'user', content: 'rework', timestamp: Date.now() });
    await expect(proveWorkspace({ cwd: path, sessionManager: resumed }, x.data, { commit: x.base })).resolves.toMatchObject({ gitRoot: linked });
  }
  const primarySession = SessionManager.create(x.root, join(x.dir, 'primary-sessions'));
  primarySession.appendMessage({ role: 'user', content: 'primary', timestamp: Date.now() });
  await expect(proveWorkspace({ cwd: x.root, sessionManager: primarySession }, x.data)).rejects.toBeDefined();
  const other = fixture();
  const otherSession = SessionManager.create(other.root, join(other.dir, 'sessions'));
  otherSession.appendMessage({ role: 'user', content: 'other', timestamp: Date.now() });
  await expect(proveWorkspace({ cwd: other.root, sessionManager: otherSession }, x.data)).rejects.toBeDefined();
  await expect(proveWorkspace(ctx, x.data, {})).rejects.toMatchObject({ code: 'git_commit_required' });
  await expect(proveWorkspace(ctx, x.data, { commit: x.base.slice(0, 8) })).rejects.toMatchObject({ code: 'git_commit_required' });
  await expect(proveWorkspace(ctx, x.data, { commit: x.base, baseCommit: 'bad' })).rejects.toMatchObject({ code: 'git_base_commit_invalid' });
  await expect(proveWorkspace(ctx, x.data, { baseCommit: x.base, commit: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'git_workspace_unverified' });
  writeFileSync(join(linked, 'dirty'), 'dirty');
  await expect(proveWorkspace(ctx, x.data, { baseCommit: x.base, commit: x.base })).rejects.toMatchObject({ code: 'git_workspace_unverified' });
  rmSync(join(linked, 'dirty')); g(x.root, 'worktree', 'lock', linked);
  await expect(proveWorkspace(ctx, x.data)).rejects.toMatchObject({ code: 'git_workspace_unverified' });
  g(x.root, 'worktree', 'unlock', linked); rmSync(join(dir, 'pi-worktree-manager.json'));
  await expect(proveWorkspace(ctx, x.data)).rejects.toMatchObject({ code: 'git_workspace_unverified' });
});
