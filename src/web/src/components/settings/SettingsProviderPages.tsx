import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined, RightOutlined } from '@ant-design/icons';
import { api } from '../../api';
import { isLoginPool } from '../../lib/codexLogin';
import { routeId } from '../../lib/idCodec';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../../lib/providerAdmin';
import { poolEligibleCount, poolRefusals, providerPoolsQuery } from '../../lib/providerPools';
import { providersQuery } from '../../lib/queries';
import { accountPoolList, poolAccessQuery, sharedPoolsQuery } from '../../lib/sharedPools';
import { useToast } from '../../lib/toast';
import { AccountPools, NewPoolModal, PoolHint } from '../AccountPools';
import { KeyImpact } from '../KeyImpact';
import { ProviderTile, vendorName, vendorOf } from '../ProviderGallery';
import { ProviderKeyRows } from '../ProviderKeyCards';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Spinner } from '../ui/Spinner';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsBlocks';

/*
 * Settings' Providers group (owner's choice C1, docs/mocks/settings-redesign board-4, its nav made two
 * fixed rows by choice A, docs/mocks/settings-providers-compact): one page of API keys, grouped by
 * vendor, and Account pools on a page of its own — what Infrastructure's API keys and Account pools
 * sections held.
 */

const useKeys = () => useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });

function Loading() {
  return (
    <div style={{ padding: 24, textAlign: 'center' }}>
      <Spinner />
    </div>
  );
}

/** /settings/providers: every key (SettingsKeysPage), or with no key at all, connecting one. */
export function SettingsProvidersHome() {
  const keys = useKeys();
  if (keys.isPending) return <Loading />;
  return keys.data?.length ? <SettingsKeysPage /> : <Navigate to="/settings/providers/new" replace />;
}

/**
 * /settings/providers and /settings/providers/:vendor — every API key on the account on one page
 * (owner's choice A, docs/mocks/settings-providers-compact board-1), a section per vendor with its own
 * Add, so the nav holds one row for keys however many vendors are connected. A vendor in the address
 * shows that vendor's keys alone, its chip chosen; with keys of two vendors or more the chips switch
 * between them. Then the account pools using the keys shown.
 */
export function SettingsKeysPage() {
  const vendor = useParams().vendor;
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, confirmHolder] = useConfirm();
  const keys = useKeys();
  const pools = useQuery(providerPoolsQuery());
  const nowMs = Date.now();

  // The vendors in the order of each one's first key, as the nav once listed them.
  const all = keys.data ?? [];
  const vendors = new Map<string, ProviderRow[]>();
  for (const row of all) {
    const slug = vendorOf(row.presetSlug);
    vendors.set(slug, [...(vendors.get(slug) ?? []), row]);
  }
  const shown: [string, ProviderRow[]][] = vendor ? [[vendor, vendors.get(vendor) ?? []]] : [...vendors];
  const rows = shown.flatMap(([, list]) => list);
  const poolsWith = (row: ProviderRow) =>
    (pools.data ?? []).filter((pool) => pool.members.some((member) => routeId(member.id) === routeId(row.id)));
  const using = (pools.data ?? []).filter((pool) => rows.some((row) => poolsWith(row).includes(pool)));

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
      onConfirm: async () => {
        await deleteMut.mutateAsync(p.id);
        // The chosen vendor's last key gone, its chip goes too: back to every key.
        if (vendor && rows.length === 1) navigate('/settings/providers', { replace: true });
      },
    });

  if (keys.isPending) return <Loading />;

  return (
    <>
      <div className="sp-vendor-head">
        <h1 className="sp-vendor-title">API keys</h1>
        {/* The page's one solid button, as tall as the title beside it (settings-buttons board 03, A). */}
        <Button variant="primary" icon={<PlusOutlined />} onClick={() => navigate('/settings/providers/new')}>
          Add key
        </Button>
      </div>
      <p className="sp-vendor-sub">Keys on your account, usable from every machine and billed per token.</p>

      {vendors.size >= 2 && (
        <nav className="sp-chips" aria-label="Vendors">
          <Link className={vendor ? 'sp-chip' : 'sp-chip on'} to="/settings/providers" replace>
            All <span className="sp-chip-count">{all.length}</span>
          </Link>
          {[...vendors].map(([slug, list]) => (
            <Link
              key={slug}
              className={slug === vendor ? 'sp-chip on' : 'sp-chip'}
              to={`/settings/providers/${slug}`}
              replace
            >
              {vendorName(slug)} <span className="sp-chip-count">{list.length}</span>
            </Link>
          ))}
        </nav>
      )}

      {shown.map(([slug, list]) => {
        const name = vendorName(slug);
        return (
          <SettingsSection
            key={slug}
            className="sp-vendor-section"
            title={
              <span className="sp-vendor-name">
                <ProviderTile slug={slug} label={name} size={20} />
                {name} <span className="sp-count">{list.length === 1 ? '1 key' : `${list.length} keys`}</span>
              </span>
            }
            action={
              // Quiet beside the page's own Add key, the one bordered add on the page (settings-buttons board 01).
              <Button
                size="small"
                variant="text"
                icon={<PlusOutlined />}
                aria-label={`Add ${name} key`}
                onClick={() => navigate(`/settings/providers/new/${slug}`)}
              >
                Add
              </Button>
            }
          >
            {list.length === 0 ? (
              <SettingsCard>
                <SettingsRow title={`No ${name} keys`} description="Add one, and it's usable from every machine." />
              </SettingsCard>
            ) : (
              <ProviderKeyRows
                rows={list}
                nowMs={nowMs}
                poolsOf={(row) => poolsWith(row).map((pool) => pool.label)}
                onDelete={deleteKey}
              />
            )}
          </SettingsSection>
        );
      })}

      {using.length > 0 && (
        <SettingsSection title="Account pools using these keys">
          <SettingsCard>
            {using.map((pool) => (
              <SettingsRow
                key={pool.id}
                title={pool.label}
                description={`${pool.members.length} ${pool.members.length === 1 ? 'account' : 'accounts'} · dispatches to whichever has quota left`}
                control={
                  <Link className="sp-pools-link" to="/settings/providers/pools">
                    Account pools <RightOutlined />
                  </Link>
                }
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      {confirmHolder}
    </>
  );
}

/**
 * /settings/providers/pools — Infrastructure's Account pools section, unchanged, on its own page: the
 * user's account pools and the shared pools they are in, who can use each, New pool, and the
 * offer to make one while there is something to pool and no pool yet (PoolHint).
 */
export function SettingsPoolsPage() {
  const keys = useKeys();
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
  const eligible = poolEligibleCount(keys.data ?? []);
  const refusals = poolRefusals(keys.data ?? []);
  const [creatingPool, setCreatingPool] = useState(false);

  return (
    <>
      {pools.isSuccess && pools.data.length === 0 && eligible >= 2 && (
        <PoolHint rows={keys.data ?? []} eligible={eligible} />
      )}
      {/* A pool that exists is always shown, whatever its keys have since become: hiding it would
          leave sessions dispatching to something the page no longer lets you see or delete. The
          section stands with none too, saying what one is. */}
      {pools.isPending || shared.isPending ? <Loading /> : (
        <AccountPools
          pools={poolList}
          refusals={refusals}
          action={
            // The page's one solid button (settings-buttons board 03, A); the page's title says what kind of pool.
            <Button variant="primary" icon={<PlusOutlined />} onClick={() => setCreatingPool(true)}>
              New pool
            </Button>
          }
        />
      )}
      {creatingPool && <NewPoolModal rows={keys.data ?? []} onClose={() => setCreatingPool(false)} />}
    </>
  );
}
