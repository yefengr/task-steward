import { randomUUID } from 'node:crypto';
import type { AgentContinueRequest, AgentDeliveryRevisionRequest, TaskLifecycle } from '@pi-steward/contract';
import { reject } from './errors.js';
import { gitLocked } from './git-lifecycle.js';
import { requireNoPendingSessionOperation } from './session-control.js';
import type { Store } from './store.js';
import { requireTask } from './views.js';
import type { AttemptRow, TaskRow } from './views.js';

export function lifecycleView(store: Store, task: TaskRow): TaskLifecycle {
  const attempt = store.get<AttemptRow>('SELECT * FROM attempts WHERE task_id=? ORDER BY claimed_at DESC,rowid DESC LIMIT 1', task.id);
  return { phase: task.lifecycle_phase ?? (task.status === 'done' ? 'complete' : attempt?.settled_at != null ? 'settled' : task.status === 'review' ? 'delivered' : 'working'),
    acceptedAt: task.accepted_at, message: task.lifecycle_message };
}

export function workPermissions(store: Store, attempt: AttemptRow) {
  const task = requireTask(store, attempt.task_id);
  const latest = store.get<{ id: string; attempt_id: string }>('SELECT id,attempt_id FROM deliveries WHERE task_id=? ORDER BY version DESC LIMIT 1', task.id);
  const current = store.get<{ id: string }>('SELECT id FROM attempts WHERE task_id=? ORDER BY claimed_at DESC,rowid DESC LIMIT 1', task.id)?.id === attempt.id;
  const closed = task.accepted_at !== null || ['done','cancelled'].includes(task.status) || !!attempt.cancel_requested;
  return { workRevision: attempt.work_revision, settled: attempt.settled_at !== null,
    implementationAllowed: current && !closed && attempt.ended_at === null && attempt.settled_at === null && task.status === 'running' && !['pausing', 'paused'].includes(task.lifecycle_phase ?? '') && !gitLocked(store, task.id),
    recordAllowed: current && !closed && latest?.attempt_id === attempt.id && task.status === 'review' && !gitLocked(store, task.id),
    phase: lifecycleView(store, task).phase, latestDeliveryId: latest?.id ?? null };
}

// 控制读取独立于实施权；只有最新交付的前台原 owner 可在结算解绑后继续记录。
export function requireAgentAccess(store: Store, attempt: AttemptRow, owner: string | undefined) {
  if (attempt.execution_mode === 'foreground' && (!owner || owner !== attempt.owner_id)) reject('forbidden', 'Foreground owner credentials required');
  const permissions = workPermissions(store, attempt);
  const latest = store.get<{ id: string }>('SELECT id FROM attempts WHERE task_id=? ORDER BY claimed_at DESC,rowid DESC LIMIT 1', attempt.task_id);
  if (latest?.id !== attempt.id || attempt.cancel_requested || requireTask(store, attempt.task_id).status === 'cancelled' ||
      (attempt.ended_at !== null && !(attempt.execution_mode === 'foreground' && permissions.recordAllowed))) reject('attempt_ended', 'Attempt no longer owns this task');
  return permissions;
}

export function requireWorkRevision(attempt: AttemptRow, header: string | undefined) {
  if (header !== undefined && !/^(0|[1-9]\d*)$/.test(header)) reject('invalid_request', 'Invalid work revision');
  const revision = header === undefined ? 0 : Number(header);
  if (!Number.isSafeInteger(revision) || revision !== attempt.work_revision) reject('conflict', 'Work revision changed; reload task context');
}

export function requireImplementationWrite(store: Store, attempt: AttemptRow, operation: string) {
  const permissions = workPermissions(store, attempt);
  if (permissions.implementationAllowed) return;
  const closing = ['progress','decision','create_question','update_question','reply','foreground_heartbeat'].includes(operation);
  if (closing && permissions.recordAllowed && attempt.settled_at === null && attempt.ended_at === null) return;
  reject('conflict', 'This work segment no longer permits implementation writes');
}

