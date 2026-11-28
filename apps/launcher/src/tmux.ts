import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaimedAttempt, LocalConfig, PiSessionLocator } from '@pi-steward/contract';

const runFile = promisify(execFile);
const escapedTmuxArg = (value: string) => value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
const instructions = '先调用 steward_task 读取目标、验收要求和授权。';
export const targetFor = (id: string) => `steward-${id}`;

export type TmuxHealth = 'ready' | 'missing' | 'unavailable';
export const tmuxHealthText: Record<TmuxHealth, string> = {
  ready: 'tmux 可用',
  missing: '找不到 tmux，请检查安装和配置中的 PATH',
  unavailable: 'tmux 无法运行或无法查询 Steward 的会话',
};

function commandFailure(error: unknown): 'missing' | 'unavailable' {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
}

export class TmuxError extends Error {
  constructor(readonly notStarted = false) { super('无法完成 tmux 操作，将在下次循环重新核对。'); }
}

function parsePid(value: string) {
  const pid = /^[1-9][0-9]*$/u.test(value) ? Number(value) : NaN;
  return pid > 1 && pid <= 0x7fffffff ? pid : undefined;
}

function resumeCommandDidNotStart(error: unknown, target: string) {
  const { code, killed, signal, stderr } = error as {
    code?: string | number; killed?: boolean; signal?: string | null; stderr?: string;
  };
  if (code === 'ENOENT' || code === 'EACCES') return true;
  if (code !== 1 || killed || signal || typeof stderr !== 'string') return false;
  const message = stderr.trimEnd();
  // 只认 tmux 同步拒绝或 fork 失败；超时、退出信号及其它响应不能证明没启动。
  return message === `duplicate session: ${target}` || message === `invalid session name: ${target}` ||
    /^(?:create window failed: )?fork failed(?:: [^\r\n]+)?$/u.test(message);
}

export function displayName(title: string) {
  const safe = title.replace(/[^\p{L}\p{N} _-]/gu, ' ').trim().replace(/^[ -]+/u, '');
  return safe.slice(0, 79).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() || 'Pi task';
}

