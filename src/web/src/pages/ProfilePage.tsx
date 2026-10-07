import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, Card, Checkbox, Form, Input } from 'antd';
import { useRef, useState } from 'react';
import { api, setAvatar } from '../api';
import { SignInMethodsCard } from '../components/SignInMethodsCard';
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
  const [form] = Form.useForm<PwdValues>();

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
      form.resetFields();
    },
    onError: (e: Error) => message.error("Couldn't change the password", e.message),
  });

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
                onPressEnter={() => canSave && rename.mutate()}
              />
              <Button type="primary" disabled={!canSave} loading={rename.isPending} onClick={() => rename.mutate()}>
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
          <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => changePwd.mutate(v)}>
            <Form.Item
              name="currentPassword"
              label="Current password"
              rules={[{ required: true, message: 'Enter your current password' }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="New password"
              rules={[
                { required: true, message: 'Enter a new password' },
                { min: 6, message: 'At least 6 characters' },
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="Confirm new password"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: 'Confirm your new password' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                    return Promise.reject(new Error('Passwords do not match'));
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="revokeAccessTokens"
              valuePropName="checked"
              extra="Scripts and the orbit CLI using them stop working at once. Unticked, they keep working."
            >
              <Checkbox>Also revoke all my access tokens</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={changePwd.isPending}>
              Change password
            </Button>
          </Form>
        </Card>
      )}
    </div>
  );
}
