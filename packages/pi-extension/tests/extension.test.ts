import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { uuidSchema } from '@pi-steward/contract';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSteward } from '../src/index.js';

const toolNames = ['steward_task', 'steward_progress', 'steward_ask', 'steward_question_update',
  'steward_decision', 'steward_deliver', 'steward_finish'];
const directories: string[] = [];
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'steward-extension-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const delivery = { summary: '结果', done: ['完成'], notCovered: [], verification: ['通过'], howTo: [], issues: [] };
function mockTools(fetcher: typeof fetch, options: { attemptId?: string; config?: string } = {}) {
  const registerTool = vi.fn<ExtensionAPI['registerTool']>();
  const shutdown = vi.fn();
  registerSteward({ registerTool } as unknown as ExtensionAPI, {
    env: { STEWARD_ATTEMPT_ID: options.attemptId, STEWARD_CONFIG: options.config }, fetcher,
  });
  return { registerTool, shutdown, call: (name: string, args = {}) => {
    const tool = registerTool.mock.calls.map(([entry]) => entry).find((entry) => entry.name === name);
    if (!tool) throw new Error('工具未注册');
    return tool.execute('test-call', args, undefined, undefined, { shutdown } as unknown as Parameters<typeof tool.execute>[4]);
  } };
}
function configFile() {
  const file = join(workspace(), 'config.json');
  const token = `stm_${randomBytes(32).toString('base64url')}`;
  writeFileSync(file, JSON.stringify({ platformUrl: 'https://steward.example', machineToken: token,
    slots: 1, projects: [], path: ['/usr/bin'], pi: { command: 'pi', extraArgs: [] } }), { mode: 0o600 });
  return file;
}

it('手动会话或无效执行编号不注册工具', () => {
  expect(mockTools(vi.fn()).registerTool).not.toHaveBeenCalled();
  expect(mockTools(vi.fn(), { attemptId: 'bogus' }).registerTool).not.toHaveBeenCalled();
});

it('Pi 1.5.2 的资源加载器可以加载编译后的正式扩展并注册全部工具', async () => {
  const directory = workspace();
  vi.stubEnv('STEWARD_ATTEMPT_ID', randomUUID());
  const extension = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, additionalExtensionPaths: [extension],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  expect(errors).toHaveLength(0);
  expect(extensions.length).toBe(1);
  expect([...extensions[0]!.tools.keys()]).toEqual(toolNames);
}, 10_000);

it('交付未开始、失败和请求未完成时拦截 finish，确认成功后才 shutdown', async () => {
  let unblock: (response: Response) => void = () => { throw new Error('交付请求没有发出'); };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: { code: 'internal_error', message: '不可回显的诊断内容' } }, { status: 500 }))
    .mockImplementationOnce(() => new Promise((resolve) => { unblock = resolve; }));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  expect((await agent.call('steward_finish')).details).toEqual({ code: 'delivery_required' });
  const failure = await agent.call('steward_deliver', delivery);
  expect(failure.details).toEqual({ code: 'internal_error' });
  expect(JSON.stringify(failure)).not.toContain('不可回显的诊断内容');
  expect((await agent.call('steward_finish')).details).toEqual({ code: 'delivery_required' });
  const pending = agent.call('steward_deliver', delivery);
  expect((await agent.call('steward_finish')).details).toEqual({ code: 'delivery_required' });
  expect(agent.shutdown).not.toHaveBeenCalled();
  const saved = { deliveryId: randomUUID(), version: 1 };
  unblock(Response.json(saved));
  expect((await pending).details).toEqual(saved);
  expect((await agent.call('steward_finish')).details).toEqual({ ok: true });
  expect(agent.shutdown).toHaveBeenCalledTimes(1);
});

