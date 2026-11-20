import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalConfig } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { configPath, readConfig, writeConfig } from '../src/config.js';
import { platformClient } from '../src/platform.js';
import { initConfig, launchService } from '../src/service.js';
import { acquireRunLock } from '../src/state.js';
import { displayName, targetFor, tmuxClient } from '../src/tmux.js';

const homes: string[] = [];
const home = () => { const value = mkdtempSync(join(tmpdir(), 'steward-local-')); homes.push(value); return value; };
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });
const config: LocalConfig = { platformUrl: 'https://steward.example', machineToken: `stm_${randomBytes(32).toString('base64url')}`,
  slots: 1, projects: [], path: ['/mock/node', '/usr/bin'], pi: { command: '/mock/Pi tools/pi', extraArgs: ['--flag', '中文 $HOME'] } };

it('tmux 使用参数数组、精确目标、显式 PATH，并只把处理后的标题传给 Pi', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
  const tmux = tmuxClient(config, { configPath: '/mock/config;', extensionPath: '/mock/extension/index.js', run: run as Runner, env: {} });
  const id = randomUUID();
  const target = targetFor(id);
  const oldSession = targetFor(randomUUID());
  const display = '-@中文\n第二行;#{pane_id}';
  await tmux.launch(target, { id, taskId: randomUUID(), projectId: 'mock', kind: 'rework', restoreSession: true,
    agent: 'pi', sessionId: oldSession, displayName: display }, '/mock/项目 #{};');
  expect(run).toHaveBeenCalledWith('tmux', ['-L', 'steward', '-u', '-f', '/dev/null', 'new-session', '-d', '-s', target,
    '-c', '/mock/项目 ##{};/.', '-e', `STEWARD_ATTEMPT_ID=${id}`, '-e', 'STEWARD_CONFIG=/mock/config\\;', '-e', 'PATH=/mock/node:/usr/bin',
    '--', config.pi.command, '--flag', '中文 $HOME', '-e', '/mock/extension/index.js', '--session-id', oldSession,
    '-n', '中文 第二行   pane_id', '--', expect.stringMatching(/^返修本任务。先调用 steward_task/u)],
  expect.objectContaining({ env: expect.objectContaining({ PATH: '/mock/node:/usr/bin' }) }));
  await tmux.cancel(target);
  expect(run.mock.lastCall?.[1]).toContain(`=${target}`);
  expect(displayName('-@;')).toBe('Pi task');
});

it('区分无 server、名称仅前缀匹配和 tmux 查询失败', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const target = targetFor(randomUUID());
  const run = vi.fn().mockRejectedValueOnce({ code: 1, stderr: 'no server running on /tmp/isolated\n' })
    .mockResolvedValueOnce({ stdout: `${target}-other\n`, stderr: '' })
    .mockRejectedValueOnce({ code: 1, stderr: 'error connecting to /tmp/isolated (Permission denied)\n' })
    .mockResolvedValueOnce({ stdout: `${target}\n`, stderr: '' });
  const tmux = tmuxClient(config, { configPath: '/mock/config', extensionPath: '/mock/extension', run: run as Runner, env: {} });
  expect(await tmux.inspect(target)).toBe('absent');
  expect(await tmux.inspect(target)).toBe('absent');
  expect(await tmux.inspect(target)).toBe('unavailable');
  expect(await tmux.inspect(target)).toBe('present');
});

it('tmux 检查区分空闲、缺失、无法执行和 socket 故障', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const run = vi.fn().mockResolvedValueOnce({ stdout: 'tmux 3.7c\n', stderr: '' })
    .mockRejectedValueOnce({ code: 1, stderr: 'no server running on /tmp/isolated\n' })
    .mockRejectedValueOnce({ code: 'ENOENT' })
    .mockRejectedValueOnce({ code: 'EACCES' })
    .mockRejectedValueOnce({ code: 1, stderr: 'error connecting to /tmp/isolated (Permission denied)\n' });
  const tmux = tmuxClient(config, { configPath: '/mock/config', extensionPath: '/mock/extension', run: run as Runner, env: {} });
  expect(await tmux.check({ verifyVersion: true })).toBe('ready');
  expect(run.mock.calls[0]?.[1]).toEqual(['-L', 'steward', '-u', '-f', '/dev/null', '-V']);
  expect(await tmux.check({ verifyVersion: true })).toBe('missing');
  expect(await tmux.check({ verifyVersion: true })).toBe('unavailable');
  expect(await tmux.check()).toBe('unavailable');
  expect(run).toHaveBeenCalledTimes(5);
});

it('新安装使用家目录下的 pi-steward，已有配对继续读取原配置', () => {
  const directory = home();
  const current = join(directory, 'pi-steward', 'config.json');
  const legacy = join(directory, '.config', 'pi-steward', 'config.json');
  expect(configPath({}, directory)).toBe(current);
  writeConfig(`${legacy}.pairing`, config);
  expect(configPath({}, directory)).toBe(legacy);
  writeConfig(`${current}.pairing`, config);
  expect(configPath({}, directory)).toBe(current);
  writeConfig(legacy, config);
  expect(configPath({}, directory)).toBe(legacy);
  expect(readConfig(configPath({}, directory))).toEqual(config);
  writeConfig(current, { ...config, slots: 2 });
  expect(readConfig(configPath({}, directory)).slots).toBe(2);
  expect(configPath({ STEWARD_CONFIG: legacy }, directory)).toBe(legacy);
});

