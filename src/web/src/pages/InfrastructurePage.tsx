import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, DownOutlined, EditOutlined } from '@ant-design/icons';
import { api } from '../api';
import { isLoginPool } from '../lib/codexLogin';
import { routeId } from '../lib/idCodec';
import { providersQuery, publishedRunnerVersionQuery, runnersQuery, workspacesQuery } from '../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { poolEligibleCount, poolRefusals, providerPoolsQuery } from '../lib/providerPools';
import { latestRunnerVersion, runnerAttention, type AttentionWorkspace } from '../lib/runnerAttention';
import { providerDisplayLabel } from '../lib/sessionProviderChoices';
import { ownPoolWithAccess, poolAccessQuery, sharedPoolAsProviderPool, sharedPoolsQuery } from '../lib/sharedPools';
import { AccountPools, NewPoolModal, PoolHint } from '../components/AccountPools';
import { EngineOverview, NeedsAttention } from '../components/InfrastructureOverview';
import { ProviderGallery, ProviderTile } from '../components/ProviderGallery';
import { RunnerEngines } from '../components/RunnerEngines';
import { DshRunnerStatus } from '../components/DshRunnerStatus';
import { DeepSeekBalanceLine } from '../components/DeepSeekBalance';
import { hasDeepSeekBalance } from '../lib/deepseekBalance';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Menu, type MenuItem } from '../components/ui/Menu';
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
 * Where the user's agents run, and whose model quota they spend — what the Runners and Providers
 * pages used to split between them, on one page (docs/mocks/infrastructure-page).
 *
 * At the top, what needs a person and what each engine can run on (NeedsAttention, EngineOverview),
 * read from the lists the sections below show.
 *
 * Then the machines (RunnerEngines), each with the engines signed in on it: a subscription there is
 * spent only by sessions on that machine and needs nothing pasted, which is what most sessions
 * actually run on. Each card is also where its machine is renamed, reordered and deleted.
 *
 * Then the API keys on the account — usable from every machine and billed per token. Adding or
 * editing one happens on its own page (ProviderConnectPage), so a vendor's setup stays deep-linkable.
 * Before there is an account pool, the list opens with the offer to make one — but only when at least
 * two keys could join, since a pool of one is the key.
 *
 * Last the account pools (AccountPools): several of those keys' Claude subscriptions dispatched under
 * one name, a Codex pool of the user's ChatGPT accounts, and the shared pools they are in.
 *
 * The head's Add makes any of the three. `/runners` and `/providers` land here (App.tsx), and
 * `#keys` / `#pools` bring that section into view.
 */
