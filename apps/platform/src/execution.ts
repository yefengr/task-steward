import { randomUUID } from 'node:crypto';
import { LEASE_DURATION_MS } from '@pi-steward/contract';
import type { LauncherClaimResponse, LauncherExitedRequest, LauncherHeartbeatRequest, LauncherHeartbeatResponse, LauncherStartedRequest } from '@pi-steward/contract';
import { reject } from './errors.js';
import type { Store } from './store.js';
import { executionMachineSql, isOnline, occupiedSlots, requireMachine, requireTask } from './views.js';
import type { AttemptRow, TaskRow } from './views.js';

const tmuxTarget = (attemptId: string) => `steward-${attemptId}`;

export function heartbeat(store: Store, machineId: string, input: LauncherHeartbeatRequest, now: number): LauncherHeartbeatResponse {
  store.run('UPDATE machines SET last_seen_at=?, slots=?, launcher_version=? WHERE id=?', now, input.slots, input.launcherVersion, machineId);
  store.run('DELETE FROM machine_projects WHERE machine_id=?', machineId);
  for (const project of input.projects) {
    store.run('INSERT INTO projects (id, name, created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING', project.id, project.name, now);
    store.run('INSERT INTO machine_projects VALUES (?,?,?,?)', machineId, project.id, project.path, now);
  }
  const reported = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const active = store.all<AttemptRow>('SELECT * FROM attempts WHERE machine_id=? AND ended_at IS NULL ORDER BY claimed_at, rowid', machineId);
  return { directives: active.map((attempt) => {
    const tmuxSession = tmuxTarget(attempt.id);
    const observation = reported.get(attempt.id);
    const matched = observation?.tmuxSession === tmuxSession;
    if (matched && observation.running && !attempt.cancel_requested) {
      store.run('UPDATE attempts SET lease_expires_at=? WHERE id=?', now + LEASE_DURATION_MS, attempt.id);
    }
    return { attemptId: attempt.id, tmuxSession, action: attempt.cancel_requested ? 'cancel' : matched ? 'continue' : 'unknown' };
  }) };
}

export function claim(store: Store, machineId: string, now: number): LauncherClaimResponse {
  const machine = requireMachine(store, machineId);
  if (!isOnline(machine, now) || occupiedSlots(store, machineId) >= machine.slots) return { attempt: null };
  const task = store.get<TaskRow & { local_path: string }>(`SELECT t.*, mp.local_path FROM tasks t
    JOIN projects p ON p.id=t.project_id JOIN machine_projects mp ON mp.project_id=t.project_id AND mp.machine_id=?
    WHERE t.status='queued' AND t.agent='pi' AND ${executionMachineSql}=mp.machine_id
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id=t.id AND a.ended_at IS NULL)
    ORDER BY t.rework_pending DESC, t.position, t.created_at, t.id LIMIT 1`, machineId);
  if (!task) return { attempt: null };
  const id = randomUUID();
  const previous = task.rework_pending ? store.get<{ session_id: string }>(`SELECT session_id FROM attempts
    WHERE task_id=? AND machine_id=? ORDER BY claimed_at DESC, rowid DESC LIMIT 1`, task.id, machineId) : undefined;
  const kind = task.rework_pending ? 'rework' : 'new';
  const sessionId = previous?.session_id ?? tmuxTarget(id);
  store.run(`INSERT INTO attempts (id, task_id, machine_id, agent, kind, session_id, workspace_path, claimed_at, lease_expires_at)
    VALUES (?,?,?,'pi',?,?,?,?,?)`, id, task.id, machineId, kind, sessionId, task.local_path, now, now + LEASE_DURATION_MS);
  store.run("UPDATE tasks SET status='running', rework_pending=0, version=version+1, updated_at=? WHERE id=?", now, task.id);
  store.run('UPDATE projects SET last_machine_id=? WHERE id=?', machineId, task.project_id);
  store.event(task.id, 'launcher', id, 'claimed', { from: 'queued', to: 'running', kind }, now);
  // 该标题交给 tmux 当作窗口名，正文保留在任务详情。
  const safeTitle = task.title.replace(/[^\p{L}\p{N} _-]/gu, ' ').trim().replace(/^[ -]+/, '');
  const displayName = safeTitle.slice(0, 79).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() || 'Pi task';
  return { attempt: { id, taskId: task.id, projectId: task.project_id, agent: 'pi', sessionId,
    restoreSession: previous !== undefined, displayName, kind } };
}

export function started(store: Store, attempt: AttemptRow, input: LauncherStartedRequest, now: number) {
  if (input.tmuxSession !== tmuxTarget(attempt.id)) reject('invalid_request', 'Invalid tmux target for this attempt');
  if (attempt.ended_at !== null) reject('attempt_ended', 'Attempt has ended');
  if (attempt.started_at !== null && (attempt.started_at !== input.startedAt || attempt.tmux_session !== input.tmuxSession)) {
    reject('conflict', 'Attempt already has a start report');
  }
  if (attempt.started_at === null) {
    store.run('UPDATE attempts SET tmux_session=?, started_at=?, lease_expires_at=? WHERE id=?',
      input.tmuxSession, input.startedAt, now + LEASE_DURATION_MS, attempt.id);
    store.event(attempt.task_id, 'launcher', attempt.id, 'started', { tmuxSession: input.tmuxSession, startedAt: input.startedAt }, now);
  }
  return { ok: true } as const;
}

export function exited(store: Store, attempt: AttemptRow, input: LauncherExitedRequest, now: number) {
  if (attempt.ended_at !== null) reject('attempt_ended', 'Attempt has ended');
  const task = requireTask(store, attempt.task_id);
  const delivered = !!store.get('SELECT 1 FROM deliveries WHERE attempt_id=?', attempt.id);
  const result = attempt.cancel_requested ? 'cancelled' : delivered ? 'delivered' : 'interrupted';
  store.run('UPDATE attempts SET ended_at=?, exit_code=?, result=? WHERE id=?', input.endedAt, input.exitCode, result, attempt.id);
  const interrupted = task.status === 'running' && result === 'interrupted';
  if (interrupted) store.run("UPDATE tasks SET status='interrupted', version=version+1, updated_at=? WHERE id=?", now, task.id);
  store.event(task.id, 'launcher', attempt.id, 'exited', { result, exitCode: input.exitCode,
    ...(interrupted ? { from: 'running', to: 'interrupted' } : {}) }, now);
  return { ok: true } as const;
}
