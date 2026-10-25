import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DownloadOutlined } from '@ant-design/icons';
import { AgentProvider, ENGINE_CLI_NAMES } from '@orbit/shared';
import { api } from '../api';
import { DSH_STATE_HINT, DSH_STATE_LABEL, dshRunnerState } from '../lib/dshRuntime';
import { encodeId } from '../lib/idCodec';
import { runnersQuery } from '../lib/queries';
import { engineVersionNumber, updateNoteOf } from '../lib/runnerEngines';
import { useToast } from '../lib/toast';
import { EngineTile } from './ProviderGallery';
import type { Runner } from './TasksSidePanel';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

/**
 * DeepSeek Harness on one machine, as a row of its card in Infrastructure's Machines (and of the
 * machine's own page): whether the machine can run it at all (dshRunnerState), and the one fix that
 * can be made from here — installing the pinned CLI, or reinstalling a version Orbit does not support.
 *
 * Harness has no sign-in and no quota of a machine's: every session on it runs on one of the account's
 * DeepSeek keys (API keys below), and the row says so where the others say whether they are signed in.
 * A reason it can't run here is written under the row rather than hidden in a tooltip.
 */
export function DshRunnerStatus({ runner }: { runner: Runner }) {
  const message = useToast();
  const qc = useQueryClient();
  const install = useMutation({
    mutationFn: () =>
      api(`/runners/${encodeId(runner.id)}/install`, { method: 'POST', body: { engine: AgentProvider.DSH } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
    onError: (e: Error) => message.error("Couldn't install DeepSeek Harness", e.message),
  });
  const health = runner.engines?.find((engine) => engine.engine === AgentProvider.DSH);
  const state = dshRunnerState(runner);
  const relay = runner.install?.engine === AgentProvider.DSH ? runner.install : null;
  const installing = relay?.status === 'pending' || relay?.status === 'installing';
  const note = health?.installed ? updateNoteOf(health.update) : null;
  const status = installing
    ? { tone: 'blue' as const, label: 'Installing…' }
    : state === 'ready'
      ? { tone: 'default' as const, label: 'Uses API keys' }
      : { tone: state === 'updateRunner' || state === 'unsupportedVersion' ? ('orange' as const) : ('default' as const), label: DSH_STATE_LABEL[state] };
  return (
    <div className="re-row" data-engine={AgentProvider.DSH}>
      <div className="re-id">
        <EngineTile engine={AgentProvider.DSH} size={28} />
        <div style={{ minWidth: 0 }}>
          <div className="re-name">{ENGINE_CLI_NAMES[AgentProvider.DSH]}</div>
          {installing ? (
            <div className="re-meta">{health?.installed ? 'Reinstalling' : 'Not installed yet'}</div>
          ) : health?.installed ? (
            <div className="re-meta">
              {health.version ? engineVersionNumber(health.version) : 'version not reported'}
              {note && (
                <span className={`re-upd${note.tone === 'warn' && runner.online ? ' warn' : ''}`} title={health.update?.message}>
                  {' '}
                  · {note.text}
                </span>
              )}
            </div>
          ) : (
            state === 'notInstalled' && <div className="re-meta">Not installed — Orbit can install it here</div>
          )}
        </div>
      </div>
      <div className="re-status">
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div className="re-quota">
        <span className="re-quota-none">—</span>
      </div>
      <div className="re-act">
        {!installing && (state === 'notInstalled' || state === 'unsupportedVersion') && (
          <Button
            size="small"
            className="re-action re-install"
            icon={<DownloadOutlined aria-hidden />}
            disabled={!runner.online}
            loading={install.isPending}
            onClick={() => install.mutate()}
          >
            Install
          </Button>
        )}
      </div>
      {!installing && state !== 'ready' && state !== 'notInstalled' && (
        <div className="re-panel-hint re-login-note">{DSH_STATE_HINT[state]}</div>
      )}
      {/* The machine's own words for an install that failed, which nothing here can guess. */}
      {relay?.status === 'failed' && !health?.installed && (
        <div className="re-panel bad">
          <div className="re-panel-row">{relay.message || 'The installer failed.'}</div>
        </div>
      )}
    </div>
  );
}
