import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LauncherSessionDirective, PiSessionLocator, SessionOperationFailure } from '@pi-steward/contract';
import type { Execution, SessionOperation, State } from './state.js';
import { targetFor, TmuxError } from './tmux.js';
import { acquireExecutionLock } from '@pi-steward/execution-runtime';
import { validateForegroundWorkspace } from './foreground-workspace.js';
import type { Tmux } from './tmux.js';

const MAX_HEADER_BYTES = 64 * 1024;
const HEADER_READ_BLOCK_BYTES = 4096;
export type PermissionClock = { wall: number; monotonic: number };
const validElapsed = (elapsed: number, validForMs: number) => elapsed >= 0 && elapsed < validForMs;
const VALUE_FLAGS = new Set([
  '--provider', '--model', '--models', '--thinking', '--extension', '-e', '--tools', '-t', '--exclude-tools', '-xt',
  '--theme', '--use-theme',
]);
const SWITCH_FLAGS = new Set([
  '--approve', '-a', '--no-approve', '-na', '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--offline',
  '--no-extensions', '-ne', '--no-context-files', '-nc', '--no-skills', '-ns',
]);

export function supportsResumeArgs(args: readonly string[]) {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) return false;
    if (SWITCH_FLAGS.has(flag)) continue;
    if (!VALUE_FLAGS.has(flag)) return false;
    const value = args[++i];
    if (!value || /^[-@]|[\0\r\n]/u.test(value)) return false;
  }
  return true;
}

function readHeader(file: string): { type?: unknown; id?: unknown; cwd?: unknown } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error();
    const bytes = Buffer.alloc(MAX_HEADER_BYTES);
    // 块读取有上限，只解析首行；块中可能读到的后续字节不解析、不返回。
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, Math.min(HEADER_READ_BLOCK_BYTES, bytes.length - offset), null);
      if (!count) return JSON.parse(bytes.toString('utf8', 0, offset));
      const block = bytes.subarray(offset, offset + count);
      const newline = block.indexOf(10);
      if (newline >= 0) return JSON.parse(bytes.toString('utf8', 0, offset + newline));
      offset += count;
    }
    throw new Error();
  } finally {
    closeSync(fd);
  }
}

export function validateLocator(locator: PiSessionLocator): SessionOperationFailure | undefined {
  try {
    if (realpathSync(locator.path) !== locator.path || !statSync(locator.path).isDirectory()) return 'session_workspace_unavailable';
    accessSync(locator.path, constants.R_OK | constants.X_OK);
  } catch { return 'session_workspace_unavailable'; }
  let header: ReturnType<typeof readHeader>;
  try {
    if (realpathSync(locator.sessionFile) !== locator.sessionFile) return 'session_record_missing';
    header = readHeader(locator.sessionFile);
  } catch { return 'session_record_missing'; }
  if (header?.type !== 'session' || header.id !== locator.sessionId) return 'session_record_missing';
  try {
    if (typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || realpathSync(header.cwd) !== locator.path) {
      return 'session_workspace_unavailable';
    }
  } catch { return 'session_workspace_unavailable'; }
}

export class SessionControl {
  private readonly foregroundLocks = new Map<string, () => void>();
  constructor(private readonly options: {
    state: State; tmux: Tmux; save: () => void; now: () => number; monotonicNow: () => number;
    extraArgs: readonly string[]; started: (record: Execution) => void; warn?: (message: string) => void;
    configFile?: string;
  }) {}

  private get state() { return this.options.state; }
  private get tmux() { return this.options.tmux; }
  private save() { this.options.save(); }
  private record(id: string) { return this.state.executions.find((item) => item.id === id); }

  private rememberPid(record: Execution, pid: number) {
    if (record.pid === undefined) { record.pid = pid; this.save(); }
    return record.pid === pid;
  }

