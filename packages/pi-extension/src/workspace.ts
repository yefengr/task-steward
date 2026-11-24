import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { attemptWorkspaceSchema, piSessionLocatorSchema } from '@pi-steward/contract';
import type { AgentContextResponse, AttemptWorkspace } from '@pi-steward/contract';
import { AgentError } from './client.js';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 2_000;
// 只读会话头，不加载或传输对话记录。
const HEADER_LIMIT = 32 * 1024;
type LocationContext = Pick<ExtensionContext, 'cwd' | 'sessionManager'>;

type GitLayout = { kind: 'non_git'; branch: null } |
  { kind: 'primary' | 'linked'; branch: string | null; common: string };

async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return (await run('git', ['-C', cwd, ...args], { env: { ...env, LC_ALL: 'C' }, timeout: GIT_TIMEOUT_MS })).stdout;
}

async function gitLayout(cwd: string): Promise<GitLayout> {
  let output: string;
  try {
    output = await git(cwd, 'rev-parse', '--is-inside-work-tree', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir');
  } catch (error) {
    const { code, stderr } = error as { code?: number; stderr?: string };
    if (code === 128 && stderr?.startsWith('fatal: not a git repository (or any of the parent directories):')) {
      return { kind: 'non_git', branch: null };
    }
    throw error;
  }
  const [inside, gitDir, commonDir, end, ...extra] = output.split('\n');
  if (inside !== 'true' || !gitDir || !commonDir || end !== '' || extra.length ||
      !isAbsolute(gitDir) || !isAbsolute(commonDir)) throw new Error('git_layout');
  const [local, common] = await Promise.all([realpath(gitDir), realpath(commonDir)]);
  let branch: string | null;
  try {
    const ref = (await git(cwd, 'symbolic-ref', '--quiet', 'HEAD')).trimEnd();
    const prefix = 'refs/heads/';
    if (!ref.startsWith(prefix)) throw new Error('git_branch');
    branch = ref.slice(prefix.length);
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
    branch = null;
  }
  return { kind: common === local ? 'primary' : 'linked', branch, common };
}

function sameRepository(registered: GitLayout, current: GitLayout) {
  if (registered.kind === 'non_git' || current.kind === 'non_git') return registered.kind === current.kind;
  return registered.common === current.common;
}

async function readHeader(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('session_file');
    const buf = Buffer.alloc(HEADER_LIMIT);
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    const end = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (end < 0) throw new Error('session_header');
    const header = JSON.parse(buf.toString('utf8', 0, end)) as { type?: string; id?: string; cwd?: string };
    if (header.type !== 'session' || !header.id || !header.cwd || !isAbsolute(header.cwd)) throw new Error('session_header');
    return { id: header.id, path: await realpath(header.cwd) };
  } finally { await file.close(); }
}

export async function currentSessionLocator(ctx: LocationContext, requireLoaded: boolean) {
  const session = ctx.sessionManager.getSessionFile();
  const sessionCwd = ctx.sessionManager.getCwd();
  if (!session || !isAbsolute(session) || !isAbsolute(sessionCwd) || !isAbsolute(ctx.cwd)) return undefined;
  const [path, cwd] = await Promise.all([realpath(ctx.cwd), realpath(sessionCwd)]);
  if (path !== cwd) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = await realpath(session).catch(async (error: unknown) => {
    if (requireLoaded || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Pi 可能尚未收到首条消息，因此这里只登记之后将写入的路径。
    const parent = await realpath(dirname(session)).catch(() => dirname(session));
    return join(parent, basename(session));
  });
  if (requireLoaded) {
    const header = await readHeader(sessionFile);
    if (header.id !== sessionId || header.path !== path || !ctx.sessionManager.getEntries().some((entry) =>
      entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant'))) return undefined;
  }
  return piSessionLocatorSchema.parse({ path, sessionId, sessionFile });
}

export async function currentWorkspace(ctx: LocationContext, registeredPath: string): Promise<AttemptWorkspace> {
  try {
    const [path, registered] = await Promise.all([realpath(ctx.cwd), realpath(registeredPath)]);
    const [layout, registeredLayout] = await Promise.all([gitLayout(path), gitLayout(registered)]);
    if (!sameRepository(registeredLayout, layout) || (layout.kind === 'non_git' && path !== registered)) throw new Error('workspace');
    const sessionId = ctx.sessionManager.getSessionId();
    const session = ctx.sessionManager.getSessionFile();
    if (!session || !isAbsolute(session) || await realpath(ctx.sessionManager.getCwd()) !== path) throw new Error('session');
    const sessionFile = await realpath(session);
    const header = await readHeader(sessionFile);
    if (header.id !== sessionId || header.path !== path) throw new Error('session');
    return attemptWorkspaceSchema.parse({ path, gitKind: layout.kind, gitBranch: layout.branch, sessionId, sessionFile });
  } catch { throw new AgentError('workspace_unavailable'); }
}

export async function checkReworkWorkspace(ctx: LocationContext, data: AgentContextResponse) {
  if (data.task.type !== 'implementation' || data.attempt.kind === 'resume') return undefined;
  const previous = data.workspace.previous;
  if (previous === undefined && data.attempt.kind !== 'rework' && data.deliveries.at(-1)?.review !== 'rework') return undefined;
  if (!previous) return 'not_recorded';
  if (!previous.sameMachine) return 'different_machine';
  const saved = previous.workspace;
  if (!saved) return 'not_recorded';
  try {
    const [path, registered, sessionFile] = await Promise.all([
      realpath(saved.path), realpath(data.workspace.path), realpath(saved.sessionFile),
    ]);
    if (path !== saved.path || sessionFile !== saved.sessionFile) return 'mismatch';
    const [layout, registeredLayout, header] = await Promise.all([gitLayout(path), gitLayout(registered), readHeader(sessionFile)]);
    if (!sameRepository(registeredLayout, layout) || (layout.kind === 'non_git' && path !== registered) ||
        layout.kind !== saved.gitKind || layout.branch !== saved.gitBranch || header.id !== saved.sessionId || header.path !== path) {
      return 'mismatch';
    }
    if (layout.kind !== 'non_git' && layout.branch === null) return 'unverifiable';
    if (await realpath(ctx.cwd) !== path) return 'switch_required';
    const session = ctx.sessionManager.getSessionFile();
    if (session && ctx.sessionManager.getSessionId() === saved.sessionId && await realpath(session) === sessionFile &&
        await realpath(ctx.sessionManager.getCwd()) === path) return 'confirmed';
    return 'switch_required';
  } catch { return 'unavailable'; }
}
