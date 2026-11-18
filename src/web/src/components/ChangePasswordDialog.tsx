import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { api } from '../api';
import { accessTokensQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { Dialog } from './ui/Dialog';
import { Field } from './ui/Field';
import { PasswordInput } from './ui/PasswordInput';
import { useFormFields } from './ui/useFormFields';

export const CHANGE_PASSWORD = 'Change password';
export const NEW_PASSWORD_RULE = 'At least 6 characters';

interface PwdValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  /** Also revoke every personal access token; unticked, they keep working (§11.3). */
  revokeAccessTokens?: boolean;
}

const NO_PASSWORDS = { currentPassword: '', newPassword: '', confirmPassword: '' };

/**
 * Profile → Sign-in methods → Password → Change (docs/mocks/profile-change-password-dialog): the
 * current password, the new one twice, and whether to revoke every access token as well. The password
 * is re-verified server-side; the session keeps working, and so do access tokens unless the box is
 * ticked. The form starts over each time the dialog opens. A refusal is said inside the dialog, which
 * stays open with what was typed; while the request is out the dialog cannot be closed. Done, it closes
 * and a toast says so.
 */
export function ChangePasswordDialog({
  open,
  onClose,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const current = useRef<HTMLInputElement>(null);
  const change = useMutation({
    mutationFn: (v: PwdValues) =>
      api<{ success: boolean; revokedAccessTokens?: number }>('/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword: v.currentPassword,
          newPassword: v.newPassword,
          ...(v.revokeAccessTokens ? { revokeAccessTokens: true } : {}),
        },
      }),
    onSuccess: (result) => {
      const revoked = result?.revokedAccessTokens ?? 0;
      if (revoked > 0) {
        void qc.invalidateQueries({ queryKey: accessTokensQuery().queryKey });
        message.success('Password changed', revoked === 1 ? '1 access token revoked' : `${revoked} access tokens revoked`);
      } else {
        message.success('Password changed');
      }
      close();
    },
    onError: () => current.current?.focus(),
  });
  const close = () => {
    change.reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={CHANGE_PASSWORD}
      width={400}
      initialFocus={current}
      returnFocus={returnFocus}
      busy={change.isPending}
      className="change-password-dialog"
    >
      <ChangePasswordForm
        currentRef={current}
        error={change.error}
        pending={change.isPending}
        onCancel={close}
        onSubmit={(values) => change.mutate(values)}
      />
    </Dialog>
  );
}

function ChangePasswordForm({
  currentRef,
  error,
  pending,
  onCancel,
  onSubmit,
}: {
  currentRef: RefObject<HTMLInputElement | null>;
  error: Error | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: PwdValues) => void;
}) {
  const form = useFormFields(
    NO_PASSWORDS,
    {
      currentPassword: [(value) => (value ? null : 'Enter your current password')],
      newPassword: [
        (value) => (value ? null : 'Enter a new password'),
        (value) => (!value || [...value].length >= 6 ? null : NEW_PASSWORD_RULE),
      ],
      confirmPassword: [
        (value) => (value ? null : 'Confirm your new password'),
        (value, values) => (!value || values.newPassword === value ? null : 'Passwords do not match'),
      ],
    },
    { confirmPassword: ['newPassword'] },
  );
  const [revokeTokens, setRevokeTokens] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (form.validate()) onSubmit({ ...form.values, revokeAccessTokens: revokeTokens });
  };

  return (
    <form onSubmit={submit}>
      {error && (
        <Alert type="error" title="Couldn't change the password" description={error.message} style={{ marginBottom: 16 }} />
      )}
      <Field id="currentPassword" label="Current password" required errors={form.errors.currentPassword}>
        {(control) => (
          <PasswordInput
            {...control}
            ref={currentRef}
            autoComplete="current-password"
            invalid={!!form.errors.currentPassword?.length}
            value={form.values.currentPassword}
            onChange={(e) => form.set('currentPassword', e.target.value)}
          />
        )}
      </Field>
      <Field
        id="newPassword"
        label="New password"
        required
        errors={form.errors.newPassword}
        extra={form.errors.newPassword?.length ? undefined : NEW_PASSWORD_RULE}
      >
        {(control) => (
          <PasswordInput
            {...control}
            autoComplete="new-password"
            invalid={!!form.errors.newPassword?.length}
            value={form.values.newPassword}
            onChange={(e) => form.set('newPassword', e.target.value)}
          />
        )}
      </Field>
      <Field id="confirmPassword" label="Confirm new password" required errors={form.errors.confirmPassword}>
        {(control) => (
          <PasswordInput
            {...control}
            autoComplete="new-password"
            invalid={!!form.errors.confirmPassword?.length}
            value={form.values.confirmPassword}
            onChange={(e) => form.set('confirmPassword', e.target.value)}
          />
        )}
      </Field>
      <Field
        id="revokeAccessTokens"
        extra="Scripts and the orbit CLI using them stop working at once. Unticked, they keep working."
      >
        {(control) => (
          <Checkbox {...control} checked={revokeTokens} onCheckedChange={setRevokeTokens}>
            Also revoke all my access tokens
          </Checkbox>
        )}
      </Field>
      <div className="orbit-overlay-footer">
        <Button disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={pending}>
          {CHANGE_PASSWORD}
        </Button>
      </div>
    </form>
  );
}
