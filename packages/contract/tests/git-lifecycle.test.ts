import { describe, expect, it } from 'vitest';
import * as c from '../src/index.js';

const requestId = '12345678-1234-4123-8123-123456789abc';

describe('任务基准与 Git 生命周期契约', () => {
  it.each(['main', 'develop', 'release/2.0', 'feature/261126-任务'])('接受分支名称 %s', (branch) => {
    expect(c.gitBranchSchema.parse(branch)).toBe(branch);
  });

  it.each(['', '-main', '/main', 'main/', 'main.', 'a..b', 'a//b', '.hidden', 'a/.hidden',
    'a.lock', 'x/y.lock', '@', 'a@{1}', 'a b', 'a\nb', 'a\0b', 'a:b', 'a?b', 'a[b', 'a\\b', 'a~b', 'a^b', 'a*b'])
  ('拒绝危险或无效分支 %j', (branch) => {
    expect(c.gitBranchSchema.safeParse(branch).success).toBe(false);
  });

  it('新旧任务输入兼容，任务可覆盖或清除基准分支', () => {
    expect(c.webCreateTaskRequestSchema.parse({ title: '旧任务', projectId: 'repo' })).not.toHaveProperty('baseBranch');
    expect(c.webCreateTaskRequestSchema.parse({ title: '版本修复', projectId: 'repo', baseBranch: 'release/2.0' }).baseBranch)
      .toBe('release/2.0');
    expect(c.webUpdateTaskRequestSchema.parse({ version: 1, baseBranch: null }).baseBranch).toBeNull();
    expect(c.managedUpdateTaskRequestSchema.parse({ version: 1, requestId, sessionId: 'session', baseBranch: 'develop' }).baseBranch)
      .toBe('develop');
    expect(c.managedUpdateTaskRequestSchema.safeParse({ version: 1, requestId, sessionId: 'session' }).success).toBe(false);
  });

  it('没有上游与同步失败不是同一种可跳过结果', () => {
    expect(c.gitSyncResultSchema.parse('no_upstream')).toBe('no_upstream');
    expect(c.gitSyncResultSchema.safeParse('network_error').success).toBe(false);
    expect(c.gitSyncResultSchema.safeParse('diverged').success).toBe(false);
  });

  it('已有项目可以保持未配置，但必须显式给出版本和同步选择', () => {
    expect(c.projectGitSettingsSchema.parse({ baseBranch: null, syncBeforeStart: true, version: 1 }).baseBranch).toBeNull();
    expect(c.webUpdateProjectGitRequestSchema.safeParse({ baseBranch: 'main', version: 1 }).success).toBe(false);
    expect(c.webUpdateProjectGitRequestSchema.safeParse({ baseBranch: 'main', syncBeforeStart: true, version: 1, force: true }).success)
      .toBe(false);
  });

  it('精确版本只接受完整提交哈希，不接受可移动引用或缩写', () => {
    expect(c.gitCommitSchema.parse('a'.repeat(40))).toHaveLength(40);
    expect(c.gitCommitSchema.parse('b'.repeat(64))).toHaveLength(64);
    for (const ref of ['HEAD', 'main', 'abc1234', 'A'.repeat(40), '--all']) {
      expect(c.gitCommitSchema.safeParse(ref).success).toBe(false);
    }
  });

  it('旧启动器响应不必含 Git 指令，新指令不会放宽普通任务状态枚举', () => {
    expect(c.launcherHeartbeatResponseSchema.parse({ directives: [] })).toEqual({ directives: [] });
    expect(c.launcherHeartbeatResponseSchema.parse({ directives: [], gitOperations: [] }).gitOperations).toEqual([]);
    expect(c.taskGitPhaseSchema.parse('awaiting_merge')).toBe('awaiting_merge');
    expect(c.taskStatusSchema.safeParse('awaiting_merge').success).toBe(false);
  });
});
