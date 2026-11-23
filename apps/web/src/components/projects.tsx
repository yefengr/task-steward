import type { Task, TaskStatus, WebMachine, WebProject } from '@pi-steward/contract';
import { ChevronRight, Folder } from 'lucide-react';
import { Link } from 'wouter';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { projectPath, taskPath } from '../lib/paths';
import { useResource } from '../lib/resource';
import { Empty, ErrorNotice, Loading, TaskFlags, TaskTypeLabel, WaitReason } from './common';

const openGroups = ['running', 'review', 'interrupted', 'queued', 'unscheduled'] as const;
const closedGroups = ['done', 'cancelled'] as const;
export const openCount = (project: WebProject) => openGroups.reduce((sum, status) => sum + project.counts[status], 0);

export function Projects({ projects }: { projects: WebProject[] }) {
  const { t } = useI18n();
  if (!projects.length) return <Empty title={t.project.none}>{t.project.noneHint}</Empty>;
  return <div className="list">
    {projects.map((project) => <Link className="row project-row" href={projectPath(project.id)} key={project.id}>
      <span className="row-title"><Folder size={18} />{project.name}</span><span className="muted count">{openCount(project)}</span>
      <span className="row-sub">{t.project.open}</span>
    </Link>)}
  </div>;
}

function TaskRow({ task, machines }: { task: Task; machines: WebMachine[] }) {
  const { t } = useI18n();
  const machine = machines.find((machine) => machine.id === task.machineId);
  return <Link href={taskPath(task.id)} className="row">
    <span className="row-title">{task.title}</span>
    {(task.needsResponse || task.needsVerification || task.discussionEndRequested) && <span className="row-side"><TaskFlags task={task} /></span>}
    <span className="row-sub">
      <TaskTypeLabel task={task} />
      <span>{task.agent === 'pi' ? 'Pi' : t.form.claude}</span>
      {machine && <span>{machine.name}</span>}
      {task.createdBy === 'agent' && <span>{t.task.createdByAgent}</span>}
      {task.reworkPending && <span>{t.task.reworkPending}</span>}
      {task.status === 'queued' && <WaitReason task={task} />}
    </span>
  </Link>;
}

function TaskGroup({ status, tasks, machines, fold }: { status: TaskStatus; tasks: Task[]; machines: WebMachine[]; fold?: boolean }) {
  const { t } = useI18n();
  const rows = tasks.filter((task) => task.status === status);
  if (!rows.length) return null;
  const title = <>{t.statuses[status]}<span className="muted count">{rows.length}</span></>;
  const list = <div className="list">{rows.map((task) => <TaskRow key={task.id} task={task} machines={machines} />)}</div>;
  if (fold) return <details className="task-group"><summary className="group-head"><ChevronRight size={16} />{title}</summary>{list}</details>;
  return <section className="task-group" aria-label={t.statuses[status]}><h2 className="group-head">{title}</h2>{list}</section>;
}

export function Project({ id, machines }: { id: string; machines: WebMachine[] }) {
  const { t } = useI18n();
  const { data, error, refresh } = useResource((signal) => api.projectTasks(id, signal));
  const names = machines.filter((machine) => machine.revokedAt === null && machine.projects.some((project) => project.id === id))
    .map((machine) => machine.name);
  return <>
    <p className="project-machine muted">{names.length ? `${t.project.machines} · ${names.join(' · ')}` : t.project.noMachines}</p>
    <ErrorNotice error={error} retry={refresh} />
    {!data && !error && <Loading />}
    {data && (data.tasks.length ? <>
      {openGroups.map((status) => <TaskGroup key={status} status={status} tasks={data.tasks} machines={machines} />)}
      {closedGroups.map((status) => <TaskGroup key={status} status={status} tasks={data.tasks} machines={machines} fold />)}
    </> : <Empty>{t.project.empty}</Empty>)}
  </>;
}