  private finish(op: SessionOperation, failure?: SessionOperationFailure) {
    if (!failure && op.step !== 'stop') return;
    op.report = failure ? { requestId: randomUUID(), result: 'failed', step: op.step, failure }
      : { requestId: randomUUID(), result: 'stopped', step: 'stop' };
    this.save();
    if (failure) this.releaseForeground(op.id);
  }

  private releaseForeground(id: string) {
    this.foregroundLocks.get(id)?.();
    this.foregroundLocks.delete(id);
  }

  reconcileForegroundLocks(active: ReadonlySet<string>) {
    for (const id of this.foregroundLocks.keys()) if (!active.has(id)) this.releaseForeground(id);
  }

  private holdForeground(op: SessionOperation) {
    const owner = op.foregroundOwner;
    if (!owner || !this.options.configFile) return false;
    if (this.tmux.processStatus(owner.pid) !== 'dead') return false;
    if (this.foregroundLocks.has(op.id)) return true;
    try {
      const release = acquireExecutionLock(this.options.configFile, owner.goalId);
      if (this.tmux.processStatus(owner.pid) !== 'dead') { release(); return false; }
      this.foregroundLocks.set(op.id, release);
      return true;
    } catch { return false; }
  }

  private definitelyDead(pid: number | undefined) {
    return pid !== undefined && this.tmux.processStatus(pid) === 'dead';
  }

  private async sourceGone(attemptId: string) {
    const operation = this.state.sessionOperations?.find((item) => item.attemptId === attemptId && item.foregroundOwner);
    if (operation?.foregroundOwner && !this.definitelyDead(operation.foregroundOwner.pid)) return false;
    if (await this.tmux.inspect(targetFor(attemptId)) !== 'absent') return false;
    const pid = this.record(attemptId)?.pid;
    return pid === undefined || this.definitelyDead(pid);
  }

  async replacementGone(op: SessionOperation) {
    const id = op.replacementId;
    if (id === undefined || id === op.attemptId) return false;
    const record = this.record(id);
    if (record && record.sessionOperationId !== op.id) return false;
    if (await this.tmux.inspect(targetFor(id)) !== 'absent' || !await this.sourceGone(op.attemptId)) return false;
    return record?.pid !== undefined ? this.definitelyDead(record.pid) : op.launchIssued === false;
  }

  private async remainsStopped(target: string, pid: number, mayRecheck = () => true) {
    // tmux 可在 Pi 处理终止信号之前移除会话；短暂复查，不另发杀进程信号。
    for (let i = 0; i < 3; i++) {
      if (await this.tmux.inspect(target) === 'absent' && this.definitelyDead(pid)) return true;
      if (i === 2 || !mayRecheck()) break;
      await delay(50);
      if (!mayRecheck()) break;
    }
    return false;
  }

  private invalid(locator: PiSessionLocator) {
    return validateLocator(locator) ?? (supportsResumeArgs(this.options.extraArgs) ? undefined : 'session_config_unsupported');
  }

