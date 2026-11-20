import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { reject } from './errors.js';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class Store {
  constructor(readonly connection: DatabaseSync) {}
  get<T>(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.connection.prepare(sql).run(...params); }
  immediate<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
  event(taskId: string, actor: 'user' | 'launcher' | 'agent', attemptId: string | null,
    kind: string, payload: Record<string, unknown>, now: number) {
    this.run('INSERT INTO task_events VALUES (?,?,?,?,?,?,?)',
      randomUUID(), taskId, actor, attemptId, kind, JSON.stringify(payload), now);
  }
  request<T>(key: { machineId: string; actor: 'launcher' | 'agent'; operation: string; target: string },
    body: { requestId: string }, now: number, apply: () => T): T {
    const { machineId, actor, operation, target } = key;
    const { requestId } = body;
    const hash = sha256(JSON.stringify(body));
    this.run('DELETE FROM request_log WHERE created_at <= ?', now - REQUEST_RETENTION_MS);
    const entry = this.get<{ actor: string; operation: string; target: string; payload_hash: string; response: string }>(
      'SELECT actor, operation, target, payload_hash, response FROM request_log WHERE machine_id=? AND request_id=?',
      machineId, requestId);
    if (entry) {
      if (entry.actor !== actor || entry.operation !== operation || entry.target !== target || entry.payload_hash !== hash) {
        reject('conflict', 'Request ID already belongs to a different request');
      }
      return JSON.parse(entry.response) as T;
    }
    const response = apply();
    this.run('INSERT INTO request_log VALUES (?,?,?,?,?,?,?,?)', machineId, requestId, actor,
      operation, target, hash, JSON.stringify(response), now);
    return response;
  }
}

function migrate(store: Store) {
  const directory = new URL('../migrations/', import.meta.url);
  const migrations = readdirSync(directory).filter((name) => /^\d{4}-[\w-]+\.sql$/.test(name)).sort();
  if (!migrations.length || migrations.some((name, index) => Number(name.slice(0, 4)) !== index + 1)) {
    throw new Error('Invalid migration sequence');
  }
  store.immediate(() => {
    const { user_version: version } = store.get<{ user_version: number }>('PRAGMA user_version')!;
    if (version < 0 || version > migrations.length) throw new Error('Unsupported database schema version');
    for (const [index, filename] of migrations.entries()) {
      if (index < version) continue;
      store.connection.exec(readFileSync(new URL(filename, directory), 'utf8'));
      store.connection.exec(`PRAGMA user_version=${index + 1}`);
    }
  });
}

export function openStore(path: string) {
  const connection = new DatabaseSync(path);
  const store = new Store(connection);
  try {
    connection.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    migrate(store);
    return store;
  } catch (error) {
    connection.close();
    throw error;
  }
}
