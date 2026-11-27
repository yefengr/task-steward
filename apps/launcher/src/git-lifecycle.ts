import { randomUUID } from 'node:crypto';
import { processStatus } from '@pi-steward/execution-runtime';
import type { LauncherGitOperation, LauncherGitReport, LocalConfig } from '@pi-steward/contract';
import { PlatformError, type Platform } from './platform.js';
import type { GitOperation, State } from './state.js';
import { cleanupAccepted, GitFailure, lockRepository, mergeAccepted, validateOperation, verifySource } from './git-native.js';

export class GitLifecycle {
  constructor(private readonly options: { state: State; config: LocalConfig; save: () => void;
    platform: Platform; warn?: (message: string) => void }) {}

  private save() {
    const entries = this.options.state.gitOperations;
    if (entries) {
      // 仅裁剪已终结项；未知回报与未完成删除的精确检查点必须保留。
      const terminal = entries.filter((item) => (item.reportRejected || (item.reportAcknowledged &&
        (item.report?.outcome === 'complete' || item.report?.outcome === 'needs_rework'))) &&
        (!item.cleanupIssued || item.cleaned));
      const expired = new Set(terminal.slice(0, -32));
      this.options.state.gitOperations = entries.filter((item) => !expired.has(item));
    }
    this.options.save();
  }
  private async report(entry: GitOperation) {
    if (entry.reportRejected) return false;
    if (!entry.report || entry.reportAcknowledged) return true;
    try { await this.options.platform.reportGit(entry.operation.id, entry.report); }
    catch (error) {
      if (error instanceof PlatformError && ['conflict', 'not_found', 'forbidden', 'invalid_request'].includes(error.code)) {
        entry.reportRejected = true; this.save();
        this.options.warn?.(`Git 回报已被平台拒绝（${error.code}），停止重放和清理。`);
      } else this.options.warn?.('Git 回报尚未确认，保留原请求并暂停清理。');
      return false;
    }
    entry.reportAcknowledged = true;
    if (entry.report.outcome === 'merged') entry.mergeAcknowledged = true;
    this.save();
    return true;
  }
  private setReport(entry: GitOperation, outcome: LauncherGitReport['outcome'], message?: string) {
    entry.report = { requestId: randomUUID(), outcome, ...(entry.merged ? { mergedCommit: entry.operation.approvedCommit } : {}),
      ...(message ? { message } : {}) };
    entry.reportAcknowledged = false; this.save();
  }
  async apply(operation: LauncherGitOperation, busy: boolean) {
    const { state, config } = this.options;
    state.gitOperations ??= [];
    let entry = state.gitOperations.find((item) => item.operation.id === operation.id);
    if (entry) {
      const identity = { ...operation, phase: undefined, mergedCommit: undefined };
      const oldIdentity = { ...entry.operation, phase: undefined, mergedCommit: undefined };
      if (JSON.stringify(identity) !== JSON.stringify(oldIdentity)) return;
    } else {
      const prior = state.gitOperations.find((item) => item.mergeAcknowledged && item.cleanupIssued &&
        item.operation.taskId === operation.taskId && item.operation.deliveryId === operation.deliveryId &&
        item.operation.projectId === operation.projectId && item.operation.repositoryPath === operation.repositoryPath &&
        item.operation.worktreePath === operation.worktreePath && item.operation.taskBranch === operation.taskBranch &&
        item.operation.baseBranch === operation.baseBranch && item.operation.baseCommit === operation.baseCommit &&
        item.operation.approvedCommit === operation.approvedCommit);
      entry = { operation, ...(prior ? { cleanupIssued: true, worktreeRemoved: prior.worktreeRemoved } : {}) };
      // 新操作已接替同一任务；先复制必要的 partial cleanup 检查点，再移除已确认旧项。
      state.gitOperations = state.gitOperations.filter((item) => item.operation.taskId !== operation.taskId ||
        (!item.reportAcknowledged && !item.reportRejected) || (item.cleanupIssued && !item.cleaned && item !== prior));
      state.gitOperations.push(entry); this.save();
    }
    // 恢复旧版在 merged=true 与创建报告之间崩溃的 journal。
    if (entry.merged && !entry.mergeAcknowledged && !entry.report) this.setReport(entry, 'merged');
    // 未知 HTTP 结果只重放原 requestId 和内容；不重复任何 Git 写操作。
    const wasPending = !!entry.report && !entry.reportAcknowledged;
    if (!await this.report(entry)) return;
    if (entry.report?.outcome === 'complete' || entry.report?.outcome === 'needs_rework') return;
    if (entry.report?.outcome === 'blocked') {
      if (wasPending) return;
      delete entry.report; delete entry.reportAcknowledged; this.save();
    }
    if (busy || state.claimRequestId || state.executions.length || state.sessionOperations?.some((item) => !item.reportAcknowledged)) return;
    const project = config.projects.find((item) => item.id === operation.projectId);
    let release: (() => void) | undefined;
    try {
      if (!project) throw new GitFailure('git_project_unregistered');
      // 普通 Pi 结算后仍可能停留在原生会话；OS cwd 不能证明其逻辑工作树已无人使用。
      if (operation.foregroundOwner && processStatus(operation.foregroundOwner.pid) !== 'dead') {
        throw new GitFailure('git_foreground_session_active');
      }
      await validateOperation(operation, project.path);
      release = await lockRepository(project.path);
      if (operation.phase === 'cleanup') {
        if (operation.mergedCommit !== operation.approvedCommit) throw new GitFailure('git_merge_unverified');
        entry.merged = true; entry.mergeAcknowledged = true; this.save();
      }
      if (!entry.merged) {
        await verifySource(operation);
        entry.mergeIssued = true; this.save();
        await mergeAccepted(operation);
        // merged 与稳定 requestId/body 必须在同一次原子状态保存中落盘。
        entry.merged = true;
        this.setReport(entry, 'merged');
        // 下一轮拿到平台明确授权的 cleanup 指令后才清理。
        await this.report(entry); return;
      }
      if (!entry.mergeAcknowledged || operation.phase !== 'cleanup') return;
      if (!entry.cleaned) {
        // 先记录删除意图；崩溃后仍只允许恢复这一精确工作树的清理。
        const canResumeRemoval = !!entry.worktreeRemoved || !!entry.cleanupIssued;
        await verifySource(operation, canResumeRemoval);
        entry.cleanupIssued = true; this.save();
        await cleanupAccepted(operation, canResumeRemoval, () => {
          entry!.worktreeRemoved = true; this.save();
        });
        entry.cleaned = true; this.save();
      }
      this.setReport(entry, 'complete'); await this.report(entry);
    } catch (error) {
      const reason = error instanceof GitFailure ? error.reason : 'git_verification_failed';
      this.setReport(entry, error instanceof GitFailure && error.rework && !entry.merged ? 'needs_rework' : 'blocked', reason);
      await this.report(entry);
    } finally { release?.(); }
  }
}
