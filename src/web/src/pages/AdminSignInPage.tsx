import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { AdminNav } from '../components/AdminNav';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Radio, RadioGroup } from '../components/ui/Radio';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import '../components/ui/Card.css';
import { copyText } from '../lib/clipboard';
import { authMethodsQuery } from '../lib/googleLink';
import { useToast } from '../lib/toast';

type SignupPolicy = 'EXISTING_ACCOUNTS' | 'OPEN';

/** `GET` and `PUT /admin/sign-in/google` (docs/google-sign-in-design.md §6, §7.1): never the secret, only whether one is saved and whether it still decrypts. */
export interface GoogleSignInSettings {
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  /** A secret is saved and `PROVIDER_SECRET_KEY` can no longer decrypt it: Google sign-in is not working. */
  secretUnreadable: boolean;
  signupPolicy: SignupPolicy;
  /** What to register in the Google Cloud console as the client's authorized redirect URI. */
  redirectUri: string;
}

export const SIGN_IN_SETTINGS_TITLE = 'Google sign-in';
/** Said wherever open sign-up is chosen (§5.6, §7.1). */
export const OPEN_SIGNUP_WARNING =
  'Any Google account can create an account on this server: its first sign-in opens a member account with no password.';
export const INCOMPLETE_WARNING = 'Google sign-in stays off until both the client ID and the client secret are saved.';
/**
 * Said when the saved secret no longer decrypts (§7.1): the switch may read on, but nobody can sign in
 * with Google until the secret is entered again. Entering the secret is the fix, so say so.
 */
export const SECRET_UNREADABLE_WARNING =
  'The saved client secret can no longer be decrypted, usually because PROVIDER_SECRET_KEY changed. '
  + 'Google sign-in is not working: paste the client secret again and save.';

export const googleSignInSettingsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'sign-in', 'google'] as const,
    queryFn: () => api<GoogleSignInSettings>('/admin/sign-in/google'),
  });

/**
 * The admin area's Sign-in settings (docs/google-sign-in-design.md §7.1): the Google OAuth client this
 * server signs people in with, and who may sign up through it. The client secret goes in and never
 * comes back: the field is always empty, says whether one is saved, and a save that leaves it empty
 * keeps the saved one. Google sign-in is on only when it is switched on and both the client ID and the
 * secret are saved — and the saved secret still decrypts: one `PROVIDER_SECRET_KEY` rotation leaves the
 * row in place, and the page says so and asks for the secret again instead of showing On. Every save
 * answers the setting as the server now holds it, which is what the page shows from then on.
 */
