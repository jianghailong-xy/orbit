import { useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, runEventsUrl } from '../api';
import { StatusTag } from '../components/StatusTag';

interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  ts?: string;
}

export function TaskDetailPage() {
  const { id } = useParams();
  const { message } = AntApp.useApp();
  const task = useQuery({
    queryKey: ['task', id],
    queryFn: () => api<any>(`/tasks/${id}`),
    refetchInterval: 3000,
  });
  const [events, setEvents] = useState<RunEvent[]>([]);
  const seen = useRef<Set<number>>(new Set());
  const latestRun = task.data?.runs?.[0];

  useEffect(() => {
    if (!latestRun?.id) return;
    setEvents([]);
    seen.current = new Set();
    const es = new EventSource(runEventsUrl(latestRun.id));
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as RunEvent;
      if (seen.current.has(ev.seq)) return;
      seen.current.add(ev.seq);
      setEvents((prev) => [...prev, ev]);
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [latestRun?.id]);

  if (!task.data) return null;
  const t = task.data;

  const enqueue = async () => {
    try {
      await api(`/tasks/${id}/enqueue`, { method: 'POST' });
      message.success('queued');
      task.refetch();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Space>
          <StatusTag status={t.status} />
          {['DRAFT', 'FAILED', 'CANCELLED'].includes(t.status) && (
            <Button type="primary" onClick={enqueue}>
              Run now
            </Button>
          )}
        </Space>
      </Space>

      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="Task ID">{t.id}</Descriptions.Item>
        <Descriptions.Item label="Source">{t.source}</Descriptions.Item>
        <Descriptions.Item label="Agent">
          {t.agent?.name ?? '—'} ({t.agent?.model ?? '—'})
        </Descriptions.Item>
        <Descriptions.Item label="Runner">{t.assignedRunner?.name ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Prompt" span={2}>
          {t.prompt}
        </Descriptions.Item>
      </Descriptions>

      {latestRun && (
        <Descriptions bordered size="small" column={4} title="Latest run">
          <Descriptions.Item label="Status">
            <StatusTag status={latestRun.status} />
          </Descriptions.Item>
          <Descriptions.Item label="Cost">${(latestRun.costUsd ?? 0).toFixed(4)}</Descriptions.Item>
          <Descriptions.Item label="Tokens">
            {latestRun.sumInputTokens ?? 0} in / {latestRun.sumOutputTokens ?? 0} out
          </Descriptions.Item>
          <Descriptions.Item label="Turns">{latestRun.numTurns ?? 0}</Descriptions.Item>
        </Descriptions>
      )}

      <Card title="Run stream" size="small">
        <div style={{ maxHeight: 480, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
          {events.length === 0 && (
            <Typography.Text type="secondary">No events yet.</Typography.Text>
          )}
          {events.map((e, i) => (
            <EventLine key={i} ev={e} />
          ))}
        </div>
      </Card>
    </Space>
  );
}

function EventLine({ ev }: { ev: RunEvent }) {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'assistant':
      return <div style={{ margin: '4px 0' }}>🤖 {p.text}</div>;
    case 'text_delta':
      return <span>{p.text}</span>;
    case 'tool_use':
      return (
        <div style={{ margin: '4px 0' }}>
          🔧 <Tag>{p.name}</Tag> <code>{JSON.stringify(p.input)}</code>
        </div>
      );
    case 'tool_result':
      return (
        <div style={{ color: '#555' }}>
          ↳ {typeof p.content === 'string' ? p.content : JSON.stringify(p.content)}
        </div>
      );
    case 'system':
      return <div style={{ color: '#999' }}>· {JSON.stringify(p)}</div>;
    case 'status':
      return <div>📍 status: {String(p.status)}</div>;
    case 'error':
      return <div style={{ color: 'red' }}>✖ {String(p.message)}</div>;
    default:
      return (
        <div>
          {ev.type}: {JSON.stringify(p)}
        </div>
      );
  }
}