export function settleWork(store: Store, attempt: AttemptRow, now: number) {
  const task = requireTask(store, attempt.task_id);
  if (!['review','queued','done'].includes(task.status) || !store.get("SELECT 1 FROM deliveries WHERE attempt_id=? AND work_revision=?", attempt.id, attempt.work_revision)) reject('conflict', 'Settle requires the current saved delivery');
  if (attempt.settled_at !== null) reject('conflict', 'Work segment is already settled');
  store.run(`UPDATE attempts SET settled_at=COALESCE(settled_at,?), ended_at=CASE WHEN execution_mode='foreground' THEN COALESCE(ended_at,?) ELSE ended_at END,
    result=CASE WHEN execution_mode='foreground' THEN 'delivered' ELSE result END WHERE id=?`, now, now, attempt.id);
  store.run("UPDATE tasks SET lifecycle_phase=CASE WHEN accepted_at IS NULL AND (lifecycle_phase IS NULL OR lifecycle_phase='delivered') THEN 'settled' ELSE lifecycle_phase END,version=version+1,updated_at=? WHERE id=?", now, task.id);
  store.event(task.id, 'agent', attempt.id, 'work_settled', { workRevision: attempt.work_revision }, now);
  return { ok: true } as const;
}

function requireLatestRecord(store: Store, attempt: AttemptRow, deliveryId: string, now: number) {
  requireNoPendingSessionOperation(store, attempt.task_id, now);
  if (!workPermissions(store, attempt).recordAllowed) reject('conflict', 'Only the original latest delivered session can revise or continue');
  const latest = store.get<{ id: string; base_commit: string | null; commit: string | null; review: string | null }>('SELECT * FROM deliveries WHERE task_id=? ORDER BY version DESC LIMIT 1', attempt.task_id)!;
  if (latest.id !== deliveryId || latest.review !== null) reject('conflict', 'The exact latest unreviewed delivery is required');
  return latest;
}

export function continueWork(store: Store, attempt: AttemptRow, input: AgentContinueRequest, now: number) {
  requireLatestRecord(store, attempt, input.deliveryId, now);
  const workRevision = attempt.work_revision + 1;
  store.run("UPDATE attempts SET work_revision=?,work_mode='foreground',settled_at=NULL,ended_at=NULL,result=NULL,continuation_pending=0,discussion_end_requested_at=NULL WHERE id=?", workRevision, attempt.id);
  store.run("UPDATE tasks SET status='running',lifecycle_phase=NULL,lifecycle_message=NULL,version=version+1,updated_at=? WHERE id=?", now, attempt.task_id);
  store.event(attempt.task_id, 'agent', attempt.id, 'work_continued', { workRevision, sourceDeliveryId: input.deliveryId, reason: input.reason, authorizedByUser: true }, now);
  return { workRevision };
}

export function reviseDelivery(store: Store, attempt: AttemptRow, input: AgentDeliveryRevisionRequest, now: number) {
  const source = requireLatestRecord(store, attempt, input.deliveryId, now);
  if ((input.baseCommit ?? null) !== source.base_commit || (input.commit ?? null) !== source.commit) reject('conflict', 'Record revisions cannot change Git commits');
  const deliveryId = randomUUID();
  const { version } = store.get<{ version: number }>('SELECT COALESCE(MAX(version),0)+1 version FROM deliveries WHERE task_id=?', attempt.task_id)!;
  store.run(`INSERT INTO deliveries (id,task_id,attempt_id,version,summary,done,not_covered,verification,how_to,issues,base_commit,"commit",report_ref,created_at,work_revision,kind,source_delivery_id,revision_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'record',?,?)`, deliveryId, attempt.task_id, attempt.id, version, input.summary, JSON.stringify(input.done), JSON.stringify(input.notCovered),
  JSON.stringify(input.verification), JSON.stringify(input.howTo), JSON.stringify(input.issues), source.base_commit, source.commit, input.reportRef ?? null, now, attempt.work_revision, source.id, input.reason);
  store.run('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?', now, attempt.task_id);
  store.event(attempt.task_id, 'agent', attempt.id, 'delivery_revised', { deliveryId, version, sourceDeliveryId: source.id, reason: input.reason, authorizedByUser: true }, now);
  return { deliveryId, version };
}
