import { randomUUID } from 'node:crypto';
import { LEASE_DURATION_MS } from '@pi-steward/contract';
import type { LauncherClaimResponse, LauncherExitedRequest, LauncherHeartbeatRequest, LauncherHeartbeatResponse, LauncherStartedRequest } from '@pi-steward/contract';
import { reject } from './errors.js';
import { freezeGitSettings, gitDirectives, gitState } from './git-lifecycle.js';
import { attemptLocator, confirmedLocator, sameLocator, sessionInUse } from './session-locator.js';
import { checkReplacementStart, expireSessionPermissions, launchPending, replacementExited, replacementStarted, requestSessionOperation, sessionDirectives } from './session-control.js';
import type { Store } from './store.js';
import { executionMachineSql, isOnline, occupiedSlots, requireMachine, requireTask } from './views.js';
import type { AttemptRow, TaskRow } from './views.js';

const tmuxTarget = (attemptId: string) => `steward-${attemptId}`;

export function heartbeat(store: Store, machineId: string, input: LauncherHeartbeatRequest, now: number): LauncherHeartbeatResponse {
  store.run('UPDATE machines SET last_seen_at=?, slots=?, launcher_version=?, session_control=?, foreground_control=? WHERE id=?',
    now, input.slots, input.launcherVersion, Number(input.sessionControl === true), Number(input.foregroundControl === true), machineId);
  store.run('DELETE FROM machine_projects WHERE machine_id=?', machineId);
  for (const project of input.projects) {
    store.run('INSERT INTO projects (id, name, created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING', project.id, project.name, now);
    store.run('INSERT INTO machine_projects VALUES (?,?,?,?)', machineId, project.id, project.path, now);
  }
  expireSessionPermissions(store, machineId, now);
  const reported = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const active = store.all<AttemptRow>("SELECT * FROM attempts WHERE machine_id=? AND ended_at IS NULL AND execution_mode='background' ORDER BY claimed_at, rowid", machineId);
  const directives = active.flatMap((attempt): LauncherHeartbeatResponse['directives'] => {
    const tmuxSession = tmuxTarget(attempt.id);
    const observation = reported.get(attempt.id);
    const matched = observation?.tmuxSession === tmuxSession;
    if (matched && observation.running && !attempt.cancel_requested) {
      store.run('UPDATE attempts SET lease_expires_at=? WHERE id=?', now + LEASE_DURATION_MS, attempt.id);
    }
    if (launchPending(store, attempt.id)) return [];
    return [{ attemptId: attempt.id, tmuxSession, action: attempt.cancel_requested ? 'cancel' : matched ? 'continue' : 'unknown' }];
  });
  return { directives, ...(input.gitLifecycle === true ? { gitOperations: gitDirectives(store, machineId) } : {}), ...(input.sessionControl === true ? { sessionOperations: sessionDirectives(store, machineId, now) } : {}) };
}

