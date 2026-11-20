import * as http from 'node:http';
import * as https from 'node:https';
import type { PlatformProxy } from '@pi-steward/contract';

export const RESPONSE_LIMIT = 32 * 1024 * 1024;

export class PlatformTransportError extends Error {
  constructor(readonly code: 'proxy_unsupported' | 'helper_unavailable' | 'invalid_response') {
    super(code);
  }
}
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function platformResponse(status: number, body: Buffer): Response {
  if (REDIRECT_STATUSES.has(status)) throw new Error('Steward platform redirected the request');
  return new Response(NULL_BODY_STATUSES.has(status) ? null : Uint8Array.from(body), { status });
}

export type PlatformRequest = { url: string; method: string; headers: Record<string, string>; body?: string };

export async function nodeRequest(input: PlatformRequest, proxy: PlatformProxy, signal?: AbortSignal | null): Promise<Response> {
  if (proxy.mode === 'custom') {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    // 旧版 Node 会忽略 proxyEnv，不能让显式代理意外变成直连。
    if (major < 24 || (major === 24 && minor < 20)) throw new PlatformTransportError('proxy_unsupported');
  }
  const url = new URL(input.url);
  const protocol = url.protocol === 'https:' ? https : http;
  // 显式代理失败时，由该 Agent 返回错误，不做直连重试。直连模式忽略终端的代理变量。
  const proxyEnv = proxy.mode === 'custom' ? { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url } : {};
  const agent = new protocol.Agent({ proxyEnv });
  const headers = { ...input.headers };
  if (input.body !== undefined) headers['content-length'] = String(Buffer.byteLength(input.body));
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = protocol.request(url, { method: input.method, headers, agent, signal: signal ?? undefined }, resolve);
      request.on('error', reject);
      request.end(input.body);
    });
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      length += chunk.length;
      if (length > RESPONSE_LIMIT) throw new Error('Steward platform response exceeds the limit');
      chunks.push(chunk);
    }
    return platformResponse(response.statusCode ?? 0, Buffer.concat(chunks, length));
  } finally { agent.destroy(); }
}
