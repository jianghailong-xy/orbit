import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntdApp,
  Button,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  type TableColumnsType,
} from 'antd';
import { api } from '../api';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'MEMBER' | 'ADMIN';
  createdAt: string;
}
interface CreateResult {
  email: string;
  reset: boolean;
  generatedPassword?: string;
}

// Admin-only account management (gated by role on both the nav entry and every
// endpoint). Create/reset return a one-time password shown once in a dialog.
export function AdminUsersPage() {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<AdminUser[]>('/admin/users'),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  const announce = (label: string, pwd?: string) => {
    if (pwd) {
      modal.success({
        title: label,
        content: (
          <div>
            Share this one-time password:
            <br />
            <code style={{ fontSize: 14 }}>{pwd}</code>
          </div>
        ),
      });
    } else {
      message.success(label);
    }
  };

  const createMut = useMutation({
    mutationFn: (body: { email: string; name?: string; force?: boolean }) =>
      api<CreateResult>('/admin/users', { method: 'POST', body }),
    onSuccess: (r) => {
      invalidate();
      setCreateOpen(false);
      setEmail('');
      setName('');
      announce(r.reset ? `Password reset for ${r.email}` : `Created ${r.email}`, r.generatedPassword);
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'MEMBER' | 'ADMIN' }) =>
      api(`/admin/users/${id}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      invalidate();
      message.success('Role updated');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      message.success('User deleted');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const columns: TableColumnsType<AdminUser> = [
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Name', dataIndex: 'name', key: 'name' },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (role: AdminUser['role']) => (
        <Tag color={role === 'ADMIN' ? 'gold' : 'default'}>{role}</Tag>
      ),
    },
    {
      title: '',
      key: 'actions',
      align: 'right',
      render: (_, u) => (
        <Space>
          <Popconfirm
            title={`Reset ${u.email}'s password?`}
            onConfirm={() => createMut.mutate({ email: u.email, force: true })}
          >
            <Button size="small">Reset password</Button>
          </Popconfirm>
          <Button
            size="small"
            loading={roleMut.isPending}
            onClick={() => roleMut.mutate({ id: u.id, role: u.role === 'ADMIN' ? 'MEMBER' : 'ADMIN' })}
          >
            {u.role === 'ADMIN' ? 'Make member' : 'Make admin'}
          </Button>
          <Popconfirm title={`Delete ${u.email}?`} onConfirm={() => deleteMut.mutate(u.id)}>
            <Button size="small" danger>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Users</h1>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          Add user
        </Button>
      </div>

      <Table
        rowKey="id"
        loading={users.isLoading}
        dataSource={users.data ?? []}
        columns={columns}
        pagination={false}
      />

      <Modal
        title="Add user"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() =>
          email.trim() && createMut.mutate({ email: email.trim(), name: name.trim() || undefined })
        }
        confirmLoading={createMut.isPending}
        okText="Create"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            A one-time password is generated and shown once after creating.
          </div>
        </Space>
      </Modal>
    </div>
  );
}
