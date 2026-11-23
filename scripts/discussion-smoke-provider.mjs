import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const tool = (name, args = {}) => ({ type: 'toolCall', id: randomUUID(), name: `steward_${name}`, arguments: args });
const text = (value) => ({ type: 'text', text: value });
const wrapUp = () => tool('deliver', { summary: '讨论结论：采用现有流程', done: [], issues: ['待确认下一步'],
  notCovered: [], verification: [], howTo: [] });

function reply(messages) {
  const last = messages.findLast((message) => !['system', 'assistant'].includes(message.role));
  if (last?.role === 'toolResult') {
    if (last.isError || last.content.some((block) => block.type === 'text' && block.text.includes('请求失败'))) return text('冒烟工具失败');
    if (last.toolName === 'steward_task') return text('普通讨论回合已完成');
    if (last.toolName === 'steward_ask') return text('请选择实施方案。');
    if (last.toolName === 'steward_deliver') return tool('finish');
    return text('冒烟回合已完成');
  }
  const content = typeof last?.content === 'string' ? last.content : last?.content?.map((block) => block.text ?? '').join('');
  if (content?.includes('用户已请求结束讨论') || content?.trim() === '结束讨论') return wrapUp();
  if (content === '提出问题') return tool('ask', { text: '请选择实施方案', context: '' });
  if (content?.includes('先调用 steward_task')) return tool('task');
  return text('普通讨论回合已完成');
}

export default function smokeProvider(pi) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider('steward-smoke', {
    baseUrl: 'http://127.0.0.1', apiKey: 'local-smoke-fixture', api: 'steward-smoke-api',
    models: [{ id: 'local', name: 'Local Steward smoke', reasoning: false, input: ['text'], cost, contextWindow: 32_768, maxTokens: 2_048 }],
    streamSimple(model, { messages }) {
      const stream = createAssistantMessageEventStream();
      const block = reply(messages);
      const result = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } }, stopReason: 'pending', timestamp: Date.now() };
      stream.push({ type: 'start', partial: result });
      if (block.type === 'toolCall') {
        result.content.push({ ...block, arguments: {} });
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: result });
        result.content[0] = block;
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: result });
      } else {
        result.content.push(text(''));
        stream.push({ type: 'text_start', contentIndex: 0, partial: result });
        result.content[0] = block;
        stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: result });
      }
      result.stopReason = block.type === 'toolCall' ? 'toolUse' : 'stop';
      stream.push({ type: 'done', reason: result.stopReason, message: result });
      stream.end();
      return stream;
    },
  });
}
