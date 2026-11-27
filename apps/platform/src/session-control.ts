import { randomUUID } from 'node:crypto';
import { LEASE_DURATION_MS, piSessionLocatorSchema } from '@pi-steward/contract';
import type { LauncherSessionDirective, LauncherSessionReport, PiSessionLocator, SessionOperationFailure,
  Task, WebSessionOperation, WebSessionOperationRequest } from '@pi-steward/contract';
import { reject } from './errors.js';
import { gitLocked, gitState } from './git-lifecycle.js';
import type { Store } from './store.js';
import { attemptLocator, confirmedLocator, sameLocator, sessionInUse } from './session-locator.js';
import { activeAttempt, isOnline, occupiedSlots, requireMachine, requireTask } from './views.js';
import type { AttemptRow } from './views.js';

const STOP_WINDOW_MS = 45_000;
const LAUNCH_WINDOW_MS = 60_000;
const PERMISSION_MARGIN_MS = 5_000;
const READY_NOTICE_MS = 120_000;
const ok = { ok: true } as const;

interface OperationRow {
  id: string; task_id: string; machine_id: string; source_attempt_id: string; replacement_id: string | null;
  mode: WebSessionOperation['mode']; locator: string; step: 'stop' | 'launch' | 'cleanup' | 'succeeded' | 'failed';
  deadline_at: number; loaded_at: number | null; failure: SessionOperationFailure | null;
}

function latestAttempt(store: Store, taskId: string) {
  return store.get<AttemptRow>('SELECT * FROM attempts WHERE task_id=? ORDER BY claimed_at DESC, rowid DESC LIMIT 1', taskId);
}

export function isForegroundRework(store: Store, taskId: string, sourceId: string) {
  const task = requireTask(store, taskId);
  const delivery = store.get<{ attempt_id: string; review: string | null }>(
    'SELECT attempt_id,review FROM deliveries WHERE task_id=? ORDER BY version DESC LIMIT 1', taskId);
  return task.status === 'queued' && Boolean(task.rework_pending) && delivery?.attempt_id === sourceId &&
    (delivery.review === 'rework' || gitState(store, taskId)?.phase === 'needs_rework');
}

function operationForReplacement(store: Store, attemptId: string) {
  return store.get<OperationRow>("SELECT * FROM session_operations WHERE replacement_id=? AND step IN ('launch','cleanup')", attemptId);
}

export function requireNoPendingSessionOperation(store: Store, taskId: string, now: number, cancelling = false) {
  // 超时后允许取消任务，但保留替代进程的核对和槽位，直到确认退出。
  if (cancelling) store.run(`UPDATE session_operations SET step='cleanup'
    WHERE task_id=? AND step='launch' AND deadline_at<=?`, taskId, now);
  if (store.get(`SELECT 1 FROM session_operations WHERE task_id=? AND
    (step='launch' OR (step='cleanup' AND ?=0) OR (step='stop' AND deadline_at>?))`, taskId, Number(cancelling), now)) {
    reject('conflict', 'A session operation is pending');
  }
}

export function sessionOperationView(store: Store, task: Pick<Task, 'id' | 'status'>, attempt: { id: string } | undefined, now: number): WebSessionOperation | undefined {
  if (!attempt || !['running', 'interrupted', 'queued'].includes(task.status)) return undefined;
  const operation = store.get<OperationRow>(`SELECT * FROM session_operations WHERE task_id=?
    AND COALESCE(replacement_id, source_attempt_id)=? ORDER BY rowid DESC LIMIT 1`, task.id, attempt.id);
  if (!operation || (operation.step === 'succeeded' && now - operation.loaded_at! > READY_NOTICE_MS)) return undefined;
  if (task.status === 'queued' && (operation.mode !== 'background' || !requireTask(store, task.id).rework_pending)) return undefined;
  const expired = operation.step === 'stop' && operation.deadline_at <= now;
  const needsExitVerification = operation.step === 'cleanup' || (operation.step === 'launch' && operation.deadline_at <= now);
  return { id: operation.id, attemptId: operation.source_attempt_id, mode: operation.mode,
    status: expired ? 'failed' : operation.step === 'succeeded' || operation.step === 'failed' ? operation.step : 'pending',
    failure: expired ? 'session_timeout' : operation.failure, ...(needsExitVerification ? { needsExitVerification: true } : {}) };
}

