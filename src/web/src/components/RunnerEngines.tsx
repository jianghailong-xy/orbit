import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, LoginOutlined } from '@ant-design/icons';
import {
  accountToStartOn,
  type InstallEngine,
  type LoginEngine,
  type PlanUsageSnapshot,
  type RunnerAccountRemoveState,
  type RunnerEngineAccount,
  type RunnerEngineHealth,
  type RunnerInstallState,
} from '@orbit/shared';
import { api } from '../api';
import { accountIsPaused, usePauseClock } from '../lib/accountPause';
import { AccountPauseActions, AccountPauseStatus } from './AccountPause';
import { routeId, encodeId } from '../lib/idCodec';
import {
  accountDir,
  accountNameOf,
  accountPlanUsage,
  defaultAccountName,
  engineKeepsAccounts,
} from '../lib/engineAccounts';
import {
  bindingPlanUsageRow,
  currentPlanUsageRows,
  planUsageSnapshotForProvider,
  type PlanUsageDisplayRow,
} from '../lib/planUsage';
import { formatResetTime } from '../lib/providerPools';
import { runnersQuery } from '../lib/queries';
import { ago, engineVersionNumber, updateNoteOf } from '../lib/runnerEngines';
import { ENGINE_PRESET } from '../lib/sessionProviderChoices';
import { useToast } from '../lib/toast';
import { ProviderTile } from './ProviderGallery';
import { ENGINE_NAME, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';

// Every engine a runner can sign into, in display order. Derived from ENGINE_NAME — a
// `Record<LoginEngine, …>` — so adding another login can't silently skip this page. Antigravity
// has an installation row of its own and never contributes to the signed-in summaries.
const ENGINES = Object.keys(ENGINE_NAME) as LoginEngine[];

// Which runner cards the user opened. Cards start folded — three engines per machine adds up
// fast, and a runner that is set up and quiet has nothing to say beyond its summary line — so
// this remembers the ones worth keeping open, like the sidebar's width.
const EXPANDED_KEY = 'orbit:providers-expanded-runners';

function readExpanded(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** What one row is saying. The install relay outranks the probe: it is newer than the last
 *  heartbeat, and it is the thing the user is currently watching. */
type RowKind =
  | 'in'
  | 'out'
  | 'unknown'
  | 'missing'
  | 'installing'
  | 'installed'
  | 'install-failed';

export function rowKindOf(
  health: RunnerEngineHealth | undefined,
  install: RunnerInstallState | null | undefined,
  engine: InstallEngine,
): RowKind {
  if (install?.engine === engine) {
    if (install.status === 'pending' || install.status === 'installing') return 'installing';
    // Both terminal outcomes only speak while the probe hasn't answered for itself: an install
    // slot records what one attempt reported, and the machine's actual state outranks it. A
    // failure the probe contradicts is a failure that stopped being true — the installer can
    // land a binary and still be judged failed (an install dir missing from the service PATH
    // does exactly that), and once a later probe finds it, insisting on the red panel leaves a
    // working engine looking broken until someone presses Dismiss.
    if (install.status === 'failed' && !health?.installed) return 'install-failed';
    // Finished, but the last heartbeat's probe still predates it. Saying "not installed" here
    // would offer to install what was just installed; the server clears this slot as soon as the
    // probe catches up, and the row then speaks from engine health again.
    if (install.status === 'done' && !health?.installed) return 'installed';
  }
  if (!health?.installed) return 'missing';
  if (health.auth === 'yes') return 'in';
  if (health.auth === 'no') return 'out';
  // The CLI wouldn't say. Never render this as signed in — that is the whole reason the probe
  // has three states instead of a boolean.
  return 'unknown';
}


const STATUS_TAG: Record<RowKind, { color: string; label: string }> = {
  in: { color: 'green', label: 'Signed in' },
  out: { color: 'orange', label: 'Signed out' },
  unknown: { color: 'default', label: 'Unknown' },
  missing: { color: 'default', label: 'Not installed' },
  installing: { color: 'blue', label: 'Installing…' },
  installed: { color: 'green', label: 'Installed' },
  'install-failed': { color: 'red', label: 'Install failed' },
};

/** An engine's version as a number — the name beside it already says which CLI it is, so
 *  `2.1.287 (Claude Code)` would say it twice — or the CLI's own name when it reported none. */
function versionOf(engine: LoginEngine, health?: RunnerEngineHealth): string {
  return health?.version ? engineVersionNumber(health.version) : engine;
}

/** The sub-line under an engine's name: what is on this machine, or what would be. */
function metaFor(kind: RowKind, engine: LoginEngine, health?: RunnerEngineHealth): string {
  if (kind === 'installing') return health?.installed ? 'Reinstalling' : 'Not installed yet';
  if (kind === 'installed') return 'Waiting for this runner to check in';
  if (!health?.installed) {
    // After a failed attempt the offer has already been made (and the panel below says how it
    // went), so this just states the fact.
    return kind === 'missing' ? 'Not installed — Orbit can install it here' : 'Not installed';
  }
  if (kind === 'unknown') return `${versionOf(engine, health)} · the CLI wouldn't say`;
  return versionOf(engine, health);
}

/** The sign-in panel a card holds open: an engine's own (keyed by the engine), one of its
 *  accounts', or the account being added — each engine's under its own prefix, so opening one
 *  account's panel never opens another engine's. */
const accountPanel = (engine: LoginEngine, id: string) => `${engine}/${id}`;
const addAccountPanel = (engine: LoginEngine) => `${engine}/+`;

/** An account's own answer, in the words a row speaks. */
function accountKindOf(account: RunnerEngineAccount): RowKind {
  if (account.auth === 'yes') return 'in';
  if (account.auth === 'no') return 'out';
  return 'unknown';
}

/**
 * The slots that turned out to hold an account already signed in above them: each such slot's id,
 * against the account it repeats.
 *
 * One account signed into two slots is two sign-ins of one quota, and the page would otherwise show
 * it as two rows of quota that have nothing to do with each other — so the repeat is worth saying,
 * and it is said on the later row: the list is in the order the sign-ins were made (Default first,
 * then each slot the runner added), so an account already seen above is the one this row repeats.
 *
 * A slot with no fingerprint is never a repeat. The runner reads fingerprints as it goes, an older
 * runner reports none at all, and an unread account is not evidence of a second copy of a read one.
 */
function duplicateAccounts(
  accounts: RunnerEngineAccount[],
): Map<string, RunnerEngineAccount> {
  const firstSeen = new Map<string, RunnerEngineAccount>();
  const repeats = new Map<string, RunnerEngineAccount>();
  for (const account of accounts) {
    const fingerprint = account.fingerprintPrefix;
    if (!fingerprint) continue;
    const first = firstSeen.get(fingerprint);
    if (first) repeats.set(account.id, first);
    else firstSeen.set(fingerprint, account);
  }
  return repeats;
}

/**
 * A CODEX_HOME the way a terminal spells it, with the machine's home directory as `~`. The page
 * can't ask that machine where its home is, so this reads the places a home directory lives; any
 * other path is shown whole, and the row always carries the full one on hover.
 */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/root|\/home\/[^/]+|\/Users\/[^/]+)(?=\/|$)/, '~');
}

