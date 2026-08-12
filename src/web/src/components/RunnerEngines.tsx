import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Tag } from 'antd';
import type { LoginEngine, RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import { api } from '../api';
import { decodeId, encodeId } from '../lib/idCodec';
import { planUsageRows, planUsageSnapshotForProvider } from '../lib/planUsage';
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

/** One engine on one runner: what it is, what state it's in, what it costs, and the way out. */
function EngineRow({
  runner,
  engine,
  health,
  signIn,
  onSignIn,
  focused,
}: {
  runner: Runner;
  engine: LoginEngine;
  health?: RunnerEngineHealth;
  /** The engine whose sign-in panel is open on this runner, if any. */
  signIn: LoginEngine | null;
  onSignIn: (engine: LoginEngine | null) => void;
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
    <div className={`re-row${focused ? ' focused' : ''}`} ref={row}>
      <div className="re-id">
        <ProviderTile slug={ENGINE_PRESET[engine]} label={ENGINE_NAME[engine]} size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name">{ENGINE_NAME[engine]}</div>
          <div className="re-meta">
            {metaFor(kind, engine, health)}
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
      <div>
        <Tag color={STATUS_TAG[kind].color}>{STATUS_TAG[kind].label}</Tag>
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
          <span className="re-quota-none">
            {kind === 'in' ? 'No quota reported' : kind === 'out' ? 'Sign in to see quota' : '—'}
          </span>
        )}
      </div>
      <div className="re-act">{action()}</div>

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
            Orbit tries daily.{' '}
            <Link to={`/runners/${encodeId(runner.id)}`}>Update this machine’s engines →</Link>
          </div>
        </div>
      )}
      {signIn === engine && (
        <div className="re-panel">
          <RunnerSignIn runnerId={runner.id} engine={engine} />
        </div>
      )}
    </div>
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
  const signedIn = shown.filter((e) => e.installed && e.auth === 'yes').length;
  return signedIn === ENGINES.length
    ? 'All signed in'
    : `${signedIn} of ${ENGINES.length} signed in`;
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
  const [signIn, setSignIn] = useState<LoginEngine | null>(null);
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
        ENGINES.map((engine) => (
          <EngineRow
            key={engine}
            runner={runner}
            engine={engine}
            health={engines.find((e) => e.engine === engine)}
            signIn={signIn}
            onSignIn={setSignIn}
            focused={engine === focusEngine}
          />
        ))
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
  const focusRunner = decodeId(params.get('runner'));
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
          (r.install?.status === 'done' && r.install?.mode !== 'update'),
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
        (e) => e.installed && e.auth === 'yes' && ENGINES.some((engine) => engine === e.engine),
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
          {list.length > 0 && ' Orbit keeps these CLIs updated daily.'}
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
            Add a runner and sign its CLIs in — your agents then run on the subscription you
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
