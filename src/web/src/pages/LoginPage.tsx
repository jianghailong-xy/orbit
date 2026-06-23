import { App as AntApp, Button, Card, Form, Input } from 'antd';
import { api, setToken } from '../api';

interface AuthResponse {
  accessToken: string;
}

export function LoginPage() {
  const { message } = AntApp.useApp();

  const submit = async (values: Record<string, string>) => {
    try {
      const res = await api<AuthResponse>('/auth/login', { method: 'POST', body: values });
      setToken(res.accessToken);
      const next = new URLSearchParams(window.location.search).get('next');
      if (next && next.startsWith('/')) {
        location.href = next;
        return;
      }
      // Brand-new accounts have no runner yet — drop them on the registration guide
      // so onboarding starts there instead of an empty Active view.
      let dest = '/active';
      try {
        const runners = await api<unknown[]>('/runners');
        if (runners.length === 0) dest = '/runners/register';
      } catch {
        // If the check fails, fall back to the normal landing.
      }
      location.href = dest;
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
