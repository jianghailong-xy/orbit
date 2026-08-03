import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm, Space, Table, Tag, type TableColumnsType } from 'antd';
import { api } from '../api';
import { providersQuery } from '../lib/queries';
import {
  PROVIDERS_BASE,
  PROVIDERS_LIST_KEY,
  SUBSCRIPTIONS_BASE,
  subscriptionAccountsQuery,
  type ProviderRow,
} from '../lib/providerAdmin';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { useToast } from '../lib/toast';

/**
 * A Claude subscription account arrives in this list as an ordinary provider row — it *is* one,
 * underneath — and only its auth mode tells it apart. It has no endpoint of its own and adds no
 * model of its own, but it is one of this user's Claude credentials, so it belongs in the one list
 * that answers "what have I set up, and how do I drop it?". Adding one lives behind the Anthropic
 * tile with the API-key form, its only entry point.
 */
const isSubscriptionRow = (p: ProviderRow) => p.authMode === 'subscription';

/**
 * Model providers: every user's personal (BYOK) list — their own API key, visible only to them
 * (/providers/mine). Adding or editing one happens on its own page (ProviderConnectPage), so a
 * vendor's setup is deep-linkable.
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

  const dropAccount = useMutation({
    mutationFn: (id: string) => api(`${SUBSCRIPTIONS_BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      // An account is a provider row, so the pickers' catalog has to refresh with this list.
      void qc.invalidateQueries({ queryKey: subscriptionAccountsQuery().queryKey });
      void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success('Account removed');
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
          {/* Which account a new agent lands on isn't visible anywhere else in this list. */}
          {isSubscriptionRow(p) && p.isDefault && <Tag className="row-default-tag">Default</Tag>}
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
      // The subscription has no endpoint to show — what matters about it is who pays, so it says
      // that instead, in prose rather than the monospace an endpoint gets.
      render: (u: string, p) =>
        isSubscriptionRow(p) ? (
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Your Claude plan · no API billing</span>
        ) : (
          <code style={{ fontSize: 12, color: 'var(--text-3)' }}>{u}</code>
        ),
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
      render: (_, p) => {
        const isSub = isSubscriptionRow(p);
        return (
          <Space>
            <Button size="small" onClick={() => navigate(isSub ? '/providers/subscription' : `/providers/${p.id}`)}>
              Edit
            </Button>
            <Popconfirm
              title={isSub ? `Remove ${p.label}?` : `Delete ${p.label}?`}
              description={isSub ? 'Agents on this account fall back to the default one.' : undefined}
              onConfirm={() => (isSub ? dropAccount.mutate(p.id) : deleteMut.mutate(p.id))}
            >
              <Button size="small" danger>
                {isSub ? 'Remove' : 'Delete'}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  // Subscription accounts lead the list: they're the credentials here that aren't scoped to a
  // single endpoint — each covers this user's claude sessions on every runner.
  const all = providers.data ?? [];
  const rows = [...all.filter(isSubscriptionRow), ...all.filter((p) => !isSubscriptionRow(p))];
  const loading = providers.isLoading;

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

      {loading ? (
        <Table
          rowKey="id"
          style={{ marginTop: 12 }}
          loading
          dataSource={[]}
          columns={columns}
          pagination={false}
        />
      ) : rows.length === 0 ? (
        <div className="provider-empty">
          <h3>Connect your first provider</h3>
          <p>Pick a provider and paste your API key — that's it.</p>
          <ProviderGallery />
        </div>
      ) : (
        <>
          <Table
            rowKey="id"
            style={{ marginTop: 12 }}
            dataSource={rows}
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
