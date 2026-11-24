import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { okResponseSchema } from '@pi-steward/contract';
import type { AgentError, agentClient } from './client.js';
import { currentSessionLocator } from './workspace.js';

const RETRY_MS = 3_000;
const MAX_TRIES = 5;
const TERMINAL = new Set(['attempt_ended', 'not_found', 'invalid_request', 'invalid_response', 'forbidden']);

export function registerSessionReport(pi: ExtensionAPI, request: ReturnType<typeof agentClient>, resumed: boolean) {
  let active: AbortController | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }
  pi.on('session_start', (_event, ctx) => {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const { signal } = controller;
    async function send() {
      const locator = await currentSessionLocator(ctx, resumed);
      if (!locator || signal.aborted) return;
      const body = { requestId: randomUUID(), locator };
      for (let tries = 0; tries < MAX_TRIES && !signal.aborted; tries++) {
        try {
          await request('POST', 'session', okResponseSchema, body, signal);
          return;
        } catch (error) {
          if (TERMINAL.has((error as AgentError).code) || tries === MAX_TRIES - 1) return;
          await delay(RETRY_MS, undefined, { signal, ref: false });
        }
      }
    }
    // 只上报会话定位；不产生输入，也不阻塞 TUI 或 Pi Reach 的启动。
    void serial(send).catch(() => undefined);
  });
  pi.on('session_shutdown', () => active?.abort());
  return {
    workspace<T>(run: () => Promise<T>): Promise<T> {
      // 等待整轮启动确认（含重试）结束，避免丢失恢复所需的 loaded 信号。
      // 现场写入始终在旧定位之后；真正替换运行时仍由 shutdown 取消旧上报。
      return serial(run);
    },
  };
}
