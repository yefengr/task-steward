import { spawnSync } from 'node:child_process';
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

it('tmux 使用参数数组、精确目标、显式 PATH，窗口名处理与任务原始标题分离', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
  const tmux = tmuxClient(config, { configPath: '/mock/config;', extensionPath: '/mock/extension/index.js', run: run as Runner, env: {} });
  const id = randomUUID();
  const target = targetFor(id);
  const oldSession = targetFor(randomUUID());
  const display = '-@中文\n第二行;#{pane_id}';
  await tmux.launch(target, { id, taskId: randomUUID(), projectId: 'mock', kind: 'rework', restoreSession: true,
    sessionLocator: { path: '/mock/项目 #{};', sessionId: oldSession, sessionFile: '/sessions/exact.jsonl' },
    agent: 'pi', sessionId: oldSession, displayName: display, title: '讨论「方案 A～F」' }, '/registered/project');
  expect(run).toHaveBeenCalledWith('tmux', ['-L', 'steward', '-u', '-f', '/dev/null', 'new-session', '-d', '-s', target,
    '-c', '/mock/项目 ##{};/.', '-e', 'STEWARD_RESUME=1', '-e', `STEWARD_ATTEMPT_ID=${id}`, '-e', 'STEWARD_CONFIG=/mock/config\\;', '-e', 'PATH=/mock/node:/usr/bin',
    '--', config.pi.command, '--flag', '中文 $HOME', '-e', '/mock/extension/index.js', '--session', '/sessions/exact.jsonl',
    '-n', '中文 第二行   pane_id', '--', '返修：讨论「方案 A～F」\n先调用 steward_task 读取目标、验收要求和授权。'],
  expect.objectContaining({ env: expect.objectContaining({ PATH: '/mock/node:/usr/bin' }) }));
  await tmux.cancel(target);
  expect(run.mock.lastCall?.[1]).toContain(`=${target}`);
  expect(displayName('-@;')).toBe('Pi task');
});

it.each([true, false])('新任务开工消息只包含原始标题和读任务指引，旧平台兼容=%s', async (legacy) => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
  const tmux = tmuxClient(config, { configPath: '/mock/config', extensionPath: '/mock/extension', run: run as Runner, env: {} });
  const id = randomUUID();
  const title = `带标点的任务「${'长标题'.repeat(40)}」`;
  await tmux.launch(targetFor(id), { id, taskId: randomUUID(), projectId: 'mock', kind: 'new', restoreSession: false,
    agent: 'pi', sessionId: id, displayName: '窗口名', ...(legacy ? {} : { title }) }, '/project');
  expect(run.mock.lastCall?.[1].at(-1)).toBe(`新任务：${legacy ? '窗口名' : title}\n先调用 steward_task 读取目标、验收要求和授权。`);
});

it('恢复命令不携带新会话 ID、名称或消息；只使用原文件和显式恢复环境', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const run = vi.fn().mockResolvedValue({ stdout: '123\n', stderr: '' });
  const resume = { ...config, pi: { ...config.pi, extraArgs: ['--approve', '--model', 'vendor/model', '-e', '/mock/extension;'] } };
  const tmux = tmuxClient(resume, { configPath: '/mock/config;', extensionPath: '/mock/steward', run: run as Runner, env: {} });
  const id = randomUUID();
  const locator = { path: '/mock/项目 #{};', sessionId: randomUUID(), sessionFile: '/mock/old session;' };
  expect(await tmux.launchResume(targetFor(id), id, locator)).toBe(123);
  expect(run.mock.lastCall?.[1]).toEqual(['-L', 'steward', '-u', '-f', '/dev/null', 'new-session', '-d', '-s', targetFor(id),
    '-P', '-F', '#{pane_pid}', '-c', '/mock/项目 ##{};/.', '-e', `STEWARD_ATTEMPT_ID=${id}`, '-e', 'STEWARD_CONFIG=/mock/config\\;',
    '-e', 'STEWARD_RESUME=1', '-e', 'PATH=/mock/node:/usr/bin', '--', resume.pi.command, '--approve', '--model', 'vendor/model',
    '-e', '/mock/extension\\;', '-e', '/mock/steward', '--session', '/mock/old session\\;']);
});

