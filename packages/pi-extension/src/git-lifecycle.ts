import { execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import * as c from '@pi-steward/contract';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AgentError } from './client.js';
import { currentWorkspace } from './workspace.js';

const run = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return (await run('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000, maxBuffer: 1024 * 1024,
  })).stdout.trimEnd();
}
async function isAncestor(root: string, older: string, newer: string) {
  try { await git(root, 'merge-base', '--is-ancestor', older, newer); return true; }
  catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
}
async function branch(root: string, name: string) {
  if (!c.gitBranchSchema.safeParse(name).success) throw new AgentError('git_invalid_branch');
  try { await git(root, 'check-ref-format', `refs/heads/${name}`); }
  catch { throw new AgentError('git_invalid_branch'); }
}
export async function repositoryLock<T>(root: string, action: () => Promise<T>) {
  const common = await realpath(await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const path = join(common, 'steward-git.lock');
  closeSync(openSync(path, 'a', 0o600));
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    try { db.exec('BEGIN IMMEDIATE'); } catch { throw new AgentError('git_repository_busy'); }
    return await action();
  } finally { db.close(); }
}
async function clean(root: string) {
  if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all')) throw new AgentError('git_dirty');
}
async function worktrees(root: string) {
  return (await git(root, 'worktree', 'list', '--porcelain')).split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    return { path: lines[0]!.slice(9), branch: lines.find((line) => line.startsWith('branch '))?.slice(7),
      locked: lines.some((line) => /^(locked|prunable)( |$)/u.test(line)) };
  });
}
export async function prepareGit(data: c.AgentContextResponse, taskBranch: string): Promise<c.TaskGit | Omit<c.AgentPrepareGitRequest, 'requestId'>> {
  if (data.task.type !== 'implementation') throw new AgentError('git_implementation_required');
  const saved = data.git;
  if (saved) {
    if (saved.taskBranch !== taskBranch) throw new AgentError('git_snapshot_conflict');
    return saved;
  }
  const settings = data.gitSettings;
  const baseBranch = settings?.baseBranch;
  if (!baseBranch || !settings) throw new AgentError('git_configuration_required');
  const repositoryPath = await realpath(data.workspace.path);
  await branch(repositoryPath, baseBranch); await branch(repositoryPath, taskBranch);
  if (baseBranch === taskBranch) throw new AgentError('git_dedicated_branch_required');
  return repositoryLock(repositoryPath, async () => {
    let syncResult: c.AgentPrepareGitRequest['syncResult'] = 'disabled';
    const ref = `refs/heads/${baseBranch}`;
    let baseCommit: string;
    try { baseCommit = c.gitCommitSchema.parse(await git(repositoryPath, 'rev-parse', '--verify', ref)); }
    catch { throw new AgentError('git_invalid_ref'); }
    if (settings.syncBeforeStart) {
      const upstream = (await git(repositoryPath, 'for-each-ref', '--format=%(upstream)', ref));
      syncResult = 'no_upstream';
      if (upstream) {
        const remote = await git(repositoryPath, 'config', '--get', `branch.${baseBranch}.remote`);
        const merge = await git(repositoryPath, 'config', '--get', `branch.${baseBranch}.merge`);
        if (!remote || remote.startsWith('-') || !merge.startsWith('refs/heads/')) throw new AgentError('git_upstream_invalid');
        await git(repositoryPath, 'check-ref-format', merge);
        const checked = (await worktrees(repositoryPath)).filter((entry) => entry.branch === ref);
        for (const entry of checked) { if (entry.locked) throw new AgentError('git_worktree_locked'); await clean(entry.path); }
        try { await git(repositoryPath, 'fetch', '--no-tags', '--', remote, merge); }
        catch { throw new AgentError('git_fetch_failed'); }
        const target = c.gitCommitSchema.parse(await git(repositoryPath, 'rev-parse', '--verify', 'FETCH_HEAD'));
        if (await isAncestor(repositoryPath, baseCommit, target)) {
          if (checked.length) await git(checked[0]!.path, 'merge', '--ff-only', '--no-edit', target);
          else await git(repositoryPath, 'update-ref', ref, target, baseCommit);
          baseCommit = target;
        } else if (!await isAncestor(repositoryPath, target, baseCommit)) throw new AgentError('git_upstream_diverged');
        syncResult = 'synced';
      }
    }
    return { baseBranch, baseCommit, taskBranch, repositoryPath, syncBeforeStart: settings.syncBeforeStart, syncResult };
  });
}
export async function proveWorkspace(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>, data: c.AgentContextResponse,
  delivery?: { commit?: string; baseCommit?: string }) {
  const snapshot = data.git;
  if (snapshot && delivery) {
    if (!c.gitCommitSchema.safeParse(delivery.commit).success) throw new AgentError('git_commit_required');
    if (delivery.baseCommit !== undefined && (!c.gitCommitSchema.safeParse(delivery.baseCommit).success ||
      delivery.baseCommit !== snapshot.baseCommit)) throw new AgentError('git_base_commit_invalid');
  }
  const workspace = await currentWorkspace(ctx, snapshot?.repositoryPath ?? data.workspace.path);
  if (!snapshot) return workspace;
  try {
    const root = await realpath(await git(ctx.cwd, 'rev-parse', '--show-toplevel'));
    const repository = await realpath(snapshot.repositoryPath);
    const common = async (path: string) => realpath(await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    if (repository !== snapshot.repositoryPath || workspace.gitKind !== 'linked' || workspace.gitBranch !== snapshot.taskBranch ||
      root === repository || (snapshot.worktreePath && root !== snapshot.worktreePath) ||
      await common(root) !== await common(repository)) throw new Error();
    const gitDir = await realpath(await git(root, 'rev-parse', '--absolute-git-dir'));
    const marker = JSON.parse(await readFile(join(gitDir, 'pi-worktree-manager.json'), 'utf8')) as Record<string, unknown>;
    if (marker.schemaVersion !== 1 || typeof marker.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(marker.createdAt) || !Number.isFinite(Date.parse(marker.createdAt))) throw new Error();
    const listed = (await worktrees(root)).find((entry) => entry.path === root && entry.branch === `refs/heads/${snapshot.taskBranch}`);
    if (!listed || listed.locked) throw new Error();
    await git(root, 'merge-base', '--is-ancestor', snapshot.baseCommit, 'HEAD');
    if (delivery) {
      if ((delivery.baseCommit ?? snapshot.baseCommit) !== snapshot.baseCommit || delivery.commit !== await git(root, 'rev-parse', 'HEAD')) throw new Error();
      // 与 Pi 的工作树移除规则一致：阻止受跟踪修改和未跟踪文件，不将忽略的构建产物当作源码改动。
      await clean(root);
    }
    return { ...workspace, gitRoot: root };
  } catch { throw new AgentError('git_workspace_unverified'); }
}
