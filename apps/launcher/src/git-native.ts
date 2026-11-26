import { execFile } from 'node:child_process';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitBranchSchema, gitCommitSchema } from '@pi-steward/contract';
import type { LauncherGitOperation } from '@pi-steward/contract';
import { acquireRunLock } from './state.js';

const run = promisify(execFile);
export class GitFailure extends Error {
  constructor(readonly reason: string, readonly rework = false, readonly exitCode?: number) { super(reason); }
}
export async function git(root: string, ...args: string[]) {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    return (await run('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, timeout: 10_000, maxBuffer: 1024 * 1024,
    })).stdout.trimEnd();
  } catch (error) { throw new GitFailure('git_command_failed', false, (error as { code?: number }).code); }
}
async function ancestor(root: string, older: string, newer: string) {
  try { await git(root, 'merge-base', '--is-ancestor', older, newer); return true; }
  catch (error) { if (error instanceof GitFailure && error.exitCode === 1) return false; throw error; }
}
export async function records(root: string) {
  return (await git(root, 'worktree', 'list', '--porcelain')).split('\n\n').filter(Boolean).map((block, index) => {
    const lines = block.split('\n');
    return { path: lines[0]!.slice(9), primary: index === 0,
      branch: lines.find((line) => line.startsWith('branch '))?.slice(7),
      unsafe: lines.some((line) => /^(locked|prunable|bare)( |$)/u.test(line)) };
  });
}
async function clean(root: string) {
  if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all')) throw new GitFailure('git_dirty');
}
async function unused(root: string) {
  let output: string;
  try {
    // macOS 使用固定系统入口；Linux CI 的系统 lsof 位于 /usr/bin，仍失败关闭、不跳过占用核对。
    const command = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
    output = (await run(command, ['-F', 'p', '+D', root], { timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout;
  } catch (error) {
    const value = error as { code?: number; stdout?: string; stderr?: string };
    // lsof 在部分进程不可见时仍可能以 1 返回已发现的进程；已有占用证据不能丢弃。
    if (value.code !== 1 || value.stderr?.trim()) throw new GitFailure('git_process_check_failed');
    output = value.stdout ?? '';
  }
  const pids = output.split('\n').filter((line) => /^p[0-9]+$/u.test(line)).map((line) => Number(line.slice(1)));
  // 仓库事务锁也会出现在 lsof；仅排除执行本次 Git 操作的启动器自身。
  if (pids.some((pid) => pid !== process.pid)) throw new GitFailure('git_worktree_in_use');
}
export async function lockRepository(root: string) {
  const common = await realpath(await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  try { return acquireRunLock(join(common, 'steward-git'), 'git_repository_busy'); }
  catch { throw new GitFailure('git_repository_busy'); }
}
export async function validateOperation(op: LauncherGitOperation, registered: string) {
  if (await realpath(registered) !== op.repositoryPath || await realpath(op.repositoryPath) !== op.repositoryPath ||
    op.worktreePath === op.repositoryPath || op.taskBranch === op.baseBranch) throw new GitFailure('git_repository_mismatch');
  for (const branch of [op.taskBranch, op.baseBranch]) {
    if (!gitBranchSchema.safeParse(branch).success) throw new GitFailure('git_invalid_branch');
    await git(registered, 'check-ref-format', `refs/heads/${branch}`);
  }
  for (const commit of [op.baseCommit, op.approvedCommit]) if (!gitCommitSchema.safeParse(commit).success) throw new GitFailure('git_invalid_commit');
}
export async function verifySource(op: LauncherGitOperation, removed = false) {
  const root = op.repositoryPath;
  const all = await records(root);
  const entry = all.find((item) => item.path === op.worktreePath);
  if (!entry && removed) {
    try { await lstat(op.worktreePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    throw new GitFailure('git_worktree_replaced');
  }
  if (!entry || entry.primary || entry.unsafe || entry.branch !== `refs/heads/${op.taskBranch}` ||
    await realpath(entry.path) !== entry.path || await realpath(await git(entry.path, 'rev-parse', '--show-toplevel')) !== entry.path) {
    throw new GitFailure('git_worktree_mismatch');
  }
  const common = await realpath(await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const sourceCommon = await realpath(await git(entry.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const dir = await realpath(await git(entry.path, 'rev-parse', '--absolute-git-dir'));
  if (sourceCommon !== common || dir === common) throw new GitFailure('git_repository_mismatch');
  let marker: Record<string, unknown>;
  try { marker = JSON.parse(await readFile(join(dir, 'pi-worktree-manager.json'), 'utf8')) as Record<string, unknown>; }
  catch { throw new GitFailure('git_ownership_unverified'); }
  if (marker.schemaVersion !== 1 || typeof marker.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(marker.createdAt) || !Number.isFinite(Date.parse(marker.createdAt))) {
    throw new GitFailure('git_ownership_unverified');
  }
  if (await git(entry.path, 'rev-parse', 'HEAD') !== op.approvedCommit ||
    await git(root, 'rev-parse', '--verify', `refs/heads/${op.taskBranch}`) !== op.approvedCommit) throw new GitFailure('git_source_changed', true);
  if (!await ancestor(root, op.baseCommit, op.approvedCommit)) throw new GitFailure('git_base_invalid', true);
  // 沿用 Pi 工作树移除的 Git clean 语义；忽略的依赖/构建产物随专用工作树清理。
  await clean(entry.path);
  await unused(entry.path);
  return true;
}
export async function mergeAccepted(op: LauncherGitOperation) {
  const root = op.repositoryPath;
  const ref = `refs/heads/${op.baseBranch}`;
  const head = await git(root, 'rev-parse', '--verify', ref);
  // 已合入可恢复 merge 成功但尚未来得及落 journal 的崩溃。
  if (await ancestor(root, op.approvedCommit, head)) return;
  if (!await ancestor(root, op.baseCommit, head) || !await ancestor(root, head, op.approvedCommit)) throw new GitFailure('git_target_diverged', true);
  const checked = (await records(root)).filter((entry) => entry.branch === ref);
  if (checked.length > 1 || checked.some((entry) => entry.unsafe)) throw new GitFailure('git_target_occupied');
  if (checked.length) {
    const target = checked[0]!.path;
    await clean(target); await unused(target);
    if (await git(target, 'rev-parse', 'HEAD') !== head) throw new GitFailure('git_target_changed');
    await git(target, 'merge', '--ff-only', '--no-edit', op.approvedCommit);
  } else await git(root, 'update-ref', ref, op.approvedCommit, head);
  if (await git(root, 'rev-parse', '--verify', ref) !== op.approvedCommit) throw new GitFailure('git_target_changed');
}
export async function cleanupAccepted(op: LauncherGitOperation, removed: boolean, checkpoint: () => void) {
  const root = op.repositoryPath;
  if (!await ancestor(root, op.approvedCommit, `refs/heads/${op.baseBranch}`)) throw new GitFailure('git_merge_unverified');
  const present = await verifySource(op, removed);
  if (present) { await git(root, 'worktree', 'remove', '--', op.worktreePath); checkpoint(); }
  const ref = `refs/heads/${op.taskBranch}`;
  const branches = await git(root, 'for-each-ref', '--format=%(objectname)', ref);
  if (!branches) return;
  if (branches !== op.approvedCommit || (await records(root)).some((entry) => entry.branch === ref)) throw new GitFailure('git_branch_changed');
  await git(root, 'update-ref', '-d', ref, op.approvedCommit);
}
