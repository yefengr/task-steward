import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ProcessStatus = 'alive' | 'dead' | 'unavailable';
export function processStatus(pid: number): ProcessStatus {
  if (!Number.isInteger(pid) || pid < 2 || pid > 0x7fffffff) return 'unavailable';
  try { process.kill(pid, 0); return 'alive'; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unavailable';
  }
}

// 复用启动器的 SQLite 事务锁：崩溃自动释放，不删除或强抢锁文件。
export function acquireExecutionLock(configFile: string, goalId: string): () => void {
  if (!/^[0-9a-f-]{36}$/iu.test(goalId)) throw new Error('invalid_execution_identity');
  const config = realpathSync(configFile);
  const root = join(dirname(config), 'execution-locks');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Error('execution_lock_unavailable');
  const path = join(root, `${goalId}.sqlite`);
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
      throw new Error('execution_lock_unavailable');
    }
  } finally { closeSync(fd); }
  const db = new DatabaseSync(path, { timeout: 0 });
  try { db.exec('BEGIN IMMEDIATE'); } catch { db.close(); throw new Error('execution_owned'); }
  let released = false;
  return () => { if (!released) { released = true; db.close(); } };
}
