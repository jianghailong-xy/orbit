import { useMutation, useQuery } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Form, Input } from 'antd';
import { api } from '../api';

interface Me {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

interface PwdValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

// Self-service account page. Profile is read-only for now; the only action is
// changing your own password (the current password is re-verified server-side,
// and the existing session keeps working — no token revocation).
export function AccountSettingsPage() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PwdValues>();

  const me = useQuery({ queryKey: ['user', 'me'], queryFn: () => api<Me>('/users/me') });

  const changePwd = useMutation({
    mutationFn: (v: PwdValues) =>
      api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: v.currentPassword, newPassword: v.newPassword },
      }),
    onSuccess: () => {
      message.success('Password changed');
      form.resetFields();
    },
    onError: (e: Error) => message.error(e.message || 'Failed to change password'),
  });

  return (
    <>
      <h1 className="page-title">Account settings</h1>

      <Card title="Profile" style={{ maxWidth: 480, marginBottom: 16 }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 2 }}>Name</div>
            <div>{me.data?.name ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 2 }}>Email</div>
            <div>{me.data?.email ?? '—'}</div>
          </div>
        </div>
      </Card>

      <Card title="Change password" style={{ maxWidth: 480 }}>
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
          <Button type="primary" htmlType="submit" loading={changePwd.isPending}>
            Change password
          </Button>
        </Form>
      </Card>
    </>
  );
}
