import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons';
import type { Runner } from './TasksSidePanel';

// Visual scaffold for a selected agent's detail view. Like the rest of the side
// navigation, these sessions are placeholder rows — they are not wired to Orbit
// data yet. Selecting a runner on the left renders this view on the right.
interface Session {
  id: string;
  title: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  meta: string;
  time: string;
}

const SESSIONS: Session[] = [
  {
    id: 's1',
    title: 'Migration build engine to tea-cli',
    status: 'RUNNING',
    meta: 'acceptEdits · claude-sonnet-4-6 · 6 turns',
    time: '2m ago',
  },
  {
    id: 's2',
    title: 'Dorado 项目152 psm 改为 data.tea.build_compliance',
    status: 'SUCCEEDED',
    meta: 'Succeeded · 12 turns · $0.42',
    time: '1h ago',
  },
  {
    id: 's3',
    title: 'importer not-ready sg 2026-06-13',
    status: 'SUCCEEDED',
    meta: 'Succeeded · 8 turns · $0.21',
    time: '3h ago',
  },
  {
    id: 's4',
    title: 'importer not-ready sg 2026-06-12',
    status: 'FAILED',
    meta: 'Failed: exit code 1 · 3 turns',
    time: '1d ago',
  },
  {
    id: 's5',
    title: 'Dorado 项目152 owner 变更为 jianghailong.rd',
    status: 'SUCCEEDED',
    meta: 'Succeeded · 5 turns · $0.13',
    time: '2d ago',
  },
];

const STATUS_LABEL: Record<Session['status'], { text: string; color: string }> = {
  RUNNING: { text: 'Running', color: '#3370ff' },
  SUCCEEDED: { text: 'Done', color: '#2ea121' },
  FAILED: { text: 'Failed', color: '#f54a45' },
};

function SessionIcon({ status }: { status: Session['status'] }) {
  if (status === 'RUNNING') return <LoadingOutlined spin style={{ color: '#3370ff', fontSize: 16 }} />;
  if (status === 'SUCCEEDED') return <CheckCircleFilled style={{ color: '#2ea121', fontSize: 16 }} />;
  return <CloseCircleFilled style={{ color: '#f54a45', fontSize: 16 }} />;
}

export function AgentView({ runner }: { runner: Runner }) {
  return (
    <div className="agent-view">
      <div className="agent-header">
        <span className={`agent-status-dot ${runner.online ? 'online' : ''}`} />
        <div className="agent-header-main">
          <div className="agent-name">{runner.name}</div>
          <div className="agent-sub">{runner.online ? 'Online' : 'Offline'}</div>
        </div>
        <div className="agent-header-spacer" />
        <div className="agent-header-count">{SESSIONS.length} sessions</div>
      </div>

      <div className="session-head">Sessions</div>
      <div>
        {SESSIONS.map((s) => {
          const label = STATUS_LABEL[s.status];
          return (
            <div className="session-row" key={s.id}>
              <span className="session-icon">
                <SessionIcon status={s.status} />
              </span>
              <div className="session-main">
                <div className="session-title">{s.title}</div>
                <div className="session-meta">{s.meta}</div>
              </div>
              <div className="session-right">
                <div className="session-status" style={{ color: label.color }}>
                  {label.text}
                </div>
                <div className="session-time">{s.time}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
