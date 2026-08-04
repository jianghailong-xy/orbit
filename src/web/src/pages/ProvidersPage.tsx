import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm, Space, Table, Tag, type TableColumnsType } from 'antd';
import { api } from '../api';
import { providersQuery } from '../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { RunnerEngines } from '../components/RunnerEngines';
import { useToast } from '../lib/toast';

/**
 * Where an agent's model comes from — two kinds of identity, in the order a new user has them.
 *
 * First the engines signed in on their own machines (RunnerEngines): those spend the subscription
 * signed into that runner and need nothing pasted, which is what most sessions actually run on.
 * Then their personal (BYOK) providers — an API key on the account, usable from every runner and
 * billed per token. Adding or editing one of those happens on its own page (ProviderConnectPage),
 * so a vendor's setup stays deep-linkable.
 */
export function ProvidersPage() {
  const message = useToast();
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
            Where your agents&apos; models come from — the CLIs signed in on your machines, and the
            API keys on your account.
          </div>
        </div>
        {/* Still only about keys: an engine gets its identity from the Sign in on its own row. */}
        <Button type="primary" onClick={() => navigate('/providers/new')}>
          Add provider
        </Button>
      </div>

      <RunnerEngines />

      <div className="re-sec-head" style={{ marginTop: 28 }}>
        <h3>Your API keys</h3>
        <span className="re-sec-sub">
          On your account and usable from every runner — billed per token.
        </span>
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
          <h3>No keys yet</h3>
          <p>Pick a provider and paste your API key — or skip it and sign a runner in above.</p>
          <ProviderGallery />
        </div>
      ) : (
        <>
          <Table
            rowKey="id"
            style={{ marginTop: 12 }}
            dataSource={providers.data ?? []}
            columns={columns}
            pagination={false}
          />
          {/* The gallery stays on the page once the list isn't empty: it's how another vendor gets
              connected, and it's where "which of these do I already have?" gets answered. */}
          <div className="provider-more">
            <h3>Connect another provider</h3>
            <ProviderGallery />
          </div>
        </>
      )}
    </div>
  );
}
