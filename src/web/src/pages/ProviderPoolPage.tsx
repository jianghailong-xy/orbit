import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm, Spin } from 'antd';
import { api } from '../api';
import {
  availabilityOf,
  PoolAccountsModal,
  PoolEngineMark,
  PoolGauge,
  PoolMembers,
} from '../components/AccountPools';
import { CodexSignInModal } from '../components/CodexSignIn';
import { AddKeyModal, PoolPeopleCard, PoolRulesCard, ReplaceKeyModal } from '../components/SharedPool';
import { codexLoginPath, isLoginPool, loginName } from '../lib/codexLogin';
import { encodeId, routeId } from '../lib/idCodec';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import {
  poolRefusals,
  providerPoolsQuery,
  type PoolMember,
  type PoolRefusals,
  type ProviderPool,
} from '../lib/providerPools';
import {
  canAddKey,
  SHARED_POOLS_BASE,
  sharedPoolAsProviderPool,
  sharedPoolsQuery,
  type SharedPool,
  type SharedPoolKey,
} from '../lib/sharedPools';
import { useToast } from '../lib/toast';

/**
 * One account pool (/providers/pools/:id), linkable like a provider's own page: its accounts with
 * where each stands, and the ways to change it — add an account, take one out, delete the pool.
 * Taking an account out or deleting the pool leaves the provider itself standing. The same address
 * opens a shared pool the user is in (SharedPoolPage), and a Codex pool of their own ChatGPT account
 * (CodexPoolPage).
 */
