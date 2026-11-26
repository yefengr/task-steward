import { randomUUID } from 'node:crypto';
import type { AgentContextResponse, AgentControlResponse, AgentDeliveryRequest, AgentDeliveryResponse, AttemptWorkspace, Delivery } from '@pi-steward/contract';
import { reject } from './errors.js';
import { checkGitDelivery, confirmGitWorkspace, gitState, resolvedGitSettings } from './git-lifecycle.js';
import type { Store } from './store.js';
import { decisionViews, deliveryViews, questionViews, replyWait, requireTask } from './views.js';
import type { AttemptRow } from './views.js';

const ok = { ok: true } as const;
const scopeRequirement = 'Follow the project rules and the scope authorized for this task.';
const implementationWorkspaceRequirement = 'For Git implementation work that requires changes, use a dedicated branch and worktree by default. Preserve uncommitted work in the original checkout. Do not create a branch or worktree for read-only work.';
const resumeWorkspaceRequirement = 'This is the restored conversation, not a new assignment or rework. Continue in the restored working directory unless the user requests a change. Do not replay the previous instruction by default.';

type PreviousWorkspace = AgentContextResponse['workspace']['previous'];

function previousWorkspace(store: Store, attempt: AttemptRow, latest: Delivery | undefined): PreviousWorkspace {
  // 只检查最新交付，不能越过它回到更早的一轮返修。
  const previous = latest && (latest.review === 'rework' || (attempt.kind === 'rework' && latest.review === 'accepted' && gitState(store, attempt.task_id)?.deliveryId === latest.id)) && latest.attemptId !== attempt.id
    ? store.get<AttemptRow>('SELECT * FROM attempts WHERE task_id=? AND id=?', attempt.task_id, latest.attemptId)
    : undefined;
  if (!previous) return attempt.kind === 'rework' ? null : undefined;

  const sameMachine = previous.machine_id === attempt.machine_id;
  const { confirmed_workspace_path: path, confirmed_git_kind: gitKind, confirmed_git_branch: gitBranch,
    confirmed_session_id: sessionId, confirmed_session_file: sessionFile } = previous;
  const workspace = sameMachine && path !== null && gitKind !== null && sessionId !== null && sessionFile !== null
    ? { path, gitKind, gitBranch, sessionId, sessionFile, ...(previous.confirmed_git_root ? { gitRoot: previous.confirmed_git_root } : {}) } : null;
  return { attemptId: previous.id, machineId: previous.machine_id, sameMachine, workspace };
}

export function agentContext(store: Store, attempt: AttemptRow): AgentContextResponse {
  const task = requireTask(store, attempt.task_id);
  const deliveries = deliveryViews(store, task.id);
  const requirements = [scopeRequirement];
  const resumed = attempt.resumed_from_attempt_id !== null;
  const previous = task.type === 'implementation' && !resumed ? previousWorkspace(store, attempt, deliveries.at(-1)) : undefined;
  if (resumed) requirements.push(resumeWorkspaceRequirement);
  else if (task.type === 'implementation') requirements.push(implementationWorkspaceRequirement);
  return { gitSettings: resolvedGitSettings(store, task.id), git: gitState(store, task.id), task: { id: task.id, projectId: task.project_id, type: task.type, title: task.title, goal: task.goal,
    acceptance: task.acceptance, notes: task.notes }, attempt: { id: attempt.id, kind: resumed ? 'resume' : attempt.kind },
  workspace: { path: attempt.workspace_path, requirements, ...(previous === undefined ? {} : { previous }) }, deliveries,
  decisions: decisionViews(store, task.id).filter((decision): decision is typeof decision & { confirmedByUser: true } => decision.confirmedByUser),
  questions: questionViews(store, task.id).filter((question): question is typeof question & { status: 'open' } => question.status === 'open') };
}

export function confirmWorkspace(store: Store, attempt: AttemptRow, workspace: AttemptWorkspace) {
  const task = requireTask(store, attempt.task_id);
  if (task.type !== 'implementation' || task.status !== 'running') {
    reject('conflict', 'Only a running implementation can confirm its workspace');
  }
  confirmGitWorkspace(store, attempt, workspace);
  store.run(`UPDATE attempts SET confirmed_workspace_path=?, confirmed_git_kind=?, confirmed_git_branch=?,
    confirmed_session_id=?, confirmed_session_file=?, session_locator=? WHERE id=?`,
  workspace.path, workspace.gitKind, workspace.gitBranch, workspace.sessionId, workspace.sessionFile,
  JSON.stringify({ path: workspace.path, sessionId: workspace.sessionId, sessionFile: workspace.sessionFile }), attempt.id);
  return ok;
}

