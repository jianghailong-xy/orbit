import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { Button, Checkbox, Input, Modal, Popconfirm, Radio, Segmented, Select, Tag, Tooltip } from 'antd';
import { api } from '../api';
import { encodeId, routeId } from '../lib/idCodec';
import {
  availableCount,
  formatResetTime,
  memberQuota,
  memberRefusal,
  memberStatus,
  poolHeadline,
  type PoolMember,
  type PoolRefusals,
  type ProviderPool,
} from '../lib/providerPools';
import type { ProviderRow } from '../lib/providerAdmin';
import {
  allOutOfBudget,
  canRemoveKey,
  canReplaceKey,
  formatCapReset,
  SHARED_POOLS_BASE,
  type SharedPool,
  type SharedPoolKey,
} from '../lib/sharedPools';
import { useIsMobile } from '../lib/useMediaQuery';
import { useToast } from '../lib/toast';
import { ProviderTile } from './ProviderGallery';
import { PeopleStack, PersonMark, ReplaceKeyModal } from './SharedPool';

// Which pool cards the user folded or unfolded, by pool id. A card nobody has touched follows the
// window: open on a desktop, where its rows fit, and folded to its head line on a phone.
const FOLD_KEY = 'orbit:providers-pool-fold';

function readFold(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, open]) => typeof open === 'boolean'));
  } catch {
    return {};
  }
}

/** What a pool's members are: a shared pool holds keys, an account pool of one's own accounts. */
const memberNoun = (pool: ProviderPool, n: number) => `${pool.shared ? 'key' : 'account'}${n === 1 ? '' : 's'}`;

/** "2 of 3 accounts available" — "2 of 5 keys available" on a shared pool: the members a session could
 *  start on right now. */
export const availabilityOf = (pool: ProviderPool, refusals: PoolRefusals): string =>
  `${availableCount(pool, refusals)} of ${pool.members.length} ${memberNoun(pool, pool.members.length)} available`;

/** The same words for a head line, where a phone drops "accounts" to keep the pool's name. */
function Availability({ pool, refusals }: { pool: ProviderPool; refusals: PoolRefusals }) {
  const total = pool.members.length;
  return (
    <span className="re-summary">
      {availableCount(pool, refusals)} of {total}
      <span className="pool-wide"> {memberNoun(pool, total)}</span> available
    </span>
  );
}

/** The engine a pool runs on, as the session picker draws it: Codex for a shared pool of OpenAI keys,
 *  Claude for an account pool. */
export function PoolEngineMark({ pool, size = 18 }: { pool: ProviderPool; size?: number }) {
  return pool.shared ? (
    <ProviderTile slug="openai" label="Codex" size={size} />
  ) : (
    <ProviderTile slug="anthropic" label="Claude" size={size} />
  );
}

/**
 * The head's gauge: the member the next session runs on, by name, with its own 5-hour bar — the
 * pool's real answer, where an average would show half a quota no account has. With no member to
 * run on it says when the first one frees up (the earliest reset, not the latest), and with none
 * that can run at all, why (the server's `unavailable`).
 */
export function PoolGauge({ pool }: { pool: ProviderPool }) {
  const head = poolHeadline(pool);
  if (head.kind === 'spent') {
    // A shared pool's keys are capped rather than spent, and come back with the month — unless what
    // stopped them is OpenAI's own out-of-budget mark, which comes back at a date of its own.
    const spent = !pool.shared ? 'All spent' : allOutOfBudget(pool.shared) ? 'All out of budget' : 'All at cap';
    return (
      <span className="pool-gauge spent">
        {head.resetsAt ? (
          // One inline run, so the gauge's flex gap doesn't open up inside the sentence.
          <span>
            <span className="pool-wide">{spent} · </span>resets{' '}
            {pool.shared ? formatCapReset(head.resetsAt) : formatResetTime(head.resetsAt)}
          </span>
        ) : (
          spent
        )}
      </span>
    );
  }
  if (head.kind === 'none') return <span className="pool-gauge none">{head.reason}</span>;
  const { member, quota } = head;
  return (
    <span className="pool-gauge" title={`The next session starts on ${member.label}`}>
      <span className="pool-gauge-name">Next: {member.label}</span>
      {quota ? (
        <>
          <span className={`runner-util ${quota.nearLimit ? 'full' : ''}`}>
            <span className="runner-util-fill" style={{ width: `${quota.percent}%` }} />
          </span>
          <span className="pool-gauge-pct">{quota.percent}%</span>
        </>
      ) : member.key ? null : (
        // A key with no cap has nothing to fill; an account that reports no quota says so.
        <span className="pool-gauge-none">No quota reported</span>
      )}
    </span>
  );
}

