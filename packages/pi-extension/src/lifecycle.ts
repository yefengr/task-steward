import type { AgentContextResponse, AgentControlResponse } from '@pi-steward/contract';

export type Permission = Pick<AgentContextResponse, 'workRevision' | 'settled' | 'implementationAllowed' | 'recordAllowed' | 'phase' | 'latestDeliveryId'>;
const readTools = new Set(['read', 'grep', 'find', 'ls', 'steward_task', 'steward_list_projects', 'steward_list_tasks', 'steward_get_task']);
export function isReadTool(tool: string): boolean { return readTools.has(tool); }
const controls = new Set(['steward_finish', 'steward_continue', 'steward_revise_delivery', 'steward_interrupt_task']);
const closing = new Set(['steward_progress', 'steward_decision', 'steward_ask', 'steward_question_update', 'steward_deliver']);

/** 未知工具按可能实施处理，包括 shell、子代理和工作树工具。 */
export function lifecycleBlocked(tool: string, state: Permission & Partial<Pick<AgentControlResponse, 'deliverySaved'>>): boolean {
  if (readTools.has(tool) || controls.has(tool)) return false;
  if (!state.settled && !['merging', 'complete', 'cleanup_pending', 'cleanup_blocked'].includes(state.phase ?? '') && closing.has(tool)) return false;
  return state.implementationAllowed === false || state.settled === true || state.deliverySaved === true ||
    (state.phase !== undefined && state.phase !== 'working');
}
