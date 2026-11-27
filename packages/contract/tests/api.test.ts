import { expect, it } from 'vitest';
import * as c from '../src/index.js';

const id = '12345678-1234-4123-8123-123456789abc';
const tmuxSession = `steward-${id}`;
const request = { requestId: id };
const code = 'A123B456C7';
const token = `stm_${'A'.repeat(43)}`;
const tokenHash = 'a'.repeat(64);
const ok = { ok: true };
const projectId = 'pi-steward';
const taskContent = { title: '标题', goal: '', acceptance: '', notes: '', agent: 'pi', machineId: null, type: 'implementation',
  priority: 'normal', difficulty: 'unassessed' };
const task = { ...taskContent, id, projectId, status: 'queued', reworkPending: false, position: 1, createdBy: 'user',
  version: 1, createdAt: 100, updatedAt: 200, waiting: null, needsVerification: false, needsResponse: false };
const attempt = { id, taskId: id, machineId: id, machineName: 'Mac', agent: 'pi', kind: 'new', sessionId: tmuxSession,
  tmuxSession: null, claimedAt: 100, startedAt: null, leaseExpiresAt: 200, cancelRequested: false,
  endedAt: null, exitCode: null, result: null, needsVerification: false };
const deliveryContent = { summary: '交付', done: ['完成'], notCovered: [], verification: [], howTo: [], issues: [], commit: 'result' };
const delivery = { ...deliveryContent, id, taskId: id, attemptId: id, version: 1, review: null, feedback: null, reviewedAt: null, createdAt: 100 };
const progress = { id, taskId: id, attemptId: id, text: '说明', createdAt: 100 };
const decision = { ...progress, confirmedByUser: true };
const question = { ...progress, context: '背景', status: 'open', updatedAt: 100 };
const event = { id, taskId: id, attemptId: null, actor: 'user', kind: 'scheduled', payload: { to: 'queued' }, createdAt: 100 };
const project = { id: projectId, name: 'Steward', lastMachineId: null, createdAt: 100,
  counts: { unscheduled: 0, queued: 1, running: 0, review: 0, done: 0, interrupted: 0, cancelled: 0 } };
const machine = { id, name: 'Mac', online: true, slots: 1, occupiedSlots: 0, lastSeenAt: 100, launcherVersion: 'test', revokedAt: null,
  projects: [{ id: projectId, name: project.name }], activeTasks: [] };
const claimed = { id, taskId: id, projectId, agent: 'pi', sessionId: tmuxSession, restoreSession: false, displayName: '标题', kind: 'new' };
const projectRegistration = { id: projectId, name: project.name, path: '/work/项目' };
const heartbeat = { ...request, launcherVersion: 'test', slots: 1, projects: [projectRegistration], attempts: [{ id, tmuxSession, running: true }] };
const locator = { path: '/work/linked', sessionId: id, sessionFile: '/work/sessions/test.jsonl' };
const workspace = { ...locator, gitKind: 'linked', gitBranch: 'feature/test' };
const sessionOperation = { id, attemptId: id, mode: 'restart' };
const context = { task: { id, projectId, title: task.title, goal: '', acceptance: '', notes: '' }, attempt: { id, kind: 'new' },
  workspace: { path: projectRegistration.path, requirements: ['按项目规范执行'] }, decisions: [decision], deliveries: [delivery], questions: [question] };

it('返修领取携带实际 Pi ID 与精确 locator，仍兼容首次领取', () => {
  expect(c.claimedAttemptSchema.parse(claimed)).toEqual(claimed);
  const rework = { ...claimed, kind: 'rework', restoreSession: true, sessionId: locator.sessionId, sessionLocator: locator };
  expect(c.claimedAttemptSchema.parse(rework)).toEqual(rework);
  expect(c.claimedAttemptSchema.safeParse({ ...rework, sessionLocator: { ...locator, path: 'relative' } }).success).toBe(false);
});

const gitSettings = { baseBranch: 'main', syncBeforeStart: true, version: 1 };
const gitState = { baseBranch: 'main', baseCommit: 'a'.repeat(40), taskBranch: 'feature/task',
  repositoryPath: '/work/repo', worktreePath: '/work/linked', machineId: id,
  syncBeforeStart: true, syncResult: 'no_upstream', phase: 'ready', operationId: null, deliveryId: null,
  approvedCommit: null, mergedCommit: null, message: null };
const gitPrepare = { ...request, baseBranch: gitState.baseBranch, baseCommit: gitState.baseCommit,
  taskBranch: gitState.taskBranch, repositoryPath: gitState.repositoryPath, syncBeforeStart: true, syncResult: 'no_upstream' };
