import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const [extensionFlag, extension, sessionFlag, session, nameFlag, displayName, marker, instruction] = process.argv.slice(2);
  const attemptId = process.env.STEWARD_ATTEMPT_ID;
  if (!attemptId || !process.env.STEWARD_CONFIG || extensionFlag !== '-e' || !['--session-id', '--session'].includes(sessionFlag) ||
      nameFlag !== '-n' || marker !== '--' || !extension || !session || !displayName || !instruction ||
      process.argv.length !== 10 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(displayName)) throw new Error();
  const config = realpathSync(process.env.STEWARD_CONFIG);
  const cwd = realpathSync(process.cwd());
  if (!cwd.startsWith(`${dirname(config)}/`) || !cwd.endsWith('/中文 project #{pane_id};')) throw new Error();
  const { default: load } = await import(pathToFileURL(extension).href);
  const tools = new Map();
  load({ registerTool: (tool) => tools.set(tool.name, tool), on: () => () => {} });
  let stopped = false;
  async function call(tool, args = {}) {
    const result = await tools.get(`steward_${tool}`).execute(`fake-${tool}`, args, undefined, undefined, { shutdown: () => { stopped = true; } });
    return result.details;
  }
  if ((await call('finish')).code !== 'delivery_required' || stopped) throw new Error();
  const context = await call('task');
  const rework = context.attempt.kind === 'rework';
  if (context.attempt.id !== attemptId || !context.task.goal.startsWith('@完整正文') || context.task.goal.length < 40_000 ||
      !instruction.startsWith(`${rework ? '返修' : '开始执行'}本任务。先调用 steward_task`) || instruction.includes('@完整正文')) throw new Error();
  const firstId = rework ? context.deliveries[0]?.attemptId : attemptId;
  const sessionFile = rework ? session : join(cwd, `${session}.jsonl`);
  if (!rework) writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: session, cwd })}\n`);
  const header = JSON.parse(readFileSync(sessionFile, 'utf8').split('\n', 1)[0]);
  if (header.id !== `steward-${firstId}` || header.cwd !== cwd ||
      sessionFlag !== (rework ? '--session' : '--session-id') ||
      (rework && context.deliveries[0]?.feedback !== '请验证返修')) throw new Error();
  const local = JSON.parse(readFileSync(config, 'utf8'));
  const response = await fetch(`${local.platformUrl}/api/v1/agent/session`, { method: 'POST',
    headers: { Authorization: `Bearer ${local.machineToken}`, 'X-Steward-Attempt-Id': attemptId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: crypto.randomUUID(), locator: { path: cwd, sessionId: header.id, sessionFile } }),
    signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new Error();
  if (!(await call('progress', { text: rework ? '假 Agent 返修进展' : '假 Agent 开工进展' })).ok) throw new Error();
  const report = await call('deliver', { summary: '假 Agent 交付', done: ['完成'], notCovered: [], verification: ['冒烟'], howTo: [], issues: [] });
  if (!report.deliveryId || report.version !== (rework ? 2 : 1)) throw new Error();
  if (!(await call('finish')).ok || !stopped) throw new Error();
}

main().catch(() => { process.exitCode = 1; });