/** One account in a pool: who it is, where it stands, its own gauge, and what can be done about it.
 *  `refusal` is why the pool would no longer admit it (memberRefusal). */
function MemberRow({
  member,
  refusal,
  onRemove,
}: {
  member: PoolMember;
  refusal: string | null;
  onRemove?: () => void;
}) {
  const navigate = useNavigate();
  const status = memberStatus(member, undefined, refusal);
  const quota = memberQuota(member);
  return (
    <div className="re-row pool-row" data-member={member.id}>
      <div className="re-id">
        <ProviderTile slug={member.presetSlug ?? member.slug} label={member.label} size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name" title={member.label}>
            <span className="pool-member-label">{member.label}</span>
            {member.next && <span className="re-chip">NEXT</span>}
          </div>
        </div>
      </div>
      <div className="pool-status">
        <Tag color={status.color} title={status.label}>
          {status.label}
        </Tag>
      </div>
      <div className="re-quota">
        {quota ? (
          <>
            <div className="re-quota-head">
              <b>{quota.label}</b>
              <span>{quota.percent}%</span>
            </div>
            <div className={`runner-util ${quota.nearLimit ? 'full' : ''}`}>
              <span className="runner-util-fill" style={{ width: `${quota.percent}%` }} />
            </div>
          </>
        ) : (
          <span className="re-quota-none">—</span>
        )}
      </div>
      <div className="re-act">
        {/* A refused key is final for the key, not for the account: a new one is the way back, and
            it is pasted on the provider's own page. */}
        {member.state === 'REFUSED' && (
          <Button size="small" onClick={() => navigate(`/providers/${encodeId(member.id)}`)}>
            Re-add key
          </Button>
        )}
        {/* A mark rather than a word: beside Re-add key the pair would outgrow the column, and
            taking an account out is undone by adding it back. */}
        {onRemove && (
          <Tooltip title="Remove from this pool">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={onRemove}
              aria-label={`Remove ${member.label} from this pool`}
            />
          </Tooltip>
        )}
      </div>
      {refusal && <div className="pool-why">{refusal}</div>}
    </div>
  );
}

/** What can be done to a shared pool's key where it is shown — paste a working key over it, switch it
 *  off and on, take it out. Each is offered only to whom the server lets do it. */
export interface KeyActions {
  onReplace?: (key: SharedPoolKey) => void;
  onSwitch?: (key: SharedPoolKey, enabled: boolean) => void;
  onRemove?: (key: SharedPoolKey) => void;
}

/** One key of a shared pool: whose it is and its fingerprint, where it stands, what the others spent on
 *  it this month against the cap its contributor set, and what the viewer may do about it. */
