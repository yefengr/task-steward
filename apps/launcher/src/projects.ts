import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { localConfigSchema } from '@pi-steward/contract';
import { readConfig, writeConfig } from './config.js';
import { acquireRunLock } from './state.js';

export function addProject(configFile: string, directory = process.cwd()) {
  const release = acquireRunLock(`${configFile}.write`, '已有 Steward 命令正在更新配置，请稍后重试。');
  try {
    const config = readConfig(configFile);
    let path: string;
    try {
      const root = execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 });
      path = realpathSync(root.replace(/\n$/u, ''));
    } catch { throw new Error('请在要登记的 Git 项目目录下运行 stew add。'); }
    const existing = config.projects.find((project) => project.path === path);
    if (existing) return { project: existing, added: false };
    // 用当前机器的身份和规范化路径生成稳定 ID，避免不同电脑的同名目录互相覆盖。
    const id = `project-${createHash('sha256').update(config.machineToken).update('\0').update(path).digest('hex')}`;
    const project = { id, name: basename(path).trim() || 'Git project', path };
    const updated = localConfigSchema.safeParse({ ...config, projects: [...config.projects, project] });
    if (!updated.success) throw new Error('项目目录不符合登记要求，或已达到项目数量上限。');
    writeConfig(configFile, updated.data, true);
    return { project, added: true };
  } finally { release(); }
}
