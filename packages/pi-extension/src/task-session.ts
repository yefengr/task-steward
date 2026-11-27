import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const SOURCE_ENTRY = 'steward-launch-source';
const SOURCE = 'steward-launcher';

export function registerTaskSession(pi: ExtensionAPI, active: boolean | (() => false | 'foreground' | 'background')) {
  const mode = () => typeof active === 'function' ? active() : active ? 'background' : false;
  const hasSource = (entries: readonly { type: string; customType?: string; data?: unknown }[]) =>
    entries.some((entry) => entry.type === 'custom' && entry.customType === SOURCE_ENTRY && entry.data === SOURCE);

  {
    pi.on('session_start', (_event, ctx) => {
      if (mode() === 'background' && !hasSource(ctx.sessionManager.getEntries())) pi.appendEntry(SOURCE_ENTRY, SOURCE);
    });
  }
  pi.on('before_agent_start', (event, ctx) => {
    const rules = event.systemPromptOptions.promptGuidelines;
    if (!mode()) {
      rules.push('Steward 前台：遇到明确工作目标先自动调用 steward_begin_task 登记；普通随口问答不建任务。已纳管历史不授予执行权，必须重新开始并取得当前所有权；失败时不得继续实施。新目标离线可本地工作，但须明确尚未纳管、没有平台权限。');
      if (hasSource(ctx.sessionManager.getEntries())) {
        rules.push('会话历史来源：此 Pi 会话或其来源会话由 Steward 任务台后台启动。当前未绑定 Steward 执行尝试；历史任务指令不授予回报、交付或收尾权限。');
      }
      return;
    }
    if (mode() === 'foreground') rules.push('Steward 当前为前台目标。先 steward_task 核对目标和权限；交付保存后 steward_finish 只解除本目标绑定，不退出 Pi，可以开始下一目标。需要切换未结束目标先显式 steward_interrupt_task；等待用户回复不算中断。');
    rules.push(
      mode() === 'foreground' ? '前台目标已取得当前执行权；会话历史不是权限。' : '会话来源：此 Pi 执行由 Steward 任务台后台启动。先调用 steward_task，确认本次任务类型、授权、项目规则和工作现场，再行动。接回仍在运行的会话或切换工作树后，任务规则仍有效。',
      '遵守项目已有的任务管理机制与状态来源；Steward 回报不能替代项目要求的记录更新。相关写入须符合本次授权；只读任务不擅自修改项目记录，不迁移或另建管理体系。',
      '只读任务不创建工作树或提交。新 Git 代码写入前先调用 steward_prepare_git({taskBranch})，将返回的精确 baseRef 和 taskBranch 交给现有 Pi worktree_create，再用 Pi 已有迁移/切换能力进入目标会话。不自行创建工作树或会话；缺少配置或能力时暂停，不能回退到主分支修改。已有快照返修必须复用原工作树和会话，不重设基线。用户验收后由启动器合入和清理；Agent 不自行合入、清理或推送，不创建空提交。',
      '返修首次写入前，依据 steward_task 核对上次实现的机器、路径、Git 分支和 Pi 会话。上次使用独立工作树时，使用 Pi 已有能力复用同一个工作树和对应会话，不创建替代工作树。核对结果为 switch_required 时，先切换，再调用 steward_task，只有 confirmed 才表示原现场已核对。其他返修结果表示现场缺失、不匹配或无法确认；若出现这些结果，或无法切换，暂停修改并用 steward_ask 请用户确认。',
      '实现所用目录和分支确认后、首次写入前，调用 steward_record_workspace 保存当前实际目录、Git 分支和 Pi 会话。工作树创建或迁移成功后，在目标会话调用，不在待离开的会话调用。现场变更后或交付前再确认记录，记录失败不得声称已保存。',
      '实现任务按授权执行，在关键节点用 steward_progress 回报；验证完毕后用 steward_deliver 交付。已准备 Git 的任务必须将 git rev-parse HEAD 的完整 SHA 作为 commit；baseCommit 可省略使用冻结快照，显式值必须一致。只读任务不要求提交。确认保存后用 steward_finish 收尾。',
    );
  });
}
