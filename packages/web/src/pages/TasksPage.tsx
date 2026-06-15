import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Collapse,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { StatusTag } from '../components/StatusTag';

const SOURCES = [
  { key: 'AGENT', label: 'Agents' },
  { key: 'MANUAL', label: 'Manual Task' },
  { key: 'EXTERNAL', label: 'External' },
];

export function TasksPage() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<any[]>('/tasks') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
  const runners = useQuery({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks'] });

  const create = useMutation({
    mutationFn: (body: unknown) => api('/tasks', { method: 'POST', body }),
    onSuccess: () => {
      setOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api(`/tasks/${id}/${action}`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  });

  const columns = [
    {
      title: 'Task Title',
      dataIndex: 'title',
      render: (t: string, r: any) => <Link to={`/tasks/${r.id}`}>{t}</Link>,
    },
    { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
    { title: 'Agent', dataIndex: ['agent', 'name'], render: (n: string) => n ?? '—' },
    { title: 'Runner', dataIndex: ['assignedRunner', 'name'], render: (n: string) => n ?? '—' },
    {
      title: 'Cost',
      key: 'cost',
      render: (_: unknown, r: any) =>
        r.runs?.[0]?.costUsd ? `$${r.runs[0].costUsd.toFixed(4)}` : '—',
    },
    {
      title: 'Created at',
      dataIndex: 'createdAt',
      render: (d: string) => new Date(d).toLocaleString(),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, r: any) => (
        <Space>
          {['DRAFT', 'FAILED', 'CANCELLED'].includes(r.status) && (
            <Button size="small" onClick={() => act.mutate({ id: r.id, action: 'enqueue' })}>
              Run
            </Button>
          )}
          {['QUEUED', 'RUNNING'].includes(r.status) && (
            <Button size="small" danger onClick={() => act.mutate({ id: r.id, action: 'cancel' })}>
              Cancel
            </Button>
          )}
          <Button size="small" type="text" danger onClick={() => remove.mutate(r.id)}>
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  const grouped = (tasks.data ?? []).reduce<Record<string, any[]>>((acc, t) => {
    (acc[t.source] ??= []).push(t);
    return acc;
  }, {});

  return (
    <>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Tasks
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          New Task
        </Button>
      </Space>

      <Collapse
        defaultActiveKey={SOURCES.map((s) => s.key)}
        items={SOURCES.map((s) => ({
          key: s.key,
          label: `${s.label}  ·  ${grouped[s.key]?.length ?? 0}`,
          children: (
            <Table
              rowKey="id"
              size="small"
              loading={tasks.isLoading}
              dataSource={grouped[s.key] ?? []}
              columns={columns as any}
              pagination={false}
            />
          ),
        }))}
      />

      <Modal
        title="New Task"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="Create"
      >
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input placeholder="e.g. 运行命令 tea-cli-sg hdfs clean enable" />
          </Form.Item>
          <Form.Item name="prompt" label="Prompt (instruction for Claude Code)">
            <Input.TextArea rows={3} placeholder="Defaults to the title if left blank" />
          </Form.Item>
          <Form.Item name="agentId" label="Agent">
            <Select
              allowClear
              placeholder="Pick an agent (defines model + tools)"
              options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            />
          </Form.Item>
          <Form.Item name="assignedRunnerId" label="Pin to runner (optional)">
            <Select
              allowClear
              placeholder="Any matching runner"
              options={(runners.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item name="enqueue" label="Queue immediately" valuePropName="checked" initialValue>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
