import {
  ApartmentOutlined,
  DashboardOutlined,
  DesktopOutlined,
  LogoutOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { Button, Layout, Menu } from 'antd';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { clearToken, getToken } from './api';
import { AgentsPage } from './pages/AgentsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { RunnersPage } from './pages/RunnersPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const selected = '/' + (loc.pathname.split('/')[1] || 'tasks');
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider theme="light" breakpoint="lg" collapsedWidth="0">
        <div style={{ padding: 16, fontWeight: 700, fontSize: 18 }}>🛰 Orbit</div>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          items={[
            { key: '/tasks', icon: <UnorderedListOutlined />, label: <Link to="/tasks">Tasks</Link> },
            { key: '/agents', icon: <ApartmentOutlined />, label: <Link to="/agents">Agents</Link> },
            { key: '/runners', icon: <DesktopOutlined />, label: <Link to="/runners">Runners</Link> },
            {
              key: '/dashboard',
              icon: <DashboardOutlined />,
              label: <Link to="/dashboard">Dashboard</Link>,
            },
          ]}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingInline: 16,
          }}
        >
          <Button
            icon={<LogoutOutlined />}
            onClick={() => {
              clearToken();
              location.href = '/login';
            }}
          >
            Logout
          </Button>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}

export function App() {
  const authed = !!getToken();
  return (
    <Routes>
      <Route path="/login" element={authed ? <Navigate to="/tasks" /> : <LoginPage />} />
      {!authed ? (
        <Route path="*" element={<Navigate to="/login" replace />} />
      ) : (
        <>
          <Route path="/" element={<Navigate to="/tasks" replace />} />
          <Route path="/tasks" element={<Shell><TasksPage /></Shell>} />
          <Route path="/tasks/:id" element={<Shell><TaskDetailPage /></Shell>} />
          <Route path="/agents" element={<Shell><AgentsPage /></Shell>} />
          <Route path="/runners" element={<Shell><RunnersPage /></Shell>} />
          <Route path="/dashboard" element={<Shell><DashboardPage /></Shell>} />
        </>
      )}
    </Routes>
  );
}
