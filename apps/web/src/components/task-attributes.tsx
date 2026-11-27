import type { Task } from '@pi-steward/contract';
import { useI18n } from '../lib/i18n';

export function TaskAttributes({ task }: { task: Task }) {
  const { t } = useI18n();
  return <>
    <span className="chip">{t.form.priority} · {t.priorities[task.priority]}</span>
    <span className="chip">{t.form.difficulty} · {t.difficulties[task.difficulty]}</span>
  </>;
}

export function TaskCreatedAt({ task, short = false }: { task: Task; short?: boolean }) {
  const { t, dateTime, shortDate } = useI18n();
  return <span className="task-created-at">{t.task.createdAt} · <time dateTime={new Date(task.createdAt).toISOString()}
    title={dateTime(task.createdAt)}>{(short ? shortDate : dateTime)(task.createdAt)}</time></span>;
}
