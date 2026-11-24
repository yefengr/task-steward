import { randomUUID } from 'node:crypto';
import { LEASE_DURATION_MS, piSessionLocatorSchema } from '@pi-steward/contract';
import type { LauncherSessionDirective, LauncherSessionReport, PiSessionLocator, SessionOperationFailure,
  Task, WebSessionOperation, WebSessionOperationRequest } from '@pi-steward/contract';
import { reject } from './errors.js';
import type { Store } from './store.js';
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

function confirmedLocator(attempt: AttemptRow): PiSessionLocator | undefined {
  const result = piSessionLocatorSchema.safeParse({ path: attempt.confirmed_workspace_path,
    sessionId: attempt.confirmed_session_id, sessionFile: attempt.confirmed_session_file });
  return result.success ? result.data : undefined;
}

function sameLocator(a: PiSessionLocator | undefined, b: PiSessionLocator) {
  return a?.path === b.path && a.sessionId === b.sessionId && a.sessionFile === b.sessionFile;
}

function latestAttempt(store: Store, taskId: string) {
  return store.get<AttemptRow>('SELECT * FROM attempts WHERE task_id=? ORDER BY claimed_at DESC, rowid DESC LIMIT 1', taskId);
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
  if (!attempt || (task.status !== 'running' && task.status !== 'interrupted')) return undefined;
  const operation = store.get<OperationRow>(`SELECT * FROM session_operations WHERE task_id=?
    AND COALESCE(replacement_id, source_attempt_id)=? ORDER BY rowid DESC LIMIT 1`, task.id, attempt.id);
  if (!operation || (operation.step === 'succeeded' && now - operation.loaded_at! > READY_NOTICE_MS)) return undefined;
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
  requireNoPendingSessionOperation(store, taskId, now);
  const source = latestAttempt(store, taskId);
  if (!source || source.id !== input.attemptId || source.agent !== 'pi' || source.cancel_requested ||
      store.get('SELECT 1 FROM deliveries WHERE attempt_id=?', source.id) ||
      (input.mode === 'restart' ? task.status !== 'running' || source.ended_at !== null || source.started_at === null ||
        source.discussion_end_requested_at !== null
        : task.status !== 'interrupted' || source.ended_at === null || !!activeAttempt(store, taskId))) {
    reject('conflict', 'The expected attempt cannot be restarted or restored in its current state');
  }
  const machine = requireMachine(store, source.machine_id);
  if (!isOnline(machine, now)) reject('session_machine_offline', 'The original execution machine is offline');
  if (!machine.session_control) reject('session_unsupported', 'The original launcher does not support session control');
  if (input.mode === 'restore' && occupiedSlots(store, machine.id, now) >= machine.slots) {
    reject('session_slots_full', 'The original machine has no free execution slots');
  }
  const locator = source.session_locator ? piSessionLocatorSchema.parse(JSON.parse(source.session_locator)) : confirmedLocator(source);
  if (!locator) reject('session_record_missing', 'The execution has no saved Pi session locator');

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
  const rows = store.all<OperationRow & { ended_at: number | null }>(`SELECT o.*, a.ended_at FROM session_operations o
    JOIN attempts a ON a.id=o.source_attempt_id WHERE o.machine_id=? AND o.step IN ('stop','launch','cleanup') ORDER BY o.rowid`, machineId);
  const directives: LauncherSessionDirective[] = [];
  for (const operation of rows) {
    const base = { id: operation.id, attemptId: operation.source_attempt_id, mode: operation.mode };
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
    VALUES (?,?,?,'pi','new',?,?,?,?,?,?,?,?,?,?,?)`, replacementId, operation.task_id, operation.machine_id,
  source.session_id, locator.path, now, now + LEASE_DURATION_MS, source.id, operation.locator,
  inheritWorkspace ? source.confirmed_workspace_path : null, inheritWorkspace ? source.confirmed_git_kind : null,
  inheritWorkspace ? source.confirmed_git_branch : null, inheritWorkspace ? source.confirmed_session_id : null,
  inheritWorkspace ? source.confirmed_session_file : null);
  store.run("UPDATE tasks SET status='running', version=version+1, updated_at=? WHERE id=?", now, operation.task_id);
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
  store.run('UPDATE attempts SET session_locator=? WHERE id=?', JSON.stringify(locator), attempt.id);
  return ok;
}