export function AdminSignInPage() {
  const message = useToast();
  const qc = useQueryClient();
  const saved = useQuery(googleSignInSettingsQuery());
  /** The fields being edited, over the saved ones; a field not touched shows what is saved. */
  const [draft, setDraft] = useState<{ enabled?: boolean; clientId?: string; signupPolicy?: SignupPolicy }>({});
  const [secret, setSecret] = useState('');
  const ids = { title: useId(), enabled: useId(), clientId: useId(), secret: useId(), policy: useId() };

  const save = useMutation({
    mutationFn: (body: { enabled: boolean; clientId: string; signupPolicy: SignupPolicy; clientSecret?: string }) =>
      api<GoogleSignInSettings>('/admin/sign-in/google', { method: 'PUT', body }),
    onSuccess: (settings) => {
      qc.setQueryData(googleSignInSettingsQuery().queryKey, settings);
      void qc.invalidateQueries({ queryKey: authMethodsQuery().queryKey });
      setDraft({});
      setSecret('');
      message.success('Sign-in settings saved');
    },
    onError: (e: Error) => message.error("Couldn't save the sign-in settings", e.message),
  });

  const copy = async (uri: string) => {
    if (await copyText(uri)) message.success('Redirect URI copied');
    else message.error("Couldn't copy the redirect URI", 'Select it and copy it by hand.');
  };

  if (saved.isPending) {
    return (
      <div className="admin-page">
        <AdminNav />
        <Spinner />
      </div>
    );
  }
  if (saved.isError) {
    return (
      <div className="admin-page">
        <AdminNav />
        <h1 className="page-title">Sign-in</h1>
        <p className="admin-signin-error" role="alert">
          Couldn’t load the sign-in settings: {saved.error.message}
        </p>
      </div>
    );
  }

  const settings = saved.data;
  const enabled = draft.enabled ?? settings.enabled;
  const clientId = draft.clientId ?? settings.clientId;
  const signupPolicy = draft.signupPolicy ?? settings.signupPolicy;
  const changed =
    enabled !== settings.enabled
    || clientId.trim() !== settings.clientId
    || signupPolicy !== settings.signupPolicy
    || secret.trim() !== '';
  const on = settings.enabled && settings.clientId !== '' && settings.hasSecret && !settings.secretUnreadable;
  const incomplete = enabled && (clientId.trim() === '' || (!settings.hasSecret && secret.trim() === ''));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || save.isPending) return;
    save.mutate({
      enabled,
      clientId: clientId.trim(),
      signupPolicy,
      ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
    });
  };

  return (
    <div className="admin-page">
      <AdminNav />
      <h1 className="page-title">Sign-in</h1>
      <form className="orbit-card admin-signin" onSubmit={submit} aria-labelledby={ids.title}>
        <div className="orbit-card-head">
          <h2 className="orbit-card-title" id={ids.title}>
            {SIGN_IN_SETTINGS_TITLE}
          </h2>
          <Badge tone={on ? 'success' : 'default'}>{on ? 'On' : 'Off'}</Badge>
        </div>
        <div className="orbit-card-body admin-signin-fields">
          {settings.secretUnreadable && (
            <div className="admin-signin-warning" role="alert">
              {SECRET_UNREADABLE_WARNING}
            </div>
          )}

          <div className="admin-signin-row">
            <div>
              <div className="admin-signin-label" id={ids.enabled}>
                Allow signing in with Google
              </div>
              <div className="admin-signin-hint">The login page offers Continue with Google, on the web and in the apps.</div>
            </div>
            <Switch
              aria-labelledby={ids.enabled}
              checked={enabled}
              onCheckedChange={(value) => setDraft((d) => ({ ...d, enabled: value }))}
            />
          </div>
          {incomplete && <div className="admin-signin-note">{INCOMPLETE_WARNING}</div>}

          <div className="admin-signin-field">
            <label className="admin-signin-label" htmlFor={ids.clientId}>
              Client ID
            </label>
            <Input
              id={ids.clientId}
              value={clientId}
              placeholder="1234567890-abc.apps.googleusercontent.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft((d) => ({ ...d, clientId: e.target.value }))}
            />
          </div>

          <div className="admin-signin-field">
            <label className="admin-signin-label" htmlFor={ids.secret}>
              Client secret
            </label>
            <Input
              id={ids.secret}
              type="password"
              value={secret}
              placeholder={
                settings.secretUnreadable
                  ? 'Not readable — paste the client secret again'
                  : settings.hasSecret
                    ? 'Saved — enter a new one to replace it'
                    : 'Paste the client secret'
              }
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setSecret(e.target.value)}
            />
            <div className="admin-signin-hint">
              {settings.secretUnreadable
                ? 'The saved secret cannot be decrypted. Paste the client secret again to replace it.'
                : settings.hasSecret
                  ? 'A secret is saved. It is never shown again; leave this empty to keep it.'
                  : 'No secret is saved yet. Once saved, it is never shown again.'}
            </div>
          </div>

          <div className="admin-signin-field">
            <div className="admin-signin-label" id={ids.policy}>
              Who can sign in with Google
            </div>
            <RadioGroup<SignupPolicy>
              aria-labelledby={ids.policy}
              className="admin-signin-policy"
              value={signupPolicy}
              onValueChange={(value) => setDraft((d) => ({ ...d, signupPolicy: value }))}
            >
              <Radio value="EXISTING_ACCOUNTS">
                <span className="admin-signin-choice">Existing accounts only</span>
                <span className="admin-signin-hint">
                  People who already have an account here. Add someone by creating their account in Users.
                </span>
              </Radio>
              <Radio value="OPEN">
                <span className="admin-signin-choice">Anyone with a Google account</span>
                <span className="admin-signin-hint">Open sign-up.</span>
              </Radio>
            </RadioGroup>
            {signupPolicy === 'OPEN' && (
              <div className="admin-signin-warning" role="note">
                {OPEN_SIGNUP_WARNING}
              </div>
            )}
          </div>

          <div className="admin-signin-field">
            <div className="admin-signin-label">Authorized redirect URI</div>
            <div className="admin-signin-redirect">
              <code>{settings.redirectUri}</code>
              <Button size="small" onClick={() => void copy(settings.redirectUri)}>
                Copy
              </Button>
            </div>
            <div className="admin-signin-hint">
              Register it, exactly as written, as an authorized redirect URI of this OAuth client in the Google Cloud console.
            </div>
          </div>

          <div className="admin-signin-actions">
            <Button variant="primary" type="submit" disabled={!changed} loading={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
