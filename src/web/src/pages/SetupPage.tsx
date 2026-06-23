import { App as AntApp, Button, Card, Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { api, setToken } from '../api';
import { setupStatusQuery } from '../lib/queries';

interface AuthResponse {
  accessToken: string;
}

/**
 * First-run setup. Reachable only while the deployment has zero users: creates the
 * first account — guarded by the deploy-time ADMIN_TOKEN — and logs straight in, then
 * sends the operator to the runner-registration guide, the next onboarding step.
 */
export function SetupPage() {
  const { message } = AntApp.useApp();
  const status = useQuery(setupStatusQuery());

  // One-time door: once a user exists, setup is closed. If we land here afterwards
  // (a bookmarked /setup, or a second tab that finished first), fall back to login.
  if (status.data && !status.data.needsSetup) {
    return <Navigate to="/login" replace />;
  }

  const submit = async (values: {
    name?: string;
    email: string;
    password: string;
    adminToken: string;
  }) => {
    try {
      const res = await api<AuthResponse>('/auth/bootstrap', {
        method: 'POST',
        body: { email: values.email, name: values.name, password: values.password },
        headers: { 'x-admin-token': values.adminToken },
      });
      setToken(res.accessToken);
      // A brand-new system has no runner yet — start onboarding at the registration guide.
      location.href = '/runners/register';
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--bg-base)' }}>
      <Card title="🛰 Orbit · First-run setup" style={{ width: 440 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Create the first account for this deployment. This screen is shown only until the
          first user exists.
        </Typography.Paragraph>
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="name" label="Name">
            <Input placeholder="Defaults to the email name" autoComplete="name" />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input type="email" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Password" hasFeedback rules={[{ required: true, min: 6 }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="Confirm password"
            dependencies={['password']}
            hasFeedback
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator: (_, value) =>
                  !value || getFieldValue('password') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error('passwords do not match')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="adminToken"
            label="Admin token"
            rules={[{ required: true }]}
            extra="The ADMIN_TOKEN configured for this deployment (see your .env / docker-compose)."
          >
            <Input.Password autoComplete="off" />
          </Form.Item>
          <Button htmlType="submit" type="primary" block>
            Create account & sign in
          </Button>
        </Form>
      </Card>
    </div>
  );
}