it('配置为独占 0600，拒绝不安全权限和未显式允许的 HTTP', () => {
  const file = join(home(), 'config.json');
  initConfig(file, { PATH: '/usr/bin' });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(() => initConfig(file, { PATH: '/usr/bin' })).toThrow();
  writeFileSync(file, JSON.stringify(config));
  expect(readConfig(file).slots).toBe(1);
  chmodSync(file, 0o644);
  expect(() => readConfig(file)).toThrow(/0600/u);
  chmodSync(file, 0o600);
  for (const options of [{ platformUrl: 'http://127.0.0.1:3000' }, { platformUrl: 'http://example.test', allowHttpLoopback: true }]) {
    writeFileSync(file, JSON.stringify({ ...config, ...options }));
    expect(() => readConfig(file)).toThrow(/platformUrl/u);
  }
  writeFileSync(file, JSON.stringify({ ...config, platformUrl: 'http://127.0.0.1:3000', allowHttpLoopback: true }));
  expect(readConfig(file).allowHttpLoopback).toBe(true);
});

it('launchctl 安装卸载只操作指定服务，plist 中只有配置路径', async () => {
  const directory = home();
  const run = vi.fn().mockResolvedValue(undefined);
  const service = launchService({ home: directory, uid: 42, node: '/bin/node', launcher: '/work/a&b.js', config: '/work/机密.json', launchctl: run });
  await service.install();
  const file = join(directory, 'Library', 'LaunchAgents', 'dev.pi-steward.launcher.plist');
  expect(run).toHaveBeenCalledWith(['bootstrap', 'gui/42', file]);
  const plist = readFileSync(file, 'utf8');
  expect(plist).toContain('/work/a&amp;b.js');
  expect(plist).toContain('/work/机密.json');
  expect(plist).toContain('<key>KeepAlive</key><true/>');
  await service.uninstall();
  expect(run).toHaveBeenCalledWith(['bootout', 'gui/42/dev.pi-steward.launcher']);
  expect(() => statSync(file)).toThrow();
});

it('launchctl 加载失败清理本轮 plist，卸载失败保留 plist 供核对', async () => {
  const directory = home();
  const run = vi.fn().mockRejectedValueOnce(new Error('bootstrap')).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('bootout'));
  const service = launchService({ home: directory, uid: 42, node: '/bin/node', launcher: '/work/launcher.js', config: '/work/config.json', launchctl: run });
  const file = join(directory, 'Library', 'LaunchAgents', 'dev.pi-steward.launcher.plist');
  await expect(service.install()).rejects.toThrow(/bootstrap/u);
  expect(() => statSync(file)).toThrow();
  await service.install();
  await expect(service.uninstall()).rejects.toThrow(file);
  expect(statSync(file).isFile()).toBe(true);
});

it('第二个 run 锁失败，前一个退出后可再次取得', () => {
  const path = join(home(), 'state.json');
  const release = acquireRunLock(path);
  try { expect(() => acquireRunLock(path)).toThrow(/启动器锁/u); } finally { release(); }
  acquireRunLock(path)();
});

it('HTTP 设置截止时间和禁止重定向，错误不回显平台消息', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'forbidden', message: '出错的详细内容' } }, { status: 403 }));
  await expect(platformClient(config, fetcher).claim(randomUUID())).rejects.toMatchObject({ code: 'forbidden', message: '平台请求失败（forbidden）。' });
  const request = fetcher.mock.lastCall;
  expect(request?.[0]).toBe('https://steward.example/api/v1/launcher/claim');
  expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal);
  expect(request?.[1]?.redirect).toBe('error');
});

it('只把 M1 明确的已有开始记录响应识别为已保存，并隔离原始错误', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => Response.json({ error: { code: 'conflict',
    message: 'Attempt already has a start report' } }, { status: 409 }))
    .mockImplementationOnce(async () => Response.json({ error: { code: 'conflict',
      message: 'Request ID already belongs to a different request' } }, { status: 409 }));
  const id = randomUUID();
  const event = { id, kind: 'started' as const, body: { requestId: randomUUID(), tmuxSession: targetFor(id), startedAt: 100 } };
  const client = platformClient(config, fetcher);
  await expect(client.report(event)).rejects.toMatchObject({ code: 'conflict', startedAlreadySaved: true });
  await expect(client.report(event)).rejects.toMatchObject({ code: 'conflict', startedAlreadySaved: false, message: '平台请求失败（conflict）。' });
});

it('令牌修复后原客户端使用新的凭据续送', async () => {
  const repaired = `stm_${randomBytes(32).toString('base64url')}`;
  let current = config.machineToken;
  const fetcher: typeof fetch = async (_input, init) => new Headers(init?.headers).get('Authorization') === `Bearer ${repaired}`
    ? Response.json({ attempt: null }) : Response.json({ error: { code: 'unauthorized', message: '认证失败' } }, { status: 401 });
  const client = platformClient(config, fetcher, () => current);
  const requestId = randomUUID();
  await expect(client.claim(requestId)).rejects.toMatchObject({ code: 'unauthorized' });
  current = repaired;
  await expect(client.claim(requestId)).resolves.toEqual({ attempt: null });
});
