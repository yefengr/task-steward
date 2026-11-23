import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { backupDatabase } from '../src/admin.js';
import { addMachine, hashPassword, newMachineToken } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { claim, heartbeat } from '../src/execution.js';
import { openStore, sha256, Store } from '../src/store.js';

it('迁移空库并开启外键，重复打开保留版本和数据', () => {
  const store = openStore(':memory:');
  try {
    expect(store.get('PRAGMA user_version')).toMatchObject({ user_version: 3 });
    expect(store.get('PRAGMA foreign_keys')).toMatchObject({ foreign_keys: 1 });
    expect(store.get('PRAGMA busy_timeout')).toMatchObject({ timeout: 5000 });
    expect(() => store.run('INSERT INTO projects VALUES (?,?,?,?)', 'project', 'Project', 'missing', 100)).toThrow(/FOREIGN KEY/);
    expect(store.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='index' AND name='one_active_attempt'")).toHaveLength(1);
  } finally { store.connection.close(); }
});

it('升级原有数据库时建立配对表并保留已有机器及凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-steward-migration-'));
  const path = join(directory, 'steward.sqlite');
  const token = newMachineToken();
  try {
    const connection = new DatabaseSync(path);
    try {
      connection.exec(readFileSync(new URL('../migrations/0001-initial.sql', import.meta.url), 'utf8'));
      connection.exec('PRAGMA user_version=1');
      addMachine(new Store(connection), 'Existing Mac', token, 100);
    } finally { connection.close(); }
    const upgraded = openStore(path);
    try {
      expect(upgraded.get('PRAGMA user_version')).toEqual({ user_version: 3 });
      expect(upgraded.all('SELECT * FROM machine_pairings')).toEqual([]);
      expect(upgraded.get('SELECT name, token_hash FROM machines')).toEqual({ name: 'Existing Mac', token_hash: sha256(token) });
    } finally { upgraded.connection.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('将平台异常映射成统一的内部错误响应', async () => {
  const store = openStore(':memory:');
  const accessPasswordHash = await hashPassword(randomUUID());
  const app = createApp({ store, accessPasswordHash, publicOrigin: 'https://steward.example' });
  store.connection.close();
  const response = await app.request('/health');
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
});

it('同一文件库的两条连接按任务位置领取，每项仅领取一次', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-claim-'));
  const path = join(directory, 'claims.sqlite');
  const one = openStore(path);
  const two = openStore(path);
  try {
    const project = { id: 'project', name: 'Project', path: '/tmp/project' };
    const machine = addMachine(one, 'Mac', newMachineToken(), 100);
    one.immediate(() => heartbeat(one, machine, {
      requestId: 'fixture', launcherVersion: 'test', slots: 3, projects: [project], attempts: [],
    }, 100));
    const tasks = ['second-position', 'first-position'];
    for (const [index, id] of tasks.entries()) {
      one.run(`INSERT INTO tasks (id, project_id, title, goal, acceptance, notes, agent, status, position,
        created_by, created_at, updated_at) VALUES (?, ?, ?, '', '', '', 'pi', 'queued', ?, 'user', ?, 100)`,
      id, project.id, id, tasks.length - index, 100 + index);
    }
    expect(one.immediate(() => claim(one, machine, 100)).attempt?.taskId).toBe('first-position');
    expect(two.immediate(() => claim(two, machine, 100)).attempt?.taskId).toBe('second-position');
    expect(one.immediate(() => claim(one, machine, 100)).attempt).toBeNull();
    expect(two.all('SELECT task_id FROM attempts')).toHaveLength(2);
  } finally {
    one.connection.close(); two.connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('WAL 的两条连接隔离未提交事务，竞争失败后可重试，备份可恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-test-'));
  const path = join(directory, 'source.sqlite');
  const snapshot = join(directory, 'snapshot.sqlite');
  const one = openStore(path);
  const two = openStore(path);
  try {
    expect(one.get('PRAGMA journal_mode')).toMatchObject({ journal_mode: 'wal' });
    two.connection.exec('PRAGMA busy_timeout=0');
    one.immediate(() => {
      addMachine(one, 'Committed', newMachineToken(), 100);
      expect(two.get('SELECT name FROM machines')).toBeUndefined();
      expect(() => two.immediate(() => undefined)).toThrow(/locked/);
    });
    expect(two.get('SELECT name FROM machines')).toMatchObject({ name: 'Committed' });
    expect(() => two.immediate(() => { addMachine(two, 'Rollback', newMachineToken(), 100); throw new Error('abort'); })).toThrow('abort');
    expect(one.all('SELECT name FROM machines')).toHaveLength(1);
    await backupDatabase(one, snapshot);
    await expect(backupDatabase(one, snapshot)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
    const restored = openStore(snapshot);
    try {
      expect(restored.get('SELECT name FROM machines')).toMatchObject({ name: 'Committed' });
      expect(restored.get('PRAGMA integrity_check')).toMatchObject({ integrity_check: 'ok' });
    } finally { restored.connection.close(); }
  } finally { one.connection.close(); two.connection.close(); await rm(directory, { recursive: true, force: true }); }
});