export function agentControl(store: Store, attempt: AttemptRow): AgentControlResponse {
  return {
    type: requireTask(store, attempt.task_id).type,
    discussionEndRequested: attempt.discussion_end_requested_at !== null,
    deliverySaved: !!store.get('SELECT 1 FROM deliveries WHERE attempt_id=?', attempt.id),
    waitId: replyWait(store, attempt)?.id ?? null,
  };
}

export function addProgress(store: Store, attempt: AttemptRow, text: string, now: number) {
  store.run('INSERT INTO progress VALUES (?,?,?,?,?)', randomUUID(), attempt.task_id, attempt.id, text, now);
  return ok;
}
export function addQuestion(store: Store, attempt: AttemptRow, input: { text: string; context: string }, now: number) {
  const questionId = randomUUID();
  const task = requireTask(store, attempt.task_id);
  // 只复制当前仍有未关闭问题的等待组，保留首问的计时起点。
  const wait = task.status === 'running' && attempt.discussion_end_requested_at === null
    ? replyWait(store, attempt) ?? { id: questionId, since: now } : undefined;
  store.run(`INSERT INTO questions (id, task_id, attempt_id, text, context, status, created_at, updated_at, wait_id, wait_since)
    VALUES (?,?,?,?,?,'open',?,?,?,?)`, questionId, attempt.task_id, attempt.id, input.text, input.context, now, now,
  wait?.id ?? null, wait?.since ?? null);
  return wait ? { questionId, waitId: wait.id } : { questionId };
}
export function recordReply(store: Store, attempt: AttemptRow, waitId: string) {
  store.run('UPDATE questions SET wait_id=NULL, wait_since=NULL WHERE attempt_id=? AND wait_id=?', attempt.id, waitId);
  return ok;
}
export function updateQuestion(store: Store, attempt: AttemptRow, questionId: string, status: 'resolved' | 'withdrawn', now: number) {
  const question = store.get<{ task_id: string; status: string }>('SELECT task_id, status FROM questions WHERE id=?', questionId);
  if (!question) reject('not_found', 'Question not found');
  // 返修尝试可以处理该任务之前留下的未解决问题。
  if (question.task_id !== attempt.task_id) reject('forbidden', 'Question belongs to a different task');
  if (question.status !== 'open') reject('conflict', 'Question is already closed');
  store.run('UPDATE questions SET status=?, updated_at=? WHERE id=?', status, now, questionId);
  return ok;
}
export function addDecision(store: Store, attempt: AttemptRow, input: { text: string; confirmedByUser: boolean }, now: number) {
  store.run('INSERT INTO decisions VALUES (?,?,?,?,?,?)', randomUUID(), attempt.task_id, attempt.id, input.text, Number(input.confirmedByUser), now);
  return ok;
}
export function deliver(store: Store, attempt: AttemptRow, input: AgentDeliveryRequest, now: number): AgentDeliveryResponse {
  const task = requireTask(store, attempt.task_id);
  if (task.status !== 'running' || store.get('SELECT 1 FROM deliveries WHERE attempt_id=?', attempt.id)) {
    reject('conflict', 'This attempt cannot submit another delivery');
  }
  if (task.type === 'discussion' && attempt.discussion_end_requested_at === null) {
    reject('conflict', 'Discussion must be ended before delivery');
  }
  checkGitDelivery(store, attempt, input);
  const deliveryId = randomUUID();
  const { version } = store.get<{ version: number }>('SELECT COALESCE(MAX(version),0)+1 version FROM deliveries WHERE task_id=?', task.id)!;
  store.run(`INSERT INTO deliveries (id, task_id, attempt_id, version, summary, done, not_covered, verification, how_to,
    issues, base_commit, "commit", report_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  deliveryId, task.id, attempt.id, version, input.summary, JSON.stringify(input.done), JSON.stringify(input.notCovered),
  JSON.stringify(input.verification), JSON.stringify(input.howTo), JSON.stringify(input.issues), input.baseCommit ?? null,
  input.commit ?? null, input.reportRef ?? null, now);
  store.run("UPDATE tasks SET status='review', version=version+1, updated_at=? WHERE id=?", now, task.id);
  store.event(task.id, 'agent', attempt.id, 'delivered', { deliveryId, version, from: 'running', to: 'review' }, now);
  return { deliveryId, version };
}