/** The accounts a Codex row lists under itself: every one, once there is more than one — and only
 *  while the probe speaks for the engine, since an install under way is about the binary all of
 *  them share. None otherwise, which leaves the row exactly what it was before accounts. */
function accountRowsOf(
  engine: LoginEngine,
  health: RunnerEngineHealth | undefined,
  install: RunnerInstallState | null | undefined,
): RunnerEngineAccount[] {
  const accounts = engineKeepsAccounts(engine) ? (health?.accounts ?? []) : [];
  const kind = rowKindOf(health, install, engine);
  return accounts.length >= 2 && (kind === 'in' || kind === 'out' || kind === 'unknown')
    ? accounts
    : [];
}

/** Whether every sign-in an engine needs is in place. With several Codex accounts that is all of
 *  them: a folded card that called the machine signed in over a signed-out account would be
 *  hiding the one thing it exists to surface. */
function signedIn(health: RunnerEngineHealth): boolean {
  return (
    health.installed &&
    health.auth === 'yes' &&
    (health.accounts ?? []).every((account) => account.auth === 'yes')
  );
}

/** A login's quota as a row draws it: every window it reported, as it stands now — or none, for a
 *  login that is not signed in, whose last reading is about sessions that can no longer start. */
interface Quota {
  windows: PlanUsageDisplayRow[];
  /** "Usage as of 17:44 · 7h ago", once the reading is older than the runner's reads. */
  stale: string | null;
}

/** Older than this, a reading has missed three of the runner's reads (every 5 min with a session
 *  running, every 10 without, when any workspace there defaults to the engine) and is said to be as
 *  of then. Not that anything is wrong: an engine no workspace defaults to is read only while one of
 *  its sessions runs, so its idle reading is often this old. */
const STALE_QUOTA_MS = 30 * 60_000;

function quotaOf(kind: RowKind, snapshot: PlanUsageSnapshot | null, online: boolean, now: number): Quota {
  if (kind !== 'in' || !snapshot) return { windows: [], stale: null };
  const windows = currentPlanUsageRows(snapshot, now);
  const read = snapshot.fetchedAt;
  // An offline machine reads nothing, and the card already says it is offline: one note per row
  // would only repeat that.
  const stale =
    windows.length > 0 && online && read && now - Date.parse(read) > STALE_QUOTA_MS
      ? `Usage as of ${formatResetTime(read, now)} · ${ago(read, now)}`
      : null;
  return { windows, stale };
}

/** What a row's tag says: whether that login can run a session now — and if its quota is spent, when
 *  it can — in the words the account pools use for theirs. */
function statusOf(kind: RowKind, quota: Quota, now: number): { color: string; label: string } {
  const binding = bindingPlanUsageRow(quota.windows);
  // Signed in with nothing read: the sign-in is all there is to say.
  if (kind !== 'in' || !binding) return STATUS_TAG[kind];
  if (binding.window.utilization < 100) return { color: 'green', label: 'Available' };
  const resetsAt = binding.window.resetsAt;
  return { color: 'orange', label: resetsAt ? `Spent · resets ${formatResetTime(resetsAt, now)}` : 'Spent' };
}

/** Whether a login can take a session now: signed in, and no window of its spent. */
function available(kind: RowKind, quota: Quota): boolean {
  return kind === 'in' && (bindingPlanUsageRow(quota.windows)?.window.utilization ?? 0) < 100;
}

/** The quota column: each window with how much of it is used and when it resets, or why there is
 *  nothing to show. */
function QuotaCell({ kind, quota }: { kind: RowKind; quota: Quota }) {
  return (
    <div className="re-quota">
      {quota.windows.length > 0 ? (
        <>
          {quota.windows.map((row) => (
            <div key={row.key} className="re-window">
              {row.groupLabel && <div className="re-quota-head">{row.groupLabel}</div>}
              <div className="re-quota-head">
                <b>{row.label}</b>
                <span>{row.percent}%</span>
              </div>
              <div className={`runner-util ${row.nearLimit ? 'full' : ''}`}>
                <span className="runner-util-fill" style={{ width: `${row.percent}%` }} />
              </div>
              {row.window.resetsAt && (
                <div className="re-reset">resets {formatResetTime(row.window.resetsAt)}</div>
              )}
            </div>
          ))}
          {quota.stale && <div className="re-stale">{quota.stale}</div>}
        </>
      ) : (
        <span className="re-quota-none">
          {kind === 'in' ? 'No quota reported' : kind === 'out' ? 'Sign in to see quota' : '—'}
        </span>
      )}
    </div>
  );
}

