import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Tag } from 'antd';
import type { LoginEngine, RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import { api } from '../api';
import { encodeId } from '../lib/idCodec';
import { planUsageRows, planUsageSnapshotForProvider } from '../lib/planUsage';
import { runnersQuery } from '../lib/queries';
import { ENGINE_PRESET } from '../lib/sessionProviderChoices';
import { useToast } from '../lib/toast';
import { ProviderTile } from './ProviderGallery';
import { ENGINE_NAME, RunnerSignIn } from './RunnerSignIn';
import type { Runner } from './TasksSidePanel';

// Every engine a runner can sign into, in display order. Derived from ENGINE_NAME — a
// `Record<LoginEngine, …>` — so adding a fourth engine can't silently skip this page.
const ENGINES = Object.keys(ENGINE_NAME) as LoginEngine[];

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
    if (install.status === 'failed') return 'install-failed';
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
}: {
  runner: Runner;
  engine: LoginEngine;
  health?: RunnerEngineHealth;
  /** The engine whose sign-in panel is open on this runner, if any. */
  signIn: LoginEngine | null;
  onSignIn: (engine: LoginEngine | null) => void;
}) {
  const message = useToast();
  const qc = useQueryClient();
  const kind = rowKindOf(health, runner.install, engine);
  const offline = !runner.online;

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
    <div className="re-row">
      <div className="re-id">
        <ProviderTile slug={ENGINE_PRESET[engine]} label={ENGINE_NAME[engine]} size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name">{ENGINE_NAME[engine]}</div>
          <div className="re-meta">{metaFor(kind, engine, health)}</div>
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
      {signIn === engine && (
        <div className="re-panel">
          <RunnerSignIn runnerId={runner.id} engine={engine} />
        </div>
      )}
    </div>
  );
}

function RunnerEngineCard({ runner }: { runner: Runner }) {
  const [signIn, setSignIn] = useState<LoginEngine | null>(null);
  const engines = runner.engines ?? null;
  return (
    <div className={`re-card${runner.online ? '' : ' offline'}`}>
      <div className="re-head">
        <span className={`re-dot${runner.online ? ' on' : ''}`} />
        <span className="re-runner">{runner.displayName || runner.name}</span>
        <span className="re-runner-meta">
          {[runner.hostname, runner.version && `runner ${runner.version}`]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="re-head-sp" />
        {!runner.online && <Tag>Offline</Tag>}
        <Link className="re-manage" to={`/runners/${encodeId(runner.id)}`}>
          Manage runner →
        </Link>
      </div>
      {engines ? (
        ENGINES.map((engine) => (
          <EngineRow
            key={engine}
            runner={runner}
            engine={engine}
            health={engines.find((e) => e.engine === engine)}
            signIn={signIn}
            onSignIn={setSignIn}
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
          r.install?.status === 'done',
      )
        ? 4000
        : false,
  });
  const list = (runners.data ?? []) as Runner[];
  const ready = list.reduce(
    (n, r) => n + (r.engines ?? []).filter((e) => e.installed && e.auth === 'yes').length,
    0,
  );

  return (
    <div className="re-sec">
      <div className="re-sec-head">
        <h3>On your runners</h3>
        <span className="re-sec-sub">
          Signed in on the machine itself — a session spends that subscription, nothing to paste.
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
        list.map((runner) => <RunnerEngineCard key={runner.id} runner={runner} />)
      )}
    </div>
  );
}