function failOperation(store: Store, operation: OperationRow, failure: SessionOperationFailure, now: number) {
  store.run("UPDATE session_operations SET step='failed', failure=? WHERE id=?", failure, operation.id);
  store.event(operation.task_id, 'launcher', operation.replacement_id ?? operation.source_attempt_id,
    'session_operation_failed', { operationId: operation.id, mode: operation.mode, failure }, now);
}

export function requestSessionOperation(store: Store, taskId: string, input: WebSessionOperationRequest, now: number) {
  const replay = store.get<OperationRow>('SELECT * FROM session_operations WHERE id=?', input.requestId);
  if (replay) {
    if (replay.task_id !== taskId || replay.source_attempt_id !== input.attemptId || replay.mode !== input.mode) {
      reject('conflict', 'Request ID already belongs to a different session operation');
    }
    return ok;
  }
  const task = requireTask(store, taskId);
  if (gitLocked(store, taskId)) reject('conflict', 'Accepted Git integration cannot restore or restart its workspace');
  requireNoPendingSessionOperation(store, taskId, now);
  const source = latestAttempt(store, taskId);
  const rework = source && input.mode === 'background' && isForegroundRework(store, taskId, source.id);
  if (!source || source.id !== input.attemptId || source.agent !== 'pi' || source.cancel_requested ||
      (!rework && store.get('SELECT 1 FROM deliveries WHERE attempt_id=?', source.id)) ||
      (input.mode === 'background' ? source.execution_mode !== 'foreground' ||
        (!rework && (source.discussion_end_requested_at !== null || !['running','interrupted'].includes(task.status)))
        : source.execution_mode === 'foreground' || (input.mode === 'restart' ? task.status !== 'running' || source.ended_at !== null || source.started_at === null ||
        source.discussion_end_requested_at !== null
        : task.status !== 'interrupted' || source.ended_at === null || !!activeAttempt(store, taskId)))) {
    reject('conflict', 'The expected attempt cannot be restarted or restored in its current state');
  }
  const machine = requireMachine(store, source.machine_id);
  if (!isOnline(machine, now)) reject('session_machine_offline', 'The original execution machine is offline');
  if (input.mode === 'background' && !machine.foreground_control) reject('session_unsupported', 'Launcher does not support foreground handover');
  if (input.mode === 'background' && task.type === 'implementation' && !source.confirmed_git_kind) reject('session_workspace_unconfirmed', 'Foreground implementation requires a confirmed Git workspace');
  if (!machine.session_control) reject('session_unsupported', 'The original launcher does not support session control');
  if ((input.mode === 'restore' || input.mode === 'background') && occupiedSlots(store, machine.id, now) >= machine.slots) {
    reject('session_slots_full', 'The original machine has no free execution slots');
  }
  const locator = attemptLocator(source);
  if (!locator) reject('session_record_missing', 'The execution has no saved Pi session locator');
  if (sessionInUse(store, machine.id, locator, taskId)) reject('session_in_use', 'The Pi session belongs to another active task or handover');

  const previous = store.get<OperationRow>("SELECT * FROM session_operations WHERE task_id=? AND step='stop'", taskId);
  if (previous) failOperation(store, previous, 'session_timeout', now);
  store.run(`INSERT INTO session_operations (id, task_id, machine_id, source_attempt_id, mode, locator, step, deadline_at)
    VALUES (?,?,?,?,?,?,'stop',?)`, input.requestId, taskId, machine.id, source.id, input.mode, JSON.stringify(locator), now + STOP_WINDOW_MS);
  store.event(taskId, 'user', source.id, 'session_operation_requested', { operationId: input.requestId, mode: input.mode }, now);
  return ok;
}

export function expireSessionPermissions(store: Store, machineId: string, now: number) {
  const expiredStops = store.all<OperationRow>("SELECT * FROM session_operations WHERE machine_id=? AND step='stop' AND deadline_at<=?", machineId, now);
  for (const operation of expiredStops) failOperation(store, operation, 'session_timeout', now);
  store.run("UPDATE session_operations SET step='cleanup' WHERE machine_id=? AND step='launch' AND deadline_at<=?", machineId, now);
}

