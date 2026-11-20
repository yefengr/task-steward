import { Button, Group, Modal, Stack, Textarea } from '@mantine/core';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { nonEmptyTextSchema } from '@pi-steward/contract';
import type { Delivery, Task } from '@pi-steward/contract';
import { api } from '../lib/api';
import type { TaskAction } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './common';

type Confirmation = { action: 'cancel' } | { action: 'accept' | 'rework'; delivery: Delivery };
const primaryActions: Partial<Record<Task['status'], TaskAction>> = {
  unscheduled: 'schedule', queued: 'unschedule', interrupted: 'reschedule',
};

export function TaskControls({ task, delivery, onEdit, onChanged }: {
  task: Task; delivery?: Delivery; onEdit: () => void; onChanged: () => void;
}) {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const closed = task.status === 'done' || task.status === 'cancelled';
  const primary = task.reworkPending && task.status === 'queued' ? undefined : primaryActions[task.status];
  async function execute(action: TaskAction) {
    setBusy(true);
    setError(undefined);
    try { await api.action(task.id, action); }
    catch (error) { setError(error); }
    finally { setBusy(false); onChanged(); }
  }
  return <>
    {!closed && <div className="action-bar">
      {primary && <Button loading={busy} variant={primary === 'unschedule' ? 'light' : 'filled'}
        onClick={() => void execute(primary)}>{t.actions[primary]}</Button>}
      {task.status === 'review' && delivery?.review === null && <>
        <Button onClick={() => setConfirmation({ action: 'accept', delivery })}>{t.actions.accept} · v{delivery.version}</Button>
        <Button variant="light" onClick={() => setConfirmation({ action: 'rework', delivery })}>{t.actions.rework}</Button>
      </>}
      <Button variant="light" disabled={busy} onClick={onEdit}>{t.common.editTask}</Button>
      <Button variant="light" color="red" disabled={busy} onClick={() => setConfirmation({ action: 'cancel' })}>{t.actions.cancel}</Button>
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
        {confirmation.action !== 'cancel' && <p className="user-text"><strong>v{confirmation.delivery.version} · </strong>{confirmation.delivery.summary}</p>}
        {action === 'rework' && <Textarea data-autofocus label={t.form.feedback} required value={feedback}
          error={invalid ? feedback.trim() ? t.form.invalid : t.form.required : undefined}
          onChange={(event) => { setFeedback(event.currentTarget.value); setInvalid(false); }} />}
        <ErrorNotice error={error} />
        <Group justify="flex-end" className="dialog-actions">
          <Button variant="light" disabled={busy} onClick={onClose}>{t.common.dismiss}</Button>
          <Button type="submit" color={action === 'cancel' ? 'red' : undefined} loading={busy}>{t.actions[action]}</Button>
        </Group>
      </Stack>
    </form>
  </Modal>;
}
