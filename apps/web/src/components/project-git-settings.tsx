import { Alert, Button, Group, Modal, Stack, Switch, TextInput } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { gitBranchSchema } from '@pi-steward/contract';
import type { ProjectGitSettings as GitSettings, WebProject } from '@pi-steward/contract';
import { api, WebError } from '../lib/api';
import { isValidDialogFocus } from '../lib/dialog-focus';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './common';

export function ProjectGitSettings({ project, onChanged }: { project: WebProject; onChanged: () => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<GitSettings>();
  // 轮询返回的旧版本不能覆盖刚保存的设置。
  const remote = project.gitSettings;
  const current = saved && (!remote || saved.version >= remote.version) ? saved : remote;
  const configured = Boolean(current?.baseBranch);
  const [opened, setOpened] = useState(false);
  const [branch, setBranch] = useState('');
  const [sync, setSync] = useState(true);
  const [draftVersion, setDraftVersion] = useState(1);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  const closing = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const conflict = error instanceof WebError && error.code === 'conflict';

  function open() {
    setBranch(current?.baseBranch ?? '');
    setSync(current?.syncBeforeStart ?? true);
    // 版本在打开弹窗时冻结：期间轮询拿到别人的新版本也不能用它静默覆盖已有设置。
    setDraftVersion(current?.version ?? 1);
    setInvalid(false);
    setError(undefined);
    setBusy(false);
    setOpened(true);
  }
  function close() {
    if (busyRef.current || closing.current) return;
    closing.current = true;
    setOpened(false);
  }
  function exited() {
    if (!closing.current) return;
    closing.current = false;
    setError(undefined);
    setBusy(false);
    if (!isValidDialogFocus(document.activeElement as HTMLElement | null)) {
      document.querySelector<HTMLElement>('.project-settings-trigger')?.focus();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || closing.current) return;
    const value = branch.trim();
    if (value && !gitBranchSchema.safeParse(value).success) {
      setInvalid(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.updateProjectGit(project.id, {
        baseBranch: value || null, syncBeforeStart: sync, version: draftVersion,
      });
      setSaved(response.settings);
      closing.current = true;
      setOpened(false);
      onChanged();
    } catch (error) {
      setError(error);
    } finally {
      busyRef.current = false;
      if (!closing.current) setBusy(false);
    }
  }

  const syncLabel = current?.syncBeforeStart ? t.git.syncOn : t.git.syncOff;
  return <>
    {configured ? <p className="project-git-summary muted">
      {t.git.defaultBranch} · <code>{current!.baseBranch}</code> · {syncLabel}
      <Button className="project-settings-trigger" variant="transparent" onClick={open}>{t.git.settings}</Button>
    </p> : <div className="callout warning project-git-hint" role="status">
      <p>{t.git.unconfigured}</p>
      <Button className="project-settings-trigger" variant="default" onClick={open}>{t.git.configure}</Button>
    </div>}
    <Modal opened={opened} returnFocus={opened || !isValidDialogFocus(document.activeElement as HTMLElement | null)}
      onExitTransitionEnd={exited} onClose={close} title={`${project.name} · ${t.git.settings}`}
      closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy} closeButtonProps={{ 'aria-label': t.common.close }}>
      <form onSubmit={submit} noValidate>
        <Stack gap="sm">
          <TextInput label={t.git.baseBranch} data-autofocus value={branch}
            placeholder={t.git.branchPlaceholder} description={t.git.baseBranchHelp}
            error={invalid ? t.git.invalidBranch : undefined} disabled={busy}
            onChange={(event) => { setBranch(event.currentTarget.value); setInvalid(false); }} />
          <Switch label={t.git.syncBeforeStart} description={t.git.syncHint} checked={sync} disabled={busy}
            onChange={(event) => setSync(event.currentTarget.checked)} />
          {conflict ? <Alert color="yellow" role="alert">{t.git.conflict}</Alert> : <ErrorNotice error={error} />}
          <Group justify="flex-end">
            <Button variant="default" disabled={busy} onClick={close}>{t.common.dismiss}</Button>
            <Button type="submit" loading={busy}>{t.common.save}</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  </>;
}
