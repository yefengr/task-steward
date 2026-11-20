import { ChevronRight } from 'lucide-react';
import type { Attempt, Delivery, WebTaskDetailResponse } from '@pi-steward/contract';
import { useI18n } from '../lib/i18n';

export function DateTime({ value }: { value: number }) {
  const { dateTime } = useI18n();
  return <time dateTime={new Date(value).toISOString()}>{dateTime(value)}</time>;
}

const deliveryLists = ['done', 'notCovered', 'verification', 'howTo', 'issues'] as const;
const deliveryRefs = ['baseCommit', 'commit', 'reportRef'] as const;

function DeliveryCard({ delivery, latest }: { delivery: Delivery; latest?: boolean }) {
  const { t } = useI18n();
  return <article className="delivery-card">
    <div className="delivery-head">
      <h3 className="user-text">v{delivery.version} · {delivery.summary}</h3>
      {latest && <span className="chip">{t.task.latest}</span>}
      {delivery.review && <span className={`chip ${delivery.review === 'accepted' ? 'status-done' : 'status-review'}`}>
        {delivery.review === 'accepted' ? t.task.accepted : t.task.reworked}
      </span>}
      <span className="muted small"><DateTime value={delivery.createdAt} /></span>
    </div>
    {deliveryLists.map((key) => delivery[key].length > 0 && <div className="delivery-field" key={key}>
      <h4>{t.task[key]}</h4><ul>{delivery[key].map((item, index) => <li key={index} className="user-text">{item}</li>)}</ul>
    </div>)}
    {deliveryRefs.map((key) => delivery[key] && <div className="delivery-field" key={key}>
      <h4>{t.task[key]}</h4><code>{delivery[key]}</code>
    </div>)}
    {delivery.feedback && <p className="feedback user-text"><strong>{t.form.feedback} · </strong>{delivery.feedback}</p>}
  </article>;
}

export function Deliveries({ deliveries }: { deliveries: Delivery[] }) {
  const { t } = useI18n();
  const [latest, ...older] = deliveries.toSorted((a, b) => b.version - a.version);
  return <section className="detail-section">
    <h2>{t.task.delivery}</h2>
    {latest ? <DeliveryCard delivery={latest} latest /> : <p className="muted">{t.task.noDelivery}</p>}
    {older.length > 0 && <details className="fold">
      <summary><ChevronRight size={16} />{t.task.history} <span className="muted">{older.length}</span></summary>
      <div className="fold-body">{older.map((delivery) => <DeliveryCard key={delivery.id} delivery={delivery} />)}</div>
    </details>}
  </section>;
}

function AttemptRecord({ attempt }: { attempt: Attempt }) {
  const { t } = useI18n();
  const results = { delivered: t.task.resultDelivered, interrupted: t.task.resultInterrupted, cancelled: t.task.resultCancelled };
  const result = attempt.result ? results[attempt.result] : attempt.cancelRequested ? t.task.resultClosing : t.task.resultActive;
  return <article className="attempt-record">
    <h4>{attempt.machineName} · {attempt.kind === 'new' ? t.task.kindNew : t.task.kindRework}</h4>
    <dl className="kv">
      <dt>{t.task.result}</dt><dd>{result}{attempt.needsVerification && ` · ${t.task.needsVerification}`}</dd>
      <dt>{t.form.agent}</dt><dd>{attempt.agent === 'pi' ? 'Pi' : t.form.claude}</dd>
      <dt>{t.task.attempt}</dt><dd><code>{attempt.id}</code></dd>
      <dt>{t.task.session}</dt><dd><code>{attempt.sessionId}</code></dd>
      <dt>{t.task.tmux}</dt><dd><code>{attempt.tmuxSession ?? t.common.unknown}</code></dd>
      <dt>{t.task.started}</dt><dd><DateTime value={attempt.startedAt ?? attempt.claimedAt} /></dd>
      {attempt.endedAt !== null && <><dt>{t.task.ended}</dt><dd><DateTime value={attempt.endedAt} /></dd></>}
      {attempt.exitCode !== null && <><dt>{t.task.exitCode}</dt><dd>{attempt.exitCode}</dd></>}
    </dl>
  </article>;
}

export function Records({ attempts, events }: Pick<WebTaskDetailResponse, 'attempts' | 'events'>) {
  const { t } = useI18n();
  const eventLabels: Readonly<Record<string, string>> = t.task.event;
  return <details className="detail-section fold">
    <summary><ChevronRight size={16} />{t.task.records}</summary>
    <div className="fold-body">
      {!attempts.length && !events.length && <p className="muted">{t.task.noRecords}</p>}
      {attempts.length > 0 && <>
        <h3>{t.task.attempts}</h3>{attempts.toReversed().map((attempt) => <AttemptRecord key={attempt.id} attempt={attempt} />)}
      </>}
      {events.length > 0 && <>
        <h3>{t.task.events}</h3>
        <ul className="timeline">{events.toReversed().map((event) => <li key={event.id}>
          <DateTime value={event.createdAt} /><span>{t.task.actors[event.actor]} · {Object.hasOwn(eventLabels, event.kind) ? eventLabels[event.kind] : event.kind}</span>
        </li>)}</ul>
      </>}
    </div>
  </details>;
}