export function claim(store: Store, machineId: string, now: number): LauncherClaimResponse {
  const machine = requireMachine(store, machineId);
  if (!isOnline(machine, now) || occupiedSlots(store, machineId, now) >= machine.slots) return { attempt: null };
  const candidates = store.all<TaskRow & { local_path: string }>(`SELECT t.*, mp.local_path FROM tasks t
    JOIN projects p ON p.id=t.project_id JOIN machine_projects mp ON mp.project_id=t.project_id AND mp.machine_id=?
    WHERE t.status='queued' AND t.agent='pi' AND ${executionMachineSql}=mp.machine_id
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id=t.id AND a.ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM session_operations o WHERE o.task_id=t.id AND o.step IN ('stop','launch','cleanup'))
    ORDER BY t.rework_pending DESC, t.position, t.created_at, t.id`, machineId);
  let blockedForeground = false;
  let selected: { task: typeof candidates[number]; previous?: AttemptRow; locator?: ReturnType<typeof attemptLocator> } | undefined;
  for (const candidate of candidates) {
    if (!candidate.rework_pending) { selected = { task: candidate }; break; }
    const latestDelivery = store.get<{ attempt_id: string; review: string }>(
      'SELECT attempt_id, review FROM deliveries WHERE task_id=? ORDER BY version DESC LIMIT 1', candidate.id);
    const previous = latestDelivery && (latestDelivery.review === 'rework' || gitState(store, candidate.id)?.phase === 'needs_rework') ? store.get<AttemptRow>(
      'SELECT * FROM attempts WHERE task_id=? AND id=? AND machine_id=?', candidate.id, latestDelivery.attempt_id, machineId) : undefined;
    const locator = previous ? attemptLocator(previous) : undefined;
    if (locator && sessionInUse(store, machineId, locator, candidate.id)) { blockedForeground = true; continue; }
    if (previous?.execution_mode === 'foreground' && locator) {
      // 交付结算不等于普通 Pi 已退出；前台返修也必须走同一原进程核对链。
      const failed = store.get(`SELECT 1 FROM session_operations WHERE source_attempt_id=? AND mode='background'
        AND step='failed' AND deadline_at>=?`, previous.id, candidate.updated_at);
      const latest = store.get<{ id: string }>('SELECT id FROM attempts WHERE task_id=? ORDER BY claimed_at DESC,rowid DESC LIMIT 1', candidate.id);
      if (failed || !machine.foreground_control || !machine.session_control || latest?.id !== previous.id ||
          (candidate.type === 'implementation' && !previous.confirmed_git_kind)) { blockedForeground = true; continue; }
      requestSessionOperation(store, candidate.id, { requestId: randomUUID(), attemptId: previous.id, mode: 'background' }, now);
      return { attempt: null };
    }
    // 缺定位的返修保持停止，但不能挡住同机其它可执行任务。
    if (locator) { selected = { task: candidate, previous, locator }; break; }
  }
  if (!selected) {
    if (candidates.length && !blockedForeground) reject('session_record_missing', 'Rework requires the latest delivered session on its original machine');
    return { attempt: null };
  }
  const { task, previous, locator } = selected;
  freezeGitSettings(store, task.id);
  const id = randomUUID();
  const kind = task.rework_pending ? 'rework' : 'new';
  const sessionId = locator?.sessionId ?? tmuxTarget(id);
  const inherit = previous && locator && sameLocator(confirmedLocator(previous), locator) ? previous : undefined;
  store.run(`INSERT INTO attempts (id, task_id, machine_id, agent, kind, session_id, workspace_path, claimed_at, lease_expires_at,
    session_locator, confirmed_workspace_path, confirmed_git_kind, confirmed_git_branch, confirmed_session_id, confirmed_session_file)
    VALUES (?,?,?,'pi',?,?,?,?,?,?,?,?,?,?,?)`, id, task.id, machineId, kind, sessionId, locator?.path ?? task.local_path,
  now, now + LEASE_DURATION_MS, locator ? JSON.stringify(locator) : null, inherit?.confirmed_workspace_path ?? null,
  inherit?.confirmed_git_kind ?? null, inherit?.confirmed_git_branch ?? null, inherit?.confirmed_session_id ?? null,
  inherit?.confirmed_session_file ?? null);
  if (inherit?.confirmed_git_root) store.run('UPDATE attempts SET confirmed_git_root=? WHERE id=?', inherit.confirmed_git_root, id);
  store.run("UPDATE tasks SET status='running', rework_pending=0, version=version+1, updated_at=? WHERE id=?", now, task.id);
  store.run('UPDATE projects SET last_machine_id=? WHERE id=?', machineId, task.project_id);
  store.event(task.id, 'launcher', id, 'claimed', { from: 'queued', to: 'running', kind }, now);
  // 该标题交给 tmux 当作窗口名，正文保留在任务详情。
  const safeTitle = task.title.replace(/[^\p{L}\p{N} _-]/gu, ' ').trim().replace(/^[ -]+/, '');
  const displayName = safeTitle.slice(0, 79).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() || 'Pi task';
  return { attempt: { id, taskId: task.id, projectId: task.project_id, agent: 'pi', sessionId,
    restoreSession: locator !== undefined, ...(locator ? { sessionLocator: locator } : {}), displayName, kind } };
}

export function started(store: Store, attempt: AttemptRow, input: LauncherStartedRequest, now: number) {
  if (attempt.execution_mode !== 'background') reject('forbidden', 'Launcher cannot start a foreground owner');
  if (input.tmuxSession !== tmuxTarget(attempt.id)) reject('invalid_request', 'Invalid tmux target for this attempt');
  if (attempt.ended_at !== null) reject('attempt_ended', 'Attempt has ended');
  checkReplacementStart(store, attempt.id, now);
  if (attempt.started_at !== null && (attempt.started_at !== input.startedAt || attempt.tmux_session !== input.tmuxSession)) {
    reject('conflict', 'Attempt already has a start report');
  }
  if (attempt.started_at === null) {
    store.run('UPDATE attempts SET tmux_session=?, started_at=?, lease_expires_at=? WHERE id=?',
      input.tmuxSession, input.startedAt, now + LEASE_DURATION_MS, attempt.id);
    store.event(attempt.task_id, 'launcher', attempt.id, 'started', { tmuxSession: input.tmuxSession, startedAt: input.startedAt }, now);
    replacementStarted(store, attempt.id, now);
  }
  return { ok: true } as const;
}

export function exited(store: Store, attempt: AttemptRow, input: LauncherExitedRequest, now: number) {
  if (attempt.execution_mode !== 'background') reject('forbidden', 'Launcher cannot close a foreground owner');
  if (attempt.ended_at !== null) reject('attempt_ended', 'Attempt has ended');
  const task = requireTask(store, attempt.task_id);
  const delivered = !!store.get('SELECT 1 FROM deliveries WHERE attempt_id=?', attempt.id);
  const result = attempt.cancel_requested ? 'cancelled' : delivered ? 'delivered' : 'interrupted';
  store.run('UPDATE attempts SET ended_at=?, exit_code=?, result=? WHERE id=?', input.endedAt, input.exitCode, result, attempt.id);
  const interrupted = task.status === 'running' && result === 'interrupted';
  if (interrupted) store.run("UPDATE tasks SET status='interrupted', version=version+1, updated_at=? WHERE id=?", now, task.id);
  store.event(task.id, 'launcher', attempt.id, 'exited', { result, exitCode: input.exitCode,
    ...(interrupted ? { from: 'running', to: 'interrupted' } : {}) }, now);
  replacementExited(store, attempt.id, now);
  return { ok: true } as const;
}
