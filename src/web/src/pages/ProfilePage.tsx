import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { api, setAvatar } from '../api';
import { SignInMethodsCard } from '../components/SignInMethodsCard';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Checkbox } from '../components/ui/Checkbox';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { useFormFields } from '../components/ui/useFormFields';
import { squareJpeg } from '../lib/avatar';
import { accessTokensQuery, avatarQuery, meQuery, type Me } from '../lib/queries';
import { useToast } from '../lib/toast';

/** Under the name: who sees it besides you. The iOS edit-profile card says the same
 *  (`SettingsCopy.nameCaption`). */
export const NAME_CAPTION = 'People in your shared pools see you by this name.';
/** The photo's two actions, in the words the iOS and macOS apps use (`SettingsCopy`). */
export const CHOOSE_PHOTO = 'Choose photo';
export const REMOVE_PHOTO = 'Remove photo';

interface PwdValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  /** Also revoke every personal access token; unticked, they keep working (§11.3). */
  revokeAccessTokens?: boolean;
}

const NO_PASSWORDS = { currentPassword: '', newPassword: '', confirmPassword: '' };

// Self-service profile page: your identity — the photo and the name, which you change here, and the
// email you sign in with — plus account security: how you sign in (a password, and the Google account
// connected or to connect), and changing your own password (re-verified server-side; the existing
// session keeps working — no token revocation — and so do personal access tokens unless the box to
// revoke them is ticked). An account without a password signs in with Google and has no password to
// change, so it is not offered the form. A photo is cut to its middle square and sent the moment it is
// chosen; the name is written by its Save.
export function ProfilePage() {
  const message = useToast();
  const qc = useQueryClient();
  const form = useFormFields(
    NO_PASSWORDS,
    {
      currentPassword: [(value) => (value ? null : 'Enter your current password')],
      newPassword: [
        (value) => (value ? null : 'Enter a new password'),
        (value) => (!value || [...value].length >= 6 ? null : 'At least 6 characters'),
      ],
      confirmPassword: [
        (value) => (value ? null : 'Confirm your new password'),
        (value, values) => (!value || values.newPassword === value ? null : 'Passwords do not match'),
      ],
    },
    { confirmPassword: ['newPassword'] },
  );
  const [revokeTokens, setRevokeTokens] = useState(false);

  const me = useQuery(meQuery());
  const photo = useQuery(avatarQuery(me.data?.avatarUpdatedAt));
  const chooser = useRef<HTMLInputElement>(null);
  /** The name as it is being edited; null until touched, so the saved one shows. */
  const [edited, setEdited] = useState<string | null>(null);
  const draft = edited ?? me.data?.name ?? '';
  const canSave = draft.trim() !== '' && draft.trim() !== (me.data?.name ?? '');
  const initial = (me.data?.name || me.data?.email || '?').trim().charAt(0).toUpperCase();

  /** Every write here answers with the account; it becomes the one every view shows. */
  const adopt = (account: Me) => qc.setQueryData(meQuery().queryKey, account);

  const rename = useMutation({
    mutationFn: () => api<Me>('/users/me', { method: 'PATCH', body: { name: draft.trim() } }),
    onSuccess: (account) => {
      adopt(account);
      setEdited(null);
      message.success('Name saved');
    },
    onError: (e: Error) => message.error("Couldn't save your name", e.message),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => setAvatar(await squareJpeg(file)),
    onSuccess: adopt,
    onError: (e: Error) => message.error("Couldn't save your photo", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api<Me>('/users/me/avatar', { method: 'DELETE' }),
    onSuccess: adopt,
    onError: (e: Error) => message.error("Couldn't remove your photo", e.message),
  });

  const changePwd = useMutation({
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
      form.reset();
      setRevokeTokens(false);
    },
    onError: (e: Error) => message.error("Couldn't change the password", e.message),
  });

  const changePassword = (event: FormEvent) => {
    event.preventDefault();
    if (form.validate()) changePwd.mutate({ ...form.values, revokeAccessTokens: revokeTokens });
  };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <h1 className="page-title">Profile</h1>

      <Card title="Basic information" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Avatar size={64} src={photo.data} style={{ background: 'var(--brand)', flex: 'none', fontSize: 28 }}>
              {initial}
            </Avatar>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button loading={upload.isPending} onClick={() => chooser.current?.click()}>
                {CHOOSE_PHOTO}
              </Button>
              {me.data?.avatarUpdatedAt && (
                <Button loading={remove.isPending} onClick={() => remove.mutate()}>
                  {REMOVE_PHOTO}
                </Button>
              )}
            </div>
            <input
              ref={chooser}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) upload.mutate(file);
              }}
            />
          </div>
          <div>
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 4 }}>Name</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                value={draft}
                maxLength={80}
                autoComplete="name"
                onChange={(e) => setEdited(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing && canSave) rename.mutate();
                }}
              />
              <Button variant="primary" disabled={!canSave} loading={rename.isPending} onClick={() => rename.mutate()}>
                Save
              </Button>
            </div>
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 6 }}>{NAME_CAPTION}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 2 }}>Email</div>
            <div>{me.data?.email ?? '—'}</div>
          </div>
        </div>
      </Card>

      <SignInMethodsCard me={me.data} />

      {me.data?.signInMethods?.password !== false && (
        <Card title="Change password">
          <form onSubmit={changePassword}>
            <Field id="currentPassword" label="Current password" required errors={form.errors.currentPassword}>
              {(control) => (
                <PasswordInput
                  {...control}
                  autoComplete="current-password"
                  invalid={!!form.errors.currentPassword?.length}
                  value={form.values.currentPassword}
                  onChange={(e) => form.set('currentPassword', e.target.value)}
                />
              )}
            </Field>
            <Field id="newPassword" label="New password" required errors={form.errors.newPassword}>
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
            <Button variant="primary" type="submit" loading={changePwd.isPending}>
              Change password
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