  private async stop(directive: Extract<LauncherSessionDirective, { step: 'stop' }>, op: SessionOperation, valid: () => boolean) {
    const invalid = this.invalid(directive.locator);
    if (invalid) { this.finish(op, invalid); return; }
    if (directive.foregroundOwner && (directive.mode === 'pause' || directive.mode === 'finalize')) {
      // 普通 Pi 只接受 control 请求后自行退出；启动器不向其 PID 发信号。
      if (!this.holdForeground(op)) return;
      const failure = await validateForegroundWorkspace(directive);
      if (failure) { this.finish(op, failure); return; }
      if (valid() && await this.sourceGone(directive.attemptId)) this.finish(op);
      return;
    }
    if (directive.mode === 'background' || (directive.mode === 'continue' && directive.foregroundOwner)) {
      const owner = directive.foregroundOwner;
      if (!owner) { this.finish(op, 'session_ownership_unavailable'); return; }
      if (this.tmux.processStatus(owner.pid) === 'alive') { this.finish(op, 'session_source_alive'); return; }
      if (!this.holdForeground(op)) { this.finish(op, 'session_ownership_unavailable'); return; }
      const failure = await validateForegroundWorkspace(directive);
      if (failure) { this.finish(op, failure); return; }
      if (valid() && await this.sourceGone(directive.attemptId)) this.finish(op);
      else this.finish(op, 'session_ownership_unavailable');
      return;
    }
    const target = targetFor(directive.attemptId);
    const existing = this.record(directive.attemptId);
    const status = await this.tmux.inspect(target);
    if (status === 'absent') {
      const pid = existing?.pid;
      const historicalExit = directive.mode !== 'pause' && directive.mode !== 'finalize' && pid === undefined && directive.sourceEnded;
      if (historicalExit || this.definitelyDead(pid) ||
          (op.stopIssued && pid !== undefined && await this.remainsStopped(target, pid, valid))) this.finish(op);
      else this.finish(op, 'session_stop_failed');
      return;
    }
    if (op.stopIssued && existing?.pid !== undefined && await this.remainsStopped(target, existing.pid, valid)) {
      this.finish(op);
      return;
    }
    if (status !== 'present' || directive.sourceEnded || op.stopIssued || existing?.phase === 'exited') {
      this.finish(op, 'session_stop_failed');
      return;
    }
    const pid = await this.tmux.panePid(target);
    if (pid === undefined || this.tmux.processStatus(pid) !== 'alive') { this.finish(op, 'session_stop_failed'); return; }
    const record = existing ?? { id: directive.attemptId, target, phase: 'observed' };
    if (!existing) this.state.executions.push(record);
    if (!this.rememberPid(record, pid)) { this.finish(op, 'session_stop_failed'); return; }
    if (!valid()) return;
    op.stopIssued = true;
    this.save();
    if (!valid()) { delete op.stopIssued; this.save(); return; }
    await this.tryCancel(target);
    this.finish(op, await this.remainsStopped(target, pid, valid) ? undefined : 'session_stop_failed');
  }

  private async launch(directive: Extract<LauncherSessionDirective, { step: 'launch' }>, op: SessionOperation, valid: () => boolean) {
    const id = directive.replacementId;
    const target = targetFor(id);
    if (id === directive.attemptId) return;
    const existing = this.record(id);
    if (op.launchIssued || existing) {
      // 不重发可能已经执行的启动。同步拒绝也可能源于同名进程，须另行证实目标已无进程。
      if (existing?.sessionOperationId === op.id && op.launchIssued === false && await this.replacementGone(op)) {
        existing.phase = 'exited';
        this.finish(op, 'session_launch_failed');
      }
      return;
    }
    if (await this.tmux.inspect(target) !== 'absent' || !await this.sourceGone(directive.attemptId)) return;
    const invalid = this.invalid(directive.locator);
    if (invalid) { op.launchIssued = false; this.finish(op, invalid); return; }
    if (directive.mode === 'background' || (directive.mode === 'continue' && directive.foregroundOwner)) {
      const failure = !this.holdForeground(op) ? 'session_ownership_unavailable' : await validateForegroundWorkspace(directive);
      if (failure) { op.launchIssued = false; this.finish(op, failure); return; }
    }
    if (!valid()) return;
    const record: Execution = { id, target, phase: 'launching', startedAt: this.options.now(), sessionOperationId: op.id };
    const previouslyIssued = op.launchIssued;
    op.launchIssued = true;
    this.state.executions.push(record);
    this.save();
    if (!valid()) {
      op.launchIssued = previouslyIssued;
      this.state.executions = this.state.executions.filter((item) => item !== record);
      this.save();
      return;
    }
    try {
      const pid = directive.mode === 'background' || directive.mode === 'continue'
        ? await this.tmux.launchResume(target, id, directive.locator, true)
        : await this.tmux.launchResume(target, id, directive.locator);
      this.rememberPid(record, pid);
      if (await this.tmux.inspect(target) === 'present' && await this.tmux.panePid(target) === pid) this.options.started(record);
    } catch (error) {
      if (!(error instanceof TmuxError)) throw error;
      if (error.notStarted) {
        op.launchIssued = false;
        this.save();
        if (await this.replacementGone(op)) {
          record.phase = 'exited';
          this.finish(op, 'session_launch_failed');
        }
      }
      this.options.warn?.(error.message);
    }
  }

