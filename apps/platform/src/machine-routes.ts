import { Hono } from 'hono';
import type { Context } from 'hono';
import type { z } from 'zod';
import * as c from '@pi-steward/contract';
import { jsonInput, routeParam } from './app.js';
import { requireMachineAuth } from './auth.js';
import { reject } from './errors.js';
import { claim, exited, heartbeat, started } from './execution.js';
import { addDecision, addProgress, addQuestion, agentContext, agentControl, deliver, recordReply, updateQuestion } from './reports.js';
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
    apply: (machineId: string, body: T, time: number, attempt: AttemptRow) => R, attemptScoped = false) => async (context: Context) => {
    authenticate(context);
    const body = await jsonInput(context, input);
    const target = attemptScoped ? routeParam(context.req.param('id'), c.uuidSchema) : '';
    const response = store.immediate(() => {
      const machineId = authenticate(context);
      const attempt = attemptScoped ? ownedAttempt(store, target, machineId) : undefined;
      const time = now();
      return store.request({ machineId, actor: 'launcher', operation, target }, body, time,
        () => output.parse(apply(machineId, body, time, attempt!)));
    });
    return context.json(response as object);
  };
  api.post('/launcher/heartbeat', launcherWrite('heartbeat', c.launcherHeartbeatRequestSchema, c.launcherHeartbeatResponseSchema,
    (machineId, body, time) => heartbeat(store, machineId, body, time)));
  api.post('/launcher/claim', launcherWrite('claim', c.launcherClaimRequestSchema, c.launcherClaimResponseSchema,
    (machineId, _body, time) => claim(store, machineId, time)));
  api.post('/launcher/attempts/:id/started', launcherWrite('started', c.launcherStartedRequestSchema, c.launcherStartedResponseSchema,
    (_machineId, body, time, attempt) => started(store, attempt, body, time), true));
  api.post('/launcher/attempts/:id/exited', launcherWrite('exited', c.launcherExitedRequestSchema, c.launcherExitedResponseSchema,
    (_machineId, body, time, attempt) => exited(store, attempt, body, time), true));

  api.get('/agent/context', (context) => {
    const machineId = authenticate(context);
    const attempt = ownedAttempt(store, attemptHeader(context), machineId);
    requireLiveAttempt(store, attempt);
    return context.json(c.agentContextResponseSchema.parse(agentContext(store, attempt)));
  });
  api.get('/agent/control', (context) => {
    const machineId = authenticate(context);
    const attempt = ownedAttempt(store, attemptHeader(context), machineId);
    requireLiveAttempt(store, attempt);
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
      return store.request({ machineId, actor: 'agent', operation, target: questionScoped ? `${attemptId}/${questionId}` : attemptId }, body, time, () => {
        requireLiveAttempt(store, attempt);
        return output.parse(apply(attempt, body, time, questionId));
      });
    });
    return context.json(response as object);
  };
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
