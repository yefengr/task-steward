import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireExecutionLock, processStatus } from '../src/index.js';

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'steward-owner-')));
  paths.push(path);
  const config = join(path, 'config.json');
  writeFileSync(config, '{}', { mode: 0o600 });
  return { path, config, goal: randomUUID() };
}
it('同目标进程间锁互斥，释放后可重取；不同目标独立', () => {
  const x = fixture();
  const release = acquireExecutionLock(x.config, x.goal);
  const script = `import {acquireExecutionLock} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}; acquireExecutionLock(process.argv[1], process.argv[2]);`;
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, x.config, x.goal], { stdio: 'pipe' })).toThrow();
  const other = acquireExecutionLock(x.config, randomUUID());
  other();
  release(); release();
  acquireExecutionLock(x.config, x.goal)();
});
it('仅ESRCH证明进程死亡，活进程和非法PID均不被判为dead', async () => {
  expect(processStatus(process.pid)).toBe('alive');
  expect(processStatus(-1)).toBe('unavailable');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  expect(processStatus(pid)).toBe('dead');
});
it('配置路径别名仍竞争同一锁，不接受符号链接锁文件', () => {
  const x = fixture();
  const alias = join(x.path, 'alias.json');
  symlinkSync(x.config, alias);
  const release = acquireExecutionLock(x.config, x.goal);
  expect(() => acquireExecutionLock(alias, x.goal)).toThrow('execution_owned');
  release();
  const fakeGoal = randomUUID();
  symlinkSync(x.config, join(x.path, 'execution-locks', `${fakeGoal}.sqlite`));
  expect(() => acquireExecutionLock(x.config, fakeGoal)).toThrow();
});
