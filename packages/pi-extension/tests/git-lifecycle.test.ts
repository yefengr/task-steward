import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentContextResponse, TaskGit } from '@pi-steward/contract';
import { afterEach, expect, it } from 'vitest';
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
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
  const data: AgentContextResponse = { task: { id: randomUUID(), projectId: 'p', title: 't', goal: '', acceptance: '', notes: '', type: 'implementation' },
    attempt: { id: randomUUID(), kind: 'new' }, workspace: { path: root, requirements: [] }, decisions: [], deliveries: [], questions: [],
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
    if (mode === 'local-ahead' || mode === 'diverged') expected = commit(x.root, 'local');
    if (mode === 'disabled') { x.data.gitSettings!.syncBeforeStart = false; }
    if (mode === 'disabled' || mode === 'fetch-failed') g(x.root, 'remote', 'set-url', 'origin', '/missing/local-upstream');
    if (mode === 'dirty') writeFileSync(join(x.root, 'dirty'), 'keep');
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
