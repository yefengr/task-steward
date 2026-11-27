import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const tool = (name, args = {}) => ({ type: 'toolCall', id: randomUUID(), name, arguments: args });
const text = (value) => ({ type: 'text', text: value });
function reply(messages) {
  const last = messages.findLast((message) => !['system', 'assistant'].includes(message.role));
  if (last?.role === 'toolResult') {
    if (last.isError || last.content.some((block) => block.type === 'text' && block.text.includes('请求失败'))) return text('前台冒烟工具失败');
    if (last.toolName === 'steward_begin_task') return text('前台目标已纳管，保持普通 Pi。');
    if (last.toolName === 'steward_task') return tool('write', { path: process.env.STEWARD_SMOKE_WRITE, content: 'same native conversation continued\n' });
    if (last.toolName === 'write') return tool('steward_progress', { text: '原对话安全接续，已核对中断结果。' });
    return text('后台接续完成，等待用户。');
  }
  const content = typeof last?.content === 'string' ? last.content : last?.content?.map((block) => block.text ?? '').join('');
  if (content?.includes('核对期间原 Pi 回报')) return tool('steward_progress', { text: '核对期间的前台回报' });
  if (content?.includes('拒绝接管后原 Pi 回报')) return tool('steward_progress', { text: '原 Pi 保持绑定，无需重新登记即可回报。' });
  if (content?.includes('用户已授权在原会话接续本任务')) return tool('steward_task');
  if (content?.includes('开始前台目标')) return tool('steward_begin_task', {
    title: 'Native foreground smoke', goal: '隔离验证前台纳管及原对话后台继续', type: 'discussion', transition: 'continue',
  });
  return text('普通问答不创建目标。');
}
export default function provider(pi) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider('foreground-smoke', { baseUrl: 'http://127.0.0.1', apiKey: 'local-fixture', api: 'foreground-smoke-api',
    models: [{ id: 'local', name: 'Local foreground smoke', reasoning: false, input: ['text'], cost, contextWindow: 32768, maxTokens: 2048 }],
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
      stream.push({ type: 'done', reason: result.stopReason, message: result }); stream.end(); return stream;
    },
  });
}
