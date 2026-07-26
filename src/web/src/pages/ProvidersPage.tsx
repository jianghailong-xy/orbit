import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Popconfirm, Space, Table, Tag, type TableColumnsType } from 'antd';
import { api } from '../api';
import { meQuery, providersQuery } from '../lib/queries';
import { PROVIDER_SCOPES, scopeSuffix, type ProviderRow, type ProviderScope } from '../lib/providerAdmin';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';

/**
 * Model providers: "My providers" is every user's personal (BYOK) list — their own API key,
 * visible only to them (/providers/mine). Admins additionally manage the shared providers
 * every user sees (/admin/providers). Both sections share one table (ProviderSection); only the
 * scope and copy differ. Adding or editing one happens on its own page (ProviderConnectPage),
 * so a vendor's setup is deep-linkable.
 */
export function ProvidersPage() {
  const me = useQuery(meQuery());
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1 className="page-title">Providers</h1>
      <ProviderSection
        title="My providers"
        hint="Personal providers use your own API key and are visible only to you."
        scope="mine"
      />
      {me.data?.role === 'ADMIN' && (
        <ProviderSection
          title="Shared providers"
          hint="Available to every user on this deployment. Admin only."
          scope="shared"
        />
      )}
    </div>
  );
}

function ProviderSection({ title, hint, scope }: { title: string; hint: string; scope: ProviderScope }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { basePath, listKey } = PROVIDER_SCOPES[scope];
  const providers = useQuery({ queryKey: listKey, queryFn: () => api<ProviderRow[]>(basePath) });
  const suffix = scopeSuffix(scope);

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      // Both this section's list and the de-sensitized ['providers'] catalog the pickers read
      // must refresh on any change.
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success('Provider deleted');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  const columns: TableColumnsType<ProviderRow> = [
    {
      title: 'Provider',
      key: 'provider',
      render: (_, p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProviderTile slug={p.slug} label={p.label} size={32} />
          <div>
            <div style={{ fontWeight: 600 }}>{p.label}</div>
            <code style={{ fontSize: 12, color: 'var(--text-3)' }}>{p.slug}</code>
          </div>
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
          <Button size="small" onClick={() => navigate(`/providers/${p.id}${suffix}`)}>
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
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ marginBottom: 0 }}>{title}</h2>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{hint}</div>
        </div>
        <Button type="primary" onClick={() => navigate(`/providers/new${suffix}`)}>
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
          <ProviderGallery scope={scope} />
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
