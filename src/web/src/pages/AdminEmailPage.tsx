import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../components/settings';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { useToast } from '../lib/toast';

type EmailMissing = 'SWITCH' | 'API_KEY' | 'FROM' | 'API_KEY_UNREADABLE';

/** `GET` and `PUT /admin/email` (docs/welcome-email-design.md §3.1): never the key, only whether one is saved and still decrypts. */
export interface EmailSettings {
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyUnreadable: boolean;
  fromAddress: string;
  replyTo: string;
  /** What an empty Reply-To stands for: the earliest administrator's address. */
  replyToDefault: string | null;
  welcomeEnabled: boolean;
  on: boolean;
  missing: EmailMissing[];
  lastWeek: { sent: number; failed: number; failures: Array<{ email: string; at: string; error: string }> };
}

/** `POST /admin/email/test`: what Resend answered. */
type TestResult = { ok: true; to: string; resendId: string } | { ok: false; to: string; status: number | null; error: string };

export const EMAIL_SETTINGS_TITLE = 'Outgoing email';
export const RESEND_KEYS_URL = 'https://resend.com/api-keys';
export const KEY_UNREADABLE_WARNING =
  "The saved API key can't be decrypted (PROVIDER_SECRET_KEY changed). Paste it again — sending is paused until you do.";

/** What the card says while it is Off and something besides the key's readability is missing. */
export function missingSentence(missing: EmailMissing[]): string | null {
  const things = [missing.includes('API_KEY') && 'a Resend API key', missing.includes('FROM') && 'a From address'].filter(Boolean);
  if (things.length > 0) return `Add ${things.join(' and ')} to send email.`;
  if (missing.includes('SWITCH')) return 'Turn on Send email from this deployment to send email.';
  return null;
}

export function testResultText(result: TestResult): string {
  if (result.ok) return `Test email sent to ${result.to} — Resend id ${result.resendId}`;
  if (result.status === null) return `Couldn't send the test email: ${result.error}`;
  return `Couldn't send the test email: Resend answered ${result.status} — ${result.error}`;
}

/** An attempt's time, to the minute: "Nov 11, 2026, 4:21 AM". */
export const attemptTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export const emailSettingsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'email'] as const,
    queryFn: () => api<EmailSettings>('/admin/email'),
  });

/**
 * Admin → Email (docs/welcome-email-design.md §3.1): the Resend key this deployment sends with, From,
 * Reply-To, and whether new accounts get a welcome email. Shaped like Admin → Sign-in: the key goes in
 * and never comes back, a save that leaves it empty keeps the saved one, and a key the server can no
 * longer decrypt is a warning asking for it again. A save holds at once; Send test email sends with the
 * saved setting to the administrator and shows what Resend answered.
 */
