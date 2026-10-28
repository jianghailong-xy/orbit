import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownOutlined } from '@ant-design/icons';
import { api } from '../api';
import { isLoginPool } from '../lib/codexLogin';
import { routeId } from '../lib/idCodec';
import { providersQuery, publishedRunnerVersionQuery, runnersQuery, workspacesQuery } from '../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { poolEligibleCount, poolRefusals, providerPoolsQuery } from '../lib/providerPools';
import { latestRunnerVersion, runnerAttention, type AttentionWorkspace } from '../lib/runnerAttention';
import { accountPoolList, poolAccessQuery, sharedPoolsQuery } from '../lib/sharedPools';
import { AccountPools, NewPoolModal, PoolHint } from '../components/AccountPools';
import { KeyImpact } from '../components/KeyImpact';
import { ProviderGallery, ProviderPills } from '../components/ProviderGallery';
import { ProviderKeyCards } from '../components/ProviderKeyCards';
import { RunnerEngines } from '../components/RunnerEngines';
import { Button } from '../components/ui/Button';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { useToast } from '../lib/toast';
import type { Runner } from '../components/TasksSidePanel';

/**
 * Where the user's agents run, and whose model quota they spend — what the Runners and Providers
 * pages used to split between them, on one page (docs/mocks/infrastructure-page), centred on what the
 * user brought themselves: their machines, then their keys (docs/mocks/infrastructure-focus).
 *
 * First the machines (RunnerEngines), each with the engines signed in on it: a subscription there is
 * spent only by sessions on that machine and needs nothing pasted, which is what most sessions
 * actually run on. Each card's head says what its sessions can run on, an engine signed out there with
 * the way to sign it in again, and the card is also where its machine is renamed, reordered and deleted.
 *
 * Then the API keys on the account — usable from every machine and billed per token — a card per
 * vendor, each key saying which engines it runs on (ProviderKeyCards), with the vendors not connected
 * yet in a line under them. Adding or editing one happens on its own page (ProviderConnectPage), so a
 * vendor's setup stays deep-linkable. Deleting one first says what uses it on each of those engines
 * (KeyImpact). Before there is an account pool, the list opens with the offer to make one — but only
 * when at least two keys could join, since a pool of one is the key.
 *
 * Last, the account pools (AccountPools): several of those keys' Claude subscriptions dispatched under
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
  const [confirm, confirmHolder] = useConfirm();
  const keySection = useRef<HTMLDivElement>(null);
  const poolSection = useRef<HTMLDivElement>(null);
  const runners = useQuery(runnersQuery());
  const machines = (runners.data ?? []) as Runner[];
  const online = machines.filter((runner) => runner.online);
  const busySlots = online.reduce((n, runner) => n + (runner.activeSessions ?? 0), 0);
  const allSlots = online.reduce((n, runner) => n + (runner.maxConcurrent ?? 0), 0);
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
  const keyCount = providers.data?.length ?? 0;
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
  const poolList = accountPoolList(pools.data ?? [], shared.data ?? [], accessOf);
  const eligible = poolEligibleCount(providers.data ?? []);
  const refusals = poolRefusals(providers.data ?? []);
  const [creatingPool, setCreatingPool] = useState(false);

  // A section named in the address comes into view once everything above it has its height.
  const settled = !runners.isPending && !providers.isPending && !pools.isPending && !shared.isPending;
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
    // A delete that fails says so in the dialog that asked for it (deleteKey).
  });
  const deleteKey = (p: ProviderRow) =>
    void confirm({
      title: `Delete ${p.label}?`,
      description: <KeyImpact row={p} action="delete" />,
      confirmText: 'Delete key',
      danger: true,
      width: 440,
      onConfirm: () => deleteMut.mutateAsync(p.id),
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

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* The page is Settings' (docs/mocks/machines-and-models, 02): no sidebar row is lit on it, so the
          way back is named here, as the pages under this one name it. */}
      <Link className="provider-back" to="/settings" style={{ marginBottom: 8 }}>
        ‹ Settings
      </Link>
      <div className="prov-page-head">
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          Machines &amp; models
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

      <div id="machines">
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
          {keyCount > 0 && (
            <span className="re-sec-count">
              {keyCount} key{keyCount === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {pools.isSuccess && pools.data.length === 0 && eligible >= 2 && (
          <PoolHint rows={providers.data ?? []} eligible={eligible} />
        )}

        {providers.isLoading ? (
          <ProviderKeyCards rows={[]} nowMs={nowMs} onDelete={deleteKey} loading />
        ) : keyCount === 0 ? (
          <div className="provider-empty">
            <h3>No keys yet</h3>
            <p>Pick a provider and paste your API key — or skip it and sign a machine in above.</p>
            <ProviderGallery />
          </div>
        ) : (
          <>
            <ProviderKeyCards rows={providers.data ?? []} nowMs={nowMs} onDelete={deleteKey} />
            {/* Another vendor is connected from the line under the keys; one already connected adds a key
                from its own card. */}
            <ProviderPills />
          </>
        )}
      </div>

      {/* A pool that exists is always shown, whatever its keys have since become: hiding it would
          leave sessions dispatching to something the page no longer lets you see or delete. The
          section stands with none too, saying what one is; the head's Add makes one. */}
      <div ref={poolSection} id="pools">
        {!pools.isPending && !shared.isPending && <AccountPools pools={poolList} refusals={refusals} />}
      </div>

      {creatingPool && <NewPoolModal rows={providers.data ?? []} onClose={() => setCreatingPool(false)} />}
      {confirmHolder}
    </div>
  );
}
