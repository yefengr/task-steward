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
    expect(store.get('PRAGMA user_version')).toMatchObject({ user_version: 7 });
    expect(store.get('PRAGMA foreign_keys')).toMatchObject({ foreign_keys: 1 });
    expect(store.get('PRAGMA busy_timeout')).toMatchObject({ timeout: 5000 });
    expect(() => store.run('INSERT INTO projects (id,name,last_machine_id,created_at) VALUES (?,?,?,?)', 'project', 'Project', 'missing', 100)).toThrow(/FOREIGN KEY/);
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
      expect(upgraded.get('PRAGMA user_version')).toEqual({ user_version: 7 });
      expect(upgraded.all('SELECT * FROM machine_pairings')).toEqual([]);
      expect(upgraded.get('SELECT name, token_hash FROM machines')).toEqual({ name: 'Existing Mac', token_hash: sha256(token) });
    } finally { upgraded.connection.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('升级三版数据库保留领取目录和会话，旧尝试的实际现场为空', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-steward-workspace-migration-'));
  const path = join(directory, 'steward.sqlite');
  try {
    const prior = new Store(new DatabaseSync(path));
    try {
      for (const file of ['0001-initial.sql', '0002-machine-pairing.sql', '0003-discussion-and-reply-waits.sql']) {
        prior.connection.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
      }
      prior.connection.exec('PRAGMA user_version=3; PRAGMA foreign_keys=ON');
      const machineId = addMachine(prior, 'Mac', newMachineToken(), 100);
      prior.run("INSERT INTO projects (id, name, created_at) VALUES ('project','Project',100)");
      prior.run(`INSERT INTO tasks (id, project_id, title, goal, acceptance, notes, agent, status, position, created_by, created_at, updated_at)
        VALUES ('task','project','Task','','','','pi','running',1,'user',100,100)`);
      prior.run(`INSERT INTO attempts (id, task_id, machine_id, agent, kind, session_id, workspace_path, claimed_at, lease_expires_at)
        VALUES ('attempt','task',?,'pi','new','launcher-session','/work/registered',100,200)`, machineId);
    } finally { prior.connection.close(); }
    const upgraded = openStore(path);
    try {
      expect(upgraded.get('PRAGMA user_version')).toEqual({ user_version: 7 });
      expect(upgraded.get('SELECT origin FROM tasks')).toEqual({ origin: 'legacy' });
      expect(upgraded.get('SELECT git_base_branch,git_sync_before_start,git_version FROM projects')).toEqual({
        git_base_branch: null, git_sync_before_start: 1, git_version: 1,
      });
      expect(upgraded.get('SELECT base_branch FROM tasks')).toEqual({ base_branch: null });
      expect(upgraded.all('SELECT * FROM task_git')).toEqual([]);
      expect(upgraded.get('SELECT * FROM attempts WHERE id=?', 'attempt')).toMatchObject({
        workspace_path: '/work/registered', session_id: 'launcher-session', confirmed_workspace_path: null,
        confirmed_git_kind: null, confirmed_git_branch: null, confirmed_session_id: null, confirmed_session_file: null,
        session_locator: null, resumed_from_attempt_id: null, execution_mode: 'background', owner_id: null,
      });
    } finally { upgraded.connection.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('六版非空会话操作和请求记录迁移无损，原索引与状态约束保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-steward-foreground-migration-'));
  const path = join(directory, 'steward.sqlite');
  try {
    const prior = new Store(new DatabaseSync(path));
    let operations: unknown[]; let requests: unknown[];
    try {
      for (const file of ['0001-initial.sql', '0002-machine-pairing.sql', '0003-discussion-and-reply-waits.sql',
        '0004-attempt-workspace.sql', '0005-session-control.sql', '0006-git-lifecycle.sql']) {
        prior.connection.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
      }
      prior.connection.exec('PRAGMA user_version=6; PRAGMA foreign_keys=ON');
      const machine = addMachine(prior, 'Mac', newMachineToken(), 100);
      prior.run("INSERT INTO projects (id,name,created_at) VALUES ('p','P',100)");
      for (const [index, step] of ['stop','launch','cleanup','succeeded','failed'].entries()) {
        const task = `task-${index}`; const source = `source-${index}`; const replacement = `replacement-${index}`;
        prior.run(`INSERT INTO tasks (id,project_id,title,goal,acceptance,notes,agent,status,position,created_by,created_at,updated_at)
          VALUES (?,'p','Task','','','','pi','running',?,'user',100,100)`, task, index);
        for (const id of [source, replacement]) prior.run(`INSERT INTO attempts
          (id,task_id,machine_id,agent,kind,session_id,workspace_path,claimed_at,lease_expires_at,ended_at)
          VALUES (?,?,?,'pi','new','native','/work',100,200,200)`, id, task, machine);
        prior.run(`INSERT INTO session_operations VALUES (?,?,?,?,?,?,?,?,?,?,?)`, `operation-${index}`, task, machine,
          source, ['launch','cleanup','succeeded'].includes(step) ? replacement : null, index % 2 ? 'restore' : 'restart',
          '{"path":"/work","sessionId":"native","sessionFile":"/sessions/native.jsonl"}', step, 999, step === 'succeeded' ? 123 : null,
          step === 'failed' ? 'session_timeout' : null);
      }
      prior.request({ machineId: machine, actor: 'agent', operation: 'progress', target: 'source-0' }, { requestId: 'old-request' }, 100, () => ({ ok: true }));
      operations = prior.all('SELECT * FROM session_operations ORDER BY id');
      requests = prior.all('SELECT * FROM request_log');
    } finally { prior.connection.close(); }
    const upgraded = openStore(path);
    try {
      expect(upgraded.all('SELECT * FROM session_operations ORDER BY id')).toEqual(operations);
      expect(upgraded.all('SELECT * FROM request_log')).toEqual(requests);
      expect(upgraded.all('PRAGMA foreign_key_check')).toEqual([]);
      const indexes = upgraded.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='session_operations'").map((r) => r.name);
      expect(indexes).toEqual(expect.arrayContaining(['session_operations_active_task','session_operations_machine_step','session_operations_task']));
      expect(() => upgraded.run("UPDATE session_operations SET mode='background' WHERE id='operation-0'")).not.toThrow();
      expect(() => upgraded.run("UPDATE session_operations SET mode='invalid' WHERE id='operation-0'")).toThrow(/CHECK/);
      expect(() => upgraded.run("UPDATE session_operations SET step='failed' WHERE id='operation-0'")).toThrow(/CHECK/);
      expect(() => upgraded.run(`INSERT INTO session_operations SELECT 'duplicate',task_id,machine_id,source_attempt_id,NULL,mode,locator,'stop',deadline_at,NULL,NULL
        FROM session_operations WHERE id='operation-0'`)).toThrow(/UNIQUE/);
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
