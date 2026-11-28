import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { LocalConfig } from '@pi-steward/contract';

const PACKAGE_NAME = '@yefengr/steward';
const EXTENSION_ENTRY = './dist/extension.js';
const PI_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

export type Exec = (file: string, args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<unknown>;

export interface ExtensionCommandOptions {
  /** 当前实际运行的启动器入口，用于定位发布包根目录。 */
  moduleUrl: string;
  config?: Pick<LocalConfig, 'pi' | 'path'>;
  exec?: Exec;
}

const defaultExec: Exec = (file, args, options) => execFileAsync(file, args, options);

function usage() {
  return '用法：stew extension path|install|remove\n'
    + '  path     输出当前运行发布包的绝对路径\n'
    + '  install  通过 Pi 登记该发布包中的扩展\n'
    + '  remove   通过 Pi 移除该发布包的登记\n'
    + '旧版单独登记 extension 文件时，请用 pi remove 加该文件绝对路径精确移除。';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 发布包的扩展只登记一次：从当前真正运行的 index.js 反推包根，不按 npm 全局前缀猜测。
export function resolveExtensionPackage(moduleUrl: string) {
  let entry: string;
  try {
    entry = realpathSync(fileURLToPath(moduleUrl));
  } catch {
    throw new Error('无法定位当前运行的 Steward 启动器文件。');
  }
  const root = dirname(dirname(entry));
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    throw new Error('当前运行目录不是完整的 Steward 发布包。');
  }
  if (!isRecord(manifest) || manifest.name !== PACKAGE_NAME) {
    throw new Error(`当前运行的不是 ${PACKAGE_NAME} 发布包，无法登记 Pi 扩展。`);
  }
  const extensions = isRecord(manifest.pi) ? manifest.pi.extensions : undefined;
  if (!Array.isArray(extensions) || !extensions.includes(EXTENSION_ENTRY)) {
    throw new Error(`Steward 发布包清单未声明 ${EXTENSION_ENTRY}。`);
  }
  let extension: string;
  try {
    extension = realpathSync(join(root, 'dist/extension.js'));
    if (!statSync(extension).isFile()) throw new Error('not_file');
  } catch {
    throw new Error('Steward 发布包内缺少 dist/extension.js。');
  }
  return { root: realpathSync(root), extension };
}

function piInvocation(config: ExtensionCommandOptions['config']) {
  const command = config?.pi.command ?? 'pi';
  const path = config?.path;
  // 未配对时保持 Pi 默认命令和当前环境，不因缺少本机配置阻塞登记。
  return { command, env: path?.length ? { ...process.env, PATH: path.join(delimiter) } : undefined };
}

async function delegate(action: 'install' | 'remove', root: string, options: ExtensionCommandOptions, exec: Exec) {
  const { command, env } = piInvocation(options.config);
  try {
    await exec(command, [action, root], { timeout: PI_TIMEOUT_MS, env });
  } catch {
    // 不把 Pi 子进程的错误输出或本机配置带入提示。
    throw new Error(action === 'install'
      ? 'Pi 扩展登记失败，请确认本机 Pi 可用后重试。'
      : 'Pi 扩展移除失败，请确认本机 Pi 可用后重试。');
  }
}

export async function runExtensionCommand(argv: readonly string[], options: ExtensionCommandOptions) {
  const [command] = argv;
  if (command === undefined || command === '--help' || command === '-h') return usage();
  if (command !== 'path' && command !== 'install' && command !== 'remove') {
    throw new Error('用法：stew extension path|install|remove。');
  }
  if (argv.length !== 1) throw new Error('stew extension 只接受一个子命令。');
  const { root } = resolveExtensionPackage(options.moduleUrl);
  if (command === 'path') return root;
  await delegate(command, root, options, options.exec ?? defaultExec);
  return command === 'install'
    ? `已通过 Pi 登记 Steward 扩展：${root}\n新开 Pi 加载扩展；升级后正在运行的 Pi 需重启，使用工作台「重启 Pi 会话」或退出后重新打开。`
    : `已通过 Pi 移除 Steward 扩展登记：${root}`;
}