export function InfrastructurePage() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const isMobile = useIsMobile();
  const wide = useMediaQuery(WIDE_KEYS_QUERY);
  const machineSection = useRef<HTMLDivElement>(null);
  const keySection = useRef<HTMLDivElement>(null);
  const poolSection = useRef<HTMLDivElement>(null);
  const runners = useQuery(runnersQuery());
  const machines = (runners.data ?? []) as Runner[];
  const online = machines.filter((runner) => runner.online);
  const busySlots = online.reduce((n, runner) => n + (runner.activeSessions ?? 0), 0);
  const allSlots = online.reduce((n, runner) => n + (runner.maxConcurrent ?? 0), 0);
  const geminiReady = online.filter(
    (runner) => runner.antigravity?.supported && runner.antigravity.installed === true,
  ).length;
  // What each machine's card says it needs a person for: read from the machine's workspaces, and the
  // newest release anyone can see.
  const workspaces = (useQuery(workspacesQuery()).data ?? []) as Array<
    AttentionWorkspace & { runnerId?: string | null }
  >;
  const latestVersion = latestRunnerVersion(useQuery(publishedRunnerVersionQuery()).data, machines);
  const nowMs = Date.now();
  const attentionOf = (runner: Runner) =>
    runnerAttention({
      runner,
      workspaces: workspaces.filter((workspace) => workspace.runnerId === runner.id),
      nowMs,
      latestVersion,
    });
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
  const [creatingPool, setCreatingPool] = useState(false);
  // What needs attention and what each engine can run on are read from every list on the page, so
  // they wait for all of them: an engine called Not set up before its keys arrived would be wrong.
  const settled = !runners.isPending && !providers.isPending && !pools.isPending && !shared.isPending;

  // A section named in the address comes into view once everything above it has its height — the
  // top of the page included, which is read from the pools too.
  const target = hash === '#keys' ? keySection : hash === '#pools' ? poolSection : null;
  const arrived = target !== null && settled;
  useEffect(() => {
    if (arrived) target?.current?.scrollIntoView({ block: 'start' });
  }, [arrived, target]);

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

  const addItems: MenuItem[] = [
    {
      key: 'machine',
      textValue: 'Register a machine',
      label: (
        <span className="infra-add">
          <b>Register a machine</b>
          <span>Run agents on a computer you own, on its subscriptions</span>
        </span>
      ),
      onSelect: () => navigate('/runners/register'),
    },
    {
      key: 'key',
      textValue: 'Connect an API key',
      label: (
        <span className="infra-add">
          <b>Connect an API key</b>
          <span>Usable from every machine, billed per token</span>
        </span>
      ),
      onSelect: () => navigate('/providers/new'),
    },
    {
      key: 'pool',
      textValue: 'New account pool',
      label: (
        <span className="infra-add">
          <b>New account pool</b>
          <span>Several accounts behind one name</span>
        </span>
      ),
      onSelect: () => setCreatingPool(true),
    },
  ];

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
                    {geminiReady === 0 ? 'Not ready on any machine' : `Ready on ${geminiReady} machine${geminiReady === 1 ? '' : 's'}`}
                  </span>{' '}
                  <a className="re-link" href="#machines" onClick={(event) => {
                    event.preventDefault();
                    machineSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}>
                    See machines ↑
                  </a>
                </div>
              </div>
            )}
            {p.runtime === 'dsh' && <DshRunnerStatus runners={machines} />}
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
          { key: 'models', title: 'Models', width: 96, cell: (p: ProviderRow) => (p.models?.length ? `${p.models.length}` : '—') },
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
          Infrastructure
        </h1>
        <Menu
          align="end"
          items={addItems}
          trigger={
            <Button variant="primary">
              Add <DownOutlined />
            </Button>
          }
        />
        <div className="prov-page-sub">
          Where your agents run, and whose model quota they spend.
        </div>
      </div>

      {settled && (
        <>
          <NeedsAttention runners={machines} pools={poolList} />
          <EngineOverview runners={machines} keys={providers.data ?? []} pools={poolList} />
        </>
      )}

      <div ref={machineSection} id="machines">
        <RunnerEngines
          attentionOf={attentionOf}
          head={
            <div className="re-sec-head">
              <h3>Machines</h3>
              <span className="re-sec-sub">
                Subscriptions signed in here are spent only by sessions on that machine.
              </span>
              {machines.length > 0 && (
                <span className="re-sec-count">
                  {machines.length} machine{machines.length === 1 ? '' : 's'} · {busySlots} / {allSlots} slots busy
                </span>
              )}
            </div>
          }
        />
      </div>

      <div ref={keySection} id="keys">
        <div className="re-sec-head" style={{ marginTop: 28 }}>
          <h3>API keys</h3>
          <span className="re-sec-sub">
            On your account and usable from every machine — billed per token.
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
            <p>Pick a provider and paste your API key — or skip it and sign a machine in above.</p>
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

      {/* A pool that exists is always shown, whatever its keys have since become: hiding it would
          leave sessions dispatching to something the page no longer lets you see or delete. The
          section stands with none too: its head is where a pool is made. */}
      <div ref={poolSection} id="pools">
        {!pools.isPending && !shared.isPending && (
          <AccountPools pools={poolList} refusals={refusals} rows={providers.data ?? []} />
        )}
      </div>

      {creatingPool && <NewPoolModal rows={providers.data ?? []} onClose={() => setCreatingPool(false)} />}
    </div>
  );
}
