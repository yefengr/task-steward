import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { launcherGitOperationSchema, launcherGitReportSchema, claimedAttemptSchema, launcherExitedRequestSchema, launcherSessionReportSchema, launcherStartedRequestSchema, timestampSchema, tmuxSessionSchema, uuidSchema } from '@pi-steward/contract';

const execution = z.strictObject({
  id: uuidSchema,
  target: tmuxSessionSchema,
  phase: z.enum(['prepared', 'launching', 'observed', 'exited']),
  claim: claimedAttemptSchema.optional(),
  startedAt: timestampSchema.optional(),
  pid: z.int().min(2).max(0x7fffffff).optional(),
  sessionOperationId: uuidSchema.optional(),
}).refine(({ id, target, phase, claim, startedAt }) => target === `steward-${id}` &&
  (!claim || claim.id === id) &&
  (phase !== 'prepared' || !!claim) && (phase !== 'launching' || startedAt !== undefined));
const event = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), id: uuidSchema, body: launcherStartedRequestSchema }),
  z.strictObject({ kind: z.literal('exited'), id: uuidSchema, body: launcherExitedRequestSchema }),
]);
const sessionOperation = z.strictObject({
  id: uuidSchema,
  attemptId: uuidSchema,
  replacementId: uuidSchema.optional(),
  step: z.enum(['stop', 'launch', 'cleanup']),
  stopIssued: z.boolean().optional(),
  launchIssued: z.boolean().optional(),
  report: launcherSessionReportSchema.optional(),
  reportAcknowledged: z.boolean().optional(),
}).refine(({ step, replacementId, report }) => (step === 'stop') === (replacementId === undefined) &&
  (!report || report.step === step));
const gitOperation = z.strictObject({
  operation: launcherGitOperationSchema,
  mergeIssued: z.boolean().optional(), merged: z.boolean().optional(), mergeAcknowledged: z.boolean().optional(),
  cleanupIssued: z.boolean().optional(), worktreeRemoved: z.boolean().optional(), cleaned: z.boolean().optional(),
  report: launcherGitReportSchema.optional(), reportAcknowledged: z.boolean().optional(),
  reportRejected: z.boolean().optional(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  claimRequestId: uuidSchema.optional(),
  lastHeartbeatAt: timestampSchema.optional(),
  executions: z.array(execution),
  gitOperations: z.array(gitOperation).optional(),
  sessionOperations: z.array(sessionOperation).optional(),
  outbox: z.array(event),
});

export type GitOperation = z.infer<typeof gitOperation>;
export type State = z.infer<typeof stateSchema>;
export type Execution = z.infer<typeof execution>;
export type SessionOperation = z.infer<typeof sessionOperation>;
export type Event = z.infer<typeof event>;

export function loadState(path: string): State {
  try {
    return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, executions: [], outbox: [] };
    throw new Error('本地启动器状态不可读取。请保留原文件供核对。');
  }
}

export function saveState(path: string, state: State) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function acquireRunLock(statePath: string, message = '无法取得启动器锁，请确认只有一个 run 实例。') {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  closeSync(openSync(lockPath, 'a', 0o600));
  const db = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    // SQLite 事务锁由系统在进程退出时释放，进程崩溃后无需清除旧锁文件。
    db.exec('BEGIN IMMEDIATE');
  } catch {
    db.close();
    throw new Error(message);
  }
  return () => db.close();
}