export function sessionDirectives(store: Store, machineId: string, now: number): LauncherSessionDirective[] {
  const rows = store.all<OperationRow & Pick<AttemptRow, 'ended_at' | 'goal_id' | 'owner_pid' | 'confirmed_git_kind' | 'confirmed_git_branch'>>(`SELECT o.*, a.ended_at, a.goal_id, a.owner_pid, a.confirmed_git_kind, a.confirmed_git_branch FROM session_operations o
    JOIN attempts a ON a.id=o.source_attempt_id WHERE o.machine_id=? AND o.step IN ('stop','launch','cleanup') ORDER BY o.rowid`, machineId);
  const directives: LauncherSessionDirective[] = [];
  for (const operation of rows) {
    const base = { id: operation.id, attemptId: operation.source_attempt_id, mode: operation.mode,
      ...(operation.mode === 'background' ? { foregroundOwner: { goalId: operation.goal_id!, pid: operation.owner_pid! },
        ...(operation.confirmed_git_kind ? { foregroundGit: { kind: operation.confirmed_git_kind, branch: operation.confirmed_git_branch } } : {}) } : {}) };
    const remaining = operation.deadline_at - now;
    if (operation.step === 'cleanup' || (operation.step === 'launch' && remaining <= 0)) {
      directives.push({ ...base, step: 'cleanup', replacementId: operation.replacement_id! });
      continue;
    }
    const validForMs = Math.min(remaining, operation.step === 'stop' ? STOP_WINDOW_MS : LAUNCH_WINDOW_MS) - PERMISSION_MARGIN_MS;
    if (validForMs <= 0) continue;
    const locator = piSessionLocatorSchema.parse(JSON.parse(operation.locator));
    directives.push(operation.step === 'stop' ? { ...base, step: 'stop', locator, validForMs, sourceEnded: operation.ended_at !== null }
      : { ...base, step: 'launch', locator, validForMs, replacementId: operation.replacement_id! });
  }
  return directives;
}

export function launchPending(store: Store, attemptId: string) {
  return operationForReplacement(store, attemptId) !== undefined;
}

function beginReplacement(store: Store, operation: OperationRow, now: number) {
  const source = store.get<AttemptRow>('SELECT * FROM attempts WHERE id=?', operation.source_attempt_id)!;
  const rework = operation.mode === 'background' && isForegroundRework(store, operation.task_id, source.id);
  if (operation.mode === 'background' && (source.execution_mode !== 'foreground' || source.cancel_requested ||
      latestAttempt(store, operation.task_id)?.id !== source.id ||
      (!rework && !['running','interrupted'].includes(requireTask(store, operation.task_id).status)) ||
      gitLocked(store, operation.task_id) || (!rework && store.get('SELECT 1 FROM deliveries WHERE task_id=?', operation.task_id)))) {
    reject('conflict', 'Foreground source changed before handover');
  }
  // 活跃源占用自己的槽位；已退出源由 stop 阶段保留等量槽位。
  if (occupiedSlots(store, operation.machine_id, now) > requireMachine(store, operation.machine_id).slots) {
    reject('session_slots_full', 'The original machine has no execution slot reserved for this operation');
  }
  const locator = piSessionLocatorSchema.parse(JSON.parse(operation.locator));
  const inheritWorkspace = sameLocator(confirmedLocator(source), locator);
  const replacementId = randomUUID();
  if (source.ended_at === null) {
    store.run("UPDATE attempts SET ended_at=?, result='interrupted' WHERE id=?", now, source.id);
  }
  store.run(`INSERT INTO attempts (id, task_id, machine_id, agent, kind, session_id, workspace_path, claimed_at,
    lease_expires_at, resumed_from_attempt_id, session_locator, confirmed_workspace_path, confirmed_git_kind,
    confirmed_git_branch, confirmed_session_id, confirmed_session_file)
    VALUES (?,?,?,'pi',?,?,?,?,?,?,?,?,?,?,?,?)`, replacementId, operation.task_id, operation.machine_id, rework ? 'rework' : 'new',
  source.session_id, locator.path, now, now + LEASE_DURATION_MS, source.id, operation.locator,
  inheritWorkspace ? source.confirmed_workspace_path : null, inheritWorkspace ? source.confirmed_git_kind : null,
  inheritWorkspace ? source.confirmed_git_branch : null, inheritWorkspace ? source.confirmed_session_id : null,
  inheritWorkspace ? source.confirmed_session_file : null);
  if (inheritWorkspace && source.confirmed_git_root) {
    store.run('UPDATE attempts SET confirmed_git_root=? WHERE id=?', source.confirmed_git_root, replacementId);
  }
  store.run("UPDATE tasks SET status='running', rework_pending=0, version=version+1, updated_at=? WHERE id=?", now, operation.task_id);
  store.run("UPDATE session_operations SET step='launch', replacement_id=?, deadline_at=? WHERE id=?",
    replacementId, now + LAUNCH_WINDOW_MS, operation.id);
  store.event(operation.task_id, 'launcher', replacementId, 'session_operation_stopped',
    { operationId: operation.id, mode: operation.mode, sourceAttemptId: source.id }, now);
}

