import { randomUUID } from 'node:crypto';
import { GitLifecycle } from './git-lifecycle.js';
import { HEARTBEAT_INTERVAL_MS } from '@pi-steward/contract';
import type { LauncherHeartbeatResponse, LauncherSessionDirective, LocalConfig } from '@pi-steward/contract';
import type { Platform } from './platform.js';
import { PlatformError } from './platform.js';
import { SessionControl, supportsResumeArgs, validateLocator } from './session-control.js';
import type { PermissionClock } from './session-control.js';
import type { Execution, State } from './state.js';
import type { Tmux, TmuxHealth } from './tmux.js';
import { targetFor, TmuxError, tmuxHealthText } from './tmux.js';

type Directive = LauncherHeartbeatResponse['directives'][number];
type Heartbeat = { response: LauncherHeartbeatResponse; requestStartedAt: PermissionClock };
const managedId = (operation: LauncherSessionDirective) => operation.step === 'stop' ? operation.attemptId : operation.replacementId;
const TERMINAL_REPORT_ERRORS = new Set(['attempt_ended', 'forbidden', 'not_found', 'invalid_request', 'conflict']);
const MAX_OUTBOX_BACKOFF_MS = 120_000;

export class Launcher {
  private nextOutboxRetryAt = 0;
  private outboxBackoff = HEARTBEAT_INTERVAL_MS;
  private lastTmuxHealth: TmuxHealth = 'ready';
  private readonly control: SessionControl;
  private readonly gitLifecycle: GitLifecycle;
  constructor(private readonly options: {
    config: LocalConfig;
    version: string;
    state: State;
    save: (state: State) => void;
    platform: Platform;
    tmux: Tmux;
    now?: () => number;
    monotonicNow?: () => number;
    warn?: (message: string) => void;
    configFile?: string;
  }) {
    this.gitLifecycle = new GitLifecycle({ state: options.state, config: options.config, save: () => this.persist(),
      platform: options.platform, warn: options.warn });
    this.control = new SessionControl({ state: options.state, tmux: options.tmux, save: () => this.persist(),
      now: () => this.now(), monotonicNow: () => this.monotonicNow(), extraArgs: options.config.pi.extraArgs,
      started: (record) => this.started(record), warn: options.warn,
      configFile: options.configFile });
  }

  private get state() { return this.options.state; }
  private persist() { this.options.save(this.state); }
  private now() { return (this.options.now ?? Date.now)(); }
  private monotonicNow() { return this.options.monotonicNow?.() ?? performance.now(); }

  private async retryable<T>(run: () => Promise<T>) {
    try { return await run(); } catch (error) {
      if (!(error instanceof PlatformError || error instanceof TmuxError)) throw error;
      this.options.warn?.(error.message);
      return undefined;
    }
  }

  private pendingOperationFor(attemptId: string) {
    return this.state.sessionOperations?.find(({ replacementId }) => replacementId === attemptId);
  }

  private async flush() {
    if (this.now() < this.nextOutboxRetryAt) return false;
    let deferred = false;
    for (const event of [...this.state.outbox]) {
      const operation = this.pendingOperationFor(event.id);
      if (event.kind === 'exited' && operation && !await this.control.replacementGone(operation)) {
        deferred = true;
        continue;
      }
      let confirmed = true;
      try {
        await this.options.platform.report(event);
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        if (!TERMINAL_REPORT_ERRORS.has(error.code)) {
          // 平台或认证暂不可用，稍后重发原请求，保持事件顺序。
          this.options.warn?.(error.message);
          this.nextOutboxRetryAt = this.now() + this.outboxBackoff;
          this.outboxBackoff = Math.min(MAX_OUTBOX_BACKOFF_MS, this.outboxBackoff * 2);
          return false;
        }
        confirmed = error.code === 'attempt_ended' || (event.kind === 'started' && error.startedAlreadySaved);
        if (!confirmed) this.options.warn?.(`平台终态拒绝事件 ${event.kind}（${event.id}，${error.code}）。`);
      }
      this.outboxBackoff = HEARTBEAT_INTERVAL_MS;
      this.nextOutboxRetryAt = 0;
      this.state.outbox = this.state.outbox.filter(({ body }) => body.requestId !== event.body.requestId);
      if (event.kind === 'exited' && confirmed && !operation) this.remove(event.id);
      else this.persist();
    }
    return !deferred;
  }

  private remove(id: string) {
    this.state.executions = this.state.executions.filter((record) => record.id !== id);
    this.persist();
  }

  private started(record: Execution) {
    if (record.phase === 'observed') return;
    record.phase = 'observed';
    this.state.outbox.push({ kind: 'started', id: record.id, body: {
      requestId: randomUUID(), tmuxSession: record.target, startedAt: record.startedAt ?? this.now(),
    } });
    this.persist();
  }