export function tmuxClient(config: LocalConfig, options: {
  configPath: string; extensionPath: string; socket?: string; run?: typeof runFile; env?: NodeJS.ProcessEnv;
}) {
  const path = config.path.join(':');
  const env = { ...(options.env ?? process.env), PATH: path, LC_ALL: 'C' };
  delete (env as NodeJS.ProcessEnv).TMUX;
  delete (env as NodeJS.ProcessEnv).TMUX_PANE;
  delete (env as NodeJS.ProcessEnv).TMUX_TMPDIR;
  const run = options.run ?? runFile;
  const socket = options.socket ? ['-S', options.socket] : ['-L', 'steward'];
  const exec = (args: string[]) => run('tmux', [...socket, '-u', '-f', '/dev/null', ...args], { env, timeout: 3_000 });
  async function listSessions(): Promise<string[] | 'missing' | 'unavailable'> {
    try {
      const { stdout } = await exec(['list-sessions', '-F', '#{session_name}']);
      return stdout.split('\n');
    } catch (error) {
      const { code, stderr } = error as { code?: number; stderr?: string };
      // tmux 在没有会话时不会保留服务进程，此时仍可启动下一条任务。
      if (code === 1 && typeof stderr === 'string' &&
        /^(?:no server running on [^\n]+|error connecting to [^\n]+ \(No such file or directory\))\n?$/u.test(stderr)) return [];
      return commandFailure(error);
    }
  }
  return {
    async check({ verifyVersion = false } = {}): Promise<TmuxHealth> {
      if (verifyVersion) {
        try { await exec(['-V']); } catch (error) { return commandFailure(error); }
      }
      const sessions = await listSessions();
      return Array.isArray(sessions) ? 'ready' : sessions;
    },
    async inspect(target: string): Promise<'present' | 'absent' | 'unavailable'> {
      const sessions = await listSessions();
      if (!Array.isArray(sessions)) return 'unavailable';
      return sessions.includes(target) ? 'present' : 'absent';
    },
    async panePid(target: string): Promise<number | undefined> {
      try {
        const { stdout } = await exec(['list-panes', '-s', '-t', `=${target}`, '-F', '#{session_name}\t#{pane_pid}']);
        const [name, pid, extra] = stdout.trimEnd().split('\t');
        return name === target && pid !== undefined && extra === undefined ? parsePid(pid) : undefined;
      } catch { return undefined; }
    },
    async hasResumeIdentity(attemptId: string): Promise<boolean> {
      const target = `=${targetFor(attemptId)}`;
      try {
        const attempt = await exec(['show-environment', '-t', target, 'STEWARD_ATTEMPT_ID']);
        if (attempt.stdout !== `STEWARD_ATTEMPT_ID=${attemptId}\n`) return false;
        const resume = await exec(['show-environment', '-t', target, 'STEWARD_RESUME']);
        return resume.stdout === 'STEWARD_RESUME=1\n';
      } catch { return false; }
    },
    processStatus(pid: number): 'alive' | 'dead' | 'unavailable' {
      if (parsePid(String(pid)) === undefined) return 'unavailable';
      try { process.kill(pid, 0); return 'alive'; } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unavailable';
      }
    },
    async launch(target: string, claim: ClaimedAttempt, projectPath: string) {
      const message = `${claim.kind === 'rework' ? '返修' : '新任务'}：${claim.title ?? claim.displayName}\n${instructions}`;
      const locator = claim.sessionLocator;
      if (claim.kind === 'rework' && !locator) throw new TmuxError(true);
      try {
        await exec(['new-session', '-d', '-s', target,
          // tmux 会解析目录中的格式标记，并处理参数末尾的分号。
          '-c', `${(locator?.path ?? projectPath).replaceAll('#', '##')}/.`,
          ...(locator ? ['-e', 'STEWARD_RESUME=1'] : []),
          '-e', `STEWARD_ATTEMPT_ID=${claim.id}`, '-e', escapedTmuxArg(`STEWARD_CONFIG=${options.configPath}`),
          '-e', escapedTmuxArg(`PATH=${path}`), '--', config.pi.command, ...config.pi.extraArgs,
          '-e', options.extensionPath, ...(locator ? ['--session', escapedTmuxArg(locator.sessionFile)] : ['--session-id', claim.sessionId]),
          '-n', displayName(claim.displayName), '--', message]);
      } catch { throw new TmuxError(); }
    },
    async launchResume(target: string, attemptId: string, locator: PiSessionLocator, continuation = false): Promise<number> {
      if (target !== targetFor(attemptId)) throw new TmuxError(true);
      try {
        const { stdout } = await exec(['new-session', '-d', '-s', target, '-P', '-F', '#{pane_pid}',
          '-c', `${locator.path.replaceAll('#', '##')}/.`, '-e', `STEWARD_ATTEMPT_ID=${attemptId}`,
          '-e', escapedTmuxArg(`STEWARD_CONFIG=${options.configPath}`), '-e', 'STEWARD_RESUME=1',
          ...(continuation ? ['-e', 'STEWARD_CONTINUATION=1'] : []),
          '-e', escapedTmuxArg(`PATH=${path}`), '--',
          ...[config.pi.command, ...config.pi.extraArgs, '-e', options.extensionPath, '--session', locator.sessionFile].map(escapedTmuxArg)]);
        const pid = parsePid(stdout.trim());
        if (pid !== undefined) return pid;
      } catch (error) {
        throw new TmuxError(resumeCommandDidNotStart(error, target));
      }
      throw new TmuxError();
    },
    async cancel(target: string) {
      try { await exec(['kill-session', '-t', `=${target}`]); } catch { throw new TmuxError(); }
    },
  };
}

export type Tmux = ReturnType<typeof tmuxClient>;