export function ProviderPoolPage() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const poolId = routeId(useParams().id);
  const pools = useQuery(providerPoolsQuery());
  const shared = useQuery(sharedPoolsQuery());
  const keys = useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });
  const [adding, setAdding] = useState(false);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['providers'] });
  const removeMember = useMutation({
    mutationFn: (member: PoolMember) =>
      api(`/providers/pools/${encodeId(poolId!)}/members/${encodeId(member.id)}`, { method: 'DELETE' }),
    onSuccess: (_, member) => {
      refresh();
      message.success(`${member.label} left the pool`);
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });
  const removePool = useMutation({
    mutationFn: () => api(`/providers/pools/${encodeId(poolId!)}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      message.success('Pool deleted');
      navigate('/providers');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  if (pools.isPending || shared.isPending) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  const sharedPool = shared.data?.find((row) => routeId(row.id) === poolId);
  if (sharedPool) return <SharedPoolPage pool={sharedPool} />;
  const pool = pools.data?.find((row) => routeId(row.id) === poolId);
  // "New pool" sends a pool of one's own ChatGPT account here to sign it in straight away.
  const signInFirst = (location.state as { signIn?: boolean } | null)?.signIn === true;
  if (pool && isLoginPool(pool)) return <CodexPoolPage pool={pool} signInFirst={signInFirst} />;
  const refusals = poolRefusals(keys.data ?? []);
  if (!pool) {
    return (
      <div className="provider-form">
        <Link className="provider-back" to="/providers">
          ‹ All providers
        </Link>
        <div style={{ marginTop: 16, color: 'var(--text-3)' }}>That pool no longer exists.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/providers">
        ‹ All providers
      </Link>
      <div className="pool-page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {pool.label}
          </h1>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Account pool · {availabilityOf(pool, refusals)} · each session starts on the account whose
            quota resets soonest, so none of it goes unused, and stays on it until that one runs out.
          </div>
        </div>
        <Button type="primary" disabled={keys.isPending} onClick={() => setAdding(true)}>
          Add account
        </Button>
      </div>

      <div className="re-card pool-card pool-detail" data-pool={pool.id}>
        <div className="re-head">
          <span className="re-runner">Accounts</span>
          <span className="re-head-sp" />
          <PoolGauge pool={pool} />
        </div>
        <PoolMembers pool={pool} refusals={refusals} onRemove={(member) => removeMember.mutate(member)} />
      </div>

      <div className="pool-danger">
        <Popconfirm
          title={`Delete ${pool.label}?`}
          description="Its accounts stay as they are — only the pool goes."
          onConfirm={() => removePool.mutate()}
        >
          <Button danger loading={removePool.isPending}>
            Delete pool
          </Button>
        </Popconfirm>
      </div>

      {adding && <PoolAccountsModal rows={keys.data ?? []} pool={pool} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** No key of a shared pool is one of the user's own provider rows, so none is refused as one — and
 *  neither is the ChatGPT account of a Codex pool of one's own. */
const NO_REFUSALS: PoolRefusals = new Map();

/**
 * A Codex pool of the user's own (migration 0323): the one ChatGPT account it runs on — its email, plan,
 * where it stands and its quota, with when each window resets — and the ways to change that: sign in
 * with ChatGPT while it has none, sign in again once OpenAI signed it out, sign it out, delete the pool.
 * Only its owner ever reaches this page (another user's pool is not found), so every press is theirs.
 */
function CodexPoolPage({ pool, signInFirst }: { pool: ProviderPool; signInFirst: boolean }) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [signingIn, setSigningIn] = useState(signInFirst && !pool.login);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['providers'] });
  const failed = (e: Error) => message.error(e.message || 'Failed');
  const signOut = useMutation({
    mutationFn: () => api(`${codexLoginPath(pool.id)}/account`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      message.success(`${pool.login ? loginName(pool.login) : 'The account'} is signed out`);
    },
    onError: failed,
  });
  const removePool = useMutation({
    mutationFn: () => api(`/providers/pools/${encodeId(pool.id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      message.success('Pool deleted');
      navigate('/providers');
    },
    onError: failed,
  });
  const deleteNote = 'Its ChatGPT sign-in is deleted from the Orbit server with it.';

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/providers">
        ‹ All providers
      </Link>
      <div className="pool-page-head">
        <div style={{ minWidth: 0 }}>
          <div className="pool-page-title">
            <PoolEngineMark pool={pool} size={26} />
            <h1 className="page-title">{pool.label}</h1>
          </div>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Codex pool · Just me · sessions run on your own ChatGPT account, and its sign-in stays on the
            Orbit server.
          </div>
        </div>
        {/* One account a pool: a second sign-in is how a signed-out one comes back, from its row. */}
        {!pool.login && (
          <Button type="primary" onClick={() => setSigningIn(true)}>
            Sign in with ChatGPT
          </Button>
        )}
      </div>

      <div className="re-card pool-card pool-detail" data-pool={pool.id}>
        <div className="re-head">
          <span className="re-runner">Account</span>
          <span className="re-head-sp" />
          <PoolGauge pool={pool} />
        </div>
        <PoolMembers
          pool={pool}
          refusals={NO_REFUSALS}
          loginActions={{ onSignIn: () => setSigningIn(true), onSignOut: () => signOut.mutate() }}
        />
      </div>

      <div className="pool-danger pool-danger-row">
        <Popconfirm
          title={`Delete ${pool.label}?`}
          description={deleteNote}
          okText="Delete"
          okButtonProps={{ danger: true }}
          onConfirm={() => removePool.mutate()}
        >
          <Button danger loading={removePool.isPending}>
            Delete pool
          </Button>
        </Popconfirm>
        <span className="pool-danger-note">{deleteNote}</span>
      </div>

      {signingIn && <CodexSignInModal pool={pool} onClose={() => setSigningIn(false)} />}
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * A shared pool's page: its keys — the account pool's card, a key to a row — then its people and its
 * rules, and the way out at the bottom: deleting it for an admin (its keys go from the server with it),
 * leaving it for everyone else (their keys leave with them). What each person may do here is the
 * server's (SharedPoolsService); this offers only that.
 */
function SharedPoolPage({ pool }: { pool: SharedPool }) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<SharedPoolKey | null>(null);
  const shown = sharedPoolAsProviderPool(pool);
  const admin = pool.viewerRole === 'ADMIN';
  const at = `${SHARED_POOLS_BASE}/${encodeId(pool.id)}`;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['providers'] });
  const failed = (e: Error) => message.error(e.message || 'Failed');

  const switchKey = useMutation({
    mutationFn: ({ key, enabled }: { key: SharedPoolKey; enabled: boolean }) =>
      api(`${at}/keys/${encodeId(key.id)}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: refresh,
    onError: failed,
  });
  const removeKey = useMutation({
    mutationFn: (key: SharedPoolKey) => api(`${at}/keys/${encodeId(key.id)}`, { method: 'DELETE' }),
    onSuccess: (_, key) => {
      refresh();
      message.success(`${key.label} is out of the pool`);
    },
    onError: failed,
  });
  const goOut = useMutation({
    mutationFn: () => (admin ? api(at, { method: 'DELETE' }) : api(`${at}/leave`, { method: 'POST' })),
    onSuccess: () => {
      refresh();
      message.success(admin ? 'Pool deleted' : `You left ${pool.label}`);
      navigate('/providers');
    },
    onError: failed,
  });
  const outNote = admin
    ? 'Its keys are removed from the Orbit server and no session can run on it.'
    : 'Your keys leave with you.';

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/providers">
        ‹ All providers
      </Link>
      <div className="pool-page-head">
        <div style={{ minWidth: 0 }}>
          <div className="pool-page-title">
            <PoolEngineMark pool={shown} size={26} />
            <h1 className="page-title">{pool.label}</h1>
            <span className="re-chip pool-shared-chip">SHARED</span>
          </div>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Shared Codex pool · {plural(pool.people.length, 'member')} · {availabilityOf(shown, NO_REFUSALS)} ·
            each session starts on the key with the most room, and stays on it until that one runs out.
          </div>
        </div>
        {canAddKey(pool) && (
          <Button type="primary" onClick={() => setAdding(true)}>
            Add a key
          </Button>
        )}
      </div>

      <div className="re-card pool-card pool-detail" data-pool={pool.id}>
        <div className="re-head">
          <span className="re-runner">Keys</span>
          <span className="re-head-sp" />
          <PoolGauge pool={shown} />
        </div>
        <PoolMembers
          pool={shown}
          refusals={NO_REFUSALS}
          keyActions={{
            onReplace: setReplacing,
            onSwitch: (key, enabled) => switchKey.mutate({ key, enabled }),
            onRemove: (key) => removeKey.mutate(key),
          }}
        />
      </div>

      <PoolPeopleCard pool={pool} />
      <PoolRulesCard pool={pool} />

      <div className="pool-danger pool-danger-row">
        <Popconfirm
          title={admin ? `Delete ${pool.label}?` : `Leave ${pool.label}?`}
          description={outNote}
          okText={admin ? 'Delete' : 'Leave'}
          okButtonProps={{ danger: true }}
          onConfirm={() => goOut.mutate()}
        >
          <Button danger loading={goOut.isPending}>
            {admin ? 'Delete pool' : 'Leave pool'}
          </Button>
        </Popconfirm>
        <span className="pool-danger-note">{outNote}</span>
      </div>

      {adding && <AddKeyModal pool={pool} onClose={() => setAdding(false)} />}
      {replacing && <ReplaceKeyModal pool={pool} poolKey={replacing} onClose={() => setReplacing(null)} />}
    </div>
  );
}