  private exited(record: Execution) {
    if (record.phase === 'exited') return;
    record.phase = 'exited';
    this.state.outbox.push({ kind: 'exited', id: record.id, body: {
      requestId: randomUUID(), exitCode: null, endedAt: this.now(),
    } });
    this.persist();
  }

  private async observePresent(record: Execution) {
    const pendingResume = record.sessionOperationId && record.phase === 'launching';
    if (record.pid === undefined || pendingResume) {
      const pid = await this.options.tmux.panePid(record.target);
      if (pendingResume && (pid === undefined || (record.pid !== undefined && record.pid !== pid))) return false;
      if (pid !== undefined && record.pid === undefined) {
        if (pendingResume && (!await this.options.tmux.hasResumeIdentity(record.id) || await this.options.tmux.panePid(record.target) !== pid)) {
          return false;
        }
        record.pid = pid;
        this.persist();
      }
    }
    this.started(record);
    return true;
  }

  private absenceConfirmed(record: Execution) {
    if (record.pid !== undefined) return this.options.tmux.processStatus(record.pid) === 'dead';
    // 对本地历史普通尝试保留原有退出判断；替代启动结果未知时，不能把无目标当作进程已退出。
    return record.sessionOperationId === undefined;
  }

  private async observe() {
    const attempts: { id: string; tmuxSession: string; running: boolean }[] = [];
    for (const record of this.state.executions) {
      if (record.phase === 'exited') continue;
      const status = await this.options.tmux.inspect(record.target);
      if (status === 'unavailable') {
        this.options.warn?.('tmux 会话核对失败，保留本地尝试。');
        continue;
      }
      if (status === 'present' && !await this.observePresent(record)) continue;
      if (status === 'absent' && record.phase !== 'prepared') {
        if (!this.absenceConfirmed(record)) continue;
        const operation = this.pendingOperationFor(record.id);
        if (operation && !await this.control.replacementGone(operation)) continue;
        this.exited(record);
      }
      attempts.push({ id: record.id, tmuxSession: record.target, running: status === 'present' });
    }
    return attempts;
  }

  private async heartbeat(): Promise<Heartbeat | undefined> {
    const attempts = await this.observe();
    const requestStartedAt = { wall: this.now(), monotonic: this.monotonicNow() };
    const response = await this.retryable(() => this.options.platform.heartbeat({
      requestId: randomUUID(), launcherVersion: this.options.version, sessionControl: true, gitLifecycle: true,
      ...(this.options.configFile ? { foregroundControl: true as const } : {}),
      slots: this.options.config.slots, projects: this.options.config.projects, attempts,
    }));
    if (!response) return;
    this.state.lastHeartbeatAt = this.now();
    this.persist();
    return { response, requestStartedAt };
  }

  private async startPrepared(record: Execution) {
    const claim = record.claim!;
    const project = this.options.config.projects.find(({ id }) => id === claim.projectId);
    if (!project) { this.exited(record); return; }
    if (claim.kind === 'rework') {
      const failure = !claim.sessionLocator ? 'session_record_missing' : validateLocator(claim.sessionLocator) ??
        (supportsResumeArgs(this.options.config.pi.extraArgs) ? undefined : 'session_config_unsupported');
      if (failure) {
        this.options.warn?.(`返修无法启动（${failure}），未回退到登记目录或其他会话。`);
        this.exited(record);
        return;
      }
    }
    // 记录已开始尝试启动的时刻。调用结果未知时，下次必须核对，避免重复启动。
    record.phase = 'launching';
    record.startedAt = this.now();
    this.persist();
    const launched = await this.retryable(async () => {
      await this.options.tmux.launch(record.target, claim, claim.sessionLocator?.path ?? project.path);
      return true;
    });
    if (launched) this.started(record);
  }

  private async applyDirective(directive: Directive) {
    const { attemptId: id, tmuxSession: target, action } = directive;
    if (target !== targetFor(id)) return;
    let record = this.state.executions.find((item) => item.id === id);
    if (record?.phase === 'exited' || (action === 'continue' && record?.phase === 'observed')) return;
    const status = await this.options.tmux.inspect(target);
    if (status === 'unavailable') return;
    if (!record) {
      // 即使状态文件丢失，也只认平台指令给出的精确目标和本机查询结果。
      record = { id, target, phase: 'observed' };
      this.state.executions.push(record);
      if (status === 'present') this.persist();
    }
    if (action === 'cancel') {
      if (status === 'present') {
        await this.retryable(() => this.options.tmux.cancel(target));
        if (await this.options.tmux.inspect(target) !== 'absent') return;
      }
      if (this.absenceConfirmed(record)) this.exited(record);
    } else if (status === 'present') {
      await this.observePresent(record);
    } else if (action === 'continue' && record.phase === 'prepared') {
      await this.startPrepared(record);
    } else if (record.phase !== 'prepared' && this.absenceConfirmed(record)) {
      this.exited(record);
    }
  }

