import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from 'antd';
import type { RunnerEngineHealth } from '@orbit/shared';
import { api } from '../api';
import { runnersQuery } from '../lib/queries';
import { ENGINE_CLI_NAME, updateNoteOf } from '../lib/runnerEngines';
import { useToast } from '../lib/toast';
import type { Runner } from './TasksSidePanel';

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
 * Providers. What *version* is installed belongs to the machine, next to its own runner version,
 * slots and heartbeat.
 */
export function RunnerEnginesSection({ runner }: { runner: Runner }) {
  const message = useToast();
  const qc = useQueryClient();
  const engines = runner.engines ?? null;
  const relay = runner.install;
  const updating = relay?.mode === 'update';
  const inFlight = relay?.status === 'pending' || relay?.status === 'installing';

  const startUpdate = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/engine-update`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error(e.message || 'Could not start the update'),
  });
  const dismiss = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/install`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });
  // The model picker lists what these CLIs report, re-read by the runner every few hours — so a
  // model released today, or one a fresh CLI just learned about, is invisible until that pass.
  // This asks for the pass now. There is no relay to watch: the refreshed catalog simply arrives
  // on a heartbeat, which is why the toast promises a minute rather than showing progress.
  const refreshModels = useMutation({
    mutationFn: () => api(`/runners/${runner.id}/refresh-models`, { method: 'POST' }),
    onSuccess: () => {
      message.success('Re-reading this machine’s model lists — the picker updates within a minute.');
      void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    },
    onError: (e: Error) => message.error(e.message || 'Could not refresh the model lists'),
  });

  return (
    <section className="rd-section">
      <div className="rd-section-head">
        <div className="rd-section-title">Engines</div>
        {/* Understated on purpose: Orbit updates these every day, so this is the escape hatch for
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
        <div className="rd-engine-list">
          {engines.map((engine) => (
            <EngineLine key={engine.engine} health={engine} />
          ))}
        </div>
      )}
    </section>
  );
}

function EngineLine({ health }: { health: RunnerEngineHealth }) {
  const note = health.installed ? updateNoteOf(health.update) : null;
  return (
    <div className="rd-engine-row">
      <div className="rd-engine-name">{ENGINE_CLI_NAME[health.engine] ?? health.engine}</div>
      <div className="rd-engine-version">
        {health.installed ? health.version || 'version not reported' : 'Not installed'}
      </div>
      {/* The machine's own sentence on hover — which path, which owner, which error. The line
          itself has to stay short enough to sit after a version string. */}
      <div className={`rd-engine-note${note?.tone === 'warn' ? ' warn' : ''}`} title={health.update?.message}>
        {note?.text ?? ''}
      </div>
    </div>
  );
}