/** Re-sign in, as a mark: a login that is in rarely needs it, and a word on every row read as
 *  something each of them needed doing. It is the last thing on its row, as Sign in is on a row that
 *  needs one, so the way back into every login on a card is one column down its right edge. */
function ResignIn({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <Button
      size="small"
      type="text"
      className="re-icon"
      icon={<LoginOutlined />}
      aria-label="Re-sign in"
      title="Re-sign in"
      disabled={disabled}
      onClick={onClick}
    />
  );
}

/** One engine on one runner: what it is, what state it's in, what it costs, and the way out. */
function EngineRow({
  runner,
  engine,
  health,
  accounts,
  signIn,
  onSignIn,
  focused,
}: {
  runner: Runner;
  engine: LoginEngine;
  health?: RunnerEngineHealth;
  /** The accounts listed under this row (accountRowsOf). Any at all make it their group's head. */
  accounts: RunnerEngineAccount[];
  /** The sign-in panel open on this runner, if any: an engine, or one of Codex's accounts. */
  signIn: string | null;
  onSignIn: (panel: string | null) => void;
  /** This is the row a deep link came here for: mark it and bring it into view. */
  focused?: boolean;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const kind = rowKindOf(health, runner.install, engine);
  const offline = !runner.online;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: 'center' });
  }, [focused]);

  const install = useMutation({
    mutationFn: () =>
      api(`/runners/${runner.id}/install`, { method: 'POST', body: { engine } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't start the install", e.message),
  });
  const dismissInstall = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });

  // Only one runtime's quota is this engine's; the others belong to the other rows.
  const single = engineKeepsAccounts(engine) && health?.accounts?.length === 1 ? health.accounts[0] : undefined;
  const now = usePauseClock(single?.pausedUntil);
  const snapshot = planUsageSnapshotForProvider(runner.planUsage, engine);
  const quota = quotaOf(kind, snapshot, !!runner.online, now);
  // More than one Codex account: this row heads their group, and each account is a row of its own
  // below it (AccountRow), with its own state.
  const grouped = accounts.length > 0;
  // What the head says for its group: how many of its accounts could take a session now.
  const ready = accounts.filter((account) => {
    const own = accountKindOf(account);
    return !accountIsPaused(account.pausedUntil, now) && available(own, quotaOf(own, accountPlanUsage(runner.planUsage, engine, account.id), !!runner.online, now));
  }).length;
  // "+ Account" is how a machine gets from one account to two, so it is not the group's to hold:
  // the Codex row offers it whenever the probe speaks for the engine, whether it heads a group yet
  // or not.
  const addsAccounts =
    engineKeepsAccounts(engine) && (kind === 'in' || kind === 'out' || kind === 'unknown');

  // An offline machine isn't updating anything, and the header already says so — repeating it
  // per row as a warning would put three alarms on one fact the user has already read.
  const note = kind === 'missing' ? null : updateNoteOf(health?.update);
  const warn = note?.tone === 'warn' && !offline;

  const action = () => {
    if (offline) {
      return kind === 'in' ? <ResignIn disabled onClick={() => {}} /> : <Button size="small" disabled>Sign in</Button>;
    }
    switch (kind) {
      case 'missing':
        return (
          <Button size="small" type="primary" loading={install.isPending} onClick={() => install.mutate()}>
            Install
          </Button>
        );
      case 'installing':
        return (
          <Button size="small" type="text" onClick={() => dismissInstall.mutate()}>
            Cancel
          </Button>
        );
      case 'install-failed':
        return (
          <Button size="small" loading={install.isPending} onClick={() => install.mutate()}>
            Retry
          </Button>
        );
      case 'in':
        return <ResignIn onClick={() => onSignIn(signIn === engine ? null : engine)} />;
      // Signed out, wouldn't say, or just installed. An install the probe hasn't caught up with yet
      // gets Sign in too: a CLI that was just installed has no sign-in, so that is what comes next,
      // and the runner only reports an install done once the binary is on its PATH — waiting for the
      // check-in first left the row with nothing to press for up to a heartbeat.
      default:
        return (
          <Button
            size="small"
            type="primary"
            onClick={() => onSignIn(signIn === engine ? null : engine)}
          >
            Sign in
          </Button>
        );
    }
  };

  return (
    <div className={`re-row${grouped ? ' re-grp' : ''}${focused ? ' focused' : ''}${accountIsPaused(single?.pausedUntil, now) ? ' account-paused' : ''}`} ref={row}>
      <div className="re-id">
        <ProviderTile slug={ENGINE_PRESET[engine]} label={ENGINE_NAME[engine]} size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name">{ENGINE_NAME[engine]}</div>
          <div className="re-meta">
            {grouped ? (
              <>
                {versionOf(engine, health)} ·{' '}
                <b>
                  {ready} of {accounts.length} accounts available
                </b>
              </>
            ) : (
              metaFor(kind, engine, health)
            )}
            {/* Whether this CLI is being kept current, next to what it currently is — the two
                halves of the same question, and useless apart. */}
            {/* The machine's own sentence, on hover. The line itself stays short enough to sit
                after a version string, and everything it had to leave out — which path, which
                owner, which error — is one pointer away instead of gone. Absent for a healthy
                engine, which has nothing further to say. */}
            {note && (
              <span className={`re-upd${warn ? ' warn' : ''}`} title={health?.update?.message}>
                {' '}
                · {note.text}
              </span>
            )}
          </div>
        </div>
      </div>
      {/* Signed in and quota are each account's, not the engine's: a group's head has no columns
          for them, and its line runs the width of the row instead. */}
      {!grouped && (
        <>
          <AccountPauseStatus until={single?.pausedUntil} now={now} detail={kind === 'in' ? 'Signed in' : undefined} status={statusOf(kind, quota, now)} />
          <QuotaCell kind={kind} quota={quota} />
        </>
      )}
      <div className="re-act">
        {addsAccounts && (
          <Button
            size="small"
            disabled={offline}
            onClick={() => onSignIn(signIn === addAccountPanel(engine) ? null : addAccountPanel(engine))}
          >
            + Account
          </Button>
        )}
        {/* A group's sign-ins are its accounts', each on its own row. */}
        {!grouped && single && (kind === 'in' || accountIsPaused(single.pausedUntil, now)) && (
          <AccountPauseActions name={accountNameOf(single)} until={single.pausedUntil} endpoint={`/runners/${runner.id}/accounts/${engine}/${single.id}/pause`} />
        )}
        {!grouped && action()}
      </div>

      {/* The relay panels. Each one is the row's own news, so it opens under the row it belongs
          to rather than as a page-level banner. */}
      {kind === 'installing' && (
        <div className="re-panel">
          <div className="re-panel-row">
            Installing {ENGINE_NAME[engine]} on {runner.displayName || runner.name}…
          </div>
          {runner.install?.command && <code className="re-cmd">{runner.install.command}</code>}
          <div className="re-panel-hint">
            {runner.install?.status === 'pending'
              ? 'The runner picks it up on its next check-in, so this can take up to a minute to start.'
              : 'You can leave this page — it keeps running on that machine.'}
          </div>
        </div>
      )}
      {kind === 'install-failed' && (
        <div className="re-panel bad">
          {/* The machine's own words. Without them a failed install is only fixable by opening a
              terminal on that box, which is exactly what this page exists to avoid. */}
          <div className="re-panel-row">{runner.install?.message || 'The installer failed.'}</div>
          {/* Labelled, because the message above usually ends in an alternative command — without
              this the two commands read as a pair with no way to tell which one already failed. */}
          {runner.install?.command && (
            <div className="re-panel-hint">
              Orbit ran <code className="re-cmd">{runner.install.command}</code>
            </div>
          )}
          <div className="re-panel-hint">
            <button className="re-link" type="button" onClick={() => dismissInstall.mutate()}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {/* Drifted, and not for a reason this page can name. The machine's own words are the only
          actionable thing here — an EACCES on someone else's global prefix isn't guessable, and
          no button on this page can fix it, which is why this is a explanation and not a Retry. */}
      {warn && (
        <div className="re-panel warn">
          <div className="re-panel-row">
            {health?.update?.message || `Orbit hasn't managed to update ${ENGINE_NAME[engine]} here.`}
          </div>
          {/* Points at the machine rather than naming a shell command: that is where updating
              lives now, and telling someone to open a terminal for something the UI can do was
              only ever a symptom of the button being on the wrong page. */}
          <div className="re-panel-hint">
            Orbit tries every 30 min.{' '}
            <Link to={`/runners/${encodeId(runner.id)}`}>Update this machine’s engines →</Link>
          </div>
        </div>
      )}
      {signIn === engine && (
        <div className="re-panel">
          <RunnerSignIn runnerId={runner.id} engine={engine} />
        </div>
      )}
      {addsAccounts && signIn === addAccountPanel(engine) && (
        <div className="re-panel">
          <AddEngineAccount
            engine={engine}
            runnerId={runner.id}
            accounts={health?.accounts ?? []}
            onClose={() => onSignIn(null)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * An account's name on its row, and the way to change it — Default's too, which the machine never
 * names. The pencil after it, or a double-click on it, swaps it for the session title's own editor
 * (WorkspaceView): everything selected, Enter or a click elsewhere saves, Escape drops the draft, and
 * an empty or unchanged one changes nothing. Only a label, kept in Orbit (RunnersService.renameAccount):
 * nothing on the machine changes, so it works with the runner offline.
 */
function AccountName({
  runner,
  engine,
  account,
  next,
}: {
  runner: Runner;
  engine: LoginEngine;
  account: RunnerEngineAccount;
  next?: boolean;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Escape blurs the input too; this tells that blur not to save.
  const cancelled = useRef(false);
  // The input hugs its text, measured off an unseen twin, as the session title's does.
  const mirror = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (editing) setWidth((mirror.current?.offsetWidth ?? 0) + 2);
  }, [editing, draft]);
  const rename = useMutation({
    mutationFn: (name: string) =>
      api<RunnerEngineAccount>(`/runners/${runner.id}/accounts/${engine}/${account.id}`, {
        method: 'PATCH',
        body: { name },
      }),
    // Returned, so the new name stays on the row until the list carries it rather than flicking back.
    onSuccess: () => qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't rename the account", e.message),
  });
  const shown = rename.isPending ? (rename.variables ?? accountNameOf(account)) : accountNameOf(account);
  // Default named something else says what it still is: the login this machine's own environment
  // selects, which a terminal shares — and which signing in there changes.
  const renamedDefault = account.id === 'default' && shown !== 'Default';
  const start = () => {
    setDraft(shown);
    setEditing(true);
  };

  if (editing) {
    return (
      <>
        <span ref={mirror} className="re-name-mirror" aria-hidden="true">
          {draft || ' '}
        </span>
        <input
          className="re-name-input"
          style={{ width }}
          autoFocus
          value={draft}
          maxLength={60}
          aria-label={`Rename ${shown}`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            // Select all (typing replaces it), with the caret at the start so a long name shows its head.
            const el = e.currentTarget;
            el.setSelectionRange(0, el.value.length, 'backward');
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // let the IME (e.g. pinyin) keep Enter
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            setEditing(false);
            if (cancelled.current) {
              cancelled.current = false;
              return;
            }
            const name = draft.trim();
            if (name && name !== shown) rename.mutate(name);
          }}
        />
      </>
    );
  }
  return (
    <div className="re-name" onDoubleClick={start}>
      <span className="re-name-text">{shown}</span>
      {renamedDefault && <span className="re-chip">DEFAULT</span>}
      {/* Where Automatic starts the next session — the account pools' mark for the same thing. */}
      {next && (
        <span className="re-chip" title="Automatic starts new sessions here">
          NEXT
        </span>
      )}
      <button type="button" className="re-rename" aria-label="Rename" title="Rename" onClick={start}>
        <EditOutlined />
      </button>
    </div>
  );
}

/** One Codex account, under its engine's row: its name (AccountName), where it lives on the machine,
 *  its own sign-in state, its own way back in, and — for every account but Default — the way off
 *  this machine. */
function AccountRow({
  runner,
  engine,
  account,
  defaultName,
  next,
  duplicateOf,
  lastOfGroup,
  signIn,
  onSignIn,
}: {
  runner: Runner;
  /** The engine this account belongs to: its own sign-in panel, its own removal, its own quota. */
  engine: LoginEngine;
  account: RunnerEngineAccount;
  /** What this engine's Default is called here — where a removed account's workspaces go. */
  defaultName: string;
  /** The account a session nobody picked one for starts on next (accountToStartOn). */
  next?: boolean;
  /** The account already signed in above that this slot turned out to hold too
   *  (duplicateAccounts). Absent for the slot that made the sign-in. */
  duplicateOf?: RunnerEngineAccount;
  /** The last account under this engine: where the rail's spine ends rather than carrying on to a
   *  row that isn't there (.re-acct-end). */
  lastOfGroup?: boolean;
  signIn: string | null;
  onSignIn: (panel: string | null) => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const kind = accountKindOf(account);
  const isDefault = account.id === 'default';
  const panel = accountPanel(engine, account.id);
  // What became of the last removal asked for here, if it was this account's of this engine's: the
  // button says it is under way, and a machine that refused says why.
  const removal = runner.accountRemove;
  const mine = removal?.engine === engine && removal.account === account.id ? removal : null;
  const removing = mine?.status === 'pending';
  const refused = mine?.status === 'failed' ? mine.message : null;
  const remove = useMutation({
    mutationFn: () =>
      api<RunnerAccountRemoveState>(
        `/runners/${runner.id}/accounts/${engine}/${account.id}`,
        { method: 'DELETE' },
      ),
    onSuccess: (state) => {
      // A refusal the control plane could make itself (an older runner, or the account that is the
      // machine's own CODEX_HOME) arrives as an error; anything the machine decided arrives here.
      if (state?.status === 'failed' && state.message) message.error("Couldn't remove the account", state.message);
      void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    },
    onError: (e: Error) => message.error("Couldn't remove the account", e.message),
  });
  // Each account's quota is its own: the runner reads every account in that account's CODEX_HOME,
  // and an account it has not read shows none rather than borrowing another's limit.
  const now = usePauseClock(account.pausedUntil);
  const snapshot = accountPlanUsage(runner.planUsage, engine, account.id);
  const quota = quotaOf(kind, snapshot, !!runner.online, now);
  const toggle = () => onSignIn(signIn === panel ? null : panel);
  // Removing deletes the slot's sign-in from the machine, and only signing in again brings it back:
  // asked first, wherever it is offered.
  const confirmRemove = (trigger: ReactNode) => (
    <Popconfirm
      title={`Remove ${accountNameOf(account)}?`}
      description={
        `Its sign-in is deleted from ${runner.displayName || runner.name}. ` +
        `Workspaces set to this account run on ${defaultName}.`
      }
      okText="Remove"
      okButtonProps={{ danger: true }}
      onConfirm={() => remove.mutate()}
    >
      {trigger}
    </Popconfirm>
  );

  return (
    <div className={`re-row re-acct${lastOfGroup ? ' re-acct-end' : ''}${accountIsPaused(account.pausedUntil, now) ? ' account-paused' : ''}`}>
      <div className="re-id">
        <span className="re-rail" aria-hidden="true" />
        <div className="re-id-main" style={{ minWidth: 0 }}>
          <AccountName runner={runner} engine={engine} account={account} next={next} />
          {/* Where the account lives and which one it is — never who: the account's email and id
              stay on the machine, and the fingerprint is a prefix of a non-reversible one. */}
          <div className="re-meta" title={accountDir(account)}>
            {tildePath(accountDir(account))}
            {account.fingerprintPrefix && ` · account ${account.fingerprintPrefix}…`}
          </div>
        </div>
      </div>
      <AccountPauseStatus until={account.pausedUntil} now={now} detail={kind === 'in' ? 'Signed in' : undefined} status={statusOf(kind, quota, now)} />
      <QuotaCell kind={kind} quota={quota} />
      <div className="re-act">
        {(kind === 'in' || accountIsPaused(account.pausedUntil, now)) && <AccountPauseActions name={accountNameOf(account)} until={account.pausedUntil} endpoint={`/runners/${runner.id}/accounts/${engine}/${account.id}/pause`} />}
        {/* Default has nothing to remove: it is the CODEX_HOME the machine's own environment
            selects, the one `codex` typed in a terminal shares. Every other account is a slot this
            runner added, and this is the way back off the machine — the one thing the page could
            not do before, which left whoever signed one in twice with a directory to delete by
            hand. A grey mark until pointed at, like the account pools' sign-out: red on a row that
            is fine reads as something wrong with it. */}
        {!isDefault &&
          confirmRemove(
            <Button
              size="small"
              type="text"
              danger
              className="re-icon re-remove"
              icon={<DeleteOutlined />}
              aria-label="Remove"
              title="Remove"
              disabled={!runner.online || removing}
              loading={removing}
            />,
          )}
        {kind === 'in' ? (
          <ResignIn disabled={!runner.online} onClick={toggle} />
        ) : (
          <Button size="small" type={runner.online ? 'primary' : 'default'} disabled={!runner.online} onClick={toggle}>
            Sign in
          </Button>
        )}
      </div>
      {/* The same account, signed in twice. Two rows of quota for one account read as two quotas,
          so the repeat is named on the row that made it — with the one way out right there: this
          slot's CODEX_HOME and the record beside it go, and the other sign-in is untouched. */}
      {duplicateOf && (
        <div className="re-dup">
          <span>
            This is the same account as <b>{accountNameOf(duplicateOf)}</b> — signing in twice does
            not double the quota.
          </span>
          {confirmRemove(
            <button className="re-link" type="button" disabled={!runner.online || removing}>
              Remove
            </button>,
          )}
        </div>
      )}
      {/* The machine would not do it, and its reason is the only thing that can explain why: a
          session is running on that account, or the runner is too old to remove one at all. */}
      {refused && (
        <div className="re-panel bad">
          <div className="re-panel-row">{refused}</div>
          <div className="re-panel-hint">
            {tildePath(accountDir(account))} on {runner.displayName || runner.name} is untouched.
          </div>
        </div>
      )}
      {signIn === panel && (
        <div className="re-panel">
          <RunnerSignIn runnerId={runner.id} engine={engine} account={account.id} />
        </div>
      )}
    </div>
  );
}

/**
 * "+ Account": the same sign-in flow as every other here, started the moment the panel opens, under
 * a name the page picks (defaultAccountName). The runner gives the account a config directory of its
 * own, so Default — and the CLI in a terminal — is untouched.
 *
 * The name stays editable throughout, and Enter or a click elsewhere saves it the way a row's rename
 * does (AccountName). That rename can only name an account the runner reports, which a new one is
 * once it is signed in, so a name saved before then waits here for it — and a panel closed first
 * leaves the account the name it was added under, for its row's rename to change.
 *
 * Once that account is signed in, reported and named, the panel folds itself away: what it added is
 * that account's own row, and the row's pencil is where its name changes from then on.
 */
function AddEngineAccount({
  engine,
  runnerId,
  accounts,
  onClose,
}: {
  engine: LoginEngine;
  runnerId: string;
  /** Every account the runner reports for this engine, Default included. */
  accounts: RunnerEngineAccount[];
  /** Fold the panel away: its own Cancel, and the moment the account it added is done. */
  onClose: () => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const [picked] = useState(() => defaultAccountName(accounts));
  const [name, setName] = useState(picked);
  // The accounts the runner had when the panel opened. The one this sign-in adds is the newest it
  // reports that is not among them: the runner lists added accounts in the order they were made.
  const [had] = useState(() => new Set(accounts.map((account) => account.id)));
  const added = accounts.filter((account) => !had.has(account.id)).at(-1);
  // A name saved before the runner reported the account it is for.
  const [waiting, setWaiting] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const rename = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api<RunnerEngineAccount>(`/runners/${runnerId}/accounts/${engine}/${id}`, {
        method: 'PATCH',
        body: { name: to },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    // Not returned: an error toast stays until dismissed, and a mutation awaits what onError returns,
    // so returning it would hold the rename pending — and the panel waiting on it — until then.
    onError: (e: Error) => {
      message.error("Couldn't rename the account", e.message);
    },
  });
  const save = () => {
    const to = name.trim();
    // An empty name changes nothing, as on a row: the field goes back to the name the account has.
    if (!to) setName(added ? accountNameOf(added) : (waiting ?? picked));
    else if (!added) setWaiting(to);
    else if (to !== accountNameOf(added)) rename.mutate({ id: added.id, to });
  };
  const addedId = added?.id;
  const addedName = added && accountNameOf(added);
  useEffect(() => {
    if (!addedId || waiting === null) return;
    setWaiting(null);
    if (waiting !== addedName) rename.mutate({ id: addedId, to: waiting });
  }, [addedId, addedName, waiting, rename.mutate]);
  // Done: the account is signed in by the runner's own word, and carries the name in the field. Not
  // while that name is still being typed or saved — a rename that failed leaves it differing, and the
  // panel open — and never after a sign-in that failed or was cancelled, which reports no such account.
  const finished =
    added?.auth === 'yes' &&
    !focused &&
    waiting === null &&
    !rename.isPending &&
    name.trim() === addedName;
  useEffect(() => {
    if (finished) onClose();
  }, [finished, onClose]);

  return (
    <>
      <label className="re-add">
        <span className="re-add-label">Account name</span>
        <input
          className="rsi-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            save();
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // let the IME (e.g. pinyin) keep Enter
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          placeholder="Work"
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <RunnerSignIn runnerId={runnerId} engine={engine} accountName={name} autoStart onCancel={onClose} />
    </>
  );
}

/** What a collapsed card says in one line, so folding a runner away never hides a problem. */
export function summaryOf(runner: Runner): string {
  const relay = runner.install?.engine === 'antigravity' ? null : runner.install;
  const updating = relay?.mode === 'update';
  if (relay?.status === 'failed') return updating ? 'Update failed' : 'Install failed';
  if (relay?.status === 'pending' || relay?.status === 'installing') {
    return updating ? 'Updating…' : 'Installing…';
  }
  if (!runner.engines) return 'Engines not reported';
  // Only the engines this card actually renders. A runner reports every CLI on the machine,
  // OpenCode included, but a summary that counted those would put a problem on a folded card
  // that unfolding never reveals — the row it refers to isn't on this page.
  const shown = runner.engines.filter((e) => ENGINES.some((engine) => engine === e.engine));
  // An engine nothing has updated in a week is exactly the kind of quiet drift folding a card
  // would otherwise bury — it outranks the sign-in count, which is the good news.
  const stale = shown.filter((e) => e.installed && updateNoteOf(e.update)?.tone === 'warn').length;
  if (stale && runner.online) {
    return stale === 1 ? '1 engine not updating' : `${stale} engines not updating`;
  }
  const ready = shown.filter(signedIn).length;
  return ready === ENGINES.length ? 'All signed in' : `${ready} of ${ENGINES.length} signed in`;
}

/** Gemini uses a key, so this CLI reports installation readiness rather than sign-in or quota. */
function AntigravityRow({ runner, focused }: { runner: Runner; focused?: boolean }) {
  const qc = useQueryClient();
  const message = useToast();
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  const state = runner.antigravity;
  const health = runner.engines?.find((engine) => engine.engine === 'antigravity');
  const installed = state ? state.installed : health?.installed;
  const unsupported = state?.supported === false;
  const kind = rowKindOf(
    installed == null ? undefined : { engine: 'antigravity', installed, auth: 'yes' },
    runner.install,
    'antigravity',
  );
  const tag = unsupported
    ? { color: 'orange', label: 'Update runner' }
    : kind === 'in'
      ? { color: 'green', label: 'Ready' }
      : installed == null && kind === 'missing'
        ? { color: 'default', label: 'Unknown' }
        : STATUS_TAG[kind];
  const meta = unsupported
    ? 'Needs Orbit runner 0.1.209+ — updates itself when idle'
    : kind === 'in'
      ? engineVersionNumber(state?.version ?? health?.version ?? '') || 'Installed'
      : kind === 'installed'
        ? 'Waiting for this runner to check in'
        : installed == null && kind === 'missing'
          ? 'This runner hasn’t reported Antigravity CLI yet'
          : 'Not installed — Orbit can install it here';
  const install = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/install`, { method: 'POST', body: { engine: 'antigravity' } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't start the install", e.message),
  });
  const dismiss = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });
  return (
    <div className={`re-row${focused ? ' focused' : ''}`} ref={row} data-engine="antigravity">
      <div className="re-id">
        <ProviderTile slug="antigravity" label="Antigravity CLI" size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name">Antigravity CLI</div>
          <div className="re-meta" style={{ whiteSpace: 'normal' }}>{meta}</div>
        </div>
      </div>
      <Tag color={tag.color}>{tag.label}</Tag>
      <div className="re-quota" style={{ color: 'var(--text-3)', fontSize: 11 }}>
        No sign-in · runs on your Gemini key
      </div>
      <div className="re-act">
        {!unsupported && installed != null && kind === 'missing' && (
          <Button size="small" type="primary" disabled={!runner.online} loading={install.isPending} onClick={() => install.mutate()}>Install</Button>
        )}
        {!unsupported && kind === 'installing' && (
          <Button size="small" type="text" onClick={() => dismiss.mutate()}>Cancel</Button>
        )}
        {!unsupported && kind === 'install-failed' && (
          <Button size="small" disabled={!runner.online} loading={install.isPending} onClick={() => install.mutate()}>Retry</Button>
        )}
      </div>
      {!unsupported && kind === 'installing' && (
        <div className="re-panel">
          <div className="re-panel-row">Installing Antigravity CLI on {runner.displayName || runner.name}…</div>
          {runner.install?.command && <code className="re-cmd">{runner.install.command}</code>}
          <div className="re-panel-hint">You can leave this page — it keeps running on that machine.</div>
        </div>
      )}
      {!unsupported && kind === 'install-failed' && (
        <div className="re-panel bad">
          <div className="re-panel-row">{runner.install?.message || 'The installer failed.'}</div>
          {runner.install?.command && <code className="re-cmd">{runner.install.command}</code>}
          <button className="re-link" type="button" onClick={() => dismiss.mutate()}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

function RunnerEngineCard({
  runner,
  collapsed,
  onToggle,
  focusEngine,
}: {
  runner: Runner;
  collapsed: boolean;
  onToggle: () => void;
  /** The engine a deep link named for this runner, if this is the runner it named. */
  focusEngine?: InstallEngine | null;
}) {
  const [signIn, setSignIn] = useState<string | null>(null);
  const engines = runner.engines ?? null;

  return (
    <div className={`re-card re-runner-card${runner.online ? '' : ' offline'}${collapsed ? ' collapsed' : ''}`}>
      <div className="re-head">
        {/* The toggle is its own button rather than the whole header: the header also holds a
            link, and a link inside a button is neither valid nor operable by keyboard. */}
        <button
          className="re-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className={`re-chev${collapsed ? '' : ' open'}`} aria-hidden="true">
            ▸
          </span>
          <span className={`re-dot${runner.online ? ' on' : ''}`} />
          <span className="re-runner">{runner.displayName || runner.name}</span>
          <span className="re-runner-meta">
            {[runner.hostname, runner.version && `runner ${runner.version}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {collapsed && <span className="re-summary">{summaryOf(runner)}</span>}
        </button>
        <span className="re-head-sp" />
        {!runner.online && <Tag>Offline</Tag>}
        {/* Updating the engine CLIs is not here, on purpose. It takes no engine — it does every
            CLI on the machine — so its object is the runner, and this is a page about identity
            where everything else is scoped to one (runner, engine) pair. It lives behind this
            link, next to the machine's own version and slots. */}
        <Link className="re-manage" to={`/runners/${encodeId(runner.id)}`}>
          Manage runner →
        </Link>
      </div>
      {collapsed ? null : engines ? (
        ENGINES.map((engine) => {
          const health = engines.find((e) => e.engine === engine);
          const accounts = accountRowsOf(engine, health, runner.install);
          // Read across the whole group, since a repeat is a fact about two of its rows.
          const repeats = duplicateAccounts(accounts);
          // The same question the server asks when a session starts with no account picked.
          const next =
            (engine === 'claude' || engine === 'codex') && accounts.length > 0
              ? accountToStartOn(engine, accounts, runner.planUsage, new Date())
              : null;
          return (
            <Fragment key={engine}>
              <EngineRow
                runner={runner}
                engine={engine}
                health={health}
                accounts={accounts}
                signIn={signIn}
                onSignIn={setSignIn}
                focused={engine === focusEngine}
              />
              {accounts.map((account, index) => (
                <AccountRow
                  key={account.id}
                  runner={runner}
                  engine={engine}
                  account={account}
                  defaultName={accountNameOf(accounts.find((entry) => entry.id === 'default') ?? { id: 'default' })}
                  next={account.id === next}
                  duplicateOf={repeats.get(account.id)}
                  lastOfGroup={index === accounts.length - 1}
                  signIn={signIn}
                  onSignIn={setSignIn}
                />
              ))}
            </Fragment>
          );
        })
      ) : (
        // Never three rows of "Unknown": this runner hasn't told us anything, which is a
        // different fact from "nothing is installed" and has a different fix.
        <div className="re-unreported">
          This runner hasn&apos;t reported its engines yet. Update it to the latest version — an
          older runner can&apos;t be signed in or installed from here.
        </div>
      )}
      {!collapsed && <AntigravityRow runner={runner} focused={focusEngine === 'antigravity'} />}
    </div>
  );
}

/**
 * The Providers page's first section: the engine CLIs signed in on the user's own machines.
 *
 * These are a different kind of identity from the API keys below — they live on one machine and
 * spend the subscription signed into there, rather than on the account and billed per token — so
 * they get their own section rather than extra rows in the same table.
 */
export function RunnerEngines() {
  const [expanded, setExpanded] = useState<string[]>(readExpanded);
  const write = (next: string[]) => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
    } catch {
      // Private mode / full quota: the fold still works, it just won't outlive the page.
    }
    return next;
  };
  const toggle = (id: string) =>
    setExpanded((prev) => write(prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Where a "Not signed in" row in the new-session picker sends the user: this exact engine on
  // this exact machine. Cards start folded, so the one row they came for is exactly what's
  // hidden — arriving opens that card, and the open sticks, because it is the same edit they'd
  // have made by hand.
  const [params] = useSearchParams();
  const focusRunner = routeId(params.get('runner'));
  const engineParam = params.get('engine');
  const focusEngine: InstallEngine | null = engineParam === 'antigravity' ? 'antigravity' : ENGINES.find((e) => e === engineParam) ?? null;
  useEffect(() => {
    if (!focusRunner) return;
    setExpanded((prev) => (prev.includes(focusRunner) ? prev : write([...prev, focusRunner])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRunner]);
  const runners = useQuery({
    ...runnersQuery(),
    // An install is minutes long and its progress lives on the runner row, so poll while one is
    // in flight; otherwise this is heartbeat-paced data and doesn't need chasing. `done` counts
    // as in flight: the row is still waiting for the probe that retires it.
    refetchInterval: (q) =>
      (q.state.data as Runner[] | undefined)?.some(
        (r) =>
          r.install?.status === 'pending' ||
          r.install?.status === 'installing' ||
          // A finished install is still in flight to the UI — it waits for the probe that
          // retires it. A finished update isn't: its summary is terminal and stays until
          // dismissed, so polling on it would never stop.
          (r.install?.status === 'done' && r.install?.mode !== 'update') ||
          // Same for an account removal: the machine answers on its next check-in, and the page
          // has to be there to take the answer — a refusal is news the person who pressed it has
          // to see, and the row it is about leaves once the probe catches up.
          r.accountRemove?.status === 'pending',
      )
        ? 4000
        : false,
  });
  const list = (runners.data ?? []) as Runner[];
  // Counted over the engines this section renders, not everything the runner reports: a machine
  // reports every CLI on it, and a count that included one without a row here would never add up
  // against what the page shows.
  const ready = list.reduce(
    (n, r) =>
      n +
      (r.engines ?? []).filter(
        (e) => signedIn(e) && ENGINES.some((engine) => engine === e.engine),
      ).length,
    0,
  );

  return (
    <div className="re-sec">
      <div className="re-sec-head">
        <h3>On your runners</h3>
        <span className="re-sec-sub">
          Signed in on the machine itself — a session spends that subscription, nothing to paste.
          {/* Said once, here, because it is the answer to a question every row raises and none
              of them can answer alone: a version number can't tell you it's the current one. */}
          {list.length > 0 && ' Orbit keeps these CLIs updated every 30 min.'}
        </span>
        {list.length > 0 && (
          <span className="re-sec-count">
            {list.length} runner{list.length === 1 ? '' : 's'} · {ready} signed in
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <div className="re-empty">
          <div className="re-empty-logos">
            {ENGINES.map((engine) => (
              <ProviderTile
                key={engine}
                slug={ENGINE_PRESET[engine]}
                label={ENGINE_NAME[engine]}
                size={44}
              />
            ))}
          </div>
          <h4>Already pay for Claude, Codex or Kimi?</h4>
          <p>
            Add a runner and sign its CLIs in — your workspaces then run on the subscription you
            already have, with no API key.
          </p>
          <Link to="/runners">
            <Button>Add a runner</Button>
          </Link>
        </div>
      ) : (
        list.map((runner) => (
          <RunnerEngineCard
            key={runner.id}
            runner={runner}
            collapsed={!expanded.includes(runner.id)}
            onToggle={() => toggle(runner.id)}
            focusEngine={runner.id === focusRunner ? focusEngine : null}
          />
        ))
      )}
    </div>
  );
}