it('重载扩展后交付重试保留每次尝试固定的请求 ID 和载荷', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('网络错误详情'))
    .mockImplementation(async () => Response.json({ deliveryId: randomUUID(), version: 1 }));
  const config = configFile();
  const attemptId = randomUUID();
  const first = await mockTools(fetcher, { attemptId, config }).call('steward_deliver', delivery);
  expect(first.details).toEqual({ code: 'network_error' });
  const second = mockTools(fetcher, { attemptId, config });
  expect(second.shutdown).not.toHaveBeenCalled();
  await second.call('steward_deliver', delivery);
  await mockTools(fetcher, { attemptId: randomUUID(), config }).call('steward_deliver', delivery);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(uuidSchema.safeParse(bodies[0].requestId).success).toBe(true);
  expect(bodies[0].requestId).not.toBe(bodies[2].requestId);
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('X-Steward-Attempt-Id')).toBe(attemptId);
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

it('配置文件权限不安全时不发送请求，问题编号不会被拼成任意路由', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const config = configFile();
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config });
  expect((await agent.call('steward_question_update', { questionId: '../../context', status: 'resolved' })).details)
    .toEqual({ code: 'invalid_request' });
  chmodSync(config, 0o644);
  expect((await agent.call('steward_task')).details).toEqual({ code: 'invalid_config' });
  expect(fetcher.mock.calls).toHaveLength(0);
});

it.each([
  ['steward_progress', { text: '进展' }, { ok: true }],
  ['steward_ask', { text: '问题', context: '上下文' }, { questionId: randomUUID() }],
  ['steward_question_update', { questionId: randomUUID(), status: 'resolved' }, { ok: true }],
  ['steward_decision', { text: '决定', confirmedByUser: true }, { ok: true }],
] as const)('%s 在丢结果时同参重试，成功后的独立写入使用新 ID', async (tool, args, response) => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('模拟丢失响应'))
    .mockResolvedValueOnce(Response.json({ error: { code: 'unauthorized', message: '模拟认证失败' } }, { status: 401 }))
    .mockImplementation(async () => Response.json(response));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  expect((await agent.call(tool, args)).details).toEqual({ code: 'network_error' });
  expect((await agent.call(tool, args)).details).toEqual({ code: 'unauthorized' });
  expect((await agent.call(tool, args)).details).toEqual(response);
  expect((await agent.call(tool, args)).details).toEqual(response);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual(bodies[2]);
  expect(bodies[3].requestId).not.toBe(bodies[0].requestId);
});

it('并发同参写入共享同一请求，同参进展和决定各用独立请求', async () => {
  let unblock: (value: Response) => void = () => { throw new Error('请求没有发出'); };
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { unblock = resolve; }))
    .mockImplementation(async () => Response.json({ ok: true }));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  const first = agent.call('steward_progress', { text: '同参' });
  const second = agent.call('steward_progress', { text: '同参' });
  await expect(agent.call('steward_decision', { text: '同参', confirmedByUser: false })).resolves.toMatchObject({ details: { ok: true } });
  expect(fetcher.mock.calls).toHaveLength(2);
  unblock(Response.json({ ok: true }));
  expect((await Promise.all([first, second])).map(({ details }) => details)).toEqual([{ ok: true }, { ok: true }]);
  const ids = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).requestId);
  expect(new Set(ids).size).toBe(2);
});

it('待确认写入达到容量时限制新请求，保留已有请求 ID 供重试', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('模拟丢失响应'));
  const agent = mockTools(fetcher, { attemptId: randomUUID(), config: configFile() });
  const calls = await Promise.all(Array.from({ length: 128 }, (_, index) => agent.call('steward_progress', { text: `进展 ${index}` })));
  expect(calls.every(({ details }) => (details as { code: string }).code === 'network_error')).toBe(true);
  expect((await agent.call('steward_progress', { text: '新进展' })).details).toEqual({ code: 'pending_writes_full' });
  const first = fetcher.mock.calls[0]?.[1]?.body;
  expect(fetcher.mock.calls).toHaveLength(128);
  fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
  expect((await agent.call('steward_progress', { text: '进展 0' })).details).toEqual({ ok: true });
  expect(fetcher.mock.lastCall?.[1]?.body).toBe(first);
  fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
  expect((await agent.call('steward_progress', { text: '新进展' })).details).toEqual({ ok: true });
});
