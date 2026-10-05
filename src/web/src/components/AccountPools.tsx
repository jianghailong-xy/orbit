import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DeleteOutlined,
  LogoutOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Input, Modal, Popconfirm, Radio, Segmented, Select, Tooltip } from 'antd';
import { api } from '../api';
import { accountIsPaused, usePauseClock } from '../lib/accountPause';
import { AccountPauseActions, AccountPauseStatus } from './AccountPause';
import { isLoginPool, loginLine, type CodexLogin } from '../lib/codexLogin';
import { encodeId, routeId } from '../lib/idCodec';
import { planUsageRows } from '../lib/planUsage';
import {
  availableCount,
  formatResetTime,
  memberQuota,
  memberRefusal,
  memberStatus,
  poolHeadline,
  poolRunsCodex,
  type PoolMember,
  type PoolRefusals,
  type ProviderPool,
} from '../lib/providerPools';
import type { ProviderRow } from '../lib/providerAdmin';
import { compactWindowLabel } from '../lib/sessionProviderChoices';
import {
  allOutOfBudget,
  canAddAccount,
  canRemoveKey,
  canReplaceKey,
  canSignInAgain,
  canSignOutAccount,
  formatCapReset,
  hasPeople,
  ownsPool,
  poolOwner,
  SHARED_POOLS_BASE,
  type SharedPool,
  type SharedPoolKey,
} from '../lib/sharedPools';
import { useIsMobile } from '../lib/useMediaQuery';
import { useToast } from '../lib/toast';
import { CodexSignInModal } from './CodexSignIn';
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

/** Whether `pool` is drawn for one of the people its owner added rather than for its owner. */
const readByMember = (pool: ProviderPool): boolean => !!pool.shared && !ownsPool(pool.shared);

/** What a pool's members are to whoever reads it: to its owner, accounts — each ChatGPT account and API
 *  key of a Codex pool, each subscription of a Claude one — and to the people they added, what they can
 *  run on: the pool's ChatGPT accounts and its keys, whichever of the two it holds. */
const memberNoun = (pool: ProviderPool, n: number) => {
  if (!readByMember(pool)) return `account${n === 1 ? '' : 's'}`;
  const accounts = pool.members.some((member) => member.login);
  const keys = pool.members.some((member) => member.key);
  if (accounts && keys) return `account${n === 1 ? '' : 's'} and key${n === 1 ? '' : 's'} you can run on`;
  return (keys ? `key${n === 1 ? '' : 's'}` : `account${n === 1 ? '' : 's'}`) + ' you can run on';
};

/** "2 of 3 accounts available" — "2 of 2 accounts and keys you can run on available" for somebody the
 *  owner added: the members a session could start on right now. */
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

/** The engine a pool runs on, as the session picker draws it: Codex for a shared pool of OpenAI keys and
 *  for a pool of one's own ChatGPT account, Claude for an account pool of Claude keys. */
export function PoolEngineMark({ pool, size = 18 }: { pool: ProviderPool; size?: number }) {
  return poolRunsCodex(pool) ? (
    <ProviderTile slug="openai" label="Codex" size={size} />
  ) : (
    <ProviderTile slug="anthropic" label="Claude" size={size} />
  );
}

/**
 * The head's gauge: the member the next session runs on, by name, with the bar of its tightest window
 * and that window's name ("Weekly 97%") — the pool's real answer, where an average would show half a
 * quota no account has. With no member to run on it says when the first one frees up (the earliest
 * reset, not the latest), and with none that can run at all, why (the server's `unavailable`).
 */
