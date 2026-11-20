import { randomUUID } from 'node:crypto';
import { constants, existsSync, fstatSync, openSync, readFileSync, closeSync, mkdirSync, writeFileSync, fsyncSync, renameSync, linkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LOCAL_CONFIG, LEGACY_LOCAL_CONFIG, localConfigSchema } from '@pi-steward/contract';
import type { LocalConfig } from '@pi-steward/contract';

export function configPath(env = process.env, home = homedir()) {
  if (env.STEWARD_CONFIG !== undefined) return resolve(env.STEWARD_CONFIG);
  const current = resolve(home, DEFAULT_LOCAL_CONFIG);
  const legacy = resolve(home, LEGACY_LOCAL_CONFIG);
  if (existsSync(current)) return current;
  if (existsSync(legacy)) return legacy;
  // 继续之前未完成的配对，避免丢失网页可能已确认的本机令牌。
  if (!existsSync(`${current}.pairing`) && existsSync(`${legacy}.pairing`)) return legacy;
  return current;
}

export function readConfig(path: string): LocalConfig;
export function readConfig(path: string, optional: true): LocalConfig | undefined;
export function readConfig(path: string, optional = false) {
  let data: unknown;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
        throw new Error('config_permissions');
      }
      data = JSON.parse(readFileSync(fd, 'utf8'));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof Error && error.message === 'config_permissions') {
      throw new Error('配置必须为当前用户所有的普通文件，权限须为 0600。');
    }
    throw new Error('无法读取配置，请运行 init 或检查配置文件是否为有效 JSON。');
  }
  const result = localConfigSchema.safeParse(data);
  if (!result.success) {
    const fields = new Set(result.error.issues.map(({ path }) => String(path[0] ?? 'root')));
    throw new Error(`配置字段无效：${[...fields].join('、')}。`);
  }
  return result.data;
}

export function writeConfig(path: string, config: LocalConfig, replace = false) {
  const data = localConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
