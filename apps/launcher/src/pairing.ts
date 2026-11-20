import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import * as c from '@pi-steward/contract';
import { platformFetch, PlatformTransportError } from '@pi-steward/platform-http';
import type { z } from 'zod';
import { readConfig, writeConfig } from './config.js';
import { launcherPath } from './service.js';

const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_WAIT_MS = 12 * 60_000;
const newToken = () => `stm_${randomBytes(32).toString('base64url')}`;

function client(origin: string, proxy?: c.PlatformProxy, fetcher?: typeof fetch) {
  async function post<T>(operation: string, input: object, output: z.ZodType<T>) {
    let response: Response;
    try {
      const url = `${origin}/api/v1/pairing/${operation}`;
      const init: RequestInit = { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
      response = await (fetcher ? fetcher(url, init) : platformFetch(url, init, proxy));
    } catch (error) {
      if (error instanceof PlatformTransportError) {
        if (error.code === 'helper_unavailable') throw new Error('缺少 Steward 系统代理组件，请重新安装 Steward。');
        if (error.code === 'proxy_unsupported') throw new Error('显式代理需要 Node 24.20.0 或更高版本。');
      }
      throw new Error('无法连接 Steward。稍后可再次运行 stew pair 继续。');
    }
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = c.errorResponseSchema.safeParse(data);
      if (error.data?.error.code === 'conflict') throw new Error('此电脑的配对请求与已有记录冲突，请在 Steward 中核对。');
      if (error.data?.error.code === 'rate_limited') throw new Error('配对请求过多，请稍后重试。');
      throw new Error('Steward 无法处理配对请求，请检查平台地址和版本。');
    }
    const parsed = output.safeParse(data);
    if (!parsed.success) throw new Error('Steward 返回了无效的配对结果。');
    return parsed.data;
  }
  return {
    create: (name: string, tokenHash: string) => post('create', c.createPairingRequestSchema.parse({ name, tokenHash }), c.createPairingResponseSchema),
    status: (machineToken: string) => post('status', { machineToken }, c.pairingStatusResponseSchema),
  };
}

export async function pairMachine(options: {
  path: string; name: string; origin: string; allowHttpLoopback?: true; proxy?: c.PlatformProxy;
  display: (code: string) => void; fetcher?: typeof fetch;
  elapsed?: () => number; wait?: () => Promise<unknown>;
}) {
  const { path, name, origin } = options;
  const pendingPath = `${path}.pairing`;
  const existing = readConfig(path, true);
  if (existing && new URL(existing.platformUrl).origin !== origin) {
    throw new Error('这台电脑已配置其他 Steward 平台，请检查本地配置。');
  }
  if (existing && (await client(origin, options.proxy ?? existing.proxy, options.fetcher).status(existing.machineToken)).status === 'approved') {
    if (options.proxy) writeConfig(path, { ...existing, proxy: options.proxy }, true);
    rmSync(pendingPath, { force: true });
    return;
  }
  let config = readConfig(pendingPath, true);
  if (config && config.platformUrl !== origin) throw new Error('尚有其他 Steward 平台的配对请求，请先在原地址继续。');
  const proxy = options.proxy ?? config?.proxy ?? existing?.proxy;
  const api = client(origin, proxy, options.fetcher);
  if (!config) {
    config = c.localConfigSchema.parse({ slots: 1, projects: [], pi: { command: 'pi', extraArgs: [] }, path: launcherPath(),
      ...existing, platformUrl: origin, allowHttpLoopback: options.allowHttpLoopback, machineToken: newToken(), proxy });
    // 先落盘再发请求，确认后断网或退出时仍可用原凭据继续配对。
    writeConfig(pendingPath, config);
  } else if (options.proxy) {
    config = { ...config, proxy: options.proxy };
    writeConfig(pendingPath, config, true);
  }
  const elapsed = options.elapsed ?? (() => performance.now());
  const wait = options.wait ?? (() => sleep(POLL_INTERVAL_MS));
  if ((await api.status(config.machineToken)).status !== 'approved') {
    const hashed = createHash('sha256').update(config.machineToken).digest('hex');
    // 配对后的显示名区分同名 Mac，并保留被撤销机器的历史记录。
    const fingerprint = createHash('sha256').update('steward:machine-name:').update(config.machineToken).digest('hex').slice(0, 8);
    const displayName = `${name.slice(0, 116).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()} · ${fingerprint}`;
    const { code } = await api.create(displayName, hashed);
    options.display(code);
    const deadline = elapsed() + MAX_WAIT_MS;
    for (;;) {
      const { status } = await api.status(config.machineToken);
      if (status === 'approved') break;
      if (status === 'expired') throw new Error('配对码已过期。请再次运行 stew pair 获取新码。');
      if (elapsed() >= deadline) throw new Error('等待配对确认超时。请再次运行 stew pair 核对。');
      await wait();
    }
  }
  writeConfig(path, config, Boolean(existing));
  rmSync(pendingPath, { force: true });
}
