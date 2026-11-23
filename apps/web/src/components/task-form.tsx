import { Alert, Button, Group, Modal, NativeSelect, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { titleSchema, textSchema, webCreateTaskRequestSchema, webUpdateTaskRequestSchema } from '@pi-steward/contract';
import type { Task, WebMachine, WebProject } from '@pi-steward/contract';
import type { z } from 'zod';
import type { taskContentSchema } from '@pi-steward/contract';
import { api, WebError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useFloatingSafeMiddlewares } from '../lib/ui/safe-area';
import { ErrorNotice } from './common';

type Draft = z.infer<typeof taskContentSchema>;
const emptyDraft: Draft = { title: '', goal: '', acceptance: '', notes: '', agent: 'pi', machineId: null, type: 'implementation' };
const textFields = ['goal', 'acceptance', 'notes'] as const;
const editableFields = ['title', ...textFields, 'agent', 'machineId'] as const;

function draftFrom(task: Task): Draft {
  return { title: task.title, goal: task.goal, acceptance: task.acceptance, notes: task.notes, agent: task.agent, machineId: task.machineId, type: task.type };
}

interface FormProps {
  projects: WebProject[];
  machines: WebMachine[];
  initialProject: string;
  initialTask?: Task;
  currentTask?: Task;
  onClose: () => void;
  onSaved: (task: Task) => void;
  onConflict?: () => void;
}

export function TaskForm(props: FormProps) {
  const { t } = useI18n();
  const [baseTask, setBaseTask] = useState(props.initialTask);
  const [draft, setDraft] = useState<Draft>(() => props.initialTask ? draftFrom(props.initialTask) : emptyDraft);
  const [projectId, setProjectId] = useState(props.initialProject);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [validate, setValidate] = useState(false);
  const middlewares = useFloatingSafeMiddlewares();
  const conflict = Boolean(baseTask && props.currentTask && baseTask.version !== props.currentTask.version)
    || (error instanceof WebError && error.code === 'conflict');
  const currentClosed = props.currentTask?.status === 'done' || props.currentTask?.status === 'cancelled';
  const fields = baseTask ? editableFields.filter((field) => draft[field] !== baseTask[field]) : editableFields;
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
    if (busy || conflict || currentClosed || fields.length === 0) return;
    setValidate(true);
    if (!titleSchema.safeParse(draft.title).success || textFields.some((field) => !textSchema.safeParse(draft[field]).success)) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = baseTask
        ? await api.edit(baseTask.id, webUpdateTaskRequestSchema.parse({ version: baseTask.version,
          ...Object.fromEntries(fields.map((field) => [field, draft[field]])) }))
        : await api.create(webCreateTaskRequestSchema.parse({ ...draft, projectId }));
      props.onSaved(result.task);
    } catch (error) {
      setError(error);
      if (error instanceof WebError && error.code === 'conflict') props.onConflict?.();
    } finally { setBusy(false); }
  }

  return <Modal opened onClose={props.onClose} title={baseTask ? t.common.editTask : t.common.newTask}
    closeButtonProps={{ 'aria-label': t.common.close }} closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
    <form onSubmit={submit} noValidate>
      <Stack gap="sm">
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
            <Button variant="subtle" size="sm" onClick={useLatest}>{t.errors.useLatest}</Button>}
        </Alert>}
        {!conflict && <ErrorNotice error={error} />}
        <Group justify="flex-end" className="dialog-actions">
          <Button variant="light" onClick={props.onClose} disabled={busy}>{t.common.dismiss}</Button>
          <Button type="submit" loading={busy} disabled={conflict || currentClosed || fields.length === 0 || !projectId}>
            {baseTask ? t.common.save : t.common.create}
          </Button>
        </Group>
      </Stack>
    </form>
  </Modal>;
}

function FieldValue({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd className="user-text">{value}</dd></>;
}
