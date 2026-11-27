import { Button, Group, Modal, Stack, Textarea } from '@mantine/core';
import { PWA_CONFIRM_DIALOG_SIZE } from '@yefengr/pwa-foundation/mantine';
import { useTaskViewState } from '../lib/task-view-state';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { isValidDialogFocus, restoreDialogFocus } from '../lib/dialog-focus';
import { nonEmptyTextSchema } from '@pi-steward/contract';
import type { Attempt, Delivery, Task, WebSessionOperation, WebSessionOperationRequest } from '@pi-steward/contract';
import { api } from '../lib/api';
import type { TaskAction } from '../lib/api';
import { isGitOperationActive, isGitRetryBlocked, isIntegrationPhase } from '../lib/git';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './common';

type Confirmation = { action: 'cancel' } | { action: 'accept' | 'rework'; delivery: Delivery } |
  { action: 'restart' | 'restore' | 'background'; request: WebSessionOperationRequest; machineName: string };
const primaryActions: Partial<Record<Task['status'], TaskAction>> = {
  unscheduled: 'schedule', queued: 'unschedule', interrupted: 'reschedule',
};

export function TaskControls({ task, delivery, latestAttempt, sessionOperation, onEdit, onChanged, focusFallback }: {
  task: Task; delivery?: Delivery; latestAttempt?: Attempt; sessionOperation?: WebSessionOperation;
  onEdit: () => void; onChanged: () => void; focusFallback: () => HTMLElement | null;
}) {
  const { t } = useI18n();
  const completedSource = useRef<HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    if (completedSource.current === undefined) return;
    const source = completedSource.current;
    completedSource.current = undefined;
    restoreDialogFocus(source, focusFallback);
  }, [task.version]);
  const [confirmation, setConfirmation] = useTaskViewState<Confirmation | undefined>(`confirmation:${task.id}`, undefined, true);
  const [error, setError] = useTaskViewState<unknown>(`action-error:${task.id}`, undefined);
  const [busy, setBusy] = useTaskViewState(`action-busy:${task.id}`, false);
  const [ending, setEnding] = useTaskViewState(`ending:${task.id}`, false);
  const [endRequestedFor, setEndRequestedFor] = useTaskViewState<string | undefined>(`ended:${task.id}`, undefined);
  const [retryingGit, setRetryingGit] = useTaskViewState(`retry-git:${task.id}`, false);
  const activeAttemptId = latestAttempt?.endedAt === null ? latestAttempt.id : undefined;
  const endRequested = activeAttemptId !== undefined && endRequestedFor === activeAttemptId;
  const closed = task.status === 'done' || task.status === 'cancelled';
  const foreground = latestAttempt?.executionMode === 'foreground';
  const primary = (task.reworkPending && task.status === 'queued') || (foreground && task.status === 'interrupted')
    ? undefined : primaryActions[task.status];
  const canEndDiscussion = task.type === 'discussion' && task.status === 'running' && Boolean(activeAttemptId)
    && !task.discussionEndRequested && !endRequested;
  const pending = sessionOperation?.status === 'pending';
  const git = task.git;
  const gitActive = isGitOperationActive(git);
  const acceptedIntegration = Boolean(git && isIntegrationPhase(git.phase));
  const retryBlocked = isGitRetryBlocked(git);
  const sessionAction = task.agent === 'pi' && latestAttempt?.agent === 'pi' && !latestAttempt.cancelRequested && !gitActive
    ? foreground && (task.status === 'running' || task.status === 'interrupted' || (task.status === 'queued' && task.reworkPending)) && !task.discussionEndRequested ? 'background'
      : task.status === 'interrupted' && latestAttempt.endedAt !== null ? 'restore'
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
  async function retryGit() {
    if (retryingGit || busy) return;
    setRetryingGit(true);
    setError(undefined);
    try {
      await api.retryGit(task.id);
      // 成功后重试按钮会被集成状态替换，焦点交给仍存在的集成标题。
      document.querySelector<HTMLElement>('.git-section h2')?.focus();
    } catch (error) { setError(error); }
    finally { setRetryingGit(false); onChanged(); }
  }
  return <>
    {!closed && <div className="action-bar">
      {(sessionAction === 'restore' || sessionAction === 'background') && !pending && <Button disabled={busy} onClick={confirmSessionAction}>{t.actions[sessionAction]}</Button>}
      {primary && <Button loading={busy} disabled={pending} variant={primary === 'unschedule' || sessionAction === 'restore' ? 'default' : 'filled'}
        onClick={() => void execute(primary)}>{t.actions[primary]}</Button>}
      {foreground && task.status === 'queued' && task.reworkPending && !pending &&
        <p className="action-hint muted small">{t.session.foregroundReworkHint}</p>}
      {canEndDiscussion && <Button loading={ending} disabled={busy || pending}
        onClick={() => void endDiscussion()}>{t.actions.endDiscussion}</Button>}
      {task.status === 'review' && delivery?.review === null && !acceptedIntegration && <>
        <Button onClick={() => setConfirmation({ action: 'accept', delivery })}>{t.actions.accept} · v{delivery.version}</Button>
        <Button variant="default" onClick={() => setConfirmation({ action: 'rework', delivery })}>{t.actions.rework}</Button>
      </>}
      {retryBlocked && <Button loading={retryingGit} disabled={busy}
        onClick={() => void retryGit()}>{git?.phase === 'merge_blocked' ? t.git.retryMerge : t.git.retryCleanup}</Button>}
      {retryBlocked && <p className="action-hint muted small">
        {git?.phase === 'merge_blocked' ? t.git.retryMergeHint : t.git.retryCleanupHint}</p>}
      {gitActive && <p className="action-hint muted small">{t.git.locked}</p>}
      <div className="task-management"><p>{t.task.management}</p><Group gap="xs">
      {sessionAction === 'restart' && !pending && <Button variant="outline" disabled={busy || ending}
        onClick={confirmSessionAction}>{t.actions.restart}</Button>}
      <Button variant="transparent" disabled={busy} onClick={onEdit}>{t.common.editTask}</Button>
      <Button variant="outline" disabled={busy || ending || gitActive || (pending && !sessionOperation.needsExitVerification)}
        onClick={() => setConfirmation({ action: 'cancel' })}>{t.actions.cancel}</Button>
      </Group></div>
    </div>}
    <ErrorNotice error={error} />
    {confirmation && <ConfirmTaskAction taskId={task.id} confirmation={confirmation} onClose={() => setConfirmation((current) => current === confirmation ? undefined : current)}
      onChanged={onChanged} onSucceeded={(source) => { completedSource.current = source; onChanged(); }} focusFallback={focusFallback} />}
  </>;
}

