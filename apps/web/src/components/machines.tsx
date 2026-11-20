import type { WebMachine } from '@pi-steward/contract';
import { Link } from 'wouter';
import { useI18n } from '../lib/i18n';
import { projectPath, taskPath } from '../lib/paths';
import { Empty } from './common';

export function Machines({ machines }: { machines: WebMachine[] }) {
  const { t, dateTime } = useI18n();
  if (!machines.length) return <Empty>{t.machine.none}</Empty>;
  return <div className="machine-list">
    {machines.map((machine) => <section className="machine-card" key={machine.id} aria-label={machine.name}>
      <div className="machine-head">
        <h2>{machine.name}</h2>
        <span className="chip"><span className={machine.online ? 'online-dot' : 'offline-dot'} />
          {machine.revokedAt !== null ? t.machine.revoked : machine.online ? t.machine.online : t.machine.offline}</span>
        <span className="muted small">{t.machine.lastSeen} · {machine.lastSeenAt !== null ? dateTime(machine.lastSeenAt) : t.common.unknown}</span>
      </div>
      <div className="machine-head machine-slots">
        <span>{t.machine.slots} {machine.occupiedSlots}/{machine.slots}</span>
        <progress value={machine.occupiedSlots} max={Math.max(machine.slots, machine.occupiedSlots, 1)}
          aria-label={t.machine.slots} />
      </div>
      <h3>{t.machine.active}</h3>
      {machine.activeTasks.length ? <div className="list">{machine.activeTasks.map((task) =>
        <Link className="row" href={taskPath(task.id)} key={task.attemptId}>
          <span className="row-title">{task.title}</span><span className="row-sub">{task.projectId}</span>
        </Link>)}</div> : <p className="muted">{t.machine.idle}</p>}
      <h3>{t.machine.projects}</h3>
      {machine.projects.length ? <div className="machine-projects">{machine.projects.map((project) =>
        <Link href={projectPath(project.id)} key={project.id}>{project.name}</Link>)}</div> : <p className="muted">{t.common.unknown}</p>}
    </section>)}
  </div>;
}
