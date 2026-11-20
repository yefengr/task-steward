import { Button, TextInput } from '@mantine/core';
import { Globe } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { webLoginRequestSchema } from '@pi-steward/contract';
import { Brand, ErrorNotice } from './components/common';
import { api, WebError } from './lib/api';
import { toggleLanguage, useI18n } from './lib/i18n';

export function Login({ onLogin, expired }: { onLogin: () => void; expired: boolean }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!webLoginRequestSchema.safeParse({ password }).success) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.login(password);
      setPassword('');
      onLogin();
    } catch (error) { setError(error); }
    finally { setBusy(false); }
  }
  return <main className="center-page">
    <form className="login-card" onSubmit={submit} noValidate>
      <Brand />
      <h1>{t.common.login}</h1>
      <p className="muted">{t.auth.hint}</p>
      {expired && !error && <p role="status" className="muted">{t.errors.unauthorized}</p>}
      <TextInput label={t.auth.password} type="password" autoComplete="current-password" name="password" required
        value={password} onChange={(event) => { setPassword(event.currentTarget.value); setInvalid(false); }}
        error={invalid ? (password ? t.form.invalid : t.form.required) : undefined} />
      {error instanceof WebError && error.code === 'unauthorized'
        ? <p className="error-text" role="alert">{t.auth.incorrect}</p>
        : <ErrorNotice error={error} />}
      <Button type="submit" loading={busy}>{t.common.login}</Button>
      <div className="login-foot">
        <Button variant="subtle" onClick={toggleLanguage} aria-label={t.common.language}
          leftSection={<Globe size={16} />}>{t.common.languageOption}</Button>
      </div>
    </form>
  </main>;
}
