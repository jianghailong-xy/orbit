import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined } from '@ant-design/icons';
import { Button, Checkbox, Input, Modal, Tag, Tooltip } from 'antd';
import { api } from '../api';
import { encodeId, routeId } from '../lib/idCodec';
import {
  canTakeWork,
  formatResetTime,
  memberQuota,
  memberStatus,
  poolHeadline,
  type PoolMember,
  type ProviderPool,
} from '../lib/providerPools';
import type { ProviderRow } from '../lib/providerAdmin';
import { useIsMobile } from '../lib/useMediaQuery';
import { useToast } from '../lib/toast';
import { ProviderTile } from './ProviderGallery';

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

const accounts = (n: number) => `${n} account${n === 1 ? '' : 's'}`;

/** "2 of 3 accounts available": the members a session could start on right now. */
export const availabilityOf = (pool: ProviderPool): string =>
  `${pool.members.filter(canTakeWork).length} of ${accounts(pool.members.length)} available`;

/** The same words for a head line, where a phone drops "accounts" to keep the pool's name. */
function Availability({ pool }: { pool: ProviderPool }) {
  const total = pool.members.length;
  return (
    <span className="re-summary">
      {pool.members.filter(canTakeWork).length} of {total}
      <span className="pool-wide"> account{total === 1 ? '' : 's'}</span> available
    </span>
  );
}

/**
 * The head's gauge: the member the next session runs on, by name, with its own 5-hour bar — the
 * pool's real answer, where an average would show half a quota no account has. With no member to
 * run on it says when the first one frees up (the earliest reset, not the latest).
 */
export function PoolGauge({ pool }: { pool: ProviderPool }) {
  const head = poolHeadline(pool);
  if (head.kind === 'spent') {
    return (
      <span className="pool-gauge spent">
        {head.resetsAt ? (
          // One inline run, so the gauge's flex gap doesn't open up inside the sentence.
          <span>
            <span className="pool-wide">All spent · </span>resets {formatResetTime(head.resetsAt)}
          </span>
        ) : (
          'All spent'
        )}
      </span>
    );
  }
  if (head.kind === 'none') return <span className="pool-gauge none">No account can run</span>;
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
      ) : (
        <span className="pool-gauge-none">No quota reported</span>
      )}
    </span>
  );
}

/** One account in a pool: who it is, where it stands, its own gauge, and what can be done about it. */
function MemberRow({ member, onRemove }: { member: PoolMember; onRemove?: () => void }) {
  const navigate = useNavigate();
  const status = memberStatus(member);
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
    </div>
  );
}

/** A pool's members, with what a pool of fewer than two accounts is worth saying about itself. */
export function PoolMembers({ pool, onRemove }: { pool: ProviderPool; onRemove?: (member: PoolMember) => void }) {
  const [only] = pool.members;
  return (
    <>
      {pool.members.length === 0 && (
        <div className="pool-note">
          No accounts yet — until one is added, a session on this pool runs on the runner&apos;s own
          Claude sign-in.
        </div>
      )}
      {pool.members.length === 1 && (
        <div className="pool-note">
          With one account this pool is the same as using <b>{only.label}</b> on its own. Add another
          so a session can move when this one runs out.
        </div>
      )}
      {pool.members.map((member) => (
        <MemberRow key={member.id} member={member} onRemove={onRemove && (() => onRemove(member))} />
      ))}
    </>
  );
}

function PoolCard({ pool, collapsed, onToggle }: { pool: ProviderPool; collapsed: boolean; onToggle: () => void }) {
  return (
    <div className={`re-card pool-card${collapsed ? ' collapsed' : ''}`} data-pool={pool.id}>
      <div className="re-head">
        <button className="re-toggle" type="button" aria-expanded={!collapsed} onClick={onToggle}>
          <span className={`re-chev${collapsed ? '' : ' open'}`} aria-hidden="true">
            ▸
          </span>
          <span className="re-runner">{pool.label}</span>
          <Availability pool={pool} />
        </button>
        <span className="re-head-sp" />
        <PoolGauge pool={pool} />
        <Link className="re-manage" to={`/providers/pools/${encodeId(pool.id)}`} aria-label={`Manage ${pool.label}`}>
          <span className="pool-wide">Manage </span>→
        </Link>
      </div>
      {!collapsed && <PoolMembers pool={pool} />}
    </div>
  );
}

/**
 * The Providers page's middle section: the user's account pools — several Claude subscriptions
 * under one name, each session starting on whichever has the most room. Between the engines above
 * (one machine's login) and the keys below (what a pool is made of).
 */
export function AccountPools({ pools }: { pools: ProviderPool[] }) {
  const isMobile = useIsMobile();
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
      <div className="re-sec-head">
        <h3>Account pools</h3>
        <span className="re-sec-sub">
          Several Claude subscriptions under one name — each session starts on the account with the
          most room in its 5-hour window.
        </span>
      </div>
      {pools.map((pool) => {
        const open = fold[pool.id] ?? !isMobile;
        return <PoolCard key={pool.id} pool={pool} collapsed={!open} onToggle={() => toggle(pool.id, open)} />;
      })}
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
  // Both lists carry public ids, but compared canonically: a pool member is a key row by identity.
  const members = new Set(pool?.members.map((member) => routeId(member.id)) ?? []);
  // Joinable first, then the refusals this dialog exists to explain, then what is in already.
  const rank = (entry: { ok: boolean; member: boolean }) => (entry.ok ? 0 : entry.member ? 2 : 1);
  const listed = rows
    .map((row) => {
      const member = members.has(routeId(row.id));
      return { row, member, ...admissionOf(row, member) };
    })
    .sort((a, b) => rank(a) - rank(b));
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
      <div className="pool-pick-list">
        {listed.map(({ row, member, ok, why }) => (
          <label key={row.id} className={`pool-pick${ok ? '' : ' off'}`} data-provider={row.id}>
            <Checkbox
              checked={member || picked.includes(row.id)}
              disabled={!ok}
              onChange={(e) =>
                setPicked((prev) =>
                  e.target.checked ? [...prev, row.id] : prev.filter((id) => id !== row.id),
                )
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
