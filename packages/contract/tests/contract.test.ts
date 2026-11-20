import { describe, expect, it } from 'vitest';
import { agentSchema, errorCodeSchema, errorResponseSchema, taskStatusSchema } from '../src/index.js';

describe('共享枚举与错误响应', () => {
  it('区分任务状态与页面标记', () => {
    expect(taskStatusSchema.parse('queued')).toBe('queued');
    expect(taskStatusSchema.safeParse('needs_verification').success).toBe(false);
  });

  it('保存两种 Agent 类型', () => {
    expect(agentSchema.parse('pi')).toBe('pi');
    expect(agentSchema.parse('claude')).toBe('claude');
    expect(agentSchema.safeParse('other').success).toBe(false);
  });

  it('校验标准错误响应', () => {
    expect(errorCodeSchema.parse('conflict')).toBe('conflict');
    expect(errorResponseSchema.safeParse({ error: { code: 'conflict', message: '状态冲突' } }).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { code: 'unknown', message: '未知错误' } }).success).toBe(false);
  });
});