export function AdminEmailPage() {
  const message = useToast();
  const qc = useQueryClient();
  const saved = useQuery(emailSettingsQuery());
  const [draft, setDraft] = useState<{ enabled?: boolean; fromAddress?: string; replyTo?: string; welcomeEnabled?: boolean }>({});
  const [apiKey, setApiKey] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [showFailures, setShowFailures] = useState(false);
  const ids = { title: useId(), enabled: useId(), key: useId(), from: useId(), replyTo: useId(), welcome: useId() };

  const save = useMutation({
    mutationFn: (body: { enabled: boolean; fromAddress: string; replyTo: string; welcomeEnabled: boolean; apiKey?: string }) =>
      api<EmailSettings>('/admin/email', { method: 'PUT', body }),
    onSuccess: (settings) => {
      qc.setQueryData(emailSettingsQuery().queryKey, settings);
      setDraft({});
      setApiKey('');
      message.success('Email settings saved');
    },
    onError: (e: Error) => message.error("Couldn't save the email settings", e.message),
  });
  const sendTest = useMutation({
    mutationFn: () => api<TestResult>('/admin/email/test', { method: 'POST' }),
    onMutate: () => setTest(null),
    onSuccess: (result) => setTest(result),
    onError: (e: Error) => setTest({ ok: false, to: '', status: null, error: e.message }),
  });

  if (saved.isPending) {
    return (
      <div className="settings-page">
        <Spinner />
      </div>
    );
  }
  if (saved.isError) {
    return (
      <div className="settings-page">
        <SettingsHeader title="Email" />
        <p className="admin-signin-error" role="alert">
          Couldn’t load the email settings: {saved.error.message}
        </p>
      </div>
    );
  }

  const settings = saved.data;
  const enabled = draft.enabled ?? settings.enabled;
  const fromAddress = draft.fromAddress ?? settings.fromAddress;
  const replyTo = draft.replyTo ?? settings.replyTo;
  const welcomeEnabled = draft.welcomeEnabled ?? settings.welcomeEnabled;
  const changed =
    enabled !== settings.enabled
    || fromAddress.trim() !== settings.fromAddress
    || replyTo.trim() !== settings.replyTo
    || welcomeEnabled !== settings.welcomeEnabled
    || apiKey.trim() !== '';
  const offNote = settings.on ? null : missingSentence(settings.missing);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || save.isPending) return;
    save.mutate({
      enabled,
      fromAddress: fromAddress.trim(),
      replyTo: replyTo.trim(),
      welcomeEnabled,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
  };

  return (
    <form className="settings-page admin-form" onSubmit={submit} aria-labelledby={ids.title}>
      <SettingsHeader title="Email" description="Email this server sends, through Resend." />
      {settings.apiKeyUnreadable && (
        <div className="admin-email-result admin-email-result-error" role="alert">
          {KEY_UNREADABLE_WARNING}
        </div>
      )}
      <SettingsSection
        title={<span id={ids.title}>{EMAIL_SETTINGS_TITLE}</span>}
        description={offNote ?? undefined}
        action={<Badge tone={settings.on ? 'success' : 'default'}>{settings.on ? 'On' : 'Off'}</Badge>}
      >
        <SettingsCard>
          <SettingsRow
            title={<span id={ids.enabled}>Send email from this deployment</span>}
            description="Nothing is sent while this is off."
            control={<Switch aria-labelledby={ids.enabled} checked={enabled} onCheckedChange={(value) => setDraft((d) => ({ ...d, enabled: value }))} />}
          />
          <SettingsRow
            title={<label htmlFor={ids.key}>Resend API key</label>}
            description={
              <>
                A key with sending access is enough. It is never shown again; leave this empty to keep it.{' '}
                <a href={RESEND_KEYS_URL} target="_blank" rel="noreferrer">
                  Create a key in Resend
                </a>
              </>
            }
            control={
              <Input
                id={ids.key}
                className="admin-row-input"
                type="password"
                value={apiKey}
                placeholder={
                  settings.apiKeyUnreadable
                    ? 'Not readable — paste the API key again'
                    : settings.hasApiKey
                      ? 'Saved — enter a new one to replace it'
                      : 're_…'
                }
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
              />
            }
          />
          <SettingsRow
            title={<label htmlFor={ids.from}>From</label>}
            description="Its domain must be verified in Resend."
            control={
              <Input
                id={ids.from}
                className="admin-row-input"
                value={fromAddress}
                placeholder="Orbit <orbit@example.com>"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, fromAddress: e.target.value }))}
              />
            }
          />
          <SettingsRow
            title={<label htmlFor={ids.replyTo}>Reply-To</label>}
            description="Empty: the first administrator's address."
            control={
              <Input
                id={ids.replyTo}
                className="admin-row-input"
                value={replyTo}
                placeholder={settings.replyToDefault ?? 'admin@example.com'}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, replyTo: e.target.value }))}
              />
            }
          />
          <SettingsRow
            title="Test"
            description={
              test ? (
                <span className={test.ok ? 'admin-email-ok' : 'admin-email-failed'} role="status">
                  {testResultText(test)}
                </span>
              ) : (
                'Sends one email to your own address.'
              )
            }
            control={
              <Button
                size="small"
                onClick={() => sendTest.mutate()}
                loading={sendTest.isPending}
                disabled={changed || !settings.hasApiKey}
                title={changed ? 'Save your changes first' : undefined}
              >
                Send test email
              </Button>
            }
          />
          <SettingsRow
            title="Last 7 days"
            description={
              showFailures && settings.lastWeek.failures.length > 0 ? (
                <ul className="admin-email-failures">
                  {settings.lastWeek.failures.map((f) => (
                    <li key={`${f.email}-${f.at}`}>
                      {f.email} · {attemptTime(f.at)} · <span className="admin-email-failed">{f.error}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  Sent {settings.lastWeek.sent} ·{' '}
                  <span className={settings.lastWeek.failed > 0 ? 'admin-email-failed' : undefined}>Failed {settings.lastWeek.failed}</span>
                </>
              )
            }
            control={
              settings.lastWeek.failed > 0 ? (
                <Button size="small" variant="text" onClick={() => setShowFailures((v) => !v)}>
                  {showFailures ? 'Hide failures' : 'Show failures'}
                </Button>
              ) : undefined
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Welcome email">
        <SettingsCard>
          <SettingsRow
            title={<span id={ids.welcome}>Send a welcome email to new accounts</span>}
            description="One email when an account is created, by Google sign-up or in Users."
            control={
              <Switch
                aria-labelledby={ids.welcome}
                checked={welcomeEnabled}
                onCheckedChange={(value) => setDraft((d) => ({ ...d, welcomeEnabled: value }))}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <div className="admin-form-actions">
        <Button variant="primary" type="submit" disabled={!changed} loading={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
