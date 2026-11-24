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
  pi.on('session_start', (_event, ctx) => {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const { signal } = controller;
    async function send() {
      const locator = await currentSessionLocator(ctx, resumed);
      if (!locator) return;
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
    void send().catch(() => undefined);
  });
  pi.on('session_shutdown', () => active?.abort());
}