  private async reconcileSessionOperations(operations: LauncherSessionDirective[], requestStartedAt: PermissionClock) {
    const protectedIds = new Set<string>();
    for (const directive of operations) {
      protectedIds.add(directive.attemptId);
      protectedIds.add(managedId(directive));
      await this.control.apply(directive, requestStartedAt);
      const operation = this.state.sessionOperations?.find(({ id, step, attemptId, replacementId }) => id === directive.id &&
        step === directive.step && attemptId === directive.attemptId && (step === 'stop' || replacementId === managedId(directive)));
      if (!operation?.report || operation.reportAcknowledged) continue;
      if (operation.step !== 'stop' && !await this.control.replacementGone(operation)) continue;
      try {
        await this.options.platform.reportSession(operation.id, operation.report);
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        this.options.warn?.(error.message);
        if (!TERMINAL_REPORT_ERRORS.has(error.code)) continue;
      }
      operation.reportAcknowledged = true;
      this.persist();
    }
    return protectedIds;
  }

  private async reconcile({ response, requestStartedAt }: Heartbeat, claimPending = false) {
    const operations = response.sessionOperations ?? [];
    this.control.reconcileForegroundLocks(new Set(operations.map(({ id }) => id)));
    const protectedIds = await this.reconcileSessionOperations(operations, requestStartedAt);
    for (const directive of response.directives) {
      if (protectedIds.has(directive.attemptId)) continue;
      // 领取响应尚未重放时，平台未匹配的尝试可能就是本机还没落盘的新领取。
      if (claimPending && !this.state.executions.some(({ id }) => id === directive.attemptId)) continue;
      await this.applyDirective(directive);
    }
    const active = new Set([...response.directives.map(({ attemptId }) => attemptId), ...protectedIds]);
    const localOperations = this.state.sessionOperations;
    if (localOperations) {
      const live = new Set(operations.map(({ id }) => id));
      const ordinary = new Set(response.directives.map(({ attemptId }) => attemptId));
      const keep = localOperations.filter((item) => live.has(item.id) || (!item.reportAcknowledged &&
        (item.replacementId === undefined || !ordinary.has(item.replacementId))));
      if (keep.length !== localOperations.length) { this.state.sessionOperations = keep; this.persist(); }
    }
    const pending = new Set(this.state.outbox.map(({ id }) => id));
    for (const record of [...this.state.executions]) {
      if (active.has(record.id)) continue;
      // 被永久拒绝的退出在平台不再列出该尝试前保留，避免每轮重新生成同一报告。
      if (record.phase === 'exited' && !pending.has(record.id)) this.remove(record.id);
      else if (record.phase === 'prepared' && await this.options.tmux.inspect(record.target) === 'absent') this.remove(record.id);
    }
    const gitBusy = claimPending || response.directives.length > 0 || operations.length > 0 || this.state.outbox.length > 0;
    for (const operation of response.gitOperations ?? []) await this.gitLifecycle.apply(operation, gitBusy);
  }

  private async claim() {
    if (!this.state.claimRequestId) {
      this.state.claimRequestId = randomUUID();
      this.persist();
    }
    const requestId = this.state.claimRequestId;
    const result = await this.retryable(() => this.options.platform.claim(requestId));
    if (!result) return false;
    delete this.state.claimRequestId;
    const claim = result.attempt;
    if (claim && !this.state.executions.some(({ id }) => id === claim.id)) {
      this.state.executions.push({ id: claim.id, target: targetFor(claim.id), phase: 'prepared', claim });
    }
    this.persist();
    return !!claim;
  }

  private async canClaim() {
    const health = await this.options.tmux.check();
    if (health !== 'ready' && health !== this.lastTmuxHealth) {
      this.options.warn?.(`${tmuxHealthText[health]}。已暂停领取新任务，恢复后会自动继续。`);
    }
    this.lastTmuxHealth = health;
    return health === 'ready';
  }

  async tick() {
    const flushed = await this.flush();
    const replayed = !!this.state.claimRequestId;
    if (replayed && await this.canClaim()) await this.claim();
    const heartbeat = await this.heartbeat();
    if (!heartbeat) return;
    await this.reconcile(heartbeat, !!this.state.claimRequestId);
    if (!flushed || !await this.flush() || replayed) return;
    const slots = this.options.config.slots;
    const activeCount = new Set([
      ...heartbeat.response.directives.map(({ attemptId }) => attemptId),
      ...(heartbeat.response.sessionOperations ?? []).map(managedId),
      ...this.state.executions.filter(({ phase }) => phase !== 'exited').map(({ id }) => id),
    ]).size;
    if (activeCount >= slots || !await this.canClaim()) return;
    if (!await this.claim()) return;
    // 领取重放可能返回已经结束的尝试，须由新的心跳确认仍可启动。
    const afterClaim = await this.heartbeat();
    if (!afterClaim) return;
    await this.reconcile(afterClaim);
    await this.flush();
  }
}
