import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const SOURCE_ENTRY = 'steward-launch-source';
const SOURCE = 'steward-launcher';

export function registerTaskSession(pi: ExtensionAPI, active: boolean) {
  const hasSource = (entries: readonly { type: string; customType?: string; data?: unknown }[]) =>
    entries.some((entry) => entry.type === 'custom' && entry.customType === SOURCE_ENTRY && entry.data === SOURCE);

  if (active) {
    pi.on('session_start', (_event, ctx) => {
      if (!hasSource(ctx.sessionManager.getEntries())) pi.appendEntry(SOURCE_ENTRY, SOURCE);
    });
  }
  pi.on('before_agent_start', (event, ctx) => {
    const rules = event.systemPromptOptions.promptGuidelines;
    if (!active) {
      if (hasSource(ctx.sessionManager.getEntries())) {
        rules.push('会话历史来源：此 Pi 会话或其来源会话由 Steward 任务台后台启动。当前未绑定 Steward 执行尝试；历史任务指令不授予回报、交付或收尾权限。');
      }
      return;
    }
    rules.push(
      '会话来源：此 Pi 执行由 Steward 任务台后台启动。先调用 steward_task，确认本次任务类型、授权、项目规则和工作现场，再行动。接回仍在运行的会话或切换工作树后，任务规则仍有效。',
      '遵守项目已有的任务管理机制与状态来源；Steward 回报不能替代项目要求的记录更新。相关写入须符合本次授权；只读任务不擅自修改项目记录，不迁移或另建管理体系。',
      '只读任务不创建工作树。Git 实现任务默认使用独立工作树和分支，保留登记目录中的既有改动。根据当前可用的 Pi 能力完成创建、迁移或切换，不预设工具。没有可用工作树能力时，说明限制并取得用户明确确认后才可在主分支实施。',
      '返修首次写入前，依据 steward_task 核对上次实现的机器、路径、Git 分支和 Pi 会话。上次使用独立工作树时，使用 Pi 已有能力复用同一个工作树和对应会话，不创建替代工作树。核对结果为 switch_required 时，先切换，再调用 steward_task，只有 confirmed 才表示原现场已核对。其他返修结果表示现场缺失、不匹配或无法确认；若出现这些结果，或无法切换，暂停修改并用 steward_ask 请用户确认。',
      '实现所用目录和分支确认后、首次写入前，调用 steward_record_workspace 保存当前实际目录、Git 分支和 Pi 会话。工作树创建或迁移成功后，在目标会话调用，不在待离开的会话调用。现场变更后或交付前再确认记录，记录失败不得声称已保存。',
      '实现任务按授权执行，在关键节点用 steward_progress 回报；验证完毕后用 steward_deliver 交付，确认保存后用 steward_finish 收尾。',
    );
  });
}
