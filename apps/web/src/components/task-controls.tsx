import { Button, Group, Modal, Stack, Textarea } from '@mantine/core';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { nonEmptyTextSchema } from '@pi-steward/contract';
import type { Attempt, Delivery, Task, WebSessionOperation, WebSessionOperationRequest } from '@pi-steward/contract';
import { api } from '../lib/api';
import type { TaskAction } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './common';

type Confirmation = { action: 'cancel' } | { action: 'accept' | 'rework'; delivery: Delivery } |
  { action: 'restart' | 'restore'; request: WebSessionOperationRequest; machineName: string };
const primaryActions: Partial<Record<Task['status'], TaskAction>> = {
  unscheduled: 'schedule', queued: 'unschedule', interrupted: 'reschedule',
};

export function TaskControls({ task, delivery, latestAttempt, sessionOperation, onEdit, onChanged }: {
  task: Task; delivery?: Delivery; latestAttempt?: Attempt; sessionOperation?: WebSessionOperation;
  onEdit: () => void; onChanged: () => void;
}) {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endRequestedFor, setEndRequestedFor] = useState<string>();
  const activeAttemptId = latestAttempt?.endedAt === null ? latestAttempt.id : undefined;
  const endRequested = activeAttemptId !== undefined && endRequestedFor === activeAttemptId;
  const closed = task.status === 'done' || task.status === 'cancelled';
  const primary = task.reworkPending && task.status === 'queued' ? undefined : primaryActions[task.status];
  const canEndDiscussion = task.type === 'discussion' && task.status === 'running' && Boolean(activeAttemptId)
    && !task.discussionEndRequested && !endRequested;
  const pending = sessionOperation?.status === 'pending';
  const sessionAction = task.agent === 'pi' && latestAttempt?.agent === 'pi' && !latestAttempt.cancelRequested
    ? task.status === 'interrupted' && latestAttempt.endedAt !== null ? 'restore'
      : task.status === 'running' && latestAttempt.endedAt === null && latestAttempt.startedAt !== null &&
        !task.discussionEndRequested && !endRequested ? 'restart' : undefined
    : undefined;
  function confirmSessionAction() {
    if (!latestAttempt || !sessionAction || pending) return;
    setConfirmation({ action: sessionAction, machineName: latestAttempt.machineName,
      request: { requestId: crypto.randomUUID(), attemptId: latestAttempt.id, mode: sessionAction } });
  }
  async function execute(action: TaskAction) {
    setBusy(true);
    setError(undefined);
    try { await api.action(task.id, action); }
    catch (error) { setError(error); }
    finally { setBusy(false); onChanged(); }
  }
  async function endDiscussion() {
    if (!activeAttemptId || ending || endRequested) return;
    setEnding(true);
    setError(undefined);
    try { await api.endDiscussion(task.id, activeAttemptId); setEndRequestedFor(activeAttemptId); }
    catch (error) { setError(error); }
    finally { setEnding(false); onChanged(); }
  }
  return <>
    {!closed && <div className="action-bar">
      {sessionAction === 'restore' && !pending && <Button disabled={busy} onClick={confirmSessionAction}>{t.actions.restore}</Button>}
      {primary && <Button loading={busy} disabled={pending} variant={primary === 'unschedule' || sessionAction === 'restore' ? 'light' : 'filled'}
        onClick={() => void execute(primary)}>{t.actions[primary]}</Button>}
      {canEndDiscussion && <Button loading={ending} disabled={busy || pending}
        onClick={() => void endDiscussion()}>{t.actions.endDiscussion}</Button>}
      {sessionAction === 'restart' && !pending && <Button variant="light" disabled={busy || ending}
        onClick={confirmSessionAction}>{t.actions.restart}</Button>}
      {task.status === 'review' && delivery?.review === null && <>
        <Button onClick={() => setConfirmation({ action: 'accept', delivery })}>{t.actions.accept} · v{delivery.version}</Button>
        <Button variant="light" onClick={() => setConfirmation({ action: 'rework', delivery })}>{t.actions.rework}</Button>
      </>}
      <Button variant="light" disabled={busy} onClick={onEdit}>{t.common.editTask}</Button>
      <Button variant="light" color="red" disabled={busy || ending || (pending && !sessionOperation.needsExitVerification)}
        onClick={() => setConfirmation({ action: 'cancel' })}>{t.actions.cancel}</Button>
    </div>}
    <ErrorNotice error={error} />
    {confirmation && <ConfirmTaskAction taskId={task.id} confirmation={confirmation} onClose={() => setConfirmation(undefined)}
      onChanged={onChanged} />}
  </>;
}

function ConfirmTaskAction({ taskId, confirmation, onClose, onChanged }: {
  taskId: string; confirmation: Confirmation; onClose: () => void; onChanged: () => void;
}) {
  const { t } = useI18n();
  const { action } = confirmation;
  const [feedback, setFeedback] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (action === 'rework' && !nonEmptyTextSchema.safeParse(feedback).success) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'cancel') await api.action(taskId, action);
      else if ('request' in confirmation) await api.sessionOperation(taskId, confirmation.request);
      else if (action === 'accept') await api.accept(taskId, confirmation.delivery.id);
      else await api.rework(taskId, confirmation.delivery.id, feedback);
      onClose();
    } catch (error) { setError(error); }
    finally { setBusy(false); onChanged(); }
  }

  return <Modal opened onClose={onClose} title={t.actions[action]} size={400}
    closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy} closeButtonProps={{ 'aria-label': t.common.close }}>
    <form onSubmit={submit} noValidate>
      <Stack gap="sm">
        <p>{t.actions[`${action}Hint`]}</p>
        {'delivery' in confirmation && <p className="user-text"><strong>v{confirmation.delivery.version} · </strong>{confirmation.delivery.summary}</p>}
        {'machineName' in confirmation && <p className="user-text"><strong>{t.task.originalMachine} · </strong>{confirmation.machineName}</p>}
        {action === 'rework' && <Textarea data-autofocus label={t.form.feedback} required value={feedback}
          error={invalid ? feedback.trim() ? t.form.invalid : t.form.required : undefined}
          onChange={(event) => { setFeedback(event.currentTarget.value); setInvalid(false); }} />}
        <ErrorNotice error={error} />
        <Group justify="flex-end" className="dialog-actions">
          <Button variant="light" disabled={busy} onClick={onClose}>{t.common.dismiss}</Button>
          <Button type="submit" color={action === 'cancel' || action === 'restart' ? 'red' : undefined} loading={busy}>{t.actions[action]}</Button>
        </Group>
      </Stack>
    </form>
  </Modal>;
}
