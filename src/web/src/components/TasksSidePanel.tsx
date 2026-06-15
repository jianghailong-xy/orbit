import {
  BookOutlined,
  CaretDownOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  LogoutOutlined,
  PlusOutlined,
  ProfileOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Dropdown } from 'antd';
import { useState } from 'react';
import { clearToken } from '../api';

// Static Feishu-style left navigation for the Tasks page. These entries are a
// visual scaffold — they are not wired to Orbit data yet, so selecting one only
// moves the highlight (it does not filter the list on the right).
const TOP = [
  { key: 'running', icon: <UserOutlined />, label: 'Running', count: 385 },
  { key: 'schedule', icon: <BookOutlined />, label: 'Schedule' },
  { key: 'activities', icon: <ClockCircleOutlined />, label: 'Activities' },
];

const QUICK = [
  { key: 'agent1', label: 'Agent 1' },
  { key: 'agent2', label: 'Agent 2' },
  { key: 'agent3', label: 'Agent 3' },
  { key: 'agent4', label: 'Agent 4' },
];

const LISTS = [
  { key: 'l1', label: '#1 TEA - Migration build engine to tea-cli' },
  { key: 'l3', label: '#3 Dorado 项目152 psm 改为 data.tea.build_compliance' },
  { key: 'l4', label: '#4 Dorado 项目152 owner 变更为 jianghailong.rd' },
  { key: 'l7', label: '#7 importer not-ready sg 2026-06-12' },
  { key: 'l8', label: '#8 importer not-ready sg 2026-06-13' },
];

function logout() {
  clearToken();
  location.href = '/login';
}

export function TasksSidePanel() {
  const [sel, setSel] = useState('running');
  const [quickOpen, setQuickOpen] = useState(true);
  const [archOpen, setArchOpen] = useState(false);

  return (
    <aside className="tasks-panel">
      <div className="tp-brand">
        <span className="tp-brand-logo">🛰</span>
        <span className="tp-brand-name">Orbit</span>
      </div>

      <div className="tp-scroll">
        <div className="tp-section">
          {TOP.map((t) => (
            <div
              key={t.key}
              className={`tp-item ${sel === t.key ? 'active' : ''}`}
              onClick={() => setSel(t.key)}
            >
              <span className="tp-ico">{t.icon}</span>
              <span className="tp-label">{t.label}</span>
              {t.count != null && <span className="tp-count">{t.count}</span>}
            </div>
          ))}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setQuickOpen((o) => !o)}>
            <CaretDownOutlined className={`tp-caret ${quickOpen ? '' : 'collapsed'}`} />
            <span className="tp-group-name">Agents</span>
          </div>
          {quickOpen &&
            QUICK.map((q) => (
              <div
                key={q.key}
                className={`tp-item inset ${sel === q.key ? 'active' : ''}`}
                onClick={() => setSel(q.key)}
              >
                <span className="tp-label">{q.label}</span>
              </div>
            ))}
        </div>

        <div className="tp-divider" />

        <div className="tp-group">
          <div className="tp-group-head">
            <ProfileOutlined className="tp-group-ico" />
            <span className="tp-group-name">Task List</span>
            <PlusOutlined className="tp-add" />
          </div>
          {LISTS.map((l) => (
            <div
              key={l.key}
              className={`tp-item tp-sub ${sel === l.key ? 'active' : ''}`}
              onClick={() => setSel(l.key)}
            >
              <span className="tp-ico">
                <CheckSquareOutlined />
              </span>
              <span className="tp-label">{l.label}</span>
            </div>
          ))}
        </div>

        <div className="tp-group">
          <div className="tp-group-head" onClick={() => setArchOpen((o) => !o)}>
            <CaretDownOutlined className={`tp-caret ${archOpen ? '' : 'collapsed'}`} />
            <span className="tp-group-name">Archived</span>
          </div>
        </div>

        <div className="tp-newgroup">
          <PlusOutlined />
          <span>New Group</span>
        </div>
      </div>

      <div className="tp-user">
        <Dropdown
          placement="topLeft"
          menu={{
            items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Logout', onClick: logout }],
          }}
        >
          <div className="tp-user-trigger">
            <Avatar
              size={32}
              icon={<UserOutlined />}
              style={{ background: '#3370ff', flex: 'none' }}
            />
          </div>
        </Dropdown>
      </div>
    </aside>
  );
}
