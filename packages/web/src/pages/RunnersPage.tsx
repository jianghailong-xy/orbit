import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { StatusTag } from '../components/StatusTag';

export function RunnersPage() {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [modal, setModal] = useState<{ open: boolean; token?: any }>({ open: false });
  const [form] = Form.useForm();

  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<any[]>('/runners'),
    refetchInterval: 5000,
  });

  const createToken = useMutation({
    mutationFn: (body: unknown) =>
      api<any>('/runners/enrollment-tokens', { method: 'POST', body }),
    onSuccess: (res) => {
      setModal({ open: true, token: res });
      form.resetFields();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/runners/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runners'] }),
  });

  const columns = [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
    {
      title: 'Labels',
      dataIndex: 'labels',
      render: (l: string[]) => (l ?? []).map((x) => <Tag key={x}>{x}</Tag>),
    },
    { title: 'Max concurrent', dataIndex: 'maxConcurrent' },
    {
      title: 'Last heartbeat',
      dataIndex: 'lastHeartbeatAt',
      render: (d: string) => (d ? new Date(d).toLocaleString() : '—'),
    },
    {
      title: '',
      key: 'a',
      render: (_: unknown, r: any) => (
        <Button size="small" danger type="text" onClick={() => remove.mutate(r.id)}>
          Remove
        </Button>
      ),
    },
  ];

  const token = modal.token?.token as string | undefined;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Runners
        </Typography.Title>
        <Button type="primary" onClick={() => setModal({ open: true })}>
          Register a machine
        </Button>
      </Space>

      <Table
        rowKey="id"
        loading={runners.isLoading}
        dataSource={runners.data ?? []}
        columns={columns as any}
        pagination={false}
      />

      <Modal
        title="Register a runner"
        open={modal.open}
        footer={null}
        onCancel={() => setModal({ open: false })}
      >
        {!token ? (
          <Form form={form} layout="vertical" onFinish={(v) => createToken.mutate(v)}>
            <Form.Item name="label" label="Label (optional)">
              <Input placeholder="e.g. sg-prod-box" />
            </Form.Item>
            <Form.Item name="ttlHours" label="Expires in (hours, optional)">
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={createToken.isPending}>
              Generate enrollment token
            </Button>
          </Form>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Paragraph type="warning">
              Copy this now — the token is shown only once.
            </Typography.Paragraph>
            <Typography.Paragraph copyable code>
              {token}
            </Typography.Paragraph>
            <Typography.Text strong>
              On the target machine (Claude Code installed &amp; logged in via{' '}
              <code>/login</code>, or <code>ANTHROPIC_API_KEY</code> set):
            </Typography.Text>
            <Typography.Paragraph copyable code style={{ whiteSpace: 'pre-wrap' }}>
              {`orbit register --server ${location.origin} --token ${token} --name my-runner --labels sg\norbit run`}
            </Typography.Paragraph>
            <Typography.Text type="secondary">
              Replace the server URL with your control-plane URL if it differs from this site.
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </Space>
  );
}
