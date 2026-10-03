import { useNavigate } from 'react-router-dom';
import { useRef } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { Button, Popconfirm, Space, Table, Tag, type TableColumnsType } from 'antd';
import { api } from '../api';
import { isLoginPool } from '../lib/codexLogin';
import { routeId } from '../lib/idCodec';
import { providersQuery, runnersQuery } from '../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { poolEligibleCount, poolRefusals, providerPoolsQuery } from '../lib/providerPools';
import { ownPoolWithAccess, poolAccessQuery, sharedPoolAsProviderPool, sharedPoolsQuery } from '../lib/sharedPools';
import { AccountPools, PoolHint } from '../components/AccountPools';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { RunnerEngines } from '../components/RunnerEngines';
import { useIsMobile } from '../lib/useMediaQuery';
import { useToast } from '../lib/toast';
import type { Runner } from '../components/TasksSidePanel';

/**
 * Where a workspace's model comes from — two kinds of identity, in the order a new user has them.
 *
 * First the engines signed in on their own machines (RunnerEngines): those spend the subscription
 * signed into that runner and need nothing pasted, which is what most sessions actually run on.
 * Then their personal (BYOK) providers — an API key on the account, usable from every runner and
 * billed per token. Adding or editing one of those happens on its own page (ProviderConnectPage),
 * so a vendor's setup stays deep-linkable.
 *
 * Between the two, the account pools (AccountPools): several of those keys' Claude subscriptions
 * dispatched under one name, and the shared pools the user is in — several people's OpenAI keys under
 * one name. Its head makes a new one of either kind. Before there is an account pool, the keys list
 * also opens with the offer to make one — but only when at least two keys could join, since a pool of
 * one is the key.
 */
