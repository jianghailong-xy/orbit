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
      location.href = next && next.startsWith('/') ? next : '/tasks';
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: '#f0f2f5' }}>
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
