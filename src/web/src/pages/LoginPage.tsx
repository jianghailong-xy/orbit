import { App as AntApp, Button, Card, Form, Input } from 'antd';
import { api, setSession } from '../api';

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
}

export function LoginPage() {
  const { message } = AntApp.useApp();

  const submit = async (values: Record<string, string>) => {
    try {
      const res = await api<AuthResponse>('/auth/login', { method: 'POST', body: values });
      setSession(res);
      const next = new URLSearchParams(window.location.search).get('next');
      // Land at the root and let <DefaultLanding> resolve the destination — the first agent's
      // session list, or onboarding (registration guide / runners) when there's no agent to open
      // yet. A full reload so BootGate pre-warms that first screen behind the splash.
      location.href = next && next.startsWith('/') ? next : '/';
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--bg-base)' }}>
      <Card title="🛰 Orbit" style={{ width: 400 }}>
        <Form layout="vertical" onFinish={submit}>
          <Form.Item name="email" label="Email" rules={[{ required: true }]}>
            <Input type="email" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button htmlType="submit" type="primary" block>
            Login
          </Button>
        </Form>
      </Card>
    </div>
  );
}
