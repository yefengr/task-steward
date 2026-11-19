/**
 * Pi Steward 启动方式验证用探针扩展，只用于 V1、V3、V4 真机验证，不是正式的任务扩展。
 *
 * 记录启动器经环境变量传入的执行编号、Pi 实际使用的会话标识与退出过程，
 * 并提供一个请求 Pi 正常退出的工具，用来验证「Agent 收尾后由内部结束进程」。
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 记录写到 tmux 之外的文件，进程退出后仍可核对
const LOG_PATH = process.env.STEWARD_PROBE_LOG ?? "/tmp/steward-probe.log";

function record(event: string, details: Record<string, unknown> = {}): void {
  const line = { at: new Date().toISOString(), pid: process.pid, event, ...details };
  appendFileSync(LOG_PATH, `${JSON.stringify(line)}\n`);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    record("session_start", {
      attemptId: process.env.STEWARD_ATTEMPT_ID ?? null,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      cwd: ctx.sessionManager.getCwd(),
      mode: ctx.mode,
    });
  });

  pi.on("session_shutdown", () => {
    record("session_shutdown");
  });

  pi.registerTool({
    name: "steward_probe_finish",
    label: "Steward Probe Finish",
    description: "验证用：任务收尾完成后调用，请求 Pi 在本次回复结束后正常退出",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      record("finish_requested", { sessionId: ctx.sessionManager.getSessionId() });
      // 官方说明：退出会推迟到 Agent 空闲后执行
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "已请求退出，本次回复结束后 Pi 将关闭。" }],
        details: {},
      };
    },
  });
}
