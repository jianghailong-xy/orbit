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
 * Settings' Providers group (owner's choice C1, docs/mocks/settings-redesign board-4): a page per
 * connected vendor with its API keys and the account pools using them, and Account pools on a page of its own — what Infrastructure's API keys and Account pools sections
 * held, split by vendor.
 */

const useKeys = () => useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });

function Loading() {
  return (
    <div style={{ padding: 24, textAlign: 'center' }}>
      <Spinner />
    </div>
  );
}

/** /settings/providers: the first connected vendor's page, or with no key at all, connecting one. */
export function SettingsProvidersHome() {
  const keys = useKeys();
  if (keys.isPending) return <Loading />;
  const first = keys.data?.[0];
  return <Navigate to={first ? `/settings/providers/${vendorOf(first.presetSlug)}` : '/settings/providers/new'} replace />;
}

/**
 * /settings/providers/:vendor — one vendor's API keys: a row each (ProviderKeyRows), Add key in the
 * section's heading; and the account pools any of them is in, each a row into the pools page.
 */
export function SettingsVendorPage() {
  const vendor = useParams().vendor ?? '';
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, confirmHolder] = useConfirm();
  const keys = useKeys();
  const pools = useQuery(providerPoolsQuery());
  const nowMs = Date.now();

  const rows = (keys.data ?? []).filter((row) => vendorOf(row.presetSlug) === vendor);
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
        // The vendor's last key gone, its row leaves the nav, and so does its page.
        if (rows.length === 1) navigate('/settings/providers', { replace: true });
      },
    });

  const name = vendorName(vendor);
  return (
    <>
      <div className="sp-vendor-head">
        <ProviderTile slug={vendor} label={name} size={30} />
        <h1 className="sp-vendor-title">{name}</h1>
      </div>
      <p className="sp-vendor-sub">API keys on your account, usable from every machine and billed per token.</p>

      <SettingsSection
        title={
          <>
            Keys {rows.length > 0 && <span className="sp-count">{rows.length}</span>}
          </>
        }
        action={
          <Button size="small" icon={<PlusOutlined />} onClick={() => navigate(`/settings/providers/new/${vendor}`)}>
            Add key
          </Button>
        }
      >
        {keys.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <SettingsCard>
            <SettingsRow title={`No ${name} keys`} description="Add one, and it's usable from every machine." />
          </SettingsCard>
        ) : (
          <ProviderKeyRows
            rows={rows}
            nowMs={nowMs}
            poolsOf={(row) => poolsWith(row).map((pool) => pool.label)}
            onDelete={deleteKey}
          />
        )}
      </SettingsSection>

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
 * user's account pools and the shared pools they are in, who can use each, New account pool, and the
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
            <Button size="small" icon={<PlusOutlined />} onClick={() => setCreatingPool(true)}>
              New account pool
            </Button>
          }
        />
      )}
      {creatingPool && <NewPoolModal rows={keys.data ?? []} onClose={() => setCreatingPool(false)} />}
    </>
  );
}
