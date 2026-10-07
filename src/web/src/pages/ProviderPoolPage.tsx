import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AgentProvider } from '@orbit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Modal, Popconfirm, Radio, Spin } from 'antd';
import { api } from '../api';
import {
  availabilityOf,
  PoolAccountsModal,
  PoolEngineMark,
  PoolGauge,
  PoolMembers,
} from '../components/AccountPools';
import { CodexSignInModal } from '../components/CodexSignIn';
import { ProviderTile } from '../components/ProviderGallery';
import { AddKeyModal, ReplaceKeyModal, WhoCanUseItCard } from '../components/SharedPool';
import { codexLoginPath, isLoginPool, loginName, poolLogins, type CodexLogin } from '../lib/codexLogin';
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
  canAddAccount,
  canAddKey,
  hasPeople,
  ownPoolWithAccess,
  ownsPool,
  poolAccessQuery,
  poolOwner,
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
 * opens a Codex pool (CodexPoolPage): one of the user's own, or one somebody added them to.
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
  const pool = pools.data?.find((row) => routeId(row.id) === poolId);
  // A Codex pool of the user's own: who can use it and its API keys, read beside its accounts.
  const access = useQuery({ ...poolAccessQuery(pool?.id ?? ''), enabled: !!pool && isLoginPool(pool) });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['providers'] });
  const removeMember = useMutation({
    mutationFn: (member: PoolMember) =>
      api(`/providers/pools/${encodeId(poolId!)}/members/${encodeId(member.id)}`, { method: 'DELETE' }),
    onSuccess: (_, member) => {
      refresh();
      message.success(`${member.label} left the pool`);
    },
    onError: (e: Error) => message.error("Couldn't remove the account from the pool", e.message),
  });
  const removePool = useMutation({
    mutationFn: () => api(`/providers/pools/${encodeId(poolId!)}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      message.success('Pool deleted');
      navigate('/infrastructure#pools');
    },
    onError: (e: Error) => message.error("Couldn't delete the pool", e.message),
  });

  if (pools.isPending || shared.isPending || access.isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  const sharedPool = shared.data?.find((row) => routeId(row.id) === poolId);
  if (sharedPool) return <CodexPoolPage access={sharedPool} signInFirst={false} />;
  // "New pool" sends a pool of one's own ChatGPT account here to sign it in straight away.
  const signInFirst = (location.state as { signIn?: boolean } | null)?.signIn === true;
  if (pool && isLoginPool(pool)) return <CodexPoolPage own={pool} access={access.data} signInFirst={signInFirst} />;
  const refusals = poolRefusals(keys.data ?? []);
  if (!pool) {
    return (
      <div className="provider-form">
        <Link className="provider-back" to="/infrastructure#pools">
          ‹ Infrastructure
        </Link>
        <div style={{ marginTop: 16, color: 'var(--text-3)' }}>That pool no longer exists.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/infrastructure#pools">
        ‹ Infrastructure
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the page has open: the choice of what to add, the sign-in — of one more account, or of one OpenAI
 *  signed out — Add a key, or Replace key for one OpenAI refused. */
type Dialog =
  | { kind: 'choose' }
  | { kind: 'signIn'; login: CodexLogin | null }
  | { kind: 'addKey' }
  | { kind: 'replace'; key: SharedPoolKey };

/**
 * A Codex pool's page (docs/mocks/account-pool-access/), drawn for whoever reads it. Its owner sees each
 * ChatGPT account and API key in it, says who else can use it, and adds and takes out accounts, keys and
 * people. Somebody they added reads the same accounts — since 2026-10-03 their sessions run on them too
 * (pool-credential-select.ts) — without what changes one, may put a key of their own in, and may leave.
 *
 * `own` is the pool as its owner's providers read it — its ChatGPT accounts — and `access` its people,
 * accounts and keys. A pool made on the shared pools page (migration 0321) has only the second, and is
 * drawn the same way with no ChatGPT account in it. What each person may do is the server's
 * (SharedPoolsService, CodexLoginService); this offers only that.
 */
function CodexPoolPage({
  own,
  access,
  signInFirst,
}: {
  own?: ProviderPool;
  access?: SharedPool;
  signInFirst: boolean;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pool = own ? (access ? ownPoolWithAccess(own, access) : own) : sharedPoolAsProviderPool(access!);
  const mine = !access || ownsPool(access);
  const people = !!access && hasPeople(access);
  const logins = own ? poolLogins(own) : (access?.logins ?? []);
  const keys = access?.keys ?? [];
  // How many ChatGPT accounts the pool holds, to whoever reads it — what the card says about them is the
  // same for its owner and for the people they added (the accounts run everyone's sessions, and a member
  // may sign one of their own in, migration 0371); null for a pool that cannot hold one at all (a Claude
  // pool).
  const accounts = pool.engine === AgentProvider.CODEX ? logins.length : null;
  // Who may put something in: the pool's owner always, and a member while the pool's own rule for that
  // kind says so (an admin of a shared pool counts as the owner's side of both, migration 0371).
  const mayAddAccount = mine || (!!access && canAddAccount(access));
  const mayAddKey = mine || (!!access && canAddKey(access));
  const [dialog, setDialog] = useState<Dialog | null>(
    signInFirst && logins.length === 0 ? { kind: 'signIn', login: null } : null,
  );
  const at = `${SHARED_POOLS_BASE}/${encodeId(pool.id)}`;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['providers'] });
  const signOut = useMutation({
    mutationFn: (login: CodexLogin) =>
      api(`${codexLoginPath(pool.id)}/account?fingerprint=${encodeURIComponent(login.fingerprint)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, login) => {
      refresh();
      message.success(`${loginName(login)} is signed out`);
    },
    onError: (e: Error) => message.error("Couldn't sign out the account", e.message),
  });
  const switchKey = useMutation({
    mutationFn: ({ key, enabled }: { key: SharedPoolKey; enabled: boolean }) =>
      api(`${at}/keys/${encodeId(key.id)}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: refresh,
    onError: (e: Error, { enabled }) =>
      message.error(enabled ? "Couldn't enable the key" : "Couldn't disable the key", e.message),
  });
  const removeKey = useMutation({
    mutationFn: (key: SharedPoolKey) => api(`${at}/keys/${encodeId(key.id)}`, { method: 'DELETE' }),
    onSuccess: (_, key) => {
      refresh();
      message.success(`${key.label} is out of the pool`);
    },
    onError: (e: Error) => message.error("Couldn't remove the key", e.message),
  });
  // The way out: its owner deletes it — a pool of their own where its accounts are, one made on the
  // shared pools page where its keys are — and anybody else leaves it.
  const goOut = useMutation({
    mutationFn: () =>
      !mine
        ? api(`${at}/leave`, { method: 'POST' })
        : api(own ? `/providers/pools/${encodeId(pool.id)}` : at, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      message.success(mine ? 'Pool deleted' : `You left ${pool.label}`);
      navigate('/infrastructure#pools');
    },
    onError: (e: Error) => message.error(mine ? "Couldn't delete the pool" : "Couldn't leave the pool", e.message),
  });

  // What deleting it takes off the Orbit server: its ChatGPT sign-ins, its API keys, or both.
  const gone = [
    ...(own && (logins.length > 0 || keys.length === 0)
      ? [logins.length === 1 ? 'ChatGPT sign-in' : 'ChatGPT sign-ins']
      : []),
    ...(!own || keys.length > 0 ? ['API keys'] : []),
  ];
  const deleted = `Its ${gone.join(' and ')} ${gone.join() === 'ChatGPT sign-in' ? 'is' : 'are'} deleted from the Orbit server`;
  const outNote = !mine
    ? 'Your keys leave with you.'
    : people
      ? `${deleted}, and nobody can run on it.`
      : `${deleted} with it.`;
  const owner = access ? poolOwner(access) : undefined;
  // Who can use it, and what each of them runs on — the first thing said of a pool after what it is.
  const who = !mine
    ? `${owner?.name}’s`
    : people
      ? `Me and ${plural(access!.people.length - 1, 'person', 'people')}`
      : 'Just me';
  const how = !mine
    ? accounts
      ? 'each session starts on its ChatGPT accounts; the API keys when none of them can run.'
      : `your sessions run on the API keys${access!.ownKeyFirst ? ', your own first' : ''}.`
    : !own
      ? 'each session starts on the key with the most room, and stays on it until that one runs out.'
      : people
        ? 'each session starts on your ChatGPT accounts; the API keys when none of them can run.'
        : 'each session starts on the account whose quota resets soonest, and stays on it until that one runs out.';

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/infrastructure#pools">
        ‹ Infrastructure
      </Link>
      <div className="pool-page-head">
        <div style={{ minWidth: 0 }}>
          <div className="pool-page-title">
            <PoolEngineMark pool={pool} size={26} />
            <h1 className="page-title">{pool.label}</h1>
            {people && <span className="re-chip pool-shared-chip">SHARED</span>}
          </div>
          <div className="pool-sub">
            Codex pool · <b>{who}</b> · {!mine && `${plural(access!.people.length, 'person', 'people')} · `}
            {availabilityOf(pool, NO_REFUSALS)} · {how}
          </div>
        </div>
        {/* One ChatGPT account after another, or a key — what kind is the first thing asked — for anyone
            the pool lets put something in: its owner always, a member while its rule for that kind says so
            (migration 0371). A pool whose people are not read yet signs its owner straight in. */}
        {(mayAddAccount || mayAddKey) && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() =>
              setDialog(
                !mayAddAccount
                  ? { kind: 'addKey' }
                  : mine && !access
                    ? { kind: 'signIn', login: null }
                    : { kind: 'choose' },
              )
            }
          >
            {mayAddAccount ? 'Add account' : 'Add a key'}
          </Button>
        )}
      </div>

      <div className="re-card pool-card pool-detail" data-pool={pool.id}>
        <div className="re-head">
          <span className="re-runner">
            Accounts{mine && <span className="pool-head-count">{pool.members.length}</span>}
          </span>
          <span className="re-head-sp" />
          <PoolGauge pool={pool} />
        </div>
        <PoolMembers
          pool={pool}
          refusals={NO_REFUSALS}
          // Offered to whoever the pool admits (an admin, or a member the rule lets add) and applied
          // per row: PoolMembers knows the people, and so who may do what to which account.
          loginActions={{
            onSignIn: (login) => setDialog({ kind: 'signIn', login }),
            onSignOut: (login) => signOut.mutate(login),
          }}
          keyActions={{
            onReplace: (key) => setDialog({ kind: 'replace', key }),
            onSwitch: (key, enabled) => switchKey.mutate({ key, enabled }),
            onRemove: (key) => removeKey.mutate(key),
          }}
        />
      </div>

      {access && (
        <WhoCanUseItCard
          pool={access}
          accounts={accounts}
          onAddKey={() => setDialog({ kind: 'addKey' })}
        />
      )}

      <div className="pool-danger pool-danger-row">
        <Popconfirm
          title={mine ? `Delete ${pool.label}?` : `Leave ${pool.label}?`}
          description={outNote}
          okText={mine ? 'Delete' : 'Leave'}
          okButtonProps={{ danger: true }}
          onConfirm={() => goOut.mutate()}
        >
          <Button danger loading={goOut.isPending}>
            {mine ? 'Delete pool' : 'Leave pool'}
          </Button>
        </Popconfirm>
        <span className="pool-danger-note">{outNote}</span>
      </div>

      {dialog?.kind === 'choose' && (
        <AddAccountModal
          pool={pool}
          mine={mine}
          accounts={logins.length}
          onClose={() => setDialog(null)}
          onContinue={(kind) => setDialog(kind === 'key' ? { kind: 'addKey' } : { kind: 'signIn', login: null })}
        />
      )}
      {dialog?.kind === 'signIn' && (
        <CodexSignInModal pool={own ?? pool} login={dialog.login} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'addKey' && access && <AddKeyModal pool={access} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'replace' && access && (
        <ReplaceKeyModal pool={access} poolKey={dialog.key} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/**
 * "Add account" (03-1): which kind goes in — a ChatGPT account of the reader's, which runs the whole
 * pool's sessions (its owner's, or one of the people they added's, migration 0371), or an OpenAI API key,
 * which runs everybody's too — said on the choice rather than found out after. Continue goes on to that
 * kind's own dialog: the sign-in, or Add a key.
 */
function AddAccountModal({
  pool,
  mine,
  accounts,
  onContinue,
  onClose,
}: {
  pool: ProviderPool;
  /** The reader is the pool's owner: the account may be shared with others yet, or already is. */
  mine: boolean;
  /** How many ChatGPT accounts the pool holds already. */
  accounts: number;
  onContinue: (kind: 'chatgpt' | 'key') => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'chatgpt' | 'key'>('chatgpt');
  return (
    <Modal
      open
      width={500}
      title={`Add an account to ${pool.label}`}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" onClick={() => onContinue(kind)}>
            Continue
          </Button>
        </>
      }
    >
      <Radio.Group
        name="add-account-kind"
        className="add-kinds"
        value={kind}
        onChange={(e) => setKind(e.target.value as 'chatgpt' | 'key')}
      >
        <Radio value="chatgpt" className="add-kind">
          <ProviderTile slug="openai" label="ChatGPT" size={24} />
          <span>
            <span className="add-kind-t">Sign in with ChatGPT</span>
            <span className="add-kind-s">
              {accounts > 0 ? 'Another ChatGPT account of yours.' : 'A ChatGPT account of yours.'}{' '}
              {mine ? (
                <>
                  <b>Everyone in the pool runs on it</b> once you share the pool — until then, your
                  sessions alone.
                </>
              ) : (
                <>
                  <b>Everyone in the pool runs on it</b>, you included.
                </>
              )}
            </span>
          </span>
        </Radio>
        <Radio value="key" className="add-kind">
          <span className="add-kind-key" aria-hidden="true">
            <KeyOutlined />
          </span>
          <span>
            <span className="add-kind-t">Paste an OpenAI API key</span>
            <span className="add-kind-s">
              An organization or project key. <b>Everyone who can use this pool runs on it</b>, up to a
              monthly limit you set.
            </span>
          </span>
        </Radio>
      </Radio.Group>
    </Modal>
  );
}
