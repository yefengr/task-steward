import { randomUUID } from 'node:crypto';
import type { AgentContextResponse, AgentControlResponse, AgentDeliveryRequest, AgentDeliveryResponse } from '@pi-steward/contract';
import { reject } from './errors.js';
import type { Store } from './store.js';
import { decisionViews, deliveryViews, questionViews, replyWait, requireTask } from './views.js';
import type { AttemptRow } from './views.js';

const ok = { ok: true } as const;
const workspaceRequirements = [
  'Follow the project rules and the scope authorized for this task.',
  'For Git projects, use a dedicated branch and worktree by default. Preserve uncommitted work in the original checkout.',
];

export function agentContext(store: Store, attempt: AttemptRow): AgentContextResponse {
  const task = requireTask(store, attempt.task_id);
  return { task: { id: task.id, projectId: task.project_id, type: task.type, title: task.title, goal: task.goal,
    acceptance: task.acceptance, notes: task.notes }, attempt: { id: attempt.id, kind: attempt.kind },
  workspace: { path: attempt.workspace_path, requirements: workspaceRequirements }, deliveries: deliveryViews(store, task.id),
  decisions: decisionViews(store, task.id).filter((decision): decision is typeof decision & { confirmedByUser: true } => decision.confirmedByUser),
  questions: questionViews(store, task.id).filter((question): question is typeof question & { status: 'open' } => question.status === 'open') };
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
