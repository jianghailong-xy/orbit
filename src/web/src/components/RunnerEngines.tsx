import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Tag } from 'antd';
import type {
  LoginEngine,
  RunnerCodexAccountRemoveState,
  RunnerEngineAccount,
  RunnerEngineHealth,
  RunnerInstallState,
} from '@orbit/shared';
import { api } from '../api';
import { routeId, encodeId } from '../lib/idCodec';
import { codexAccountPlanUsage, planUsageRows, planUsageSnapshotForProvider } from '../lib/planUsage';
import { runnersQuery } from '../lib/queries';
import { updateNoteOf } from '../lib/runnerEngines';
import { ENGINE_PRESET } from '../lib/sessionProviderChoices';
import { useToast } from '../lib/toast';
import { ProviderTile } from './ProviderGallery';
import { ENGINE_NAME, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';

// Every engine a runner can sign into, in display order. Derived from ENGINE_NAME — a
// `Record<LoginEngine, …>` — so adding a fourth engine can't silently skip this page.
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
  engine: LoginEngine,
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

/** The sub-line under an engine's name: what is on this machine, or what would be. */
function metaFor(kind: RowKind, engine: LoginEngine, health?: RunnerEngineHealth): string {
  if (kind === 'installing') return health?.installed ? 'Reinstalling' : 'Not installed yet';
  if (kind === 'installed') return 'Waiting for this runner to check in';
  if (!health?.installed) {
    // After a failed attempt the offer has already been made (and the panel below says how it
    // went), so this just states the fact.
    return kind === 'missing' ? 'Not installed — Orbit can install it here' : 'Not installed';
  }
  if (kind === 'unknown') return `${engine} ${health.version ?? ''} · the CLI wouldn't say`.trim();
  return health.version ? `${engine} ${health.version}` : engine;
}

/** The sign-in panel a card holds open: an engine's own (keyed by the engine), one Codex
 *  account's, or the account being added. */
const accountPanel = (id: string) => `codex/${id}`;
const ADD_ACCOUNT_PANEL = 'codex/+';

/** An account's own answer, in the words a row speaks. */
function accountKindOf(account: RunnerEngineAccount): RowKind {
  if (account.auth === 'yes') return 'in';
  if (account.auth === 'no') return 'out';
  return 'unknown';
}

/** What a row calls an account: Default, what the user named the slot, or the slot's own id when
 *  the name it was added under is gone. */
function accountNameOf(account: RunnerEngineAccount): string {
  if (account.id === 'default') return 'Default';
  return account.name || `Account ${account.id}`;
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
  const accounts = engine === 'codex' ? (health?.accounts ?? []) : [];
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

type Quota = ReturnType<typeof planUsageRows>[number];

/** The quota column: the plan's nearest limit, or why there isn't one to show. */
function QuotaCell({ kind, quota }: { kind: RowKind; quota: Quota | null }) {
  return (
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
        <span className="re-quota-none">
          {kind === 'in' ? 'No quota reported' : kind === 'out' ? 'Sign in to see quota' : '—'}
        </span>
      )}
    </div>
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
    onError: (e: Error) => message.error(e.message || 'Could not start the install'),
  });
  const dismissInstall = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });

  // Only one runtime's quota is this engine's; the others belong to the other rows.
  const snapshot = planUsageSnapshotForProvider(runner.planUsage, engine);
  const quota = kind === 'in' && snapshot ? planUsageRows(snapshot)[0] : null;
  // More than one Codex account: this row heads their group, and each account is a row of its own
  // below it (AccountRow), with its own state.
  const grouped = accounts.length > 0;

  // An offline machine isn't updating anything, and the header already says so — repeating it
  // per row as a warning would put three alarms on one fact the user has already read.
  const note = kind === 'missing' ? null : updateNoteOf(health?.update);
  const warn = note?.tone === 'warn' && !offline;

  const action = () => {
    if (offline) return <Button size="small" disabled>Sign in</Button>;
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
      // Nothing to press until the probe lands and says whether it needs signing in.
      case 'installed':
        return null;
      case 'in':
        return (
          <Button size="small" type="text" onClick={() => onSignIn(signIn === engine ? null : engine)}>
            Re-sign in
          </Button>
        );
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
    <div className={`re-row${grouped ? ' re-grp' : ''}${focused ? ' focused' : ''}`} ref={row}>
      <div className="re-id">
        <ProviderTile slug={ENGINE_PRESET[engine]} label={ENGINE_NAME[engine]} size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name">{ENGINE_NAME[engine]}</div>
          <div className="re-meta">
            {grouped ? (
              <>
                {health?.version ? `${engine} ${health.version}` : engine} ·{' '}
                <b>{accounts.length} accounts</b>
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
      {grouped ? (
        // Signed in and quota are each account's, not the engine's: the group's own columns stay
        // empty rather than speak for one of its accounts.
        <>
          <div />
          <div className="re-quota" />
          <div className="re-act">
            <Button
              size="small"
              disabled={offline}
              onClick={() => onSignIn(signIn === ADD_ACCOUNT_PANEL ? null : ADD_ACCOUNT_PANEL)}
            >
              + Account
            </Button>
          </div>
        </>
      ) : (
        <>
          <div>
            <Tag color={STATUS_TAG[kind].color}>{STATUS_TAG[kind].label}</Tag>
          </div>
          <QuotaCell kind={kind} quota={quota} />
          <div className="re-act">{action()}</div>
        </>
      )}

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
      {grouped && signIn === ADD_ACCOUNT_PANEL && (
        <div className="re-panel">
          <AddCodexAccount runnerId={runner.id} onCancel={() => onSignIn(null)} />
        </div>
      )}
    </div>
  );
}

/** One Codex account, under its engine's row: its name, where it lives on the machine, its own
 *  sign-in state, its own way back in, and — for every account but Default — the way off this
 *  machine. */
function AccountRow({
  runner,
  account,
  duplicateOf,
  signIn,
  onSignIn,
}: {
  runner: Runner;
  account: RunnerEngineAccount;
  /** The account already signed in above that this slot turned out to hold too
   *  (duplicateAccounts). Absent for the slot that made the sign-in. */
  duplicateOf?: RunnerEngineAccount;
  signIn: string | null;
  onSignIn: (panel: string | null) => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const kind = accountKindOf(account);
  const isDefault = account.id === 'default';
  const panel = accountPanel(account.id);
  // What became of the last removal asked for here, if it was this account's: the button says it
  // is under way, and a machine that refused says why.
  const removal = runner.codexAccountRemove;
  const mine = removal?.account === account.id ? removal : null;
  const removing = mine?.status === 'pending';
  const refused = mine?.status === 'failed' ? mine.message : null;
  const remove = useMutation({
    mutationFn: () =>
      api<RunnerCodexAccountRemoveState>(
        `/runners/${runner.id}/codex-accounts/${account.id}`,
        { method: 'DELETE' },
      ),
    onSuccess: (state) => {
      // A refusal the control plane could make itself (an older runner, or the account that is the
      // machine's own CODEX_HOME) arrives as an error; anything the machine decided arrives here.
      if (state?.status === 'failed' && state.message) message.error(state.message);
      void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    },
    onError: (e: Error) => message.error(e.message || 'Could not remove the account'),
  });
  // Each account's quota is its own: the runner reads every account in that account's CODEX_HOME,
  // and an account it has not read shows none rather than borrowing another's limit.
  const snapshot = codexAccountPlanUsage(runner.planUsage, account.id);
  const quota = kind === 'in' && snapshot ? planUsageRows(snapshot)[0] : null;
  const toggle = () => onSignIn(signIn === panel ? null : panel);

  return (
    <div className="re-row re-acct">
      <div className="re-id">
        <span className="re-rail" aria-hidden="true" />
        <div style={{ minWidth: 0 }}>
          <div className="re-name">
            {accountNameOf(account)}
            {isDefault && <span className="re-chip">DEFAULT</span>}
          </div>
          {/* Where the account lives and which one it is — never who: the account's email and id
              stay on the machine, and the fingerprint is a prefix of a non-reversible one. */}
          <div className="re-meta" title={account.codexHome}>
            {tildePath(account.codexHome)}
            {account.fingerprintPrefix && ` · account ${account.fingerprintPrefix}…`}
          </div>
        </div>
      </div>
      <div>
        <Tag color={STATUS_TAG[kind].color}>{STATUS_TAG[kind].label}</Tag>
      </div>
      <QuotaCell kind={kind} quota={quota} />
      <div className="re-act">
        {!runner.online ? (
          <Button size="small" disabled>
            Sign in
          </Button>
        ) : kind === 'in' ? (
          <Button size="small" type="text" onClick={toggle}>
            Re-sign in
          </Button>
        ) : (
          <Button size="small" type="primary" onClick={toggle}>
            Sign in
          </Button>
        )}
        {/* Default has nothing to remove: it is the CODEX_HOME the machine's own environment
            selects, the one `codex` typed in a terminal shares. Every other account is a slot this
            runner added, and this is the way back off the machine — the one thing the page could
            not do before, which left whoever signed one in twice with a directory to delete by
            hand. */}
        {!isDefault && (
          <Button
            size="small"
            type="text"
            danger
            disabled={!runner.online || removing}
            loading={removing}
            onClick={() => remove.mutate()}
          >
            Remove
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
          <button
            className="re-link"
            type="button"
            disabled={!runner.online || removing}
            onClick={() => remove.mutate()}
          >
            Remove
          </button>
        </div>
      )}
      {/* The machine would not do it, and its reason is the only thing that can explain why: a
          session is running on that account, or the runner is too old to remove one at all. */}
      {refused && (
        <div className="re-panel bad">
          <div className="re-panel-row">{refused}</div>
          <div className="re-panel-hint">
            {tildePath(account.codexHome)} on {runner.displayName || runner.name} is untouched.
          </div>
        </div>
      )}
      {signIn === panel && (
        <div className="re-panel">
          <RunnerSignIn runnerId={runner.id} engine="codex" account={account.id} />
        </div>
      )}
    </div>
  );
}

/** "+ Account": name the new account, then the same device flow as every other sign-in here. The
 *  runner gives it a CODEX_HOME of its own, so Default — and the terminal's codex — is untouched. */
function AddCodexAccount({ runnerId, onCancel }: { runnerId: string; onCancel: () => void }) {
  const [name, setName] = useState('');
  return (
    <RunnerSignIn runnerId={runnerId} engine="codex" accountName={name} onCancel={onCancel}>
      <label className="re-add">
        <span className="re-add-label">Account name</span>
        <input
          className="rsi-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Work"
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="re-panel-hint re-add-hint">
        Only a label for this page. Orbit gives the account its own{' '}
        <code className="re-cmd">CODEX_HOME</code> on this machine; your terminal keeps using
        Default.
      </div>
    </RunnerSignIn>
  );
}

/** What a collapsed card says in one line, so folding a runner away never hides a problem. */
export function summaryOf(runner: Runner): string {
  const relay = runner.install;
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
  focusEngine?: LoginEngine | null;
}) {
  const [signIn, setSignIn] = useState<string | null>(null);
  const engines = runner.engines ?? null;

  return (
    <div className={`re-card${runner.online ? '' : ' offline'}${collapsed ? ' collapsed' : ''}`}>
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
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  runner={runner}
                  account={account}
                  duplicateOf={repeats.get(account.id)}
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
  const focusEngine = ENGINES.find((e) => e === engineParam) ?? null;
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
          r.codexAccountRemove?.status === 'pending',
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
