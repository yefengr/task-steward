import { constants, fstatSync, openSync, readFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { localConfigSchema } from '@pi-steward/contract';

export function configPath(env = process.env, home = homedir()) {
  return resolve(env.STEWARD_CONFIG ?? join(home, '.config', 'pi-steward', 'config.json'));
}

export function readConfig(path: string) {
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
