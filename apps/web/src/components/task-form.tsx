import { Alert, Button, Group, Modal, NativeSelect, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { useClearTaskViewState, useTaskViewState } from '../lib/task-view-state';
import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { isValidDialogFocus, restoreDialogFocus } from '../lib/dialog-focus';
import type { FormEvent } from 'react';
import { gitBranchSchema, titleSchema, textSchema, webCreateTaskRequestSchema, webUpdateTaskRequestSchema } from '@pi-steward/contract';
import type { Task, WebMachine, WebProject } from '@pi-steward/contract';
import type { z } from 'zod';
import type { taskContentSchema } from '@pi-steward/contract';
import { api, WebError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useFloatingSafeMiddlewares } from '@yefengr/pwa-foundation';
import { ErrorNotice } from './common';

type Draft = z.infer<typeof taskContentSchema>;
const emptyDraft: Draft = { title: '', goal: '', acceptance: '', notes: '', agent: 'pi', machineId: null, type: 'implementation', baseBranch: null };
const textFields = ['goal', 'acceptance', 'notes'] as const;
const editableFields = ['title', ...textFields, 'agent', 'machineId'] as const;
type EditableField = (typeof editableFields)[number] | 'baseBranch';

function draftFrom(task: Task): Draft {
  return { title: task.title, goal: task.goal, acceptance: task.acceptance, notes: task.notes, agent: task.agent,
    machineId: task.machineId, type: task.type, baseBranch: task.baseBranch ?? null };
}

interface FormProps {
  projects: WebProject[];
  machines: WebMachine[];
  initialProject: string;
  initialTask?: Task;
  currentTask?: Task;
  hasAttempts?: boolean;
  onClose: () => void;
  onSaved: (task: Task) => void;
  onConflict?: () => void;
  focusFallback: () => HTMLElement | null;
}

export function TaskForm(props: FormProps) {
  const { t } = useI18n();
  const key = `form:${props.initialTask?.id ?? `new:${props.initialProject}`}`;
  const initial = props.initialTask ? draftFrom(props.initialTask) : emptyDraft;
  const [baseTask, setBaseTask] = useTaskViewState(key + ':base', props.initialTask);
  const [draft, setDraftValue] = useTaskViewState<Draft>(key + ':draft', initial);
  const [projectId, setProjectIdValue] = useTaskViewState(key + ':project', props.initialProject);
  const [, setDirty] = useTaskViewState(key + ':dirty', false, true);
  const setDraft: typeof setDraftValue = (next) => { setDirty(true); setDraftValue(next); };
  const setProjectId = (id: string) => { setDirty(true); setProjectIdValue(id); };
  const [error, setError] = useTaskViewState<unknown>(key + ':error', undefined);
  const [busy, setBusy] = useTaskViewState(key + ':busy', false);
  const [validate, setValidate] = useTaskViewState(key + ':validate', false);
  const clear = useClearTaskViewState();
  const mounted = useRef(true);
  const busyRef = useRef(busy);
  // 导航返回的新实例也必须接收旧请求对共享 busy 的解锁。
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const closing = useRef(false);
  const saved = useRef<Task | undefined>(undefined);
  const [source] = useState(() => document.activeElement as HTMLElement | null);
  const [opened, setOpened] = useState(false);
  const mobile = useMediaQuery('(max-width: 767.98px)', undefined, { getInitialValueInEffect: false });
  useEffect(() => {
    mounted.current = true;
    setOpened(true);
    return () => {
      mounted.current = false;
      if (closing.current) { clear(key + ':'); props.onClose(); }
    };
  }, []);
  function reset() { clear(key + ':'); }
  function close() {
    if (busyRef.current || closing.current) return;
    closing.current = true;
    setOpened(false);
  }
  function exited() {
    if (!closing.current) return;
    closing.current = false;
    reset();
    props.onClose();
    restoreDialogFocus(source, props.focusFallback);
    if (saved.current && mounted.current) props.onSaved(saved.current);
  }
  const middlewares = useFloatingSafeMiddlewares();
  const conflict = Boolean(baseTask && props.currentTask && baseTask.version !== props.currentTask.version)
    || (error instanceof WebError && error.code === 'conflict');
  const currentClosed = props.currentTask?.status === 'done' || props.currentTask?.status === 'cancelled';
  const selectedProject = props.projects.find((project) => project.id === projectId);
  const defaultBranch = selectedProject?.gitSettings?.baseBranch ?? null;
  const showBaseBranch = (baseTask?.type ?? draft.type) === 'implementation';
  const started = Boolean(props.hasAttempts) || (Boolean(props.currentTask)
    && props.currentTask!.status !== 'unscheduled' && props.currentTask!.status !== 'queued');
  // 领取时尚未选分支的任务允许显式补第一次选择；已有选择或 Git 快照仍保持锁定。
  const firstSelection = started && !props.currentTask!.git && props.currentTask!.baseBranch == null;
  const baseBranchLocked = Boolean(props.currentTask?.git) || (started && !firstSelection);
  const baseBranchEditable = showBaseBranch && !baseBranchLocked;
  const baseBranchDirty = (draft.baseBranch?.trim() || null) !== (baseTask?.baseBranch ?? null);
  const fields: EditableField[] = baseTask
    ? [...editableFields.filter((field) => draft[field] !== baseTask[field]),
      ...(baseBranchEditable && baseBranchDirty ? ['baseBranch' as const] : [])]
    : [...editableFields, ...(showBaseBranch ? ['baseBranch' as const] : [])];
  const branchInvalid = validate && Boolean(draft.baseBranch?.trim()) && !gitBranchSchema.safeParse(draft.baseBranch!.trim()).success;
  const titleError = validate && !titleSchema.safeParse(draft.title).success
    ? draft.title.trim() ? t.form.invalid : t.form.required : undefined;
  const machineOptions = props.machines.filter((machine) => machine.revokedAt === null || machine.id === draft.machineId);

  function useLatest() {
    if (!props.currentTask || !baseTask || currentClosed || props.currentTask.version === baseTask.version) return;
    const latest = draftFrom(props.currentTask);
    setDraft(Object.assign(latest, Object.fromEntries(fields.map((field) => [field, draft[field]]))));
    setBaseTask(props.currentTask);
    setError(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || closing.current || conflict || currentClosed || fields.length === 0) return;
    setValidate(true);
    if (!titleSchema.safeParse(draft.title).success || textFields.some((field) => !textSchema.safeParse(draft[field]).success)) return;
    if (showBaseBranch && baseBranchEditable && Boolean(draft.baseBranch?.trim())
      && !gitBranchSchema.safeParse(draft.baseBranch!.trim()).success) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const changes = Object.fromEntries(fields.map((field) => [field,
        field === 'baseBranch' ? draft.baseBranch?.trim() || null : draft[field]]));
      const result = baseTask
        ? await api.edit(baseTask.id, webUpdateTaskRequestSchema.parse({ version: baseTask.version, ...changes }))
        : await api.create(webCreateTaskRequestSchema.parse({ ...draft,
          ...(showBaseBranch ? { baseBranch: draft.baseBranch?.trim() || null } : {}), projectId }));
      saved.current = result.task;
      // 导航卸载后仍清原目标，但不调用旧页面的保存/导航回调。
      if (!mounted.current) { reset(); props.onClose(); return; }
      closing.current = true;
      setOpened(false);
    } catch (error) {
      setError(error);
      setBusy(false);
      if (mounted.current && error instanceof WebError && error.code === 'conflict') props.onConflict?.();
    } finally {
      busyRef.current = false;
      // 成功退出期间保持按钮禁用，展示快照直到真实退出完成。
      if (!closing.current) setBusy(false);
    }
  }

  const cancelButton = <Button key="cancel" variant="default" onClick={close} disabled={busy}>{t.common.dismiss}</Button>;
  const submitButton = <Button key="submit" type="submit" loading={busy} disabled={conflict || currentClosed || fields.length === 0 || !projectId}>
    {baseTask ? t.common.save : t.common.create}
  </Button>;
  return <Modal opened={opened} returnFocus={opened || !isValidDialogFocus(document.activeElement as HTMLElement | null)}
    onExitTransitionEnd={exited} onClose={close} title={baseTask ? t.common.editTask : t.common.newTask}
    closeButtonProps={{ 'aria-label': t.common.close }} closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
    <form onSubmit={submit} noValidate>
      <fieldset disabled={busy} className="task-form-fields"><Stack gap="sm">
        {!baseTask && <NativeSelect label={t.common.projects} value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}
          data={props.projects.map((project) => ({ value: project.id, label: project.name }))} />}
        <TextInput label={t.form.title} required data-autofocus value={draft.title} error={titleError} onChange={(event) => {
          const title = event.currentTarget.value;
          setDraft((value) => ({ ...value, title }));
        }} />
        {!baseTask && <NativeSelect label={t.form.type} value={draft.type} onChange={(event) => {
          const type = event.currentTarget.value as Draft['type'];
          setDraft((value) => ({ ...value, type }));
        }} data={[{ value: 'implementation', label: t.taskTypes.implementation }, { value: 'discussion', label: t.taskTypes.discussion }]} />}
        {showBaseBranch && (baseBranchEditable
          ? <TextInput label={t.git.taskBaseBranch} value={draft.baseBranch ?? ''}
            placeholder={firstSelection ? t.git.branchPlaceholder : defaultBranch ? t.git.inheritDefault.replace('{branch}', defaultBranch) : t.git.noDefault}
            description={firstSelection ? t.git.firstSelectionHelp : t.git.taskBaseBranchHelp}
            error={branchInvalid ? t.git.invalidBranch : undefined}
            onChange={(event) => { const baseBranch = event.currentTarget.value; setDraft((value) => ({ ...value, baseBranch })); }} />
          : <TextInput label={t.git.taskBaseBranch} disabled description={t.git.branchLocked}
            value={props.currentTask?.git?.baseBranch ?? draft.baseBranch ?? defaultBranch ?? ''} />)}
        {textFields.map((field) => <Textarea key={field} label={t.form[field]} value={draft[field]}
          error={validate && !textSchema.safeParse(draft[field]).success ? t.form.invalid : undefined}
          onChange={(event) => { const text = event.currentTarget.value; setDraft((value) => ({ ...value, [field]: text })); }} />)}
        <Group grow align="start" wrap="wrap">
          <NativeSelect label={t.form.agent} value={draft.agent} onChange={() => setDraft((value) => ({ ...value, agent: 'pi' }))}
            data={[{ value: 'pi', label: 'Pi' }, { value: 'claude', label: t.form.claude, disabled: true }]} />
          <Select label={t.form.machine} allowDeselect={false} value={draft.machineId ?? 'auto'}
            comboboxProps={{ middlewares }} onChange={(id) => setDraft((value) => ({ ...value, machineId: id === 'auto' ? null : id }))}
            data={[{ value: 'auto', label: t.form.auto }, ...machineOptions.map((machine) => ({ value: machine.id,
              label: machine.name, disabled: machine.revokedAt !== null }))]} />
        </Group>
        {conflict && <Alert color="yellow" role="alert">
          {t.errors.editConflict}
          {props.currentTask && <details className="conflict-preview">
            <summary>{t.errors.compareCurrent}</summary>
            <p><strong>{t.statuses[props.currentTask.status]}</strong></p>
            <dl className="kv">{(['title', ...textFields, 'agent', 'machine'] as const).map((field) => <FieldValue key={field}
              label={t.form[field]} value={field === 'agent' ? (props.currentTask!.agent === 'pi' ? 'Pi' : t.form.claude)
                : field === 'machine' ? props.machines.find((machine) => machine.id === props.currentTask!.machineId)?.name ?? t.form.auto
                  : props.currentTask![field] || t.common.unknown} />)}</dl>
          </details>}
          {!currentClosed && props.currentTask && props.currentTask.version !== baseTask?.version &&
            <Button variant="transparent" onClick={useLatest}>{t.errors.useLatest}</Button>}
        </Alert>}
        {!conflict && <ErrorNotice error={error} />}
        <Group justify="flex-end" className="pwa-confirm-actions">
          {mobile ? [submitButton, cancelButton] : [cancelButton, submitButton]}
        </Group>
      </Stack></fieldset>
    </form>
  </Modal>;
}

function FieldValue({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd className="user-text">{value}</dd></>;
}