function endReplacement(store: Store, operation: OperationRow, failure: SessionOperationFailure, now: number) {
  store.run(`UPDATE attempts SET ended_at=?, result=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'interrupted' END
    WHERE id=? AND ended_at IS NULL`, now, operation.replacement_id);
  store.run("UPDATE tasks SET status='interrupted', version=version+1, updated_at=? WHERE id=? AND status='running'", now, operation.task_id);
  failOperation(store, operation, failure, now);
}

export function reportSessionOperation(store: Store, machineId: string, id: string, input: LauncherSessionReport, now: number) {
  const operation = store.get<OperationRow>('SELECT * FROM session_operations WHERE id=?', id);
  if (!operation) reject('not_found', 'Session operation not found');
  if (operation.machine_id !== machineId) reject('forbidden', 'Session operation belongs to a different machine');
  const expired = operation.deadline_at <= now;
  const step = operation.step === 'launch' && expired ? 'cleanup' : operation.step;
  if (input.step !== step || (step === 'stop' && expired)) reject('conflict', 'Session operation phase expired or changed');
  if (input.result === 'stopped') beginReplacement(store, operation, now);
  else if (step === 'stop') failOperation(store, operation, input.failure, now);
  else endReplacement(store, operation, input.failure, now);
  return ok;
}

function completeIfReady(store: Store, attemptId: string, now: number, actor: 'launcher' | 'agent') {
  const operation = operationForReplacement(store, attemptId);
  if (!operation || operation.step !== 'launch' || operation.loaded_at === null || operation.deadline_at <= now ||
      !store.get('SELECT 1 FROM attempts WHERE id=? AND started_at IS NOT NULL AND ended_at IS NULL', attemptId)) return;
  store.run("UPDATE session_operations SET step='succeeded' WHERE id=?", operation.id);
  store.event(operation.task_id, actor, attemptId, 'session_operation_succeeded', { operationId: operation.id, mode: operation.mode }, now);
}

export function checkReplacementStart(store: Store, attemptId: string, now: number) {
  const operation = operationForReplacement(store, attemptId);
  if (operation && (operation.step !== 'launch' || operation.deadline_at <= now)) reject('conflict', 'Session launch permission expired');
}

export function replacementStarted(store: Store, attemptId: string, now: number) {
  completeIfReady(store, attemptId, now, 'launcher');
}

export function replacementExited(store: Store, attemptId: string, now: number) {
  const operation = operationForReplacement(store, attemptId);
  if (operation) endReplacement(store, operation, 'session_launch_failed', now);
}

export function saveAgentSession(store: Store, attempt: AttemptRow, locator: PiSessionLocator, now: number) {
  if (sessionInUse(store, attempt.machine_id, locator, attempt.task_id)) reject('session_in_use', 'The Pi session belongs to another active task or handover');
  const operation = operationForReplacement(store, attempt.id);
  if (operation) {
    if (operation.step !== 'launch' || operation.deadline_at <= now || !sameLocator(piSessionLocatorSchema.parse(JSON.parse(operation.locator)), locator)) {
      reject('conflict', 'Loaded session does not match the pending operation or its launch permission expired');
    }
    store.run('UPDATE session_operations SET loaded_at=COALESCE(loaded_at,?) WHERE id=?', now, operation.id);
    completeIfReady(store, attempt.id, now, 'agent');
  } else {
    requireNoPendingSessionOperation(store, attempt.task_id, now);
  }
  store.run('UPDATE attempts SET session_locator=?, workspace_path=?, session_id=? WHERE id=?', JSON.stringify(locator), locator.path, locator.sessionId, attempt.id);
  return ok;
}