function ConfirmTaskAction({ taskId, confirmation, onClose, onChanged, onSucceeded, focusFallback }: {
  taskId: string; confirmation: Confirmation; onClose: () => void; onChanged: () => void;
  focusFallback: () => HTMLElement | null;
  onSucceeded: (source: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const { action } = confirmation;
  const [feedback, setFeedback] = useTaskViewState(`feedback:${taskId}`, '');
  const [invalid, setInvalid] = useTaskViewState(`feedback-invalid:${taskId}`, false);
  const [error, setError] = useTaskViewState<unknown>(`confirm-error:${taskId}`, undefined);
  const [busy, setBusy] = useTaskViewState(`confirm-busy:${taskId}`, false);
  const busyRef = useRef(busy);
  // 导航返回的新实例也必须接收旧请求对共享 busy 的解锁。
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const closing = useRef(false);
  const mounted = useRef(true);
  const succeeded = useRef(false);
  const [source] = useState(() => document.activeElement as HTMLElement | null);
  const [opened, setOpened] = useState(false);
  const mobile = useMediaQuery('(max-width: 767.98px)', undefined, { getInitialValueInEffect: false });
  useEffect(() => {
    mounted.current = true;
    setOpened(true);
    return () => {
      mounted.current = false;
      if (closing.current) { setFeedback(''); setInvalid(false); setError(undefined); setBusy(false); onClose(); }
    };
  }, []);
  function clear() { setFeedback(''); setInvalid(false); setError(undefined); }
  function close() {
    if (busyRef.current || closing.current) return;
    closing.current = true;
    setOpened(false);
  }
  function exited() {
    if (!closing.current) return;
    closing.current = false;
    clear(); setBusy(false); onClose();
    if (succeeded.current) onSucceeded(source);
    restoreDialogFocus(source, focusFallback);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || closing.current) return;
    if (action === 'rework' && !nonEmptyTextSchema.safeParse(feedback).success) {
      setInvalid(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'cancel') await api.action(taskId, action);
      else if ('request' in confirmation) await api.sessionOperation(taskId, confirmation.request);
      else if (action === 'accept') await api.accept(taskId, confirmation.delivery.id);
      else await api.rework(taskId, confirmation.delivery.id, feedback);
      succeeded.current = true;
      if (!mounted.current) { clear(); onClose(); return; }
      closing.current = true;
      setOpened(false);
    } catch (error) { setError(error); }
    finally {
      busyRef.current = false;
      if (!closing.current) { setBusy(false); if (mounted.current) onChanged(); }
    }
  }

  const cancelButton = <Button key="cancel" variant="default" disabled={busy} onClick={close}>{t.common.dismiss}</Button>;
  const submitButton = <Button key="submit" type="submit" variant="filled"
    className={action === 'cancel' || action === 'restart' ? 'pwa-danger-confirm' : undefined} loading={busy}>{t.actions[action]}</Button>;
  return <Modal opened={opened} returnFocus={opened || !isValidDialogFocus(document.activeElement as HTMLElement | null)}
    onExitTransitionEnd={exited} onClose={close} title={t.actions[action]} size={PWA_CONFIRM_DIALOG_SIZE}
    closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy} closeButtonProps={{ 'aria-label': t.common.close }}>
    <form onSubmit={submit} noValidate>
      <Stack gap="sm">
        <p className="pwa-confirm-description">{t.actions[`${action}Hint`]}</p>
        {'delivery' in confirmation && <p className="user-text"><strong>v{confirmation.delivery.version} · </strong>{confirmation.delivery.summary}</p>}
        {'machineName' in confirmation && <p className="user-text"><strong>{t.task.originalMachine} · </strong>{confirmation.machineName}</p>}
        {action === 'rework' && <Textarea data-autofocus label={t.form.feedback} required value={feedback} disabled={busy}
          error={invalid ? feedback.trim() ? t.form.invalid : t.form.required : undefined}
          onChange={(event) => { setFeedback(event.currentTarget.value); setInvalid(false); }} />}
        <ErrorNotice error={error} />
        <div className="pwa-confirm-actions">
          {mobile ? [submitButton, cancelButton] : [cancelButton, submitButton]}
        </div>
      </Stack>
    </form>
  </Modal>;
}
