import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaimedAttempt, LocalConfig } from '@pi-steward/contract';

const runFile = promisify(execFile);
const escapedTmuxArg = (value: string) => value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
const instructions = '先调用 steward_task 读取完整任务背景。按项目规则和任务授权工作，在关键节点调用 steward_progress。需要用户决定时调用 steward_ask 并等待回应。用 steward_deliver 保存交付，处理完收尾后调用 steward_finish。';
export const targetFor = (id: string) => `steward-${id}`;

export class TmuxError extends Error {
  constructor() { super('无法完成 tmux 操作，将在下次循环重新核对。'); }
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
  return {
    async inspect(target: string): Promise<'present' | 'absent' | 'unavailable'> {
      try {
        const { stdout } = await exec(['list-sessions', '-F', '#{session_name}']);
        return stdout.split('\n').includes(target) ? 'present' : 'absent';
      } catch (error) {
        const { code, stderr } = error as { code?: number; stderr?: string };
        if (code === 1 && typeof stderr === 'string' &&
          /^(?:no server running on [^\n]+|error connecting to [^\n]+ \(No such file or directory\))\n?$/u.test(stderr)) {
          return 'absent';
        }
        return 'unavailable';
      }
    },
    async launch(target: string, claim: ClaimedAttempt, projectPath: string) {
      const message = `${claim.kind === 'rework' ? '返修本任务。' : '开始执行本任务。'}${instructions}`;
      try {
        await exec(['new-session', '-d', '-s', target,
          // tmux 会解析目录中的格式标记，并处理参数末尾的分号。
          '-c', `${projectPath.replaceAll('#', '##')}/.`,
          '-e', `STEWARD_ATTEMPT_ID=${claim.id}`, '-e', escapedTmuxArg(`STEWARD_CONFIG=${options.configPath}`),
          '-e', escapedTmuxArg(`PATH=${path}`), '--', config.pi.command, ...config.pi.extraArgs,
          '-e', options.extensionPath, '--session-id', claim.sessionId, '-n', displayName(claim.displayName), '--', message]);
      } catch { throw new TmuxError(); }
    },
    async cancel(target: string) {
      try { await exec(['kill-session', '-t', `=${target}`]); } catch { throw new TmuxError(); }
    },
  };
}

export type Tmux = ReturnType<typeof tmuxClient>;
