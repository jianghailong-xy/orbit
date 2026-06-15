import { App as AntApp, Button, Card, Form, Input, Tabs } from 'antd';
import { api, setToken } from '../api';

interface AuthResponse {
  accessToken: string;
}

export function LoginPage() {
  const { message } = AntApp.useApp();

  const submit = async (path: string, values: Record<string, string>) => {
    try {
      const res = await api<AuthResponse>(path, { method: 'POST', body: values });
      setToken(res.accessToken);
      location.href = '/tasks';
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: '#f0f2f5' }}>
      <Card title="🛰 Orbit" style={{ width: 400 }}>
        <Tabs
          items={[
            {
              key: 'login',
              label: 'Login',
              children: (
                <Form layout="vertical" onFinish={(v) => submit('/auth/login', v)}>
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
              ),
            },
            {
              key: 'register',
              label: 'Register',
              children: (
                <Form layout="vertical" onFinish={(v) => submit('/auth/register', v)}>
                  <Form.Item name="name" label="Name" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="email" label="Email" rules={[{ required: true }]}>
                    <Input type="email" />
                  </Form.Item>
                  <Form.Item
                    name="password"
                    label="Password"
                    rules={[{ required: true }, { min: 6 }]}
                  >
                    <Input.Password />
                  </Form.Item>
                  <Button htmlType="submit" type="primary" block>
                    Create account
                  </Button>
                </Form>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
