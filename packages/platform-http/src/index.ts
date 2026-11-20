import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PlatformProxy } from '@pi-steward/contract';
import { nodeRequest, platformResponse, PlatformTransportError, RESPONSE_LIMIT, type PlatformRequest } from './node-request.js';

export { PlatformTransportError };

export const SYSTEM_PROXY = { mode: 'system' } as const;
const HELPER = fileURLToPath(new URL('./steward-http', import.meta.url));
const STDOUT_LIMIT = Math.ceil(RESPONSE_LIMIT / 3) * 4 + 1024;

function nativeRequest(input: PlatformRequest, signal?: AbortSignal | null): Promise<Response> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(HELPER, { stdio: ['pipe', 'pipe', 'ignore'], signal: signal ?? undefined, killSignal: 'SIGKILL' });
    const chunks: Buffer[] = [];
    let size = 0;
    let limited = false;
    const failed = () => reject(signal?.aborted ? signal.reason : new Error('Steward HTTPS request failed'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') reject(new PlatformTransportError('helper_unavailable'));
      else failed();
    });
    child.stdin.on('error', failed);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_LIMIT) {
        if (!limited) child.kill('SIGKILL');
        limited = true;
      } else chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (limited) return reject(new PlatformTransportError('invalid_response'));
      if (code !== 0) return failed();
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { status?: number; bodyBase64?: string; error?: string };
        if (result.error === 'network_error' || result.error === 'timeout') return failed();
        if (typeof result.status !== 'number' || typeof result.bodyBase64 !== 'string') throw new PlatformTransportError('invalid_response');
        resolve(platformResponse(result.status, Buffer.from(result.bodyBase64, 'base64')));
      } catch { reject(new PlatformTransportError('invalid_response')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function platformFetch(url: string, init: RequestInit, proxy: PlatformProxy = SYSTEM_PROXY): Promise<Response> {
  if (init.body != null && typeof init.body !== 'string') throw new Error('Steward requests require a JSON string body');
  const input: PlatformRequest = { url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)),
    body: init.body ?? undefined };
  // macOS 系统模式交给 URLSession 处理 PAC、代理与例外规则。其他模式由独立 Agent 处理。
  return proxy.mode === 'system' && process.platform === 'darwin' ?
    nativeRequest(input, init.signal) : nodeRequest(input, proxy, init.signal);
}
