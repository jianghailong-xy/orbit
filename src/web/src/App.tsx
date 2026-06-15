import { LogoutOutlined, UnorderedListOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Dropdown, Tooltip } from 'antd';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { clearToken, getToken } from './api';
import { LoginPage } from './pages/LoginPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';

const NAV = [{ key: '/tasks', icon: <UnorderedListOutlined />, label: 'Tasks' }];

function logout() {
  clearToken();
  location.href = '/login';
}

function Rail() {
  const loc = useLocation();
  const selected = '/' + (loc.pathname.split('/')[1] || 'tasks');
  return (
    <div className="orbit-rail">
      <div className="rail-inner">
        <div className="rail-logo">🛰</div>
        <div className="rail-nav">
          {NAV.map((n) => (
            <Tooltip key={n.key} title={n.label} placement="right">
              <Link to={n.key} className={`rail-item ${selected === n.key ? 'active' : ''}`}>
                {n.icon}
              </Link>
            </Tooltip>
          ))}
        </div>
        <div className="rail-footer">
          <Dropdown
            placement="topRight"
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Logout', onClick: logout }],
            }}
          >
            <Avatar
              size={32}
              icon={<UserOutlined />}
              style={{ background: '#3370ff', cursor: 'pointer' }}
            />
          </Dropdown>
        </div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  // The Tasks list page renders its own full-height two-pane layout; every
  // other page gets standard content padding.
  const isTasksList = loc.pathname === '/tasks';
  return (
    <div className="orbit-shell">
      <Rail />
      <div className="orbit-main">
        {isTasksList ? children : <div className="orbit-page-pad">{children}</div>}
      </div>
    </div>
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
        </>
      )}
    </Routes>
  );
}
