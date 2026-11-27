import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import type { LauncherSessionDirective, SessionOperationFailure } from '@pi-steward/contract';

const run = promisify(execFile);
type Permission = Extract<LauncherSessionDirective, { step: 'stop' | 'launch' }>;

export async function validateForegroundWorkspace(directive: Permission): Promise<SessionOperationFailure | undefined> {
  const expected = directive.foregroundGit;
  const path = directive.locator.path;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C' };
  const git = (...args: string[]) => run('git', ['-C', path, ...args], { env, timeout: 2_000, maxBuffer: 1024 * 1024 });
  try {
    let layout: string;
    try { layout = (await git('rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir')).stdout; }
    catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (failure.code === 128 && failure.stderr?.startsWith('fatal: not a git repository')) {
        return expected && expected.kind !== 'non_git' ? 'session_workspace_unavailable' : undefined;
      }
      throw error;
    }
    const [local, common] = layout.trimEnd().split('\n');
    if (!local || !common) return 'session_workspace_unavailable';
    const kind = realpathSync(local) === realpathSync(common) ? 'primary' : 'linked';
    let branch: string | null = null;
    try { branch = (await git('symbolic-ref', '--quiet', '--short', 'HEAD')).stdout.trimEnd(); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if (expected && (expected.kind !== kind || expected.branch !== branch)) return 'session_workspace_unavailable';
    // 脏主目录中的改动归属不能由程序猜测，必须先在原会话核对并确认迁移策略。
    if (kind === 'primary' && (await git('status', '--porcelain', '--untracked-files=all')).stdout.length) {
      return 'session_workspace_unavailable';
    }
  } catch { return 'session_workspace_unavailable'; }
}
