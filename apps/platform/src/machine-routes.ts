import { Hono } from 'hono';
import type { Context } from 'hono';
import type { z } from 'zod';
import * as c from '@pi-steward/contract';
import { jsonInput, routeParam } from './app.js';
import { requireMachineAuth } from './auth.js';
import { reject } from './errors.js';
import { foregroundAction, requireForegroundOwner } from './foreground.js';
import { gitDirectives, prepareGit, reportGit } from './git-lifecycle.js';
import { claim, exited, heartbeat, started } from './execution.js';
import { addDecision, addProgress, addQuestion, agentContext, agentControl, confirmWorkspace, deliver, recordReply, updateQuestion } from './reports.js';
import { reportSessionOperation, requireNoPendingSessionOperation, saveAgentSession, sessionDirectives } from './session-control.js';
import type { Store } from './store.js';
import { requestDiscussionEnd } from './tasks.js';
import { ownedAttempt, requireLiveAttempt } from './views.js';
import type { AttemptRow } from './views.js';

const attemptHeader = (context: Context) => {
  const id = context.req.header('X-Steward-Attempt-Id');
  if (!id) reject('unauthorized', 'Attempt credentials required');
  return routeParam(id, c.uuidSchema);
};

export function mountMachineRoutes(store: Store, now: () => number) {
  const api = new Hono();
  const authenticate = (context: Context) => requireMachineAuth(store, context.req.header('Authorization'));
  const launcherWrite = <T extends { requestId: string }, R>(operation: string, input: z.ZodType<T>, output: z.ZodType<R>,
    apply: (machineId: string, body: T, time: number, attempt: AttemptRow, target: string) => R,
    scope?: 'attempt' | 'session', project?: (response: R, machineId: string, time: number) => R) => async (context: Context) => {
    authenticate(context);
    const body = await jsonInput(context, input);
    const target = scope ? routeParam(context.req.param('id'), c.uuidSchema) : '';
    const response = store.immediate(() => {
      const machineId = authenticate(context);
      const attempt = scope === 'attempt' ? ownedAttempt(store, target, machineId) : undefined;
      const time = now();
      const saved = store.request({ machineId, actor: 'launcher', operation, target }, body, time,
        () => output.parse(apply(machineId, body, time, attempt!, target)));
      return project ? output.parse(project(saved, machineId, time)) : saved;
    });
    return context.json(response as object);
  };
  api.post('/launcher/heartbeat', launcherWrite('heartbeat', c.launcherHeartbeatRequestSchema, c.launcherHeartbeatResponseSchema,
    (machineId, body, time) => heartbeat(store, machineId, body, time), undefined, (response, machineId, time) => {
      const issuedGit = new Map(response.gitOperations?.map(({ id, phase }) => [id, phase]));
      response = { ...response, ...(response.gitOperations ? { gitOperations: gitDirectives(store, machineId).filter(({ id, phase }) => issuedGit.get(id) === phase) } : {}) };
      if (!response.sessionOperations) return response;
      // 幂等重放不延长相对权限，也不返回已完成或已转阶段的旧权限。
      const issued = new Map(response.sessionOperations.map(({ id, step }) => [id, step]));
      return { ...response, sessionOperations: sessionDirectives(store, machineId, time)
        .filter(({ id, step }) => issued.get(id) === step) };
    }));
  api.post('/launcher/claim', launcherWrite('claim', c.launcherClaimRequestSchema, c.launcherClaimResponseSchema,
    (machineId, _body, time) => claim(store, machineId, time)));
  api.post('/launcher/attempts/:id/started', launcherWrite('started', c.launcherStartedRequestSchema, c.launcherStartedResponseSchema,
    (_machineId, body, time, attempt) => started(store, attempt, body, time), 'attempt'));
  api.post('/launcher/attempts/:id/exited', launcherWrite('exited', c.launcherExitedRequestSchema, c.launcherExitedResponseSchema,
    (_machineId, body, time, attempt) => exited(store, attempt, body, time), 'attempt'));
  api.post('/launcher/session-operations/:id/report', launcherWrite('session_report', c.launcherSessionReportSchema, c.okResponseSchema,
    (machineId, body, time, _attempt, target) => reportSessionOperation(store, machineId, target, body, time), 'session'));

  api.post('/launcher/git-operations/:id/report', launcherWrite('git_report', c.launcherGitReportSchema, c.okResponseSchema,
    (machineId, body, time, _attempt, target) => reportGit(store, machineId, target, body, time), 'session'));

  api.get('/agent/context', (context) => {
    const machineId = authenticate(context);
    const attempt = ownedAttempt(store, attemptHeader(context), machineId);
    requireLiveAttempt(store, attempt);
    requireForegroundOwner(store, attempt, context.req.header('X-Steward-Owner-Id'), now());
    return context.json(c.agentContextResponseSchema.parse(agentContext(store, attempt)));
  });
  api.get('/agent/control', (context) => {
    const machineId = authenticate(context);
    const attempt = ownedAttempt(store, attemptHeader(context), machineId);
    requireLiveAttempt(store, attempt);
    requireForegroundOwner(store, attempt, context.req.header('X-Steward-Owner-Id'), now());
    return context.json(c.agentControlResponseSchema.parse(agentControl(store, attempt)));
  });
  const agentWrite = <T extends { requestId: string }, R>(operation: string, input: z.ZodType<T>, output: z.ZodType<R>,
    apply: (attempt: AttemptRow, body: T, time: number, questionId: string) => R, questionScoped = false) => async (context: Context) => {
    authenticate(context);
    const attemptId = attemptHeader(context);
    const body = await jsonInput(context, input);
    const questionId = questionScoped ? routeParam(context.req.param('id'), c.uuidSchema) : '';
    const response = store.immediate(() => {
      const machineId = authenticate(context);
      const attempt = ownedAttempt(store, attemptId, machineId);
      const time = now();
      const key = { machineId, actor: 'agent' as const, operation, target: questionScoped ? `${attemptId}/${questionId}` : attemptId };
      if (attempt.execution_mode === 'foreground' && (operation === 'foreground_settle' || operation === 'foreground_interrupt')) {
        if (context.req.header('X-Steward-Owner-Id') !== attempt.owner_id) reject('forbidden', 'Foreground owner credentials required');
        // 关闭回执不授予实施权限；用户先验收/返修也不应让原尝试永远无法结算。
        if (attempt.ended_at !== null) return store.request(key, body, time,
          () => reject('attempt_ended', 'No matching foreground close receipt'));
        requireNoPendingSessionOperation(store, attempt.task_id, time, false, 'session_handover_pending');
        return store.request(key, body, time, () => foregroundAction(store, attempt,
          operation === 'foreground_settle' ? 'settle' : 'interrupt', time));
      }
      requireForegroundOwner(store, attempt, context.req.header('X-Steward-Owner-Id'), time);
      return store.request({ machineId, actor: 'agent', operation, target: questionScoped ? `${attemptId}/${questionId}` : attemptId }, body, time, () => {
        requireLiveAttempt(store, attempt);
        if (operation !== 'session') requireNoPendingSessionOperation(store, attempt.task_id, time, false,
          attempt.execution_mode === 'foreground' ? 'session_handover_pending' : 'conflict');
        return output.parse(apply(attempt, body, time, questionId));
      });
    });
    return context.json(response as object);
  };
  api.post('/agent/foreground/heartbeat', agentWrite('foreground_heartbeat', c.foregroundHeartbeatRequestSchema, c.okResponseSchema,
    (attempt, _body, time) => foregroundAction(store, attempt, 'heartbeat', time)));
  api.post('/agent/foreground/settle', agentWrite('foreground_settle', c.foregroundSettleRequestSchema, c.okResponseSchema,
    (attempt, _body, time) => foregroundAction(store, attempt, 'settle', time)));
  api.post('/agent/foreground/interrupt', agentWrite('foreground_interrupt', c.foregroundInterruptRequestSchema, c.okResponseSchema,
    (attempt, _body, time) => foregroundAction(store, attempt, 'interrupt', time)));
  api.post('/agent/git/prepare', agentWrite('git_prepare', c.agentPrepareGitRequestSchema, c.agentPrepareGitResponseSchema,
    (attempt, body) => prepareGit(store, attempt, body)));
  api.post('/agent/session', agentWrite('session', c.agentSessionRequestSchema, c.okResponseSchema,
    (attempt, body, time) => saveAgentSession(store, attempt, body.locator, time)));
  api.post('/agent/workspace', agentWrite('workspace', c.agentWorkspaceRequestSchema, c.okResponseSchema,
    (attempt, body) => confirmWorkspace(store, attempt, body.workspace)));
  api.post('/agent/progress', agentWrite('progress', c.agentProgressRequestSchema, c.agentProgressResponseSchema,
    (attempt, body, time) => addProgress(store, attempt, body.text, time)));
  api.post('/agent/questions', agentWrite('create_question', c.agentCreateQuestionRequestSchema, c.agentCreateQuestionResponseSchema,
    (attempt, body, time) => addQuestion(store, attempt, body, time)));
  api.patch('/agent/questions/:id', agentWrite('update_question', c.agentUpdateQuestionRequestSchema, c.agentUpdateQuestionResponseSchema,
    (attempt, body, time, questionId) => updateQuestion(store, attempt, questionId, body.status, time), true));
  api.post('/agent/reply', agentWrite('reply', c.agentReplyRequestSchema, c.okResponseSchema,
    (attempt, body) => recordReply(store, attempt, body.waitId)));
  api.post('/agent/end-discussion', agentWrite('end_discussion', c.agentEndDiscussionRequestSchema, c.okResponseSchema,
    (attempt, _body, time) => {
      requestDiscussionEnd(store, attempt.task_id, attempt.id, 'agent', time);
      return { ok: true };
    }));
  api.post('/agent/decisions', agentWrite('decision', c.agentDecisionRequestSchema, c.agentDecisionResponseSchema,
    (attempt, body, time) => addDecision(store, attempt, body, time)));
  api.post('/agent/deliveries', agentWrite('delivery', c.agentDeliveryRequestSchema, c.agentDeliveryResponseSchema,
    (attempt, body, time) => deliver(store, attempt, body, time)));
  return api;
}
