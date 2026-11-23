import { useState } from 'react';
import type { WebMachine, WebProject, WebTaskDetailResponse } from '@pi-steward/contract';
import { Link } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { projectPath } from '../lib/paths';
import { StatusChip, TaskFlags, TaskTypeLabel, WaitReason } from './common';
import { TaskControls } from './task-controls';
import { TaskForm } from './task-form';
import { DateTime, Deliveries, DiscussionHistory, Records } from './task-records';

function Attention({ detail }: { detail: WebTaskDetailResponse }) {
  const { t } = useI18n();
  const { task } = detail;
  const latest = detail.deliveries.at(-1);
  if (!task.needsVerification && task.status !== 'review' && task.status !== 'interrupted') return null;
  return <section className="detail-section">
    <h2>{t.task.attention}</h2>
    {task.needsVerification && <p className="callout warning">{t.task.verificationHint}</p>}
    {task.status === 'interrupted' && <p className="callout warning">{t.task.interruptedHint}</p>}
    {task.status === 'review' && latest && <div className="callout"><strong>{t.statuses.review} · v{latest.version}</strong>
      <p className="user-text">{latest.summary}</p></div>}
  </section>;
}

function ContextSections({ detail }: { detail: WebTaskDetailResponse }) {
  const { t } = useI18n();
  return <>
    <section className="detail-section">
      <h2>{t.task.goalSection}</h2>
      <dl className="kv">{(['goal', 'acceptance', 'notes'] as const).map((field) =>
        <div key={field} className="kv-item"><dt>{t.form[field]}</dt><dd className="user-text">{detail.task[field] || t.common.unknown}</dd></div>)}</dl>
      {detail.decisions.length > 0 && <>
        <h3>{t.task.decisions}</h3>
        {detail.decisions.map((decision) => <div key={decision.id} className="decision">
          <span className={`chip ${decision.confirmedByUser ? 'status-done' : ''}`}>{decision.confirmedByUser ? t.task.confirmed : t.task.suggested}</span>
          <span className="user-text">{decision.text}</span>
        </div>)}
      </>}
    </section>
    <section className="detail-section">
      <h2>{t.task.progress}</h2>
      {detail.progress.length ? <ul className="timeline">{detail.progress.toReversed().map((item) => <li key={item.id}>
        <DateTime value={item.createdAt} /><span className="user-text">{item.text}</span>
      </li>)}</ul> : <p className="muted">{t.task.noProgress}</p>}
    </section>
  </>;
}

export default function TaskDetail({ detail, project, machines, onChanged }: {
  detail: WebTaskDetailResponse; project?: WebProject; machines: WebMachine[]; onChanged: () => void;
}) {
  const { t } = useI18n();
  const { task, attempts } = detail;
  const [editing, setEditing] = useState<typeof task>();
  const lastAttempt = attempts.at(-1);
  const activeAttempt = attempts.find((attempt) => attempt.endedAt === null);
  const assigned = machines.find((machine) => machine.id === task.machineId);
  const projectName = project?.name ?? task.projectId;
  const machineName = lastAttempt?.endedAt === null ? lastAttempt.machineName : assigned?.name ?? lastAttempt?.machineName ?? t.form.auto;
  return <>
    <Link className="back-link" href={projectPath(task.projectId)}><ArrowLeft size={16} />{projectName}</Link>
    <header className="detail-head">
      <h1 className="user-text">{task.title}</h1>
      <div className="meta-line">
        <StatusChip status={task.status} /><TaskFlags task={task} /><TaskTypeLabel task={task} />
        <span>{t.form.agent} · {task.agent === 'pi' ? 'Pi' : t.form.claude}</span>
        <span>{t.form.machine} · {machineName}</span>
        {task.createdBy === 'agent' && <span>{t.task.createdByAgent}</span>}
      </div>
      <TaskControls task={task} delivery={detail.deliveries.at(-1)} activeAttemptId={activeAttempt?.id}
        onEdit={() => setEditing(task)} onChanged={onChanged} />
      {task.status === 'queued' && <div className="waiting-banner"><WaitReason task={task} />
        {task.reworkPending && <span className="chip">{t.task.reworkPending}</span>}</div>}
    </header>
    <Attention detail={detail} />
    <ContextSections detail={detail} />
    <Deliveries deliveries={detail.deliveries} />
    <DiscussionHistory questions={detail.questions} />
    <Records attempts={detail.attempts} events={detail.events} />
    {editing && <TaskForm initialTask={editing} currentTask={task} initialProject={task.projectId} projects={project ? [project] : []}
      machines={machines} onConflict={onChanged} onClose={() => setEditing(undefined)}
      onSaved={() => { setEditing(undefined); onChanged(); }} />}
  </>;
}
