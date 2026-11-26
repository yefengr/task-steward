import { Alert, Button, Loader } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Task, TaskGit } from '@pi-steward/contract';
import { Clock, MessageCircle, TriangleAlert } from 'lucide-react';
import { describeError } from '../lib/api';
import { isIntegrationPhase } from '../lib/git';
import { useI18n } from '../lib/i18n';

export function Brand() {
  return <div className="brand"><img src="/steward.svg" width="20" height="20" alt="" /><span>Task Steward</span></div>;
}

export function Loading() {
  const { t } = useI18n();
  return <div className="empty loading" role="status"><Loader size="xs" />{t.common.loading}</div>;
}

export function Empty({ title, children }: { title?: string; children?: ReactNode }) {
  return <div className="empty">{title && <strong>{title}</strong>}{children}</div>;
}

export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useI18n();
  if (!error) return null;
  return <Alert className="error-notice" variant="light" color="red" role="alert">
    {describeError(error, t)}{retry && <Button variant="transparent" onClick={retry}>{t.common.retry}</Button>}
  </Alert>;
}

const gitChipClasses = {
  awaiting_merge: 'status-review', merge_blocked: 'status-interrupted', needs_rework: 'status-interrupted',
  cleanup_pending: 'status-review', cleanup_blocked: 'status-interrupted', complete: 'status-done',
} as const;

// 已验收交付进入集成阶段后，用集成状态替代「待验收」，避免误导用户重复验收。
export function StatusChip({ task }: { task: Task }) {
  const { t } = useI18n();
  const git = task.git;
  if (git && isIntegrationPhase(git.phase) && Object.hasOwn(gitChipClasses, git.phase)) {
    return <span className={`chip ${gitChipClasses[git.phase as keyof typeof gitChipClasses]}`}>{t.git.phases[git.phase]}</span>;
  }
  return <span className={`chip status-${task.status}`}>{t.statuses[task.status]}</span>;
}

// 执行中的 Git 状态单独展示，与核心任务状态并存。
export function GitPhaseChip({ git }: { git: TaskGit }) {
  const { t } = useI18n();
  if (isIntegrationPhase(git.phase)) return null;
  return <span className="chip">{t.git.phases[git.phase]}</span>;
}

export function TaskTypeLabel({ task }: { task: Task }) {
  const { t } = useI18n();
  return <span>{t.taskTypes[task.type]}</span>;
}

export function TaskFlags({ task }: { task: Task }) {
  const { t } = useI18n();
  return <>
    {task.needsResponse && <span className="chip status-review"><MessageCircle size={16} />{t.task.responseFlag}</span>}
    {task.discussionEndRequested && <span className="chip status-review">{t.task.discussionEndRequested}</span>}
    {task.needsVerification && <span className="chip status-interrupted"><TriangleAlert size={16} />{t.task.needsVerification}</span>}
  </>;
}

export function WaitReason({ task }: { task: Task }) {
  const { t } = useI18n();
  return <span className="wait-reason"><Clock size={16} />{t.waiting[task.waiting ?? 'ready']}</span>;
}
