import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Space, Statistic, Table, Typography } from 'antd';
import { api } from '../api';
import { StatusTag } from '../components/StatusTag';

export function DashboardPage() {
  const d = useQuery({
    queryKey: ['costs'],
    queryFn: () => api<any>('/dashboard/costs'),
    refetchInterval: 5000,
  });
  const data = d.data;

  const recentColumns = [
    { title: 'Task', dataIndex: ['task', 'title'] },
    { title: 'Agent', dataIndex: ['agent', 'name'], render: (n: string) => n ?? '—' },
    { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
    {
      title: 'Cost',
      dataIndex: 'costUsd',
      render: (c: number) => `$${(c ?? 0).toFixed(4)}`,
    },
    {
      title: 'Tokens (in/out)',
      key: 'tok',
      render: (_: unknown, r: any) => `${r.sumInputTokens ?? 0} / ${r.sumOutputTokens ?? 0}`,
    },
    {
      title: 'Finished',
      dataIndex: 'finishedAt',
      render: (x: string) => (x ? new Date(x).toLocaleString() : '—'),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Typography.Title level={3} style={{ margin: 0 }}>
        Dashboard
      </Typography.Title>

      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic
              title="Total cost (est.)"
              value={data?.totalCostUsd ?? 0}
              precision={4}
              prefix="$"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="Runs" value={data?.runs ?? 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="Input tokens" value={data?.totalInputTokens ?? 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="Output tokens" value={data?.totalOutputTokens ?? 0} />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Tasks by status">
        <Space wrap>
          {(data?.tasksByStatus ?? []).map((s: any) => (
            <span key={s.status}>
              <StatusTag status={s.status} /> {s.count}
            </span>
          ))}
          {(data?.tasksByStatus ?? []).length === 0 && (
            <Typography.Text type="secondary">No tasks yet.</Typography.Text>
          )}
        </Space>
      </Card>

      <Card size="small" title="Recent runs">
        <Table
          rowKey="id"
          size="small"
          loading={d.isLoading}
          dataSource={data?.recentRuns ?? []}
          columns={recentColumns as any}
          pagination={false}
        />
      </Card>

      <Typography.Text type="secondary">
        Cost is the Claude Code client-side estimate (`total_cost_usd`). For authoritative billing,
        reconcile with the Anthropic Usage &amp; Cost API.
      </Typography.Text>
    </Space>
  );
}
