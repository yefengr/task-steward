import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const tool = (name, args = {}) => ({ type: 'toolCall', id: randomUUID(), name, arguments: args });
const text = (value) => ({ type: 'text', text: value });
const report = (summary) => ({ summary, done: ['已核对隔离现场'], notCovered: [], verification: ['确定性本地 Pi 回归'], howTo: [], issues: [] });
const content = (message) => typeof message?.content === 'string' ? message.content :
  message?.content?.map((part) => part.text ?? '').join('') ?? '';
function data(message) {
  try { return JSON.parse(content(message)); } catch { return {}; }
}
function reply(messages) {
  const last = messages.findLast((message) => !['system', 'assistant'].includes(message.role));
  const instruction = content(messages.findLast((message) => message.role === 'user'));
  if (last?.role === 'toolResult') {
    const result = data(last);
    if (last.isError || result.code) return text(`隔离生命周期工具失败：${result.code ?? last.toolName}`);
    if (last.toolName === 'steward_task') {
      if (result.task?.type === 'discussion') return text('隔离占位讨论保持进行中，不自动结束。');
      if (result.phase === 'settled' || result.settled) {
        const delivery = result.deliveries?.at(-1);
        if (instruction.includes('仅补记录')) return tool('steward_revise_delivery', {
          ...report('仅补已有验证记录'), deliveryId: delivery.id, reason: '用户要求仅补记录，不重做实施', authorizedByUser: true,
          ...(delivery.commit ? { commit: delivery.commit } : {}), ...(delivery.baseCommit ? { baseCommit: delivery.baseCommit } : {}),
        });
        if (instruction.includes('明确授权续做')) return tool('steward_continue', {
          deliveryId: delivery.id, reason: '用户明确授权在原会话继续隔离验证', authorizedByUser: true,
        });
        return text('本轮已结算，保留 Pi 等待用户。');
      }
      if (result.attempt?.kind === 'resume') return tool('write', { path: process.env.STEWARD_SMOKE_PROOF, content: 'same conversation resumed safely\n' });
      if (instruction.includes('续做后等待暂停')) return tool('steward_progress', { text: '已取得新工作段权限，等待主动暂停。' });
      return tool('steward_record_workspace');
    }
    if (last.toolName === 'steward_continue') return tool('steward_task');
    if (last.toolName === 'steward_record_workspace' || last.toolName === 'write') return tool('steward_deliver', report('隔离生命周期实施完成'));
    if (last.toolName === 'steward_deliver') return tool('steward_finish');
    return text('隔离生命周期回合完成，Pi 保持运行。');
  }
  return tool('steward_task');
}
export default function provider(pi) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider('lifecycle-smoke', { baseUrl: 'http://127.0.0.1', apiKey: 'local-fixture', api: 'lifecycle-smoke-api',
    models: [{ id: 'local', name: 'Local lifecycle smoke', reasoning: false, input: ['text'], cost, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple(model, { messages }) {
      const block = reply(messages);
      const result = { role: 'assistant', content: [block], api: model.api, provider: model.provider, model: model.id,
        usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } }, stopReason: block.type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: result });
      if (block.type === 'toolCall') {
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: result });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: result });
      } else {
        stream.push({ type: 'text_start', contentIndex: 0, partial: result });
        stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: result });
      }
      stream.push({ type: 'done', reason: result.stopReason, message: result });
      stream.end(); return stream;
    },
  });
}
