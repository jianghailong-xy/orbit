import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { DSH_STATE_HINT, DSH_STATE_LABEL, dshRunnerState } from '../lib/dshRuntime';
import { encodeId } from '../lib/idCodec';
import { runnersQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Runner } from './TasksSidePanel';

/**
 * Where a DeepSeek Harness key can run, under its row in Providers.
 *
 * The key itself is the credential, so a runner is never "signed in" to Harness; what varies per
 * machine is whether the server will hand it a Harness session at all (dshRunnerState). A runner
 * that can't is named with its reason, and the one reason fixable from here — the pinned CLI not
 * installed — carries the Install that fixes it. Offline runners are left out: they can't run
 * anything, and their last report may be stale.
 */
export function DshRunnerStatus({ runners }: { runners: Runner[] }) {
  const message = useToast();
  const qc = useQueryClient();
  const install = useMutation({
    mutationFn: (runnerId: string) =>
      api(`/runners/${encodeId(runnerId)}/install`, { method: 'POST', body: { engine: 'dsh' } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't install DeepSeek Harness", e.message),
  });
  const online = runners.filter((runner) => runner.online);
  const states = online.map((runner) => ({ runner, state: dshRunnerState(runner) }));
  const ready = states.filter(({ state }) => state === 'ready').length;
  return (
    <div className="prov-runtime" data-testid="dsh-runner-status">
      <div>Runs on DeepSeek Harness</div>
      <div>
        <span style={ready === 0 ? { color: 'var(--warning)' } : undefined}>
          {ready === 0 ? 'Not ready on any runner' : `Ready on ${ready} runner${ready === 1 ? '' : 's'}`}
        </span>
      </div>
      {states.map(({ runner, state }) => {
        if (state === 'ready') return null;
        const name = runner.displayName || runner.name;
        const installing =
          runner.install?.engine === 'dsh' && (runner.install.status === 'pending' || runner.install.status === 'installing');
        return (
          <div key={runner.id} title={DSH_STATE_HINT[state]}>
            {name}: {installing ? 'Installing…' : DSH_STATE_LABEL[state]}
            {(state === 'notInstalled' || state === 'unsupportedVersion') && !installing && (
              <>
                {' '}
                <a
                  className="re-link"
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    if (!install.isPending) install.mutate(runner.id);
                  }}
                >
                  Install
                </a>
              </>
            )}
            {runner.install?.engine === 'dsh' && runner.install.status === 'failed' && runner.install.message && (
              <div style={{ color: 'var(--warning)' }}>{runner.install.message}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
