import { Button, TextInput } from '@mantine/core';
import { Check, Copy, Laptop, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'wouter';
import { STEW_INSTALL_COMMAND } from '@pi-steward/contract';
import { api, describeError, WebError } from '../lib/api';
import { useI18n } from '../lib/i18n';

const PAIR_COMMAND = 'stew pair';
const START_COMMAND = 'stew start';
const ADD_COMMAND = 'stew add';

function CommandCopy({ command }: { command: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState('copied');
    } catch { setState('failed'); }
  }
  return <>
    <div className="command-line">
      <code>{command}</code>
      <Button variant="transparent" leftSection={state === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        aria-label={`${t.onboarding.copy} ${command}`} onClick={() => void copy()}>
        {state === 'copied' ? t.onboarding.copied : t.onboarding.copy}
      </Button>
    </div>
    {state === 'failed' && <p className="error-text" role="alert">{t.onboarding.copyFailed}</p>}
  </>;
}

export function GettingStarted({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  const steps = [
    { command: STEW_INSTALL_COMMAND, title: t.onboarding.install, hint: t.onboarding.installHint },
    { command: PAIR_COMMAND, title: t.onboarding.pair, hint: t.onboarding.pairHint },
    { command: START_COMMAND, title: t.onboarding.start, hint: t.onboarding.startHint },
    { command: ADD_COMMAND, title: t.onboarding.add, hint: t.onboarding.addHint },
  ];
  const body = <>
    <div className="onboarding-steps">
      {steps.map((step, index) => <section className="onboarding-step" key={step.command}>
        <h3>{index + 1}. {step.title}</h3>
        <p className="muted small">{step.hint}</p>
        <CommandCopy command={step.command} />
      </section>)}
    </div>
    <div className="onboarding-links">
      <Button component={Link} href="/pair" leftSection={<Terminal size={16} />}>{t.onboarding.confirm}</Button>
      <Button component={Link} href="/machines" variant="transparent" leftSection={<Laptop size={16} />}>{t.onboarding.viewMachines}</Button>
    </div>
  </>;
  if (collapsed) return <details className="onboarding fold">
    <summary>{t.onboarding.more}</summary>
    <div className="fold-body onboarding-body">{body}</div>
  </details>;
  return <section className="onboarding onboarding-primary" aria-label={t.onboarding.title}>
    <h2>{t.onboarding.title}</h2>
    <p className="muted onboarding-intro">{t.onboarding.intro}</p>
    {body}
  </section>;
}

type Pairing = Awaited<ReturnType<typeof api.inspectPairing>>;
type Approved = Awaited<ReturnType<typeof api.approvePairing>>;

export function PairComputer() {
  const { t, dateTime } = useI18n();
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState<Pairing>();
  const [approved, setApproved] = useState<Approved>();
  const [busy, setBusy] = useState<'inspect' | 'approve'>();
  const [error, setError] = useState<{ cause: unknown; approval: boolean }>();
  const focus = useRef<HTMLElement | null>(null);
  const stage = approved ? 'approved' : pairing ? 'pending' : 'input';
  useEffect(() => { focus.current?.focus(); }, [stage]);
  const errorCode = error?.cause instanceof WebError ? error.cause.code : undefined;
  const errorMessage = error && (errorCode === 'not_found' ? t.pair.codeUnavailable
    : errorCode === 'conflict' ? t.pair.nameConflict
    : error.approval && ['network', 'invalidResponse', 'internal_error'].includes(errorCode ?? '') ? t.pair.approvalUnknown
    : describeError(error.cause, t));

  async function inspect() {
    if (busy) return;
    const normalized = code.trim().toUpperCase();
    setBusy('inspect');
    setError(undefined);
    try {
      setPairing(await api.inspectPairing(normalized));
      setCode(normalized);
    } catch (inspectError) {
      setPairing(undefined);
      setError({ cause: inspectError, approval: false });
    } finally { setBusy(undefined); }
  }

  async function approve() {
    if (busy || !pairing) return;
    setBusy('approve');
    setError(undefined);
    try {
      setApproved(await api.approvePairing(code));
      setPairing(undefined);
      setCode('');
    } catch (approveError) {
      setPairing(undefined);
      setError({ cause: approveError, approval: true });
    }
    finally { setBusy(undefined); }
  }

  function reset() {
    setCode('');
    setPairing(undefined);
    setApproved(undefined);
    setError(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void inspect();
  }

  if (approved) return <section className="pair-card" aria-label={t.pair.success}>
    <h2 ref={(element) => { focus.current = element; }} tabIndex={-1}>{t.pair.success}</h2>
    <p><strong>{approved.name}</strong> {t.pair.successHint}</p>
    <p className="pair-step">{t.pair.start}</p>
    <CommandCopy command={START_COMMAND} />
    <p className="muted small">{t.pair.startHint}</p>
    <div className="action-bar">
      <Button component={Link} href="/machines" leftSection={<Laptop size={16} />}>{t.pair.machines}</Button>
      <Button variant="transparent" onClick={reset}>{t.pair.again}</Button>
    </div>
  </section>;

  return <div className="pair-page">
    <p className="muted pair-hint">{t.pair.hint}</p>
    {errorMessage && <div className="callout warning" role="alert">
      <p>{errorMessage}</p>
      {error?.approval && <Link href="/machines">{t.pair.machines}</Link>}
    </div>}
    {pairing ? <section className="pair-card" aria-label={t.pair.request}>
      <h2 ref={(element) => { focus.current = element; }} tabIndex={-1}>{t.pair.request}</h2>
      <dl className="kv">
        <div className="kv-item"><dt>{t.pair.name}</dt><dd>{pairing.name}</dd></div>
        <div className="kv-item"><dt>{t.pair.code}</dt><dd className="pair-code">{code}</dd></div>
        <div className="kv-item"><dt>{t.pair.expires}</dt><dd>{dateTime(pairing.expiresAt)}</dd></div>
      </dl>
      <p className="callout warning">{t.pair.warning}</p>
      <div className="action-bar">
        <Button onClick={() => void approve()} loading={busy === 'approve'}>{t.pair.approve}</Button>
        <Button variant="transparent" onClick={() => void inspect()} disabled={Boolean(busy)}>{t.pair.recheck}</Button>
        <Button variant="transparent" onClick={reset} disabled={Boolean(busy)}>{t.pair.changeCode}</Button>
      </div>
    </section> : <form className="pair-card pair-form" onSubmit={submit} noValidate>
      <TextInput label={t.pair.code} placeholder={t.pair.placeholder} value={code} maxLength={10}
        ref={(element) => { focus.current = element; }} disabled={busy === 'inspect'}
        autoComplete="off" autoCapitalize="characters" spellCheck={false} classNames={{ input: 'pair-input' }}
        onChange={(event) => setCode(event.currentTarget.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 10))} />
      <Button type="submit" loading={busy === 'inspect'}>{t.pair.inspect}</Button>
    </form>}
  </div>;
}
