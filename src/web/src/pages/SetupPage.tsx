import { useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { api, setSession } from '../api';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Field, FieldFeedback } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { useFormFields } from '../components/ui/useFormFields';
import { firstRunLanding } from '../lib/managedRunner';
import { setupStatusQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
}

const EMPTY = { name: '', email: '', password: '', confirm: '' };

// The address check the replaced form ran (async-validator's email type): at most 320 characters,
// a local part, @, and a dotted domain or a bracketed IPv4 address.
const EMAIL =
  /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+\.)+[a-zA-Z\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]{2,}))$/;
const isEmail = (value: string) => value.length <= 320 && EMAIL.test(value);

/**
 * First-run setup. Reachable only while the deployment has zero users: creates the
 * first account (trust-on-first-use — the first visitor becomes ADMIN) and logs
 * straight in, then sends the operator to the runner-registration guide, the next
 * onboarding step.
 */
export function SetupPage() {
  const message = useToast();
  const status = useQuery(setupStatusQuery());
  const form = useFormFields(
    EMPTY,
    {
      email: [(value) => (!value ? 'Please enter Email' : isEmail(value) ? null : 'Email is not a valid email')],
      password: [(value) => (!value ? 'Please enter Password' : [...value].length < 6 ? 'Password must be at least 6 characters' : null)],
      confirm: [
        (value) => (value ? null : 'Please enter Confirm password'),
        (value, values) => (!value || values.password === value ? null : 'passwords do not match'),
      ],
    },
    { confirm: ['password'] },
  );

  // One-time door: once a user exists, setup is closed. If we land here afterwards
  // (a bookmarked /setup, or a second tab that finished first), fall back to login.
  if (status.data && !status.data.needsSetup) {
    return <Navigate to="/login" replace />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.validate()) return;
    const values = form.values;
    try {
      const res = await api<AuthResponse>('/auth/bootstrap', {
        method: 'POST',
        body: { email: values.email, name: values.name || undefined, password: values.password },
      });
      setSession(res);
      // A brand-new system has no runner yet — start onboarding at the registration guide (or, on a
      // server that offers managed runners, at the landing where the one bootstrap started opens).
      location.href = await firstRunLanding();
    } catch (err) {
      message.error("Couldn't create the account", (err as Error).message);
    }
  };
  // The two password fields show whether their checks passed once they have been checked.
  const feedback = (name: 'password' | 'confirm') =>
    form.checked(name) ? <FieldFeedback status={form.errors[name]?.length ? 'error' : 'success'} /> : undefined;

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--bg-base)' }}>
      <Card title="🛰 Orbit · First-run setup" style={{ width: 440 }}>
        <p style={{ margin: '0 0 1em', color: 'var(--text-3)' }}>
          Create the first account for this deployment. This screen is shown only until the
          first user exists.
        </p>
        <form onSubmit={submit}>
          <Field id="name" label="Name">
            {(control) => (
              <Input
                {...control}
                placeholder="Defaults to the email name"
                autoComplete="name"
                value={form.values.name}
                onChange={(e) => form.set('name', e.target.value)}
              />
            )}
          </Field>
          <Field id="email" label="Email" required errors={form.errors.email}>
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="username"
                invalid={!!form.errors.email?.length}
                value={form.values.email}
                onChange={(e) => form.set('email', e.target.value)}
              />
            )}
          </Field>
          <Field id="password" label="Password" required errors={form.errors.password}>
            {(control) => (
              <PasswordInput
                {...control}
                autoComplete="new-password"
                invalid={!!form.errors.password?.length}
                suffix={feedback('password')}
                value={form.values.password}
                onChange={(e) => form.set('password', e.target.value)}
              />
            )}
          </Field>
          <Field id="confirm" label="Confirm password" required errors={form.errors.confirm}>
            {(control) => (
              <PasswordInput
                {...control}
                autoComplete="new-password"
                invalid={!!form.errors.confirm?.length}
                suffix={feedback('confirm')}
                value={form.values.confirm}
                onChange={(e) => form.set('confirm', e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" style={{ width: '100%' }}>
            Create account & sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
