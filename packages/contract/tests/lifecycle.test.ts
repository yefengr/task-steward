import { describe, expect, it } from 'vitest';
import * as c from '../src/index.js';

const id = '12345678-1234-4123-8123-123456789abc';
const base = { requestId: id, deliveryId: id, reason: '用户明确授权', authorizedByUser: true };

describe('工作段与交付权限契约', () => {
  it('实质续做必须绑定确切交付、原因和明确授权，不能带提权开关', () => {
    expect(c.agentContinueRequestSchema.parse(base)).toEqual(base);
    for (const invalid of [{ ...base, deliveryId: 'latest' }, { ...base, reason: ' ' },
      { ...base, authorizedByUser: false }, { ...base, force: true }]) {
      expect(c.agentContinueRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('仅补记录要求完整交付并独立绑定旧版，不能误当普通交付请求', () => {
    const report = { summary: '补充已取得的结果', done: [], notCovered: [], verification: ['已有测试记录'], howTo: [], issues: [] };
    expect(c.agentDeliveryRevisionRequestSchema.safeParse({ ...base, ...report }).success).toBe(true);
    expect(c.agentDeliveryRequestSchema.safeParse({ ...base, ...report }).success).toBe(false);
    expect(c.agentDeliveryRevisionRequestSchema.safeParse({ ...base, summary: '缺少验证及遗留说明' }).success).toBe(false);
  });

  it('控制投影区分实施、记录和已结算，但不会把控制字段当成授权请求', () => {
    const control = { type: 'implementation', discussionEndRequested: false, deliverySaved: true, waitId: null,
      phase: 'settled', workRevision: 2, settled: true, implementationAllowed: false, recordAllowed: true,
      latestDeliveryId: id, closeRequested: false, pauseRequested: false };
    expect(c.agentControlResponseSchema.parse(control)).toEqual(control);
    expect(c.agentSettleRequestSchema.safeParse({ requestId: id, implementationAllowed: true }).success).toBe(false);
    expect(c.workPermissionSchema.safeParse({ workRevision: 0.5 }).success).toBe(false);
  });

  it.each(['pause', 'continue', 'finalize'] as const)('沿用精确会话操作协议 %s', (mode) => {
    expect(c.webSessionOperationRequestSchema.parse({ requestId: id, attemptId: id, mode }).mode).toBe(mode);
    expect(c.launcherSessionDirectiveSchema.safeParse({ id, attemptId: id, mode, step: 'stop', sourceEnded: false,
      validForMs: 1000, locator: { path: '/work/task', sessionId: id, sessionFile: '/work/sessions/task.jsonl' } }).success).toBe(true);
  });

  it.each(['pause', 'finalize'] as const)('%s 不授予启动替代进程或清理替代进程的权限', (mode) => {
    const operation = { id, attemptId: id, mode, replacementId: id };
    expect(c.launcherSessionDirectiveSchema.safeParse({ ...operation, step: 'cleanup' }).success).toBe(false);
    expect(c.launcherSessionDirectiveSchema.safeParse({ ...operation, step: 'launch', validForMs: 100,
      locator: { path: '/work/task', sessionId: id, sessionFile: '/work/task.jsonl' } }).success).toBe(false);
  });

  it('保留Pi与后台槽位是独立事实，旧响应也可以解析', () => {
    const directive = { attemptId: id, tmuxSession: `steward-${id}`, action: 'continue' };
    expect(c.launcherHeartbeatResponseSchema.parse({ directives: [directive] }).directives[0]).not.toHaveProperty('occupiesSlot');
    expect(c.launcherHeartbeatResponseSchema.parse({ directives: [{ ...directive, occupiesSlot: false, workSettled: true }] })
      .directives[0]).toMatchObject({ occupiesSlot: false, workSettled: true });
  });
});
