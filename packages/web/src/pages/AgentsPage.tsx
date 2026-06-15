import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { useState } from 'react';
import { api } from '../api';

const MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5'];
const MODES = ['dontAsk', 'acceptEdits', 'plan', 'default', 'bypassPermissions'];

const csv = (s?: string): string[] =>
  s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];

export function AgentsPage() {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });

  const create = useMutation({
    mutationFn: (body: unknown) => api('/agents', { method: 'POST', body }),
    onSuccess: () => {
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/agents/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });

  const onFinish = (v: any) =>
    create.mutate({
      ...v,
      allowedTools: csv(v.allowedTools),
      disallowedTools: csv(v.disallowedTools),
      targetLabels: csv(v.targetLabels),
    });

  const columns = [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Model', dataIndex: 'model' },
    { title: 'Permission', dataIndex: 'permissionMode' },
    {
      title: 'Allowed tools',
      dataIndex: 'allowedTools',
      render: (t: string[]) => (t ?? []).join(', ') || '—',
    },
    {
      title: '',
      key: 'a',
      render: (_: unknown, r: any) => (
        <Button size="small" danger type="text" onClick={() => remove.mutate(r.id)}>
          Delete
        </Button>
      ),
    },
  ];

  return (
    <>
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Agents
        </Typography.Title>
        <Button type="primary" onClick={() => setOpen(true)}>
          New Agent
        </Button>
      </Space>

      <Table
        rowKey="id"
        loading={agents.isLoading}
        dataSource={agents.data ?? []}
        columns={columns as any}
        pagination={false}
      />

      <Modal
        title="New Agent"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="Create"
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="model" label="Model" initialValue="claude-sonnet-4-6">
            <Select options={MODELS.map((m) => ({ value: m, label: m }))} />
          </Form.Item>
          <Form.Item name="permissionMode" label="Permission mode" initialValue="dontAsk">
            <Select options={MODES.map((m) => ({ value: m, label: m }))} />
          </Form.Item>
          <Form.Item
            name="allowedTools"
            label="Allowed tools (comma-separated)"
            tooltip="Scoped Bash rules recommended, e.g. Read, Bash(tea-cli *), Bash(hdfs *)"
          >
            <Input placeholder="Read, Bash(echo *)" />
          </Form.Item>
          <Form.Item name="disallowedTools" label="Disallowed tools (comma-separated)">
            <Input placeholder="Bash(rm *)" />
          </Form.Item>
          <Form.Item name="appendSystemPrompt" label="Append system prompt">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="maxBudgetUsd" label="Max budget (USD)">
            <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="targetLabels" label="Target runner labels (comma-separated)">
            <Input placeholder="sg" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