it('后台接续只传模式标记，不在原会话加载确认前通过启动 argv 发指令', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const run = vi.fn().mockResolvedValue({ stdout: '123\n', stderr: '' });
  const tmux = tmuxClient(config, { configPath: '/mock/config', extensionPath: '/mock/steward', run: run as Runner, env: {} });
  const id = randomUUID();
  await tmux.launchResume(targetFor(id), id, { path: '/mock/project', sessionId: randomUUID(), sessionFile: '/mock/session.jsonl' }, true);
  const args = run.mock.lastCall?.[1] as string[];
  expect(args).toContain('STEWARD_CONTINUATION=1');
  expect(args.slice(-2)).toEqual(['--session', '/mock/session.jsonl']);
  expect(args.join(' ')).not.toContain('用户已请求');
});
it('只接受精确单 pane 的 PID', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const target = targetFor(randomUUID());
  const run = vi.fn().mockResolvedValueOnce({ stdout: `${target}-other\t123\n` })
    .mockResolvedValueOnce({ stdout: `${target}\t123\n${target}\t456\n` })
    .mockResolvedValueOnce({ stdout: `${target}\t123\n` });
  const tmux = tmuxClient(config, { configPath: '/mock/config', extensionPath: '/mock/steward', run: run as Runner, env: {} });
  expect(await tmux.panePid(target)).toBeUndefined();
  expect(await tmux.panePid(target)).toBeUndefined();
  expect(await tmux.panePid(target)).toBe(123);
  expect(run.mock.lastCall?.[1]).toContain(`=${target}`);
});

it.skipIf(spawnSync('tmux', ['-V']).status !== 0)('独立 tmux socket 中验证假 Pi 的新目标 PID 与精确停止', async () => {
  const path = home();
  const command = join(path, 'fake-pi');
  writeFileSync(command, '#!/bin/sh\nexec /bin/sleep 20\n', { mode: 0o700 });
  const resume = { ...config, path: (process.env.PATH ?? '/usr/bin:/bin').split(':'), pi: { command, extraArgs: [] } };
  const tmux = tmuxClient(resume, { socket: join(path, 'socket'), configPath: join(path, 'config'), extensionPath: join(path, 'extension') });
  const id = randomUUID();
  const target = targetFor(id);
  try {
    const pid = await tmux.launchResume(target, id, { path, sessionId: randomUUID(), sessionFile: join(path, 'test.jsonl') });
    expect(await tmux.inspect(target)).toBe('present');
    expect(await tmux.panePid(target)).toBe(pid);
    expect(await tmux.hasResumeIdentity(id)).toBe(true);
    expect(await tmux.hasResumeIdentity(randomUUID())).toBe(false);
    expect(tmux.processStatus(pid)).toBe('alive');
    await expect(tmux.launchResume(target, id, { path, sessionId: randomUUID(), sessionFile: join(path, 'test.jsonl') }))
      .rejects.toMatchObject({ notStarted: true });
    await tmux.cancel(target);
    // 最后一个会话退出时，server/socket 关闭可能短暂返回 unavailable；必须等到明确的 absent。
    await vi.waitFor(async () => expect(await tmux.inspect(target)).toBe('absent'), { timeout: 3_000 });
  } finally {
    if (await tmux.inspect(target) === 'present') await tmux.cancel(target);
  }
});