export function PoolGauge({ pool }: { pool: ProviderPool }) {
  const head = poolHeadline(pool);
  // Only a pool of nothing but keys is capped: a ChatGPT account in it is spent, and comes back by the hour.
  const keysOnly = !!pool.shared && !pool.members.some((member) => member.login);
  if (head.kind === 'spent') {
    // A shared pool's keys are capped rather than spent, and come back with the month — unless what
    // stopped them is OpenAI's own out-of-budget mark, which comes back at a date of its own.
    const spent = !keysOnly ? 'All spent' : allOutOfBudget(pool.shared!) ? 'All out of budget' : 'All at cap';
    return (
      <span className="pool-gauge spent">
        {head.resetsAt ? (
          // One inline run, so the gauge's flex gap doesn't open up inside the sentence.
          <span>
            <span className="pool-wide">{spent} · </span>resets{' '}
            {keysOnly ? formatCapReset(head.resetsAt) : formatResetTime(head.resetsAt)}
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
      {/* A pool of one's own ChatGPT account with one account has nothing to choose between, so it is
          named; holding several, "Next:" says which of them the next session starts on — and once other
          people use the pool, that it is the viewer's next session, theirs running elsewhere. */}
      <span className="pool-gauge-name">
        {pool.shared && hasPeople(pool.shared)
          ? `Next for you: ${member.label}`
          : member.login && pool.members.length === 1
            ? member.label
            : `Next: ${member.label}`}
      </span>
      {quota ? (
        <>
          <span className={`runner-util ${quota.nearLimit ? 'full' : ''}`}>
            <span className="runner-util-fill" style={{ width: `${quota.percent}%` }} />
          </span>
          <span className={`pool-gauge-pct${quota.nearLimit ? ' near-limit' : ''}`}>
            {`${compactWindowLabel(quota.label)} ${quota.percent}%`}
          </span>
        </>
      ) : (
        // A key with no cap has nothing to fill; an account that reports no quota says so.
        <span className="pool-gauge-none">{member.key ? 'No limit' : 'No quota reported'}</span>
      )}
    </span>
  );
}

const poolPauseEndpoint = (poolId: string, memberId: string) =>
  `/providers/pools/${encodeId(poolId)}/members/${memberId.startsWith('login:') ? encodeURIComponent(memberId) : encodeId(memberId)}/pause`;

function PoolPauseActions({ pool, member }: { pool: ProviderPool; member: PoolMember }) {
  const permitted = !pool.shared || (member.login
    ? canSignOutAccount(pool.shared, member.login)
    : member.key && canRemoveKey(pool.shared, member.key));
  if (!permitted) return null;
  return <AccountPauseActions pool shared={!!pool.shared && hasPeople(pool.shared)} name={member.label} until={member.pausedUntil} endpoint={poolPauseEndpoint(pool.id, member.id)} />;
}

/** One account in a pool: who it is, where it stands, its own gauge, and what can be done about it.
 *  `refusal` is why the pool would no longer admit it (memberRefusal). */
function MemberRow({
  pool,
  member,
  refusal,
  onRemove,
}: {
  pool: ProviderPool;
  member: PoolMember;
  refusal: string | null;
  onRemove?: () => void;
}) {
  const navigate = useNavigate();
  const now = usePauseClock(member.pausedUntil);
  const status = memberStatus({ ...member, pausedUntil: null }, now, refusal);
  const quota = memberQuota(member);
  return (
    <div className={`re-row pool-row${accountIsPaused(member.pausedUntil, now) ? ' account-paused' : ''}`} data-member={member.id}>
      <div className="re-id">
        <ProviderTile slug={member.presetSlug ?? member.slug} label={member.label} size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name" title={member.label}>
            <span className="pool-member-label">{member.label}</span>
            {member.next && !accountIsPaused(member.pausedUntil, now) && <span className="re-chip">NEXT</span>}
          </div>
        </div>
      </div>
      <AccountPauseStatus className="pool-status" until={member.pausedUntil} now={now} detail={member.login?.state === 'ACTIVE' ? 'Signed in' : undefined} status={status} />
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
        <PoolPauseActions pool={pool} member={member} />
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

/** Whose sessions a credential of a pool shared with people runs, said on its owner's page: since
 *  2026-10-03 a ChatGPT account runs everybody's as a key does (pool-credential-select.ts), so the one
 *  mark says the one thing. What stays the owner's alone — signing an account in or out, adding one — is
 *  said by the actions a member is not offered. */
function RunsFor() {
  return (
    <span className="pool-runs-for all">
      <TeamOutlined />
      Everyone here
    </span>
  );
}

/** One key of a shared pool: whose it is and its fingerprint, where it stands, what the others spent on
 *  it this month against the cap its contributor set, and what the viewer may do about it. `tagged` says
 *  it runs everybody's sessions. */
function KeyRow({
  pool,
  member,
  actions,
  tagged = false,
}: {
  pool: SharedPool;
  member: PoolMember;
  actions: KeyActions;
  tagged?: boolean;
}) {
  const key = member.key!;
  const now = usePauseClock(member.pausedUntil);
  const status = memberStatus({ ...member, pausedUntil: null }, now);
  const cap = key.shareCap;
  const spent = key.usage.othersCostUsd;
  const percent = cap === null ? null : cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 100;
  const invalid = key.state === 'INVALID';
  // The contributor's own switch; replacing and removing are theirs and every admin's.
  const replace = invalid && canReplaceKey(pool, key) ? actions.onReplace : undefined;
  const toggle = key.contributor.you ? actions.onSwitch : undefined;
  const remove = canRemoveKey(pool, key) ? actions.onRemove : undefined;
  return (
    <div className={`re-row pool-row pool-row-key${accountIsPaused(member.pausedUntil, now) ? ' account-paused' : ''}`} data-member={key.id}>
      <div className="re-id">
        <PersonMark pool={pool} userId={key.contributor.userId} name={key.contributor.name} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name" title={key.label}>
            <span className="pool-member-label">{key.label}</span>
            {key.contributor.you && <span className="pool-you">you</span>}
            {member.next && !accountIsPaused(member.pausedUntil, now) && <span className="re-chip">NEXT</span>}
          </div>
          <div className="pool-key-mask">
            {key.contributor.name} · {key.fingerprint}
            {tagged && (
              <>
                {' · '}
                <RunsFor />
              </>
            )}
          </div>
        </div>
      </div>
      <AccountPauseStatus className="pool-status" until={member.pausedUntil} now={now} detail={member.login?.state === 'ACTIVE' ? 'Signed in' : undefined} status={status} />
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
        {canRemoveKey(pool, key) && <AccountPauseActions pool shared={hasPeople(pool)} name={member.label} until={member.pausedUntil} endpoint={poolPauseEndpoint(pool.id, member.id)} />}
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

/** What can be done to a Codex pool's ChatGPT account where it is shown: sign it in again once OpenAI
 *  signed it out, and sign it out. Who is offered which is the row's own to say (migration 0371): the
 *  person who signed the account in is the only one who can sign it in again — nobody, an admin
 *  included, has a credential for it — and taking it out is theirs and the pool's admins'.
 *  `canSignInAgain`/`canSignOut` say what this reader may do to THIS account. */
export interface LoginActions {
  onSignIn?: (login: CodexLogin) => void;
  onSignOut?: (login: CodexLogin) => void;
  canSignInAgain?: (login: CodexLogin) => boolean;
  canSignOut?: (login: CodexLogin) => boolean;
}

/** The ChatGPT account a Codex pool runs on: whose it is and its plan, where it stands, each of its
 *  windows with when it resets — and, once OpenAI signed it out, why and the way back. `tagged` says it
 *  runs everyone's sessions here. */
function LoginRow({
  pool,
  member,
  actions,
  tagged = false,
  contributor,
}: {
  pool: ProviderPool;
  member: PoolMember;
  actions: LoginActions;
  tagged?: boolean;
  /** The person who signed it in, when the pool's people are read — named on the row like a key's own. */
  contributor?: { name: string; you: boolean };
}) {
  const login = member.login!;
  const now = usePauseClock(member.pausedUntil);
  const status = memberStatus({ ...member, pausedUntil: null }, now);
  const windows = login.usage ? planUsageRows(login.usage) : [];
  const signedOut = member.state === 'SIGNED_OUT';
  const { onSignIn, onSignOut, canSignInAgain, canSignOut } = actions;
  const signInAgain = signedOut && onSignIn && (canSignInAgain?.(login) ?? true);
  const signOut = onSignOut && (canSignOut?.(login) ?? true);
  // One account the pool: signing it out leaves nothing running on the pool. Holding others, it keeps
  // running on them, and the confirmation says so in the plural when more than one stays.
  const others = pool.members.length - 1;
  return (
    <div className={`re-row pool-row pool-row-login${accountIsPaused(member.pausedUntil, now) ? ' account-paused' : ''}`} data-member={member.id}>
      <div className="re-id">
        <ProviderTile slug="openai" label="ChatGPT" size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name" title={member.label}>
            <span className="pool-member-label">{member.label}</span>
            {/* With one account there is nothing to choose between, so the mark would say nothing. */}
            {member.next && !accountIsPaused(member.pausedUntil, now) && pool.members.length > 1 && <span className="re-chip">NEXT</span>}
          </div>
          <div className="pool-key-mask">
            {contributor && `${contributor.name} · `}
            {loginLine(login)}
            {tagged && (
              <>
                {' · '}
                <RunsFor />
              </>
            )}
          </div>
        </div>
      </div>
      <AccountPauseStatus className="pool-status" until={member.pausedUntil} now={now} detail={member.login?.state === 'ACTIVE' ? 'Signed in' : undefined} status={status} />
      <div className="re-quota pool-login-quota">
        {windows.length > 0 ? (
          windows.map((row) => (
            <div key={row.key} className="pool-login-window">
              <div className="re-quota-head">
                <b>{row.label}</b>
                <span>{row.percent}%</span>
              </div>
              <div className={`runner-util ${row.nearLimit ? 'full' : ''}`}>
                <span className="runner-util-fill" style={{ width: `${row.percent}%` }} />
              </div>
              {row.window.resetsAt && (
                <div className="pool-login-reset">resets {formatResetTime(row.window.resetsAt)}</div>
              )}
            </div>
          ))
        ) : (
          // Nothing has read this account's quota yet — which is not a refusal: it runs.
          <span className="re-quota-none">No quota reported</span>
        )}
      </div>
      <div className="re-act">
        <PoolPauseActions pool={pool} member={member} />
        {signInAgain && (
          <Button size="small" type="primary" onClick={() => onSignIn!(login)}>
            Sign in again
          </Button>
        )}
        {signOut && (
          <Popconfirm
            title={`Sign out ${member.label}?`}
            description={
              others > 0
                ? `Its sign-in is deleted from the Orbit server, and no session runs on it until you sign in again — ${pool.label} keeps running on its other account${others === 1 ? '' : 's'}.`
                : 'Its sign-in is deleted from the Orbit server, and no session runs on this pool until you sign in again.'
            }
            okText="Sign out"
            okButtonProps={{ danger: true }}
            onConfirm={() => onSignOut!(login)}
          >
            <Button
              size="small"
              type="text"
              danger
              className="pool-signout"
              icon={<LogoutOutlined />}
              aria-label={`Sign out ${member.label}`}
            />
          </Popconfirm>
        )}
      </div>
      {signedOut && (
        <div className="pool-why">
          {signInAgain
            ? 'OpenAI signed this account out — sign in again to put it back in the pool.'
            : `OpenAI signed this account out — only ${contributor ? contributor.name : 'the person who signed it in'} can sign it in again.`}
        </div>
      )}
    </div>
  );
}

/** A pool's members, with what a pool of fewer than two accounts is worth saying about itself. A pool's
 *  keys are KeyRow, with `keyActions` what can be done to them here; its ChatGPT accounts are LoginRow,
 *  with `loginActions` the presses the page offers and — where the pool's people are read — what THIS
 *  reader may do to each account (migration 0371: the person who signed it in signs it in again, and with
 *  the pool's admins takes it out), and whose account each row is. */
export function PoolMembers({
  pool,
  refusals,
  onRemove,
  keyActions,
  loginActions,
}: {
  pool: ProviderPool;
  refusals: PoolRefusals;
  onRemove?: (member: PoolMember) => void;
  keyActions?: KeyActions;
  loginActions?: LoginActions;
}) {
  const [only] = pool.members;
  const { shared } = pool;
  const login = isLoginPool(pool);
  const tagged = !!shared && ownsPool(shared) && hasPeople(shared);
  // Whose account a row is and what this reader may do to it: the pool's people carry both (their `you`
  // row is the reader). Without them — an own pool whose access is not read yet — the page's own presses
  // stand as they did.
  const actionsFor = (account: CodexLogin): LoginActions =>
    shared
      ? {
          ...loginActions,
          canSignInAgain: (row) => canSignInAgain(shared, row),
          canSignOut: (row) => canSignOutAccount(shared, row),
        }
      : (loginActions ?? {});
  const contributorOf = (account: CodexLogin) => {
    const person = shared?.people.find((row) => row.userId === account.userId);
    return person ? { name: person.name, you: person.you } : undefined;
  };
  return (
    <>
      {/* Every door that takes a provider refuses a pool with nothing in it (the server's
          `unavailable`), so this says that rather than where such a session would run. */}
      {pool.members.length === 0 &&
        (login ? (
          <div className="pool-note">
            No account yet — no session can start on this pool until{' '}
            {!shared || canAddAccount(shared) ? 'you sign in' : 'its owner signs in'} with ChatGPT.
          </div>
        ) : (
          <div className="pool-note">
            No {shared ? 'keys' : 'accounts'} yet — no session can start on this pool until one is added.
          </div>
        ))}
      {/* Not of one the pool no longer admits: on its own that account still runs, and in the pool
          it can't. Nor of a ChatGPT account, which is the one a pool of one's own is for. */}
      {pool.members.length === 1 && !shared && !login && !memberRefusal(only, refusals) && (
        <div className="pool-note">
          With one account this pool is the same as using <b>{only.label}</b> on its own. Add another
          so a session can move when this one runs out.
        </div>
      )}
      {pool.members.map((member) =>
        shared && member.key ? (
          <KeyRow key={member.id} pool={shared} member={member} actions={keyActions ?? {}} tagged={tagged} />
        ) : member.login ? (
          <LoginRow
            key={member.id}
            pool={pool}
            member={member}
            actions={actionsFor(member.login)}
            tagged={tagged}
            contributor={contributorOf(member.login)}
          />
        ) : (
          <MemberRow
            key={member.id}
            pool={pool}
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
  loginActions,
}: {
  pool: ProviderPool;
  refusals: PoolRefusals;
  collapsed: boolean;
  onToggle: () => void;
  keyActions?: KeyActions;
  loginActions?: LoginActions;
}) {
  // Folded cards have no member rows to refresh the catalogue when a pause ends.
  usePauseClock(pool.members.flatMap((member) => accountIsPaused(member.pausedUntil) ? [member.pausedUntil!] : []).sort()[0]);
  const { shared } = pool;
  const member = readByMember(pool);
  const people = !!shared && hasPeople(shared);
  return (
    <div className={`re-card pool-card${collapsed ? ' collapsed' : ''}`} data-pool={pool.id}>
      <div className="re-head">
        <button className="re-toggle" type="button" aria-expanded={!collapsed} onClick={onToggle}>
          <span className={`re-chev${collapsed ? '' : ' open'}`} aria-hidden="true">
            ▸
          </span>
          <PoolEngineMark pool={pool} />
          <span className="re-runner">{pool.label}</span>
          {people && <span className="re-chip pool-shared-chip">SHARED</span>}
          {/* A Codex pool its owner keeps to themselves says so, with how many of its accounts are left to
              run on; shared, it wears SHARED and its people instead. Somebody they added reads whose it
              is and what they can run on there — the pool's ChatGPT accounts and its keys alike. */}
          {member ? (
            <span className="re-summary">
              {poolOwner(shared!)?.name}’s · {pool.members.length} {memberNoun(pool, pool.members.length)}
            </span>
          ) : poolRunsCodex(pool) && !people ? (
            <span className="re-summary">Just me · {availabilityOf(pool, refusals)}</span>
          ) : (
            <Availability pool={pool} refusals={refusals} />
          )}
        </button>
        <span className="re-head-sp" />
        {people && !member && <PeopleStack pool={shared!} />}
        {!member && <PoolGauge pool={pool} />}
        <Link className="re-manage" to={`/providers/pools/${encodeId(pool.id)}`} aria-label={`Manage ${pool.label}`}>
          <span className="pool-wide">Manage </span>→
        </Link>
      </div>
      {!collapsed && (
        <PoolMembers pool={pool} refusals={refusals} keyActions={keyActions} loginActions={loginActions} />
      )}
    </div>
  );
}

/**
 * The Providers page's middle section: the user's account pools — several Claude subscriptions
 * under one name, each session starting on the one whose quota resets soonest, or a Codex pool of their own
 * that runs on their ChatGPT account — and the shared pools they are in, several people's OpenAI keys
 * under one name (sharedPoolAsProviderPool). Between the engines above (one machine's login) and the
 * keys below (what an account pool is made of), whose verdicts say which accounts a pool would no
 * longer admit (`refusals`, poolRefusals). Its head makes another pool of any kind (NewPoolModal); a key
 * OpenAI refused is replaced from its card, and an account OpenAI signed out is signed in again from
 * it — each taken out on the pool's own page.
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
  /** The dialog for one of these pools: adding an account, or putting back one OpenAI signed out. */
  const [signingIn, setSigningIn] = useState<{ pool: ProviderPool; login: CodexLogin | null } | null>(null);
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
          Several accounts under one name.
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
            loginActions={{ onSignIn: (login) => setSigningIn({ pool, login }) }}
          />
        );
      })}
      {creating && <NewPoolModal rows={rows} onClose={() => setCreating(false)} />}
      {replacing && (
        <ReplaceKeyModal pool={replacing.pool} poolKey={replacing.key} onClose={() => setReplacing(null)} />
      )}
      {signingIn && (
        <CodexSignInModal pool={signingIn.pool} login={signingIn.login} onClose={() => setSigningIn(null)} />
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
      message.error(pool ? "Couldn't add the account" : "Couldn't create the pool", e.message);
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
 * "New pool": the engine it runs, its name, and who can use it. A Codex pool for "Just me" runs on the
 * user's own ChatGPT account: it is theirs alone, and its accounts go in from "Add account" on its page,
 * whose dialog opens the moment the pool exists (migration 0323). Shared, a Codex pool holds OpenAI
 * API keys that each person pastes on its page once it exists: whoever makes it adds people by the email
 * of their Orbit account, and says whether they may put keys of their own in. A Claude pool is the
 * user's own Claude subscriptions, picked here the way "Create a pool" picks them.
 */
export function NewPoolModal({ rows, onClose }: { rows: ProviderRow[]; onClose: () => void }) {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [engine, setEngine] = useState<'claude' | 'codex'>('codex');
  const [who, setWho] = useState<'me' | 'people'>('me');
  // Untouched, the name follows the engine and who it is for.
  const [label, setLabel] = useState<string | null>(null);
  const name = label ?? (engine === 'claude' ? 'Claude accounts' : who === 'me' ? 'My Codex' : 'Codex keys');
  const [emails, setEmails] = useState<string[]>([]);
  // An address typed but not yet turned into a tag still counts.
  const [typing, setTyping] = useState('');
  const [canAdd, setCanAdd] = useState(true);
  const listed = accountPicks(rows);
  const [picked, setPicked] = useState<string[]>(() =>
    listed.filter((entry) => entry.ok).map((entry) => entry.row.id),
  );

  const create = useMutation({
    mutationFn: async (): Promise<{ id?: string; missed: string[]; signIn?: boolean }> => {
      if (engine === 'claude') {
        await api('/providers/pools', { method: 'POST', body: { label: name.trim(), providerIds: picked } });
        return { missed: [] };
      }
      if (who === 'me') {
        // Its one account goes in by signing in, on the page it opens to.
        const pool = await api<ProviderPool>('/providers/pools', {
          method: 'POST',
          body: { label: name.trim(), engine: 'codex' },
        });
        return { id: pool.id, missed: [], signIn: true };
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
    onSuccess: ({ id, missed, signIn }) => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      if (missed.length) message.warning(`Pool created — not added: ${missed.join(', ')}`);
      else message.success('Pool created');
      onClose();
      // Where its first key goes in — or where its account is signed in, straight away.
      if (id) navigate(`/providers/pools/${encodeId(id)}`, signIn ? { state: { signIn: true } } : undefined);
    },
    onError: (e: Error) => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      message.error("Couldn't create the pool", e.message);
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
          A Codex pool runs on your own ChatGPT account, or on OpenAI API keys when you share it. A
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
          <Radio.Group name="new-pool-who" value={who} onChange={(e) => setWho(e.target.value as 'me' | 'people')}>
            <Radio value="me">Just me</Radio>
            <Radio value="people">Me and people I add</Radio>
          </Radio.Group>
          {who === 'me' && (
            <div className="np-field-h">
              Sessions run on your own ChatGPT account — sign in with ChatGPT once the pool exists.
              Nobody else sees it.
            </div>
          )}
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
        on the one whose quota resets soonest, so none of it goes unused.
      </span>
      <Button size="small" type="primary" onClick={() => setOpen(true)}>
        Create a pool
      </Button>
      {open && <PoolAccountsModal rows={rows} onClose={() => setOpen(false)} />}
    </div>
  );
}
