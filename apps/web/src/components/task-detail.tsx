import { useRef, useState } from 'react';
import type { Task, WebMachine, WebProject, WebTaskDetailResponse } from '@pi-steward/contract';
import { Link } from 'wouter';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTaskViewState } from '../lib/task-view-state';
import { isValidDialogFocus } from '../lib/dialog-focus';
import { useI18n } from '../lib/i18n';
import { projectPath } from '../lib/paths';
import { GitPhaseChip, StatusChip, TaskFlags, TaskTypeLabel, WaitReason } from './common';
import { GitSection } from './git-section';
import { TaskControls } from './task-controls';
import { TaskForm } from './task-form';
import { DateTime, Deliveries, DiscussionHistory, Records } from './task-records';

function Attention({ detail }: { detail: WebTaskDetailResponse }) {
  const { t } = useI18n();
  const { task, sessionOperation } = detail;
  const questions = detail.questions.filter((question) => question.status === 'open');
  const pending = sessionOperation?.status === 'pending';
  const resumed = sessionOperation?.status === 'succeeded' && task.status === 'running';
  const failure = sessionOperation?.status === 'failed' ? sessionOperation.failure : null;
  if (!questions.length && !pending && !resumed && !failure && !task.needsVerification && task.status !== 'interrupted') return null;
  return <section className="detail-section">
    <h2>{t.task.attention}</h2>
    {questions.map((question) => <article className="callout" key={question.id}>
      <h3 className="user-text">{question.text}</h3>
      {question.context && <p className="user-text">{question.context}</p>}
      <p><strong>{t.task.needsResponse}</strong></p>
      <DateTime value={question.createdAt} />
    </article>)}
    {pending && <p role="status" className={`callout${sessionOperation.needsExitVerification ? ' warning' : ''}`}>
      {sessionOperation.needsExitVerification ? t.session.verifyingExit : t.session.pending[sessionOperation.mode]}</p>}
    {resumed && <p role="status" className="callout">{t.session.ready}</p>}
    {failure && <p role="alert" className="callout warning">{t.session.failures[failure]}</p>}
    {task.needsVerification && !pending && <p className="callout warning">{t.task.verificationHint}</p>}
    {task.status === 'interrupted' && !pending && <p className="callout warning">
      {task.agent === 'pi' && detail.attempts.at(-1)?.agent === 'pi' ? t.session.interrupted : t.task.interruptedHint}</p>}
  </section>;
}

function ContextSections({ detail }: { detail: WebTaskDetailResponse }) {
  const { t } = useI18n();
  return <>
    <details className="detail-section fold">
      <summary><ChevronRight size={16} />{t.task.goalSection}</summary>
      <div className="fold-body">
      <dl className="kv">{(['goal', 'acceptance', 'notes'] as const).map((field) =>
        <div key={field} className="kv-item"><dt>{t.form[field]}</dt><dd className="user-text">{detail.task[field] || t.common.unknown}</dd></div>)}</dl>
      {detail.decisions.length > 0 && <>
        <h3>{t.task.decisions}</h3>
        {detail.decisions.map((decision) => <div key={decision.id} className="decision">
          <span className={`chip ${decision.confirmedByUser ? 'status-done' : ''}`}>{decision.confirmedByUser ? t.task.confirmed : t.task.suggested}</span>
          <span className="user-text">{decision.text}</span>
        </div>)}
      </>}
      </div>
    </details>
  </>;
}

function Progress({ detail }: { detail: WebTaskDetailResponse }) {
  const { t } = useI18n();
  const [latest, ...earlier] = detail.progress.toReversed();
  const row = (item: WebTaskDetailResponse['progress'][number]) => <li key={item.id}>
    <DateTime value={item.createdAt} /><span className="user-text">{item.text}</span>
  </li>;
  return <section className="detail-section">
    <h2>{t.task.progress}</h2>
    {latest ? <ul className="timeline">{row(latest)}</ul> : <p className="muted">{t.task.noProgress}</p>}
    {earlier.length > 0 && <details className="fold">
      <summary><ChevronRight size={16} />{t.task.earlierProgress}<span className="muted count">{earlier.length}</span></summary>
      <div className="fold-body"><ul className="timeline">{earlier.map(row)}</ul></div>
    </details>}
  </section>;
}

export default function TaskDetail({ detail, project, machines, onChanged }: {
  detail: WebTaskDetailResponse; project?: WebProject; machines: WebMachine[]; onChanged: () => void;
}) {
  const { t } = useI18n();
  const { task: remoteTask, attempts } = detail;
  const [savedTask, setSavedTask] = useState<Task>();
  const backLink = useRef<HTMLAnchorElement>(null);
  const focusFallback = () => isValidDialogFocus(backLink.current) ? backLink.current
    : document.querySelector<HTMLAnchorElement>('.mobile-topbar a[href]');
  const task = savedTask && savedTask.version > remoteTask.version ? savedTask : remoteTask;
  const [editing, setEditing] = useTaskViewState<typeof task | undefined>(`editing:${task.id}`, undefined);
  const lastAttempt = attempts.at(-1);
  const assigned = machines.find((machine) => machine.id === task.machineId);
  const projectName = project?.name ?? task.projectId;
  const machineName = lastAttempt?.endedAt === null ? lastAttempt.machineName : assigned?.name ?? lastAttempt?.machineName ?? t.form.auto;
  const sections = {
    progress: <div key="progress" className="current-progress"><Progress detail={detail} /></div>,
    delivery: <div key="delivery" className="current-delivery"><Deliveries deliveries={detail.deliveries} /></div>,
    controls: <div key="controls" className="current-controls"><TaskControls task={task} delivery={detail.deliveries.at(-1)} latestAttempt={lastAttempt}
      sessionOperation={detail.sessionOperation} focusFallback={focusFallback} onEdit={() => setEditing(task)} onChanged={onChanged} /></div>,
  };
  const order = task.status === 'review' ? ['delivery', 'controls', 'progress'] as const : ['progress', 'controls', 'delivery'] as const;
  return <>
    <Link ref={backLink} className="back-link" href={projectPath(task.projectId)}><ChevronLeft size={16} />{projectName}</Link>
    <header className="detail-head">
      <h1 className="user-text">{task.title}</h1>
      <div className="meta-line">
        <StatusChip task={task} />{task.git && <GitPhaseChip git={task.git} />}<TaskFlags task={task} /><TaskTypeLabel task={task} />
        <span>{t.form.agent} · {task.agent === 'pi' ? 'Pi' : t.form.claude}</span>
        <span>{t.form.machine} · {machineName}</span>
        {task.createdBy === 'agent' && <span>{t.task.createdByAgent}</span>}
      </div>
      {task.status === 'queued' && <div className="waiting-banner"><WaitReason task={task} />
        {task.reworkPending && <span className="chip">{t.task.reworkPending}</span>}</div>}
    </header>
    <Attention detail={detail} />
    <GitSection task={task} />
    <div className="current-work">{order.map((section) => sections[section])}</div>
    <ContextSections detail={detail} />
    <DiscussionHistory questions={detail.questions.filter((question) => question.status !== 'open')} />
    <Records attempts={detail.attempts} events={detail.events} />
    {editing && <TaskForm initialTask={editing} currentTask={task} initialProject={task.projectId} projects={project ? [project] : []}
      machines={machines} focusFallback={focusFallback} onConflict={onChanged} onClose={() => setEditing(undefined)}
      onSaved={(saved) => { setSavedTask(saved); setEditing(undefined); onChanged(); }} />}
  </>;
}
