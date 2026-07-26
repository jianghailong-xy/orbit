import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Popconfirm, Space, Table, Tag, type TableColumnsType } from 'antd';
import { api } from '../api';
import { providersQuery } from '../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';

/**
 * Model providers: every user's personal (BYOK) list — their own API key, visible only to them
 * (/providers/mine). Adding or editing one happens on its own page (ProviderConnectPage), so a
 * vendor's setup is deep-linkable.
 */
export function ProvidersPage() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const providers = useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`${PROVIDERS_BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      // Both this list and the de-sensitized ['providers'] catalog the pickers read
      // must refresh on any change.
      void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success('Provider deleted');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const columns: TableColumnsType<ProviderRow> = [
    {
      title: 'Provider',
      key: 'provider',
      // The dispatch slug is the server's to generate and nobody's to read, so the row shows the
      // vendor: its logo (by preset, not by the row's identifier) and the name it was given.
      render: (_, p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProviderTile slug={p.presetSlug ?? p.slug} label={p.label} size={32} />
          <div style={{ fontWeight: 600 }}>{p.label}</div>
        </div>
      ),
    },
    {
      title: 'Models',
      key: 'models',
      render: (_, p) => (p.models?.length ? `${p.models.length}` : '—'),
    },
    {
      title: 'Endpoint',
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      render: (u: string) => <code style={{ fontSize: 12, color: 'var(--text-3)' }}>{u}</code>,
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (on: boolean) => <Tag color={on ? 'green' : 'default'}>{on ? 'Enabled' : 'Disabled'}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      align: 'right',
      render: (_, p) => (
        <Space>
          <Button size="small" onClick={() => navigate(`/providers/${p.id}`)}>
            Edit
          </Button>
          <Popconfirm title={`Delete ${p.label}?`} onConfirm={() => deleteMut.mutate(p.id)}>
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
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            Providers
          </h1>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Providers use your own API key and are visible only to you.
          </div>
        </div>
        <Button type="primary" onClick={() => navigate('/providers/new')}>
          Add provider
        </Button>
      </div>

      {providers.isLoading ? (
        <Table
          rowKey="id"
          style={{ marginTop: 12 }}
          loading
          dataSource={[]}
          columns={columns}
          pagination={false}
        />
      ) : (providers.data?.length ?? 0) === 0 ? (
        <div className="provider-empty">
          <h3>Connect your first provider</h3>
          <p>Pick a provider and paste your API key — that's it.</p>
          <ProviderGallery />
        </div>
      ) : (
        <Table
          rowKey="id"
          style={{ marginTop: 12 }}
          dataSource={providers.data ?? []}
          columns={columns}
          pagination={false}
        />
      )}
    </div>
  );
}