export function ProvidersPage() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const runnerSection = useRef<HTMLDivElement>(null);
  const runners = useQuery(runnersQuery());
  const geminiReady = ((runners.data ?? []) as Runner[]).filter(
    (runner) => runner.online && runner.antigravity?.supported && runner.antigravity.installed === true,
  ).length;
  const providers = useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });
  // Which account is busy moves with sessions, not with provider edits, so nothing pushes it: read
  // again while the page is open.
  const pools = useQuery({ ...providerPoolsQuery(), refetchInterval: 60_000 });
  const shared = useQuery({ ...sharedPoolsQuery(), refetchInterval: 60_000 });
  // Who can use each Codex pool of the user's own, and its API keys: read pool by pool, beside its accounts.
  const access = useQueries({
    queries: (pools.data ?? [])
      .filter(isLoginPool)
      .map((pool) => ({ ...poolAccessQuery(pool.id), refetchInterval: 60_000 })),
  });
  const accessOf = new Map(access.flatMap((read) => (read.data ? [[routeId(read.data.id), read.data] as const] : [])));
  const poolList = [
    ...(shared.data ?? []).map(sharedPoolAsProviderPool),
    ...(pools.data ?? []).map((pool) => {
      const view = accessOf.get(routeId(pool.id));
      return view ? ownPoolWithAccess(pool, view) : pool;
    }),
  ];
  const eligible = poolEligibleCount(providers.data ?? []);
  const refusals = poolRefusals(providers.data ?? []);

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`${PROVIDERS_BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      // Both this list and the de-sensitized ['providers'] catalog the pickers read
      // must refresh on any change.
      void qc.invalidateQueries({ queryKey: PROVIDERS_LIST_KEY });
      void qc.invalidateQueries({ queryKey: providersQuery().queryKey });
      message.success('Provider deleted');
    },
    onError: (e: Error) => message.error("Couldn't delete the provider", e.message),
  });

  const columns: TableColumnsType<ProviderRow> = [
    {
      title: 'Provider',
      key: 'provider',
      // The dispatch slug is the server's to generate and nobody's to read, so the row shows the
      // vendor: its logo (by preset, not by the row's identifier) and the name it was given.
      render: (_, p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <ProviderTile slug={p.presetSlug ?? p.slug} label={p.label} size={32} />
          <div style={{ minWidth: 0 }}>
            <div className="prov-cell-name">{p.label}</div>
            {p.runtime === 'antigravity' && (
              <div className="prov-runtime">
                <div>Runs on the Antigravity CLI</div>
                <div>
                  <span style={geminiReady === 0 ? { color: 'var(--warning)' } : undefined}>
                    {geminiReady === 0 ? 'Not ready on any runner' : `Ready on ${geminiReady} runner${geminiReady === 1 ? '' : 's'}`}
                  </span>{' '}
                  <a className="re-link" href="#provider-runners" onClick={(event) => {
                    event.preventDefault();
                    runnerSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}>
                    See runners ↑
                  </a>
                </div>
              </div>
            )}
          </div>
          {/* The Enabled column collapses to a dot on narrow screens — the tag's words would
              outrun a phone's width on their own. */}
          {isMobile && (
            <span
              className={`prov-dot${p.enabled ? ' on' : ''}`}
              title={p.enabled ? 'Enabled' : 'Disabled'}
            />
          )}
        </div>
      ),
    },
    {
      title: 'Models',
      key: 'models',
      width: 70,
      // A model count is the weakest signal here — what the row is, whether it's on, and its
      // controls all outrank it — so it waits for a window wide enough for the whole table.
      responsive: ['md'],
      render: (_, p) => (p.models?.length ? `${p.models.length}` : '—'),
    },
    {
      title: 'Endpoint',
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      width: 200,
      // The widest column and the least needed on a phone: the endpoint is one tap away on the
      // edit page, and its long URL is exactly what pushes the table past the viewport.
      responsive: ['md'],
      render: (u: string) => <code className="prov-endpoint">{u}</code>,
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      responsive: ['md'],
      render: (on: boolean) => <Tag color={on ? 'green' : 'default'}>{on ? 'Enabled' : 'Disabled'}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      align: 'right',
      width: isMobile ? 88 : 170,
      render: (_, p) => (
        <Space size={isMobile ? 4 : 8}>
          {/* Icon-only on narrow screens: the labelled pair is what pushes the table past a
              phone's viewport once the wide columns are hidden. */}
          {isMobile ? (
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              aria-label={`Edit ${p.label}`}
              onClick={() => navigate(`/providers/${p.id}`)}
            />
          ) : (
            <Button size="small" onClick={() => navigate(`/providers/${p.id}`)}>
              Edit
            </Button>
          )}
          <Popconfirm title={`Delete ${p.label}?`} onConfirm={() => deleteMut.mutate(p.id)}>
            {isMobile ? (
              <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Delete ${p.label}`} />
            ) : (
              <Button size="small" danger>
                Delete
              </Button>
            )}
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
            Where your workspaces&apos; models come from — the CLIs signed in on your machines, and the
            API keys on your account.
          </div>
        </div>
        {/* Still only about keys: an engine gets its identity from the Sign in on its own row. */}
        <Button type="primary" onClick={() => navigate('/providers/new')}>
          Add provider
        </Button>
      </div>

      <div ref={runnerSection} id="provider-runners"><RunnerEngines /></div>

      {/* A pool that exists is always shown, whatever its keys have since become: hiding it would
          leave sessions dispatching to something the page no longer lets you see or delete. The
          section stands with none too: its head is where a pool is made. */}
      {!pools.isPending && !shared.isPending && (
        <AccountPools pools={poolList} refusals={refusals} rows={providers.data ?? []} />
      )}

      <div className="re-sec-head" style={{ marginTop: 28 }}>
        <h3>Your API keys</h3>
        <span className="re-sec-sub">
          On your account and usable from every runner — billed per token.
        </span>
      </div>

      {pools.isSuccess && pools.data.length === 0 && eligible >= 2 && (
        <PoolHint rows={providers.data ?? []} eligible={eligible} />
      )}

      {providers.isLoading ? (
        <Table
          rowKey="id"
          className="provider-keys"
          tableLayout="fixed"
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
            className="provider-keys"
            tableLayout="fixed"
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