const gitOperation = { id, taskId: id, projectId, deliveryId: id, baseBranch: gitState.baseBranch,
  baseCommit: gitState.baseCommit, taskBranch: gitState.taskBranch, repositoryPath: gitState.repositoryPath,
  worktreePath: gitState.worktreePath, approvedCommit: 'b'.repeat(40), mergedCommit: null, phase: 'merge' };

type SchemaName = Extract<keyof typeof c, `${string}Schema`>;
const samples = {
  agentSchema: ['pi', 'other'], taskStatusSchema: ['review', 'needs_verification'], errorCodeSchema: ['conflict', 'unknown'],
  errorResponseSchema: [{ error: { code: 'forbidden', message: 'Denied' } }, { error: { code: 'unknown', message: 'Failure' } }],
  uuidSchema: [id, projectId], projectIdSchema: [projectId, '../project'], timestampSchema: [0, -1],
  textSchema: ['', null], nonEmptyTextSchema: ['正文', '\n '], machineTokenSchema: [`stm_${'A'.repeat(43)}`, 'stm_short'],
  tmuxSessionSchema: [tmuxSession, 'another-session'], emptyRequestSchema: [{}, { extra: true }],
  okResponseSchema: [ok, { ok: false }], requestIdSchema: [request, { requestId: '' }],
  taskPrioritySchema: ['high', 'urgent'], taskDifficultySchema: ['complex', 'hard'],
  taskTypeSchema: ['discussion', 'chat'], titleSchema: [' 标题 ', ' '], attemptKindSchema: ['resume', 'retry'], attemptResultSchema: ['delivered', 'done'],
  waitingReasonSchema: ['previous_attempt_active', 'rework'], questionStatusSchema: ['open', 'unknown'], slotsSchema: [0, -1],
  taskContentSchema: [taskContent, { ...taskContent, machineId: '' }], taskSchema: [task, { ...task, needsVerification: 'yes' }],
  attemptSchema: [attempt, { ...attempt, leaseExpiresAt: null }], deliveryContentSchema: [deliveryContent, { ...deliveryContent, done: '完成' }],
  deliverySchema: [delivery, { ...delivery, version: 0 }], decisionSchema: [decision, { ...decision, confirmedByUser: 1 }],
  progressSchema: [progress, { ...progress, text: '' }], questionSchema: [question, { ...question, status: 'cancelled' }],
  taskEventSchema: [event, { ...event, actor: 'machine' }],
  gitBranchSchema: ['release/2.0', '--all'], gitCommitSchema: ['a'.repeat(40), 'shortsha'],
  gitPathSchema: ['/work/linked', '../linked'], gitSyncResultSchema: ['no_upstream', 'failed_but_skipped'],
  projectGitSettingsSchema: [gitSettings, { ...gitSettings, version: 0 }],
  webUpdateProjectGitRequestSchema: [gitSettings, { ...gitSettings, baseBranch: '-main' }],
  webProjectGitResponseSchema: [{ settings: gitSettings }, gitSettings],
  resolvedGitSettingsSchema: [{ baseBranch: null, syncBeforeStart: true }, { baseBranch: 'main' }],
  taskGitPhaseSchema: ['cleanup_blocked', 'done'], taskGitSchema: [gitState, { ...gitState, approvedCommit: 'result' }],
  agentPrepareGitRequestSchema: [gitPrepare, { ...gitPrepare, baseCommit: 'base' }],
  agentPrepareGitResponseSchema: [{ git: gitState }, { git: { ...gitState, phase: 'done' } }],
  launcherGitOperationSchema: [gitOperation, { ...gitOperation, approvedCommit: 'HEAD' }],
  launcherGitReportSchema: [{ ...request, outcome: 'merged', mergedCommit: 'b'.repeat(40) }, { ...request, outcome: 'forced' }],
  webLoginRequestSchema: [{ password: 'schema-only' }, { password: '' }], webLoginResponseSchema: [ok, {}],
  webLogoutRequestSchema: [{}, { extra: true }], webLogoutResponseSchema: [ok, {}],
  webMeResponseSchema: [{ authenticated: false }, { authenticated: 0 }], webProjectSchema: [project, { ...project, counts: {} }],
  webProjectsResponseSchema: [{ projects: [project] }, [project]], webProjectTasksResponseSchema: [{ tasks: [task] }, { tasks: null }],
  webTaskDetailResponseSchema: [{ task, progress: [progress], decisions: [decision], questions: [question], deliveries: [delivery],
    attempts: [attempt], events: [event] }, { task }],
  webCreateTaskRequestSchema: [{ title: '先记标题', projectId }, { title: '缺少项目' }],
  webUpdateTaskRequestSchema: [{ version: 1, machineId: null }, { version: 1 }], webTaskMutationResponseSchema: [{ task }, task],
  managedCreateTaskRequestSchema: [{ ...request, sessionId: id, projectId, title: '待办' },
    { ...request, sessionId: id, projectId, title: '待办', status: 'queued' }],
  managedUpdateTaskRequestSchema: [{ ...request, sessionId: id, version: 1, notes: '' },
    { ...request, sessionId: id, version: 1 }],
  webTaskActionRequestSchema: [{}, { unexpected: 1 }], webEndDiscussionRequestSchema: [{ attemptId: id }, {}],
  webAcceptRequestSchema: [{ deliveryId: id }, { deliveryId: 'invalid' }],
  webReworkRequestSchema: [{ deliveryId: id, feedback: '补充验证' }, { deliveryId: id, feedback: ' ' }],
  webMachineSchema: [machine, { ...machine, occupiedSlots: -1 }], webMachinesResponseSchema: [{ machines: [machine] }, [machine]],
  launcherHeartbeatRequestSchema: [heartbeat, { ...heartbeat, projects: [projectRegistration, projectRegistration] }],
  launcherHeartbeatResponseSchema: [{ directives: [{ attemptId: id, tmuxSession, action: 'unknown' }] }, { directives: [{ attemptId: id, tmuxSession, action: 'stop' }] }],
  launcherClaimRequestSchema: [request, { ...request, slots: 1 }], claimedAttemptSchema: [claimed, { ...claimed, agent: 'claude' }],
  launcherClaimResponseSchema: [{ attempt: null }, { attempt: { ...claimed, firstMessage: 'unexpected' } }],
  launcherStartedRequestSchema: [{ ...request, tmuxSession, startedAt: 100 }, { ...request, tmuxSession }],
  launcherExitedRequestSchema: [{ ...request, exitCode: null, endedAt: 100 }, { ...request, endedAt: 100, exitCode: '0' }],
  launcherStartedResponseSchema: [ok, {}], launcherExitedResponseSchema: [ok, {}],
  absoluteWorkspacePathSchema: [locator.path, './work'], piSessionIdSchema: [id, '../../test'],
  piSessionLocatorSchema: [locator, { ...locator, machineId: id }],
  agentSessionRequestSchema: [{ ...request, locator }, { ...request, locator: { ...locator, sessionId: null } }],
  sessionOperationModeSchema: ['restart', 'reschedule'], sessionOperationFailureSchema: ['session_launch_failed', 'unknown'],
  webSessionOperationSchema: [{ ...sessionOperation, status: 'pending', failure: null }, { ...sessionOperation, status: 'pending' }],
  webSessionOperationRequestSchema: [{ ...request, attemptId: id, mode: 'restore' }, { ...request, mode: 'restore', locator }],
  launcherSessionDirectiveSchema: [{ ...sessionOperation, step: 'launch', locator, validForMs: 100, replacementId: id },
    { ...sessionOperation, step: 'launch', locator, validForMs: 0, replacementId: id }],
  launcherSessionReportSchema: [{ ...request, step: 'stop', result: 'stopped' }, { ...request, step: 'launch', result: 'stopped' }],
  attemptWorkspaceSchema: [workspace, { ...workspace, sessionFile: 'relative.jsonl' }],
  agentWorkspaceRequestSchema: [{ ...request, workspace }, { ...request, workspace: { ...workspace, machineId: id } }],
  agentContextResponseSchema: [context, { ...context, decisions: [{ ...decision, confirmedByUser: false }] }],
  agentControlResponseSchema: [{ type: 'discussion', discussionEndRequested: false, deliverySaved: false, waitId: null }, { type: 'discussion' }],
  agentEndDiscussionRequestSchema: [request, { ...request, text: '禁止同步' }],
  agentReplyRequestSchema: [{ ...request, waitId: id }, { ...request, waitId: id, text: '禁止同步' }],
  agentProgressRequestSchema: [{ ...request, text: '进展' }, { ...request, text: ' ' }], agentProgressResponseSchema: [ok, {}],
  agentCreateQuestionRequestSchema: [{ ...request, text: '问题', context: '' }, { ...request, text: '问题' }],
  agentCreateQuestionResponseSchema: [{ questionId: id }, { id }],
  agentUpdateQuestionRequestSchema: [{ ...request, status: 'withdrawn' }, { ...request, status: 'open' }], agentUpdateQuestionResponseSchema: [ok, {}],
  agentDecisionRequestSchema: [{ ...request, text: '决定', confirmedByUser: false }, { ...request, text: '决定' }], agentDecisionResponseSchema: [ok, {}],
  agentDeliveryRequestSchema: [{ ...request, ...deliveryContent }, deliveryContent],
  agentDeliveryResponseSchema: [{ deliveryId: id, version: 1 }, { deliveryId: id, version: 0 }],
  taskOriginSchema: ['foreground', 'agent'], executionModeSchema: ['foreground', 'user'],
  processIdSchema: [12345, 1], foregroundOwnerSchema: [{ goalId: id, pid: 12345 }, { goalId: id, pid: -1 }],
  foregroundBindingSchema: [{ goalId: id, pid: 12345, taskId: id, attemptId: id }, { goalId: id, pid: 12345 }],
  foregroundStartRequestSchema: [{ ...request, goalId: id, ownerId: id, pid: 12345, projectId, projectName: 'Steward',
    registeredPath: '/work/repo', title: '前台目标', goal: '', acceptance: '', notes: '', type: 'discussion', locator },
  { ...request, goalId: id, ownerId: id, pid: 12345, projectId, title: '缺项目定位' }],
  foregroundStartResponseSchema: [{ binding: { goalId: id, pid: 12345, taskId: id, attemptId: id } }, { binding: null }],
  foregroundLookupResponseSchema: [{ binding: null }, { binding: { goalId: id, ownerId: id } }],
  foregroundHeartbeatRequestSchema: [request, {}], foregroundSettleRequestSchema: [request, { ...request, force: true }],
  foregroundInterruptRequestSchema: [request, {}],
  lifecyclePhaseSchema: ['settled', 'terminated'],
  taskLifecycleSchema: [{ phase: 'paused', acceptedAt: null, message: null }, { phase: 'paused' }],
  workPermissionSchema: [{ workRevision: 1, settled: true, implementationAllowed: false, recordAllowed: true }, { workRevision: -1 }],
  agentSettleRequestSchema: [request, { ...request, force: true }],
  agentContinueRequestSchema: [{ ...request, deliveryId: id, reason: '用户要求续做', authorizedByUser: true },
    { ...request, deliveryId: id, reason: '无明确授权', authorizedByUser: false }],
  agentContinueResponseSchema: [{ workRevision: 1 }, { workRevision: -1 }],
  agentDeliveryRevisionRequestSchema: [{ ...request, ...deliveryContent, deliveryId: id, reason: '补已有验证结果', authorizedByUser: true },
    { ...request, ...deliveryContent, deliveryId: id, authorizedByUser: true }],
  pairingCodeSchema: [code, code.toLowerCase()],
  createPairingRequestSchema: [{ name: 'Mac', tokenHash }, { name: 'Mac', tokenHash, machineToken: token }],
  createPairingResponseSchema: [{ code, expiresAt: 100 }, { code, expiresAt: -1 }],
  pairingStatusRequestSchema: [{ machineToken: token }, { tokenHash }],
  pairingStatusResponseSchema: [{ status: 'approved' }, { status: 'missing' }],
  webPairingRequestSchema: [{ code }, { code, name: 'Mac' }],
  webPairingResponseSchema: [{ name: 'Mac', expiresAt: 100 }, { name: '\n', expiresAt: 100 }],
  webApprovePairingResponseSchema: [{ machineId: id, name: 'Mac' }, { machineId: '', name: 'Mac' }],
  platformProxySchema: [{ mode: 'custom', url: 'http://127.0.0.1:7890' }, { mode: 'custom', url: 'http://user:pass@proxy.example:80' }],
  localConfigSchema: [{ platformUrl: 'https://steward.example', machineToken: `stm_${'A'.repeat(43)}`,
    slots: 1, projects: [projectRegistration], pi: { command: 'pi', extraArgs: [] }, path: ['/usr/bin'] },
  { platformUrl: 'http://steward.example', machineToken: `stm_${'A'.repeat(43)}`,
    slots: 1, projects: [projectRegistration], pi: { command: 'pi', extraArgs: [] }, path: ['/usr/bin'] }],
} satisfies Record<SchemaName, [unknown, unknown]>;

it.each(['https://proxy.example:7890', 'http://proxy.example', 'http://proxy.example:65536',
  'http://proxy.example:7890/path', 'http://proxy.example:7890?flag', 'http://proxy.example:7890#flag'])('拒绝不支持的代理地址 %s', (url) => {
  expect(c.platformProxySchema.safeParse({ mode: 'custom', url }).success).toBe(false);
});

it.each(['system', 'direct'] as const)('接受代理模式 %s', (mode) => {
  expect(c.platformProxySchema.safeParse({ mode }).success).toBe(true);
});

it.each(Object.entries(samples))('%s 接受合法样例并拒绝非法样例', (name, [valid, invalid]) => {
  const schema = c[name as SchemaName];
  expect(schema.safeParse(valid).success).toBe(true);
  expect(schema.safeParse(invalid).success).toBe(false);
});
