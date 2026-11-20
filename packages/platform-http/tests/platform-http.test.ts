import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { platformFetch } from '../dist/index.js';

const servers: Server[] = [];

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }));
});

it.each(['system', 'direct'] as const)('%s 保留请求正文、凭据和 HTTP 错误响应', async (mode) => {
  const server = createServer(async (request, response) => {
    request.setEncoding('utf8');
    let body = '';
    for await (const chunk of request) body += chunk as string;
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify([request.method, request.headers.authorization, JSON.parse(body)]));
  });
  const origin = await listen(server);
  const response = await platformFetch(`${origin}/test`, {
    method: 'PATCH', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: '{"text":"中文"}', signal: AbortSignal.timeout(2000),
  }, { mode });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual(['PATCH', 'Bearer fixture', { text: '中文' }]);
});

it.each(['system', 'direct'] as const)('%s 拒绝跳转，凭据不会发往跳转目标', async (mode) => {
  const redirected = vi.fn();
  const target = await listen(createServer((_request, response) => { redirected(); response.end(); }));
  const start = await listen(createServer((_request, response) => response.writeHead(307, { Location: target }).end()));
  await expect(platformFetch(start, { headers: { Authorization: 'Bearer fixture' }, signal: AbortSignal.timeout(2000) }, { mode })).rejects.toThrow();
  expect(redirected).not.toHaveBeenCalled();
});

it('显式代理对 HTTPS 发 CONNECT，代理拒绝后不会尝试直连目标', async () => {
  const direct = vi.fn();
  const target = await listen(createServer().on('connection', direct));
  const requests: unknown[] = [];
  const proxy = await listen(createServer().on('connect', (request, socket) => {
    requests.push([request.url, request.headers.authorization]);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  }));
  const url = new URL(target);
  url.protocol = 'https:';
  await expect(platformFetch(url.href, { headers: { Authorization: 'Bearer fixture' }, signal: AbortSignal.timeout(2000) },
    { mode: 'custom', url: proxy })).rejects.toThrow();
  expect(requests).toEqual([[url.host, undefined]]);
  expect(direct).not.toHaveBeenCalled();
});

it('旧版 Node 不支持显式代理时在发请求前失败', async () => {
  const targetContact = vi.fn();
  const origin = await listen(createServer().on('connection', targetContact));
  const versions = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  Object.defineProperty(process.versions, 'node', { ...versions, value: '22.0.0' });
  try {
    await expect(platformFetch(origin, { signal: AbortSignal.timeout(2000) }, { mode: 'custom', url: origin }))
      .rejects.toMatchObject({ code: 'proxy_unsupported' });
    expect(targetContact).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process.versions, 'node', versions); }
});

it.each(['system', 'direct'] as const)('%s 请求可在等待响应时取消', async (mode) => {
  const server = createServer();
  const origin = await listen(server);
  const seen = once(server, 'request');
  const cancel = new AbortController();
  const response = platformFetch(origin, { signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(2000)]) }, { mode });
  const result = expect(response).rejects.toMatchObject({ name: 'AbortError' });
  await seen;
  cancel.abort();
  await result;
});