  private async cleanup(directive: Extract<LauncherSessionDirective, { step: 'cleanup' }>, op: SessionOperation) {
    if (directive.replacementId === directive.attemptId) return;
    const target = targetFor(directive.replacementId);
    const record = this.record(directive.replacementId);
    if (record && record.sessionOperationId !== op.id) return;
    const status = await this.tmux.inspect(target);
    if (status === 'absent') {
      if (await this.replacementGone(op)) this.finish(op, 'session_timeout');
      return;
    }
    if (status !== 'present') return;
    const pid = await this.tmux.panePid(target);
    if (pid === undefined || (record?.pid !== undefined && record.pid !== pid) ||
        (op.stopIssued && record?.pid !== pid)) return;
    if (!await this.tmux.hasResumeIdentity(directive.replacementId)) return;
    const candidate: Execution = record ?? {
      id: directive.replacementId, target, phase: 'observed', sessionOperationId: op.id,
    };
    if (await this.tmux.panePid(target) !== pid || this.tmux.processStatus(pid) !== 'alive') return;
    if (!record) this.state.executions.push(candidate);
    candidate.pid = pid;
    op.stopIssued = true;
    this.save();
    await this.tryCancel(target);
    if (await this.remainsStopped(target, pid) && await this.sourceGone(directive.attemptId)) this.finish(op, 'session_timeout');
  }

  private async tryCancel(target: string) {
    try { await this.tmux.cancel(target); } catch (error) {
      if (!(error instanceof TmuxError)) throw error;
      this.options.warn?.(error.message);
    }
  }

  async apply(directive: LauncherSessionDirective, requestStartedAt: PermissionClock) {
    const { id, attemptId, step } = directive;
    if ((directive.mode === 'pause' || directive.mode === 'finalize') && step !== 'stop') return;
    // 双时钟都必须在授权内：单调钟可能不计睡眠，墙钟也可能被调回。
    const valid = () => step === 'cleanup' || (
      validElapsed(this.options.now() - requestStartedAt.wall, directive.validForMs) &&
      validElapsed(this.options.monotonicNow() - requestStartedAt.monotonic, directive.validForMs)
    );
    if (!valid()) return;
    const operations = this.state.sessionOperations ??= [];
    let op = operations.find((item) => item.id === id);
    const replacementId = step === 'stop' ? undefined : directive.replacementId;
    if (op && (op.attemptId !== attemptId || (op.replacementId !== undefined && op.replacementId !== replacementId))) return;
    if (step !== 'cleanup' && op?.foregroundOwner && (directive.foregroundOwner?.goalId !== op.foregroundOwner.goalId ||
        directive.foregroundOwner.pid !== op.foregroundOwner.pid)) return;
    if (op && op.step !== step && (step === 'stop' || op.step === 'cleanup')) return;
    if (op?.step !== step) {
      const launchIssued = op?.launchIssued ?? (op && op.step === 'stop' ? false : undefined);
      const foregroundOwner = directive.foregroundOwner ?? op?.foregroundOwner;
      op = { id, attemptId, step, replacementId, launchIssued, ...(foregroundOwner ? { foregroundOwner } : {}) };
      const previous = operations.findIndex((item) => item.id === id);
      if (previous < 0) operations.push(op);
      else operations[previous] = op;
      this.save();
    }
    if (op.report) return;
    if (step === 'stop') await this.stop(directive, op, valid);
    else if (step === 'launch') await this.launch(directive, op, valid);
    else await this.cleanup(directive, op);
  }
}
