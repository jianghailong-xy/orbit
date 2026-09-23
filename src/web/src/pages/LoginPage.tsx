import { Button, Card, Form, Input } from 'antd';
import { api, setSession } from '../api';
import { useToast } from '../lib/toast';

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
}

/**
 * Where a successful login goes: `next` when it is a path on this site, the root otherwise.
 *
 * `next` comes from the URL, so anyone can write it, and following it anywhere would make the
 * login page an open redirect. Only a single leading `/` is a path here — `//host` and `/\host`
 * are other sites to a browser, and so is anything with a scheme. The browser's own reading has the
 * last word: it drops tabs and newlines before it looks, so `/<tab>/host` is `//host` to it.
 */
export function loginDestination(next: string | null): string {
  if (!next || !/^\/(?![/\\])/.test(next)) return '/';
  try {
    return new URL(next, location.origin).origin === location.origin ? next : '/';
  } catch {
    return '/';
  }
}

export function LoginPage() {
  const message = useToast();

  const submit = async (values: Record<string, string>) => {
    try {
      const res = await api<AuthResponse>('/auth/login', { method: 'POST', body: values });
      setSession(res);
      const next = new URLSearchParams(window.location.search).get('next');
      // Back to the page that sent the visitor here (`next`), else land at the root and let
      // <DefaultLanding> resolve the destination — the first workspace's session list, or
      // onboarding (registration guide / runners) when there's no workspace to open yet. A full
      // reload so BootGate pre-warms that first screen behind the splash.
      location.href = loginDestination(next);
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
