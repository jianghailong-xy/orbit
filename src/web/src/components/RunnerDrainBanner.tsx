import { CloseOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { runnerDrainBanner } from '../lib/runnerDrainBanner';
import { runnerTakesUpdateNow } from '../lib/runnerUpdateNow';
import { RunnerUpdateLaterMenu } from './RunnerUpdateLater';
import { RunnerUpdateNowButton } from './RunnerUpdateNow';
import type { Runner } from './TasksSidePanel';

export const RUNNER_DRAIN_BANNER_DISMISS = 'Dismiss';

/**
 * Board 3 ⑥: `studio-mac is updating to 0.1.254 — 1 session and 1 message are waiting for 2 turns to finish.` with
 * Later ▾, Update Now… and ×, at the top of the conversation pane. Only while the runner drains and something of the
 * reader's waits on it (D3). × hides it for this drain only: the update itself is unchanged, and the next drain shows
 * it again.
 */
export function RunnerDrainBanner({ runner, machine }: { runner: Runner; machine: string }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const banner = runnerDrainBanner(runner, machine);
  if (!banner || dismissed === banner.drainKey) return null;
  return (
    <div className="runner-drain-banner" role="status">
      <ExclamationCircleOutlined className="runner-drain-banner-icon" aria-hidden="true" />
      <span className="runner-drain-banner-text">{banner.text}</span>
      <div className="runner-drain-banner-actions">
        <RunnerUpdateLaterMenu runnerId={runner.id} />
        {runnerTakesUpdateNow(runner) && <RunnerUpdateNowButton runner={runner} machine={machine} />}
        <button
          type="button"
          className="runner-drain-banner-close"
          aria-label={RUNNER_DRAIN_BANNER_DISMISS}
          title={RUNNER_DRAIN_BANNER_DISMISS}
          onClick={() => setDismissed(banner.drainKey)}
        >
          <CloseOutlined />
        </button>
      </div>
    </div>
  );
}
