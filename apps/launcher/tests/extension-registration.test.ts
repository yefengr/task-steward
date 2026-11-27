import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LocalConfig } from '@pi-steward/contract';
import { afterEach, expect, it } from 'vitest';
import { type Exec, runExtensionCommand } from '../src/extension-registration.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type ManifestState = 'ok' | 'missing' | 'undeclared';

function makePackage({ name = '@yefengr/steward', manifest = 'ok', entry = true, extension = true }:
  { name?: string; manifest?: ManifestState; entry?: boolean; extension?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'stew-extension-'));
  directories.push(base);
  // 刻意放在与 npm 全局前缀无关的目录，验证定位只依赖实际运行入口。
  const root = join(base, 'some-global-prefix', 'node_modules', '@yefengr', 'steward');
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  if (entry) writeFileSync(join(dist, 'index.js'), '');
  if (manifest !== 'missing') {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest === 'ok'
      ? { name, pi: { extensions: ['./dist/extension.js'] } }
      : { name }));
  }
  if (extension) writeFileSync(join(dist, 'extension.js'), '');
  return { base, root: realpathSync(root), entry: join(dist, 'index.js') };
}

interface Call {
  file: string;
  args: string[];
  options?: { timeout?: number; env?: NodeJS.ProcessEnv };
}

function recordingExec() {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, options) => { calls.push({ file, args, options }); return {}; };
  return { calls, exec };
}

const pairedConfig: Pick<LocalConfig, 'pi' | 'path'> = {
  path: ['/mock/node/bin', '/usr/bin'],
  pi: { command: '/mock/Pi tools/pi', extraArgs: [] },
};

it('path 从实际入口 realpath 定位发布包，不依赖 npm 全局前缀', async () => {
  const pkg = makePackage();
  const linked = join(pkg.base, 'linked-package');
  symlinkSync(pkg.root, linked, 'dir');
  const { calls, exec } = recordingExec();
  const result = await runExtensionCommand(['path'], {
    moduleUrl: pathToFileURL(join(linked, 'dist/index.js')).href, exec,
  });
  expect(result).toBe(pkg.root);
  expect(calls).toEqual([]);
});

it('install 复用已配对 Pi 命令和 PATH，并传递真实绝对包路径', async () => {
  const pkg = makePackage();
  const { calls, exec } = recordingExec();
  const text = await runExtensionCommand(['install'], {
    moduleUrl: pathToFileURL(pkg.entry).href, config: pairedConfig, exec,
  });
  expect(calls).toEqual([{ file: '/mock/Pi tools/pi', args: ['install', pkg.root],
    options: expect.objectContaining({ env: expect.objectContaining({ PATH: '/mock/node/bin:/usr/bin' }) }) }]);
  expect(text).toContain(pkg.root);
});

it('未配对时使用默认 pi 命令，不因缺少本机配置而阻塞', async () => {
  const pkg = makePackage();
  const { calls, exec } = recordingExec();
  await runExtensionCommand(['install'], { moduleUrl: pathToFileURL(pkg.entry).href, exec });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.file).toBe('pi');
  expect(calls[0]!.args).toEqual(['install', pkg.root]);
  expect(calls[0]!.options?.env).toBeUndefined();
});

it('重复 install 仍委托 Pi 处理同一个绝对路径', async () => {
  const pkg = makePackage();
  const { calls, exec } = recordingExec();
  const options = { moduleUrl: pathToFileURL(pkg.entry).href, exec };
  await runExtensionCommand(['install'], options);
  await runExtensionCommand(['install'], options);
  expect(calls.map(({ args }) => args)).toEqual([['install', pkg.root], ['install', pkg.root]]);
});

it('remove 只委托移除实际登记，不删除配对与其他配置', async () => {
  const pkg = makePackage();
  const configPath = join(pkg.base, 'config.json');
  const paired = `${JSON.stringify({ ...pairedConfig, machineToken: 'stm_fixture_secret' })}\n`;
  writeFileSync(configPath, paired, { mode: 0o600 });
  const settingsPath = join(pkg.base, 'settings.json');
  const settings = '{"packages":["/other/package"]}\n';
  writeFileSync(settingsPath, settings);
  const { calls, exec } = recordingExec();
  const text = await runExtensionCommand(['remove'], {
    moduleUrl: pathToFileURL(pkg.entry).href, config: pairedConfig, exec,
  });
  expect(calls).toEqual([{ file: '/mock/Pi tools/pi', args: ['remove', pkg.root],
    options: expect.objectContaining({ timeout: expect.any(Number) }) }]);
  expect(readFileSync(configPath, 'utf8')).toBe(paired);
  expect(readFileSync(settingsPath, 'utf8')).toBe(settings);
  expect(text).toContain(pkg.root);
});

const invalidPackages = [
  { label: '入口文件缺失', options: { entry: false }, error: /无法定位当前运行的 Steward 启动器/ },
  { label: '包清单缺失', options: { manifest: 'missing' as const }, error: /不是完整的 Steward 发布包/ },
  { label: '包名不符', options: { name: '@pi-steward/launcher' }, error: /不是 @yefengr\/steward 发布包/ },
  { label: '清单未声明扩展', options: { manifest: 'undeclared' as const }, error: /未声明 \.\/dist\/extension\.js/ },
  { label: '扩展文件缺失', options: { extension: false }, error: /缺少 dist\/extension\.js/ },
] as const;

it.each(invalidPackages)('$label 时拒绝登记且不执行 Pi', async ({ options, error }) => {
  const pkg = makePackage(options);
  const { calls, exec } = recordingExec();
  await expect(runExtensionCommand(['install'], { moduleUrl: pathToFileURL(pkg.entry).href, exec }))
    .rejects.toThrow(error);
  expect(calls).toEqual([]);
});

it('Pi 命令失败时给出清晰错误且不泄漏配置内容', async () => {
  const pkg = makePackage();
  const token = 'stm_fixture_secret';
  const exec: Exec = async () => { throw Object.assign(new Error(`command failed ${token}`), { code: 1 }); };
  const error = await runExtensionCommand(['remove'], {
    moduleUrl: pathToFileURL(pkg.entry).href, config: pairedConfig, exec,
  }).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('Pi 扩展移除失败');
  expect((error as Error).message).not.toContain(token);
});

it('help 说明用法与旧 extension 文件的精确移除方式', async () => {
  const { calls, exec } = recordingExec();
  const text = await runExtensionCommand([], { moduleUrl: 'file:///unused/index.js', exec });
  expect(text).toContain('stew extension path|install|remove');
  expect(text).toContain('pi remove');
  expect(calls).toEqual([]);
});

it('未知子命令返回用法且不执行 Pi', async () => {
  await expect(runExtensionCommand(['list'], { moduleUrl: 'file:///unused/index.js' }))
    .rejects.toThrow('用法：stew extension');
});
