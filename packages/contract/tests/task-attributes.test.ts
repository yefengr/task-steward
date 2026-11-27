import { expect, it } from 'vitest';
import * as c from '../src/index.js';

it('属性枚举严格校验；响应兼容旧端，部分请求不注入默认值', () => {
  const old = { id: '00000000-0000-4000-8000-000000000001', projectId: 'project', title: 'Task', goal: '', acceptance: '', notes: '',
    agent: 'pi', machineId: null, status: 'unscheduled', reworkPending: false, position: 1, createdBy: 'user',
    version: 1, createdAt: 100, updatedAt: 100, waiting: null, needsVerification: false, needsResponse: false };
  expect(c.taskSchema.parse(old)).toMatchObject({ priority: 'normal', difficulty: 'unassessed' });
  expect(c.webCreateTaskRequestSchema.parse({ projectId: 'project', title: 'Task' })).not.toHaveProperty('priority');
  expect(c.webUpdateTaskRequestSchema.parse({ version: 1, notes: '' })).not.toHaveProperty('difficulty');
  const source = { requestId: '00000000-0000-4000-8000-000000000002', sessionId: 'session' };
  for (const priority of c.taskPrioritySchema.options) {
    expect(c.managedUpdateTaskRequestSchema.parse({ ...source, version: 1, priority }).priority).toBe(priority);
  }
  for (const difficulty of c.taskDifficultySchema.options) {
    expect(c.managedUpdateTaskRequestSchema.parse({ ...source, version: 1, difficulty }).difficulty).toBe(difficulty);
  }
  for (const field of [{ priority: 'urgent' }, { difficulty: 'hard' }, { priority: null }, { difficulty: '' }]) {
    expect(c.webCreateTaskRequestSchema.safeParse({ projectId: 'project', title: 'Task', ...field }).success).toBe(false);
    expect(c.managedUpdateTaskRequestSchema.safeParse({ ...source, version: 1, ...field }).success).toBe(false);
  }
  expect(c.managedUpdateTaskRequestSchema.safeParse({ ...source, version: 1, type: 'discussion' }).success).toBe(false);
});
