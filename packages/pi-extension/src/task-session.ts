import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const SOURCE_ENTRY = 'steward-launch-source';
const SOURCE = 'steward-launcher';

export function registerTaskSession(pi: ExtensionAPI, active: boolean | (() => false | 'foreground' | 'background')) {
  const mode = () => typeof active === 'function' ? active() : active ? 'background' : false;
  const hasSource = (entries: readonly { type: string; customType?: string; data?: unknown }[]) =>
    entries.some((entry) => entry.type === 'custom' && entry.customType === SOURCE_ENTRY && entry.data === SOURCE);

  pi.on('session_start', (_event, ctx) => {
    if (mode() === 'background' && !hasSource(ctx.sessionManager.getEntries())) pi.appendEntry(SOURCE_ENTRY, SOURCE);
  });
  pi.on('before_agent_start', (event, ctx) => {
    const rules = event.systemPromptOptions.promptGuidelines;
    if (!mode()) {
      rules.push('Steward 前台：遇到明确工作目标先自动调用 steward_begin_task 登记；普通随口问答不建任务。历史目标须重新取得执行权；失败时不得继续实施。新目标离线可按本地授权工作，但须明确尚未纳管。');
      if (hasSource(ctx.sessionManager.getEntries())) {
        rules.push('会话历史来源：此 Pi 会话由 Steward 任务台后台启动。当前未绑定执行尝试；如需继续历史目标，用 steward_begin_task 取得执行权。');
      }
      return;
    }
    rules.push(
      mode() === 'foreground' ? 'Steward 当前为前台目标：先调用 steward_task 读取本次目标、任务类型和授权；切换未结束目标先 steward_interrupt_task，等待回复不算中断。' :
        '此 Pi 由 Steward 任务台后台启动：先调用 steward_task 读取本次目标、任务类型和授权；接续或切换工作树后同样先读任务。',
      '遵守任务授权、项目规则及已有任务管理机制；Steward 回报不替代项目记录，不另建状态体系。只读任务不改项目记录、不创建工作树或提交；需要用户回应时用 steward_ask 记录问题，再在当前会话提问并等待。',
      'Git 代码写入前调用 steward_prepare_git，按工具返回的指引准备或复用 Pi 工作树和原会话；现场由工具自动登记，核对失败按指引处理，不在主分支绕过。用户验收后由启动器合入和清理；Agent 不自行合入、清理或推送，不创建空提交。',
      '实现任务按授权执行、验证，关键节点用 steward_progress 回报，steward_deliver 保存后 steward_finish 结算。讨论只围绕目标交流：用户明确表达结束时由 Agent 判断并调用 steward_end_discussion 登记；确认后先说明「将保存以下结论并结束」及摘要，不另行提问，再交付与结算。已有结论、回合结束或无人回复不算结束。steward_finish 不退出 Pi；后台仅在工具指引的暂停或最终验收关闭时退出。',
    );
  });
}