function KeyRow({ pool, member, actions }: { pool: SharedPool; member: PoolMember; actions: KeyActions }) {
  const key = member.key!;
  const status = memberStatus(member);
  const cap = key.shareCap;
  const spent = key.usage.othersCostUsd;
  const percent = cap === null ? null : cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 100;
  const invalid = key.state === 'INVALID';
  // The contributor's own switch; replacing and removing are theirs and every admin's.
  const replace = invalid && canReplaceKey(pool, key) ? actions.onReplace : undefined;
  const toggle = key.contributor.you ? actions.onSwitch : undefined;
  const remove = canRemoveKey(pool, key) ? actions.onRemove : undefined;
  return (
    <div className="re-row pool-row pool-row-key" data-member={key.id}>
      <div className="re-id">
        <PersonMark pool={pool} userId={key.contributor.userId} name={key.contributor.name} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name" title={key.label}>
            <span className="pool-member-label">{key.label}</span>
            {key.contributor.you && <span className="pool-you">you</span>}
            {member.next && <span className="re-chip">NEXT</span>}
          </div>
          <div className="pool-key-mask">
            {key.contributor.name} · {key.fingerprint}
          </div>
        </div>
      </div>
      <div className="pool-status">
        <Tag color={status.color} title={status.label}>
          {status.label}
        </Tag>
      </div>
      <div className="re-quota pool-key-money">
        {/* Short on purpose: what the others spent on it, against the cap its contributor set — the
            whole sentence is the cell's own title. */}
        <div
          className="re-quota-head"
          title={`What the others spent on this key this month${cap === null ? '' : `, of the $${cap} its contributor allows`}`}
        >
          <b>Others</b>
          <span>
            ${spent.toFixed(2)}
            {cap === null ? '' : ` of $${cap}`}
          </span>
        </div>
        {percent !== null && (
          <div className={`runner-util ${percent >= 90 ? 'full' : ''}`}>
            <span className="runner-util-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div className="re-act">
        {replace && (
          <Button size="small" type="primary" onClick={() => replace(key)}>
            Replace key
          </Button>
        )}
        {toggle && (
          <Tooltip title={key.enabled ? 'Disable — no session starts on it until you enable it' : 'Enable'}>
            <Button
              size="small"
              type="text"
              icon={key.enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() => toggle(key, !key.enabled)}
              aria-label={`${key.enabled ? 'Disable' : 'Enable'} ${key.label}`}
            />
          </Tooltip>
        )}
        {remove && (
          <Popconfirm
            title={`Remove ${key.label}?`}
            description="It is deleted from the Orbit server, and no session runs on it again."
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove(key)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={`Remove ${key.label} from this pool`}
            />
          </Popconfirm>
        )}
      </div>
      {invalid && (
        <div className="pool-why">
          {canReplaceKey(pool, key)
            ? 'Rejected by OpenAI — replace it with a working key to put it back in the pool.'
            : `Rejected by OpenAI — only ${key.contributor.name} or the pool’s admins can replace it.`}
        </div>
      )}
    </div>
  );
}

/** A pool's members, with what a pool of fewer than two accounts is worth saying about itself. A shared
 *  pool's members are its keys (KeyRow), and `keyActions` what can be done to them here. */
export function PoolMembers({
  pool,
  refusals,
  onRemove,
  keyActions,
}: {
  pool: ProviderPool;
  refusals: PoolRefusals;
  onRemove?: (member: PoolMember) => void;
  keyActions?: KeyActions;
}) {
  const [only] = pool.members;
  const { shared } = pool;
  return (
    <>
      {/* Every door that takes a provider refuses a pool with nothing in it (the server's
          `unavailable`), so this says that rather than where such a session would run. */}
      {pool.members.length === 0 && (
        <div className="pool-note">
          No {shared ? 'keys' : 'accounts'} yet — no session can start on this pool until one is added.
        </div>
      )}
      {/* Not of one the pool no longer admits: on its own that account still runs, and in the pool
          it can't. */}
      {pool.members.length === 1 && !shared && !memberRefusal(only, refusals) && (
        <div className="pool-note">
          With one account this pool is the same as using <b>{only.label}</b> on its own. Add another
          so a session can move when this one runs out.
        </div>
      )}
      {pool.members.map((member) =>
        shared && member.key ? (
          <KeyRow key={member.id} pool={shared} member={member} actions={keyActions ?? {}} />
        ) : (
          <MemberRow
            key={member.id}
            member={member}
            refusal={memberRefusal(member, refusals)}
            onRemove={onRemove && (() => onRemove(member))}
          />
        ),
      )}
    </>
  );
}

function PoolCard({
  pool,
  refusals,
  collapsed,
  onToggle,
  keyActions,
}: {
  pool: ProviderPool;
  refusals: PoolRefusals;
  collapsed: boolean;
  onToggle: () => void;
  keyActions?: KeyActions;
}) {
  return (
    <div className={`re-card pool-card${collapsed ? ' collapsed' : ''}`} data-pool={pool.id}>
      <div className="re-head">
        <button className="re-toggle" type="button" aria-expanded={!collapsed} onClick={onToggle}>
          <span className={`re-chev${collapsed ? '' : ' open'}`} aria-hidden="true">
            ▸
          </span>
          <PoolEngineMark pool={pool} />
          <span className="re-runner">{pool.label}</span>
          {pool.shared && <span className="re-chip pool-shared-chip">SHARED</span>}
          <Availability pool={pool} refusals={refusals} />
        </button>
        <span className="re-head-sp" />
        {pool.shared && <PeopleStack pool={pool.shared} />}
        <PoolGauge pool={pool} />
        <Link className="re-manage" to={`/providers/pools/${encodeId(pool.id)}`} aria-label={`Manage ${pool.label}`}>
          <span className="pool-wide">Manage </span>→
        </Link>
      </div>
      {!collapsed && <PoolMembers pool={pool} refusals={refusals} keyActions={keyActions} />}
    </div>
  );
}

/**
 * The Providers page's middle section: the user's account pools — several Claude subscriptions
 * under one name, each session starting on whichever has the most room — and the shared pools they
 * are in, several people's OpenAI keys under one name (sharedPoolAsProviderPool). Between the engines
 * above (one machine's login) and the keys below (what an account pool is made of), whose verdicts say
 * which accounts a pool would no longer admit (`refusals`, poolRefusals). Its head makes another pool
 * of either kind (NewPoolModal); a key OpenAI refused is replaced from its card, and taken out on the
 * pool's own page.
 */
export function AccountPools({
  pools,
  refusals,
  rows,
}: {
  pools: ProviderPool[];
  refusals: PoolRefusals;
  /** The user's own keys: what a new Claude pool is made of. */
  rows: ProviderRow[];
}) {
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState<{ pool: SharedPool; key: SharedPoolKey } | null>(null);
  const [fold, setFold] = useState<Record<string, boolean>>(readFold);
  const toggle = (id: string, open: boolean) =>
    setFold((prev) => {
      const next = { ...prev, [id]: !open };
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {
        // Private mode / full quota: the fold still works, it just won't outlive the page.
      }
      return next;
    });

  return (
    <div className="re-sec pool-sec">
      <div className="re-sec-head pool-sec-head">
        <h3>Account pools</h3>
        <span className="re-sec-sub">
          Several keys under one name — each session starts on the one with the most room, and moves
          on when it runs out.
        </span>
        <Button size="small" className="pool-new" onClick={() => setCreating(true)}>
          New pool
        </Button>
      </div>
      {pools.map((pool) => {
        const open = fold[pool.id] ?? !isMobile;
        const { shared } = pool;
        return (
          <PoolCard
            key={pool.id}
            pool={pool}
            refusals={refusals}
            collapsed={!open}
            onToggle={() => toggle(pool.id, open)}
            keyActions={shared && { onReplace: (key) => setReplacing({ pool: shared, key }) }}
          />
        );
      })}
      {creating && <NewPoolModal rows={rows} onClose={() => setCreating(false)} />}
      {replacing && (
        <ReplaceKeyModal pool={replacing.pool} poolKey={replacing.key} onClose={() => setReplacing(null)} />
      )}
    </div>
  );
}

/** What a row of the account picker says about joining: the server's admission verdict, or why the
 *  question doesn't arise. */
function admissionOf(row: ProviderRow, inPool: boolean): { ok: boolean; why: string } {
  if (inPool) return { ok: false, why: 'Already in this pool' };
  if (row.poolRefusal === null) return { ok: true, why: 'Claude subscription · reports a 5-hour window' };
  return { ok: false, why: row.poolRefusal?.message ?? "Can't tell whether this key has a 5-hour window" };
}

/**
 * Pick the accounts for a new pool, or one more for an existing one. Every key the user has is
 * listed with the server's verdict on it, and one that could never be chosen from a pool — a
 * metered API key, an endpoint other than api.anthropic.com — is disabled with the reason on its
 * row. Letting it in would not fail: it would sit in the pool, never picked, with nothing to say why.
 */
export function PoolAccountsModal({
  rows,
  pool,
  onClose,
}: {
  rows: ProviderRow[];
  /** The pool to add to; absent to create one. */
  pool?: ProviderPool;
  onClose: () => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const listed = accountPicks(rows, pool);
  const [label, setLabel] = useState('Claude accounts');
  // A new pool starts with every account that can join; adding to one starts from none.
  const [picked, setPicked] = useState<string[]>(() =>
    pool ? [] : listed.filter((entry) => entry.ok).map((entry) => entry.row.id),
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!pool) {
        await api('/providers/pools', { method: 'POST', body: { label: label.trim(), providerIds: picked } });
        return;
      }
      for (const providerId of picked) {
        await api(`/providers/pools/${encodeId(pool.id)}/members`, { method: 'POST', body: { providerId } });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      message.success(pool ? `Added to ${pool.label}` : 'Pool created');
      onClose();
    },
    onError: (e: Error) => {
      // A partial add still changed the pool.
      void qc.invalidateQueries({ queryKey: ['providers'] });
      message.error(e.message || 'Failed');
    },
  });

  return (
    <Modal
      open
      title={pool ? `Add account to ${pool.label}` : 'Create an account pool'}
      okText={pool ? 'Add' : 'Create pool'}
      okButtonProps={{ disabled: picked.length === 0 || (!pool && !label.trim()), loading: save.isPending }}
      onOk={() => save.mutate()}
      onCancel={onClose}
    >
      {!pool && (
        <label className="pool-name">
          <span>Name</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </label>
      )}
      <AccountPickList listed={listed} picked={picked} onPick={setPicked} />
    </Modal>
  );
}

/** Every key the user has, as a row of the account picker, with the server's verdict on it — joinable
 *  first, then the refusals the picker exists to explain, then what `pool` holds already. */
function accountPicks(rows: ProviderRow[], pool?: ProviderPool) {
  // Both lists carry public ids, but compared canonically: a pool member is a key row by identity.
  const members = new Set(pool?.members.map((member) => routeId(member.id)) ?? []);
  const rank = (entry: { ok: boolean; member: boolean }) => (entry.ok ? 0 : entry.member ? 2 : 1);
  return rows
    .map((row) => {
      const member = members.has(routeId(row.id));
      return { row, member, ...admissionOf(row, member) };
    })
    .sort((a, b) => rank(a) - rank(b));
}

function AccountPickList({
  listed,
  picked,
  onPick,
}: {
  listed: ReturnType<typeof accountPicks>;
  picked: string[];
  onPick: (update: (prev: string[]) => string[]) => void;
}) {
  return (
    <div className="pool-pick-list">
      {listed.map(({ row, member, ok, why }) => (
        <label key={row.id} className={`pool-pick${ok ? '' : ' off'}`} data-provider={row.id}>
          <Checkbox
            checked={member || picked.includes(row.id)}
            disabled={!ok}
            onChange={(e) =>
              onPick((prev) => (e.target.checked ? [...prev, row.id] : prev.filter((id) => id !== row.id)))
            }
          />
          <ProviderTile slug={row.presetSlug ?? row.slug} label={row.label} size={24} />
          <span className="pool-pick-text">
            <span className="pool-pick-name">{row.label}</span>
            <span className={`pool-pick-why${ok || member ? '' : ' refused'}`}>{why}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * "New pool": the engine it runs, its name, and who can use it. A Codex pool holds OpenAI API keys
 * that each person pastes on its page once it exists — it is shared: whoever makes it adds people by
 * the email of their Orbit account, and says whether they may put keys of their own in. A Claude pool
 * is the user's own Claude subscriptions, picked here the way "Create a pool" picks them.
 */
export function NewPoolModal({ rows, onClose }: { rows: ProviderRow[]; onClose: () => void }) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [engine, setEngine] = useState<'claude' | 'codex'>('codex');
  // Untouched, the name follows the engine.
  const [label, setLabel] = useState<string | null>(null);
  const name = label ?? (engine === 'codex' ? 'Codex keys' : 'Claude accounts');
  const [who, setWho] = useState<'me' | 'people'>('people');
  const [emails, setEmails] = useState<string[]>([]);
  // An address typed but not yet turned into a tag still counts.
  const [typing, setTyping] = useState('');
  const [canAdd, setCanAdd] = useState(true);
  const listed = accountPicks(rows);
  const [picked, setPicked] = useState<string[]>(() =>
    listed.filter((entry) => entry.ok).map((entry) => entry.row.id),
  );

  const create = useMutation({
    mutationFn: async (): Promise<{ id?: string; missed: string[] }> => {
      if (engine === 'claude') {
        await api('/providers/pools', { method: 'POST', body: { label: name.trim(), providerIds: picked } });
        return { missed: [] };
      }
      const pool = await api<SharedPool>(SHARED_POOLS_BASE, { method: 'POST', body: { label: name.trim() } });
      const at = `${SHARED_POOLS_BASE}/${encodeId(pool.id)}`;
      const missed: string[] = [];
      if (who === 'people') {
        const people = [...new Set([...emails, typing].map((email) => email.trim()).filter(Boolean))];
        for (const email of people) {
          // One unknown address doesn't undo the pool or the rest: it is named once they are in.
          await api(`${at}/people`, { method: 'POST', body: { email } }).catch((e: Error) =>
            missed.push(`${email} (${e.message})`),
          );
        }
        if (!canAdd) await api(at, { method: 'PATCH', body: { membersCanAdd: false } });
      }
      return { id: pool.id, missed };
    },
    onSuccess: ({ id, missed }) => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      if (missed.length) message.warning(`Pool created — not added: ${missed.join(', ')}`);
      else message.success('Pool created');
      onClose();
      // Where its first key goes in.
      if (id) navigate(`/providers/pools/${encodeId(id)}`);
    },
    onError: (e: Error) => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      message.error(e.message || 'Failed');
    },
  });

  return (
    <Modal
      open
      width={520}
      title="New account pool"
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            disabled={!name.trim() || (engine === 'claude' && picked.length === 0)}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create pool
          </Button>
        </>
      }
    >
      <div className="np-field">
        <span className="np-field-l">Engine</span>
        <Segmented
          className="np-engine"
          value={engine}
          onChange={(value) => setEngine(value as 'claude' | 'codex')}
          options={[
            {
              value: 'claude',
              label: (
                <>
                  <ProviderTile slug="anthropic" label="Claude" size={16} /> Claude
                </>
              ),
            },
            {
              value: 'codex',
              label: (
                <>
                  <ProviderTile slug="openai" label="Codex" size={16} /> Codex
                </>
              ),
            },
          ]}
        />
        <div className="np-field-h">
          A Codex pool holds OpenAI API keys — each person pastes their own once the pool exists. A
          Claude pool is made of your Anthropic API keys.
        </div>
      </div>
      <label className="np-field">
        <span className="np-field-l">Name</span>
        <Input value={name} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
      </label>
      {engine === 'codex' ? (
        <div className="np-field">
          <span className="np-field-l">Who can use it</span>
          <Radio.Group value={who} onChange={(e) => setWho(e.target.value as 'me' | 'people')}>
            <Radio value="me">Just me</Radio>
            <Radio value="people">Me and people I add</Radio>
          </Radio.Group>
          {who === 'people' && (
            <>
              <Select
                mode="tags"
                className="np-people"
                value={emails}
                onChange={(next: string[]) => {
                  setEmails(next);
                  setTyping('');
                }}
                onSearch={setTyping}
                searchValue={typing}
                tokenSeparators={[',', ' ']}
                open={false}
                placeholder="Emails of their Orbit accounts"
                aria-label="People to add"
              />
              <div className="np-field-h">
                They see it on their Providers page and in the session picker, and can start sessions on it.
              </div>
              <Checkbox checked={canAdd} onChange={(e) => setCanAdd(e.target.checked)} className="np-can-add">
                They can add their own keys
              </Checkbox>
            </>
          )}
        </div>
      ) : (
        <div className="np-field">
          <span className="np-field-l">Accounts</span>
          <AccountPickList listed={listed} picked={picked} onPick={setPicked} />
        </div>
      )}
    </Modal>
  );
}

/** At the top of the keys list, while there is something to pool and no pool yet. */
export function PoolHint({ rows, eligible }: { rows: ProviderRow[]; eligible: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pool-hint">
      <span>
        <b>{eligible} of your keys are Claude subscriptions.</b> Pool them, and each session starts
        on whichever has the most room in its 5-hour window.
      </span>
      <Button size="small" type="primary" onClick={() => setOpen(true)}>
        Create a pool
      </Button>
      {open && <PoolAccountsModal rows={rows} onClose={() => setOpen(false)} />}
    </div>
  );
}