it('只能从精确 tmux 会话的环境确认恢复身份', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const id = randomUUID();
  const run = vi.fn().mockResolvedValueOnce({ stdout: `STEWARD_ATTEMPT_ID=${randomUUID()}\n` })
    .mockResolvedValueOnce({ stdout: `STEWARD_ATTEMPT_ID=${id}\n` }).mockResolvedValueOnce({ stdout: '-STEWARD_RESUME\n' })
    .mockResolvedValueOnce({ stdout: `STEWARD_ATTEMPT_ID=${id}\n` }).mockResolvedValueOnce({ stdout: 'STEWARD_RESUME=1\n' });
  const tmux = tmuxClient(config, { configPath: '/mock/config', extensionPath: '/mock/steward', run: run as Runner, env: {} });
  expect(await tmux.hasResumeIdentity(id)).toBe(false);
  expect(await tmux.hasResumeIdentity(id)).toBe(false);
  expect(await tmux.hasResumeIdentity(id)).toBe(true);
  expect(run.mock.calls.map(([, args]) => args.slice(-4))).toEqual([
    ['show-environment', '-t', `=${targetFor(id)}`, 'STEWARD_ATTEMPT_ID'],
    ['show-environment', '-t', `=${targetFor(id)}`, 'STEWARD_ATTEMPT_ID'],
    ['show-environment', '-t', `=${targetFor(id)}`, 'STEWARD_RESUME'],
    ['show-environment', '-t', `=${targetFor(id)}`, 'STEWARD_ATTEMPT_ID'],
    ['show-environment', '-t', `=${targetFor(id)}`, 'STEWARD_RESUME'],
  ]);
});

it('超时或未知响应不能当成 tmux 拒绝启动', async () => {
  type Runner = NonNullable<Parameters<typeof tmuxClient>[1]['run']>;
  const target = randomUUID();
  const run = vi.fn().mockRejectedValueOnce({ code: 1, killed: true, stderr: `duplicate session: ${targetFor(target)}` })
    .mockRejectedValueOnce({ code: 1, stderr: 'unknown error' });
  const tmux = tmuxClient(config, { configPath: '/mock/config', extensionPath: '/mock/steward', run: run as Runner, env: {} });
  const locator = { path: '/mock/work', sessionId: randomUUID(), sessionFile: '/mock/session.jsonl' };
  await expect(tmux.launchResume(targetFor(target), target, locator)).rejects.toMatchObject({ notStarted: false });
  await expect(tmux.launchResume(targetFor(target), target, locator)).rejects.toMatchObject({ notStarted: false });
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

it('旧平台仅在 invalid_request 后用新请求 ID 降级，且忽略降级响应中的会话操作', async () => {
  const request = { requestId: randomUUID(), launcherVersion: 'test', sessionControl: true as const, slots: 1, projects: [], attempts: [] };
  const operation = { id: randomUUID(), step: 'future-unknown-operation' };
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => Response.json({ error: { code: 'invalid_request', message: 'unknown key' } }, { status: 400 }))
    .mockImplementationOnce(async () => Response.json({ directives: [], sessionOperations: [operation] }))
    .mockImplementationOnce(async () => Response.json({ error: { code: 'unauthorized', message: 'credentials' } }, { status: 401 }));
  const client = platformClient(config, fetcher);
  await expect(client.heartbeat(request)).resolves.toEqual({ directives: [] });
  const sent = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(sent[0]).toEqual(request);
  expect(sent[1]).toEqual({ launcherVersion: 'test', requestId: expect.any(String), slots: 1, projects: [], attempts: [] });
  expect(sent[1].requestId).not.toBe(request.requestId);
  await expect(client.heartbeat(request)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('会话操作报告使用机器客户端的固定端点与认证', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  const id = randomUUID();
  const body = { requestId: randomUUID(), result: 'stopped', step: 'stop' } as const;
  await expect(platformClient(config, fetcher).reportSession(id, body)).resolves.toEqual({ ok: true });
  expect(fetcher).toHaveBeenCalledWith(`https://steward.example/api/v1/launcher/session-operations/${id}/report`, expect.objectContaining({
    method: 'POST', body: JSON.stringify(body), headers: expect.objectContaining({ Authorization: `Bearer ${config.machineToken}` }),
  }));
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
