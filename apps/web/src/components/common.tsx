import { Alert, Button, Loader } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Task } from '@pi-steward/contract';
import { Clock, MessageCircle, TriangleAlert } from 'lucide-react';
import { describeError } from '../lib/api';
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
    {describeError(error, t)}{retry && <Button variant="subtle" size="xs" onClick={retry}>{t.common.retry}</Button>}
  </Alert>;
}

export function StatusChip({ status }: { status: Task['status'] }) {
  const { t } = useI18n();
  return <span className={`chip status-${status}`}>{t.statuses[status]}</span>;
}

export function TaskFlags({ task }: { task: Task }) {
  const { t } = useI18n();
  return <>
    {task.needsResponse && <span className="chip status-review"><MessageCircle size={13} />{t.task.needsResponse}</span>}
    {task.needsVerification && <span className="chip status-interrupted"><TriangleAlert size={13} />{t.task.needsVerification}</span>}
  </>;
}

export function WaitReason({ task }: { task: Task }) {
  const { t } = useI18n();
  return <span className="wait-reason"><Clock size={14} />{t.waiting[task.waiting ?? 'ready']}</span>;
}
