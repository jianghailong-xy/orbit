import { useNavigate } from 'react-router-dom';
import { useRef, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { api } from '../api';
import { isLoginPool } from '../lib/codexLogin';
import { routeId } from '../lib/idCodec';
import { providersQuery, runnersQuery } from '../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { poolEligibleCount, poolRefusals, providerPoolsQuery } from '../lib/providerPools';
import { providerDisplayLabel } from '../lib/sessionProviderChoices';
import { ownPoolWithAccess, poolAccessQuery, sharedPoolAsProviderPool, sharedPoolsQuery } from '../lib/sharedPools';
import { AccountPools, PoolHint } from '../components/AccountPools';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { RunnerEngines } from '../components/RunnerEngines';
import { DshRunnerStatus } from '../components/DshRunnerStatus';
import { DeepSeekBalanceLine } from '../components/DeepSeekBalance';
import { hasDeepSeekBalance } from '../lib/deepseekBalance';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Popconfirm } from '../components/ui/Popconfirm';
import { TableEmptyRow, TableFrame } from '../components/ui/Table';
import { useIsMobile, useMediaQuery } from '../lib/useMediaQuery';
import { useToast } from '../lib/toast';
import type { Runner } from '../components/TasksSidePanel';

/** One column of the keys table: its header, its width in the fixed layout, and what each row shows. */
interface KeyColumn {
  key: string;
  title: string;
  width?: number;
  /** Right-aligned, header included. */
  end?: boolean;
  cell: (row: ProviderRow) => ReactNode;
}

/** From here up the keys table shows its wide columns (the replaced table's `md` breakpoint). */
const WIDE_KEYS_QUERY = '(min-width: 768px)';

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
  const wide = useMediaQuery(WIDE_KEYS_QUERY);
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

  const columns: KeyColumn[] = [
    {
      key: 'provider',
      title: 'Provider',
      // The dispatch slug is the server's to generate and nobody's to read, so the row shows the
      // vendor: its logo (by preset, not by the row's identifier) and the name it was given.
      cell: (p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <ProviderTile slug={p.presetSlug ?? p.slug} label={providerDisplayLabel(p.label, p.presetSlug)} size={32} />
          <div style={{ minWidth: 0 }}>
            <div className="prov-cell-name">{providerDisplayLabel(p.label, p.presetSlug)}</div>
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
            {p.runtime === 'dsh' && <DshRunnerStatus runners={(runners.data ?? []) as Runner[]} />}
            {p.runtime === 'claude' && p.presetSlug === 'deepseek' && (
              <div className="prov-runtime">
                <div>Runs on Claude Code</div>
              </div>
            )}
            {/* A DeepSeek key also carries its whole account's balance (DeepSeekBalance.tsx). */}
            {hasDeepSeekBalance(p) && <DeepSeekBalanceLine row={p} />}
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
    // A model count is the weakest signal here — what the row is, whether it's on, and its
    // controls all outrank it — so it waits for a window wide enough for the whole table. The
    // endpoint is the widest column and the least needed on a phone: it is one tap away on the edit
    // page, and its long URL is exactly what pushes the table past the viewport.
    ...(wide
      ? [
          { key: 'models', title: 'Models', width: 70, cell: (p: ProviderRow) => (p.models?.length ? `${p.models.length}` : '—') },
          { key: 'baseUrl', title: 'Endpoint', width: 200, cell: (p: ProviderRow) => <code className="prov-endpoint">{p.baseUrl}</code> },
          {
            key: 'enabled',
            title: 'Enabled',
            width: 100,
            cell: (p: ProviderRow) => <Badge tone={p.enabled ? 'green' : 'default'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>,
          },
        ]
      : []),
    {
      key: 'actions',
      title: '',
      end: true,
      width: isMobile ? 88 : 170,
      cell: (p) => (
        <span className="prov-actions" style={{ gap: isMobile ? 4 : 8 }}>
          {/* Icon-only on narrow screens: the labelled pair is what pushes the table past a
              phone's viewport once the wide columns are hidden. */}
          {isMobile ? (
            <Button
              size="small"
              variant="text"
              icon={<EditOutlined />}
              aria-label={`Edit ${providerDisplayLabel(p.label, p.presetSlug)}`}
              onClick={() => navigate(`/providers/${p.id}`)}
            />
          ) : (
            <Button size="small" onClick={() => navigate(`/providers/${p.id}`)}>
              Edit
            </Button>
          )}
          <Popconfirm
            title={`Delete ${providerDisplayLabel(p.label, p.presetSlug)}?`}
            onConfirm={() => deleteMut.mutate(p.id)}
            trigger={
              isMobile ? (
                <Button size="small" variant="text" danger icon={<DeleteOutlined />} aria-label={`Delete ${providerDisplayLabel(p.label, p.presetSlug)}`} />
              ) : (
                <Button size="small" danger>
                  Delete
                </Button>
              )
            }
          />
        </span>
      ),
    },
  ];
  const end = { textAlign: 'right' } as const;
  const keysTable = (rows: ProviderRow[], loading = false) => (
    <TableFrame className="provider-keys" loading={loading} style={{ marginTop: 12 }}>
      <table className="orbit-table" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={column.end ? end : undefined}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <TableEmptyRow colSpan={columns.length} />
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                {columns.map((column) => (
                  <td key={column.key} style={column.end ? end : undefined}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </TableFrame>
  );

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="prov-page-head">
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          Providers
        </h1>
        {/* Still only about keys: an engine gets its identity from the Sign in on its own row. */}
        <Button variant="primary" onClick={() => navigate('/providers/new')}>
          Add provider
        </Button>
        <div className="prov-page-sub">
          Where your workspaces&apos; models come from — the CLIs signed in on your machines, and the
          API keys on your account.
        </div>
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
        keysTable([], true)
      ) : (providers.data?.length ?? 0) === 0 ? (
        <div className="provider-empty">
          <h3>No keys yet</h3>
          <p>Pick a provider and paste your API key — or skip it and sign a runner in above.</p>
          <ProviderGallery />
        </div>
      ) : (
        <>
          {keysTable(providers.data ?? [])}
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
