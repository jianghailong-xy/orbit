import { RightOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from 'antd';
import { Link } from 'react-router-dom';
import { accountToStartOn, withEnginePlanUsage, type ReportedEngine, type RunnerEngineHealth } from '@orbit/shared';
import { api } from '../api';
import { accountNameOf, accountPlanUsage, engineKeepsAccounts, runsOnEnvKey } from '../lib/engineAccounts';
import { encodeId } from '../lib/idCodec';
import { bindingPlanUsageRow, currentPlanUsageRows, planUsageSnapshotForProvider } from '../lib/planUsage';
import { formatResetTime } from '../lib/providerPools';
import { runnersQuery } from '../lib/queries';
import {
  RUNNER_ENGINES,
  RUNNER_ENGINES_FOOTER,
  RUNNER_ENGINES_OFFLINE_FOOTER,
  RUNNER_ENGINE_NOT_INSTALLED,
  RUNNER_ENGINE_NO_QUOTA,
  RUNNER_ENGINE_SIGNED_IN,
  RUNNER_ENGINE_SIGNED_OUT,
  runnerEngineAccountsSignedIn,
  runnerEngineNext,
} from '../lib/runnerCopy';
import { DSH_STATE_LABEL, dshRunnerState } from '../lib/dshRuntime';
import { ENGINE_CLI_NAME, engineVersionNumber, updateNoteOf } from '../lib/runnerEngines';
import { ENGINE_PRESET } from '../lib/sessionProviderChoices';
import { useToast } from '../lib/toast';
import { ProviderTile } from './ProviderGallery';
import { rowKindOf } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/** Where an engine's sign-in and accounts live: its card on Providers, opened at this engine. */
export const engineSignInHref = (runnerId: string, engine: ReportedEngine) =>
  `/providers?runner=${encodeId(runnerId)}&engine=${engine}`;

/** POST /runners/:id/engine-update — every CLI on the machine, so it is the machine's to offer.
 *  The section's own button and a Needs Attention card both start it. */
export function useEngineUpdate(runnerId: string) {
  const message = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/runners/${runnerId}/engine-update`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't start the engine update", e.message),
  });
}

/**
 * The engine CLIs installed on one machine, and the control that updates them.
 *
 * This lives on the runner's page rather than on Providers because of what it acts on:
 * `POST /runners/:id/engine-update` takes no engine — its object is the machine, and it updates
 * every CLI on it. Providers is a page about identity, where every other control is scoped to a
 * (runner, engine) pair; the one runner-scoped button sat there next to the link that says
 * runner-scoped things are over here. The mismatch was visible in the output: the update summary
 * named OpenCode, which Providers deliberately has no row for.
 *
 * So the split is by what an action changes. What's *available* — Install, Sign in — stays on
 * Providers, one › away on every row. What *version* is installed belongs to the machine, next to
 * its own runner version, slots and heartbeat; each row also says whether it is signed in and how
 * much of its quota is left, because that is what decides whether this machine can run a session.
 */
export function RunnerEnginesSection({ runner }: { runner: Runner }) {
  const message = useToast();
  const qc = useQueryClient();
  const engines: RunnerEngineHealth[] | null = !runner.engines ? null
    : runner.engines.some((health) => health.engine === 'antigravity') ? runner.engines
      : [...runner.engines, { engine: 'antigravity', installed: runner.antigravity?.installed ?? false, version: runner.antigravity?.version ?? undefined, auth: 'unknown' }];
  const relay = runner.install;
  const updating = relay?.mode === 'update';
  const inFlight = relay?.status === 'pending' || relay?.status === 'installing';

  const startUpdate = useEngineUpdate(runner.id);
  const dismiss = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });
  // The model picker lists what these CLIs report, re-read hourly by the runner — and on the spot
  // after it installs a newer engine. This asks for a pass now, for a model a CLI learned about
  // some other way. There is no relay to watch: the refreshed catalog simply arrives
  // on a heartbeat, which is why the toast promises a minute rather than showing progress.
  const refreshModels = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/refresh-models`, { method: 'POST' }),
    onSuccess: () => {
      message.success('Re-reading this machine’s model lists — the picker updates within a minute.');
      void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    },
    onError: (e: Error) => message.error("Couldn't refresh the model lists", e.message),
  });

  return (
    <section className="rd-section rd-engines">
      <div className="rd-section-head">
        <div className="rd-section-title">{RUNNER_ENGINES}</div>
        {/* Understated on purpose: Orbit updates these every 30 min, so this is the escape hatch for
            when that isn't soon enough — not the way the CLIs are meant to stay current. The
            models button sits here for the same reason it exists: what a CLI offers is a fact
            about this machine's engines, and updating one is exactly when the other goes stale. */}
        {runner.online && (
          <div className="rd-section-actions">
            <Button
              size="small"
              disabled={refreshModels.isPending}
              onClick={() => refreshModels.mutate()}
            >
              Refresh models
            </Button>
            <Button
              size="small"
              disabled={inFlight || startUpdate.isPending}
              onClick={() => startUpdate.mutate()}
            >
              {inFlight && updating ? 'Updating…' : 'Update engines'}
            </Button>
          </div>
        )}
      </div>

      {/* The run's report. Unlike an install it is not retired by the next probe: the summary —
          what moved, what was skipped and why — exists nowhere else once it's gone. */}
      {updating && relay?.status && (
        <div className={`rd-engine-relay${relay.status === 'failed' ? ' bad' : ''}`}>
          <div className="rd-engine-relay-row">
            {relay.status === 'pending'
              ? 'Queued — the runner picks this up on its next check-in.'
              : relay.status === 'installing'
                ? 'Updating this machine’s engine CLIs…'
                : relay.message || 'Nothing to update.'}
          </div>
          {relay.status !== 'pending' && relay.command && (
            <div className="rd-engine-relay-hint">
              Orbit ran <code className="re-cmd">{relay.command}</code>
            </div>
          )}
          {(relay.status === 'done' || relay.status === 'failed') && (
            <div className="rd-engine-relay-hint">
              <button className="re-link" type="button" onClick={() => dismiss.mutate()}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {!engines ? (
        // Never "nothing installed": a runner that hasn't reported yet has told us nothing, and
        // an older one never will.
        <div className="rd-empty">This runner hasn’t reported its engines yet.</div>
      ) : (
        <>
          <div className="rd-engine-list">
            {engines.map((engine) => (
              <EngineLine key={engine.engine} runner={runner} health={engine} />
            ))}
          </div>
          <div className="rd-hint">
            {runner.online ? RUNNER_ENGINES_FOOTER : RUNNER_ENGINES_OFFLINE_FOOTER}
          </div>
        </>
      )}
    </section>
  );
}

type Tone = 'ok' | 'warn' | 'muted';

/**
 * What a row says about its sign-in, read the way Providers reads it (rowKindOf): a CLI that
 * wouldn't say is never "Signed in". With several accounts on the machine the row speaks for all of
 * them — every one in, or the one that is out. Antigravity's Google accounts are said the same way;
 * a machine that runs it on its Gemini key says "env key", and its Default on that key is never the
 * one that is out (runsOnEnvKey).
 */
function signInOf(runner: Runner, health: RunnerEngineHealth): { text: string; tone: Tone } {
  const none = { text: '—', tone: 'muted' as const };
  if (health.engine === 'antigravity' && runner.engines?.find((engine) => engine.engine === 'antigravity')?.installed !== false && health.auth !== 'yes' && runner.antigravity?.installed !== false && runner.antigravity?.googleLogin !== 'available') {
    return { text: runner.antigravity?.googleLogin === 'unsupported_platform' ? 'Not supported yet' : 'Update runner', tone: 'muted' };
  }
  if (health.engine === 'opencode') {
    return health.installed ? none : { text: RUNNER_ENGINE_NOT_INSTALLED, tone: 'muted' };
  }
  // Harness has no sign-in: each session brings a configured API key. What this machine decides is
  // whether it can start one at all (dshRunnerState), which is what the column says instead.
  if (health.engine === 'dsh') {
    const state = dshRunnerState(runner);
    return state === 'ready' ? { text: 'Uses API keys', tone: 'muted' } : { text: DSH_STATE_LABEL[state], tone: state === 'notInstalled' ? 'muted' : 'warn' };
  }
  const kind = rowKindOf(health, runner.install, health.engine);
  if (kind === 'missing' || kind === 'install-failed') {
    return { text: RUNNER_ENGINE_NOT_INSTALLED, tone: 'muted' };
  }
  // An install in flight is Providers' to narrate; the probe has nothing to say about it yet.
  if (kind !== 'in' && kind !== 'out' && kind !== 'unknown') return none;
  const accounts = engineKeepsAccounts(health.engine) ? (health.accounts ?? []) : [];
  if (accounts.length >= 2) {
    if (accounts.every((account) => account.auth === 'yes' || runsOnEnvKey(health, account))) {
      return { text: runnerEngineAccountsSignedIn(accounts.length), tone: 'ok' };
    }
    if (accounts.some((account) => account.auth === 'no' && !runsOnEnvKey(health, account))) {
      return { text: RUNNER_ENGINE_SIGNED_OUT, tone: 'warn' };
    }
    return none;
  }
  if (kind === 'in') return { text: health.engine === 'antigravity' && health.authSource !== 'google' ? 'env key' : RUNNER_ENGINE_SIGNED_IN, tone: 'ok' };
  if (kind === 'out') return { text: RUNNER_ENGINE_SIGNED_OUT, tone: 'warn' };
  return none;
}

function EngineLine({ runner, health }: { runner: Runner; health: RunnerEngineHealth }) {
  const note = health.installed ? updateNoteOf(health.update) : null;
  const signIn = signInOf(runner, health);
  const googleLogin = health.engine === 'antigravity' ? (runner.antigravity?.googleLogin ?? 'needs_update') : undefined;
  const loginHint = googleLogin === 'unsupported_platform'
    ? 'Google sign-in is not supported on macOS runners yet. Use a Gemini API key.'
    : googleLogin === 'needs_update' ? 'Update this runner to sign in with Google.' : null;
  // A quota belongs to a login that is in: signed out, its last reading is about a session that
  // can no longer start. Same reading Providers shows at the head of its row.
  const kind =
    health.engine === 'opencode' || health.engine === 'dsh'
      ? null
      : rowKindOf(health, runner.install, health.engine);
  // With several accounts the engine's own snapshot is Default's alone, and one account's windows
  // under "2 accounts signed in" would read as the machine's. The window shown is that of the
  // account a new session starts on, named — what an account pool's head shows for its next one.
  // Antigravity's quota comes with its engine's health, folded in beside the rest.
  const usage = withEnginePlanUsage(runner.planUsage, runner.engines);
  const engine = engineKeepsAccounts(health.engine) ? health.engine : null;
  const accounts = engine && (kind === 'in' || kind === 'out' || kind === 'unknown') ? (health.accounts ?? []) : [];
  const nextId =
    engine && accounts.length >= 2 ? accountToStartOn(engine, accounts, usage, new Date()) : null;
  const next = accounts.find((account) => account.id === nextId);
  const signedIn = accounts.length >= 2 ? !!next : kind === 'in';
  const snapshot = !signedIn
    ? null
    : engine && next
      ? accountPlanUsage(usage, engine, next.id)
      : planUsageSnapshotForProvider(usage, health.engine);
  // One window per row, whether the CLI reports two or four: the one that stops this login, or will
  // stop it first (bindingPlanUsageRow, the composer gauge's). Every window is the engine page's.
  const binding = snapshot ? bindingPlanUsageRow(currentPlanUsageRows(snapshot)) : undefined;
  const quota = binding ? [binding] : [];
  const name = ENGINE_CLI_NAME[health.engine] ?? health.engine;
  return (
    <Link className="rd-engine-row" to={engineSignInHref(runner.id, health.engine)}>
      <ProviderTile slug={ENGINE_PRESET[health.engine] ?? (health.engine === 'dsh' ? 'deepseek-harness' : health.engine)} label={name} size={24} />
      <div className="rd-engine-main">
        <div className="rd-engine-name">{name}</div>
        {/* The machine's own sentence on hover — which path, which owner, which error. The line
            itself has to stay short enough to sit after a version string. A CLI that isn't there
            has no version to show; its sign-in column says it is missing. */}
        {health.installed && (
          <div className="rd-engine-version" title={health.update?.message}>
            {health.version ? engineVersionNumber(health.version) : 'version not reported'}
            {note && (
              <>
                {' · '}
                <span className={`rd-engine-note${note.tone === 'warn' ? ' warn' : ''}`}>{note.text}</span>
              </>
            )}
          </div>
        )}
        {loginHint && <div className="re-panel-hint">{loginHint}</div>}
      </div>
      <div className={`rd-engine-auth ${signIn.tone}`}>{signIn.text}</div>
      <div className={`rd-engine-quota${quota.length === 0 && !signedIn ? ' empty' : ''}`}>
        {quota.length > 0 && next && <div className="rd-quota-next">{runnerEngineNext(accountNameOf(next))}</div>}
        {quota.length > 0 ? (
          quota.map((row) => (
            <div key={row.key} className={`rd-quota${row.nearLimit ? ' near' : ''}`}>
              {row.remaining && row.groupLabel && <div className="rd-quota-next">{row.groupLabel}</div>}
              <div className="rd-quota-head">
                <span>{row.label}</span>
                <span className="rd-quota-pct">{row.percent}%{row.remaining ? ' remaining' : ''}</span>
              </div>
              <div className="rd-quota-bar">
                <span style={{ width: `${row.percent}%` }} />
              </div>
              {row.window.resetsAt && <div className="re-reset">resets {formatResetTime(row.window.resetsAt)}</div>}
            </div>
          ))
        ) : (
          <span className="rd-engine-muted">{signedIn ? RUNNER_ENGINE_NO_QUOTA : '—'}</span>
        )}
      </div>
      <RightOutlined className="rd-engine-chevron" />
    </Link>
  );
}
