import { LoadingOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { sessionsQuery } from '../lib/queries';

// "Active" = sessions that are live or queued right now, grouped by how much they
// need a human. Anything finished (SUCCEEDED/FAILED/CANCELLED) is not shown here.
//   需要你回复 — blocked on you (AWAITING_INPUT) or paused by you (INTERRUPTED)
//   正在运行   — Claude is working (RUNNING)
//   排队中     — waiting for a runner slot (PENDING)
const GROUPS = [
  { key: 'attention', label: '需要你回复', statuses: ['AWAITING_INPUT', 'INTERRUPTED'] },
  { key: 'running', label: '正在运行', statuses: ['RUNNING'] },
  { key: 'queued', label: '排队中', statuses: ['PENDING'] },
];
const ACTIVE = GROUPS.flatMap((g) => g.statuses);

// Compact Chinese relative time: 刚刚 / N 分钟 / N 小时 / N 天.
const fmtAgo = (d?: string | null): string => {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时`;
  return `${Math.floor(diff / day)} 天`;
};

// Most-recent activity drives both the time label and the in-group ordering.
const timeOf = (s: any): string => s.lastTurnAt ?? s.startedAt ?? s.createdAt;

// A time phrase tuned to the session's state: running shows elapsed, waiting shows
// how long it's been blocked, queued just says it's waiting for a slot.
function timeLabel(s: any): string {
  const ago = fmtAgo(timeOf(s));
  if (s.status === 'RUNNING') return ago ? `已跑 ${ago}` : '';
  if (s.status === 'PENDING') return '等待算力';
  return ago ? `等待 ${ago}` : '';
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'RUNNING')
    return (
      <span className="status-pill running">
        <LoadingOutlined spin />
        运行中
      </span>
    );
  if (status === 'PENDING')
    return (
      <span className="status-pill queued">
        <span className="status-dot" />
        排队中
      </span>
    );
  return (
    <span className="status-pill awaiting">
      <span className="status-dot" />
      {status === 'INTERRUPTED' ? '已中断' : '等待回复'}
    </span>
  );
}

export function ActiveSessionsView() {
  const navigate = useNavigate();
  // Same query the agent console uses; poll often since this is the "what's live now" view.
  const sessionsQ = useQuery({ ...sessionsQuery({ view: 'active' }), refetchInterval: 4000 });

  // view=active is "not archived, not deleted" — it still includes finished and
  // system sessions, so filter to real, still-live ones here.
  const active = (sessionsQ.data ?? []).filter(
    (s: any) => s.source !== 'system' && ACTIVE.includes(s.status),
  );

  const renderRow = (s: any) => {
    const meta = [s.agent?.name, s.assignedRunner?.name, timeLabel(s)].filter(Boolean).join(' · ');
    return (
      <div
        className="task-row clickable session-row"
        key={s.id}
        onClick={() => navigate(`/sessions/${encodeId(s.id)}`)}
      >
        <div className="task-status-cell">
          <StatusBadge status={s.status} />
        </div>
        <div className="task-title-cell">
          <span className="task-title">{s.title || '(无标题会话)'}</span>
          {s.pendingApprovals > 0 ? (
            <span className="session-approval-badge">{s.pendingApprovals} 待审批</span>
          ) : null}
        </div>
        <div className="task-cell session-meta">{meta}</div>
      </div>
    );
  };

  return (
    <>
      <h1 className="page-title">Active</h1>
      {sessionsQ.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : active.length === 0 ? (
        <div style={{ padding: '32px 16px', color: '#8a9099', fontSize: 13 }}>
          当前没有正在运行的会话。
        </div>
      ) : (
        <div className="orbit-sessionlist">
          {GROUPS.map((g) => {
            // Oldest activity first within a group: the longest-waiting / longest-running
            // session floats to the top, where it most needs attention.
            const rows = active
              .filter((s: any) => g.statuses.includes(s.status))
              .sort((a: any, b: any) => timeOf(a).localeCompare(timeOf(b)));
            if (rows.length === 0) return null;
            return (
              <div className="session-group" key={g.key}>
                <div className={`session-group-head ${g.key}`}>
                  {g.label}
                  <span className="session-group-count">{rows.length}</span>
                </div>
                {rows.map((s: any) => renderRow(s))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
