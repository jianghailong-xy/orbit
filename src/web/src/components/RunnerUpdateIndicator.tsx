import { SyncOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import {
  RUNNER_UPDATE_INDICATOR_TURNS_SHOWN,
  runnerUpdateIndicator,
  runnerUpdateIndicatorMore,
  runnerUpdateIndicatorOpen,
} from '../lib/runnerUpdateIndicator';
import { runnerTakesUpdateNow, runnerUpdateNowTurns } from '../lib/runnerUpdateNow';
import { RunnerUpdateLaterMenu } from './RunnerUpdateLater';
import { RunnerUpdateNowButton } from './RunnerUpdateNow';
import type { Runner } from './TasksSidePanel';
import { Popover } from './ui/Popover';

/**
 * docs/mocks/runner-update-indicator ②–④: while this runner drains for its update with something of the reader's
 * waiting on it, a quiet pill left of the header's ⋯ (`HPC updating · 5 turns left`). It opens a popover with the
 * release, the turns the drain waits for, what of the reader's waits, Later ▾, Update Now… and a link to the runner.
 * It goes away by itself when the drain ends; nothing is pushed for it.
 */
export function RunnerUpdateIndicator({ runner, machine }: { runner: Runner; machine: string }) {
  const indicator = runnerUpdateIndicator(runner, machine);
  if (!indicator) return null;
  // Read at render; the runners query refetches, so `running 47 min` stays near enough.
  const turns = runnerUpdateNowTurns(runner, Date.now());
  const shown = turns.slice(0, RUNNER_UPDATE_INDICATOR_TURNS_SHOWN);
  const more = turns.length - shown.length;
  return (
    <Popover
      side="bottom"
      align="end"
      popupClassName="runner-update-popover"
      title={indicator.title}
      trigger={
        <button type="button" className="runner-update-pill" aria-label={indicator.pill}>
          <SyncOutlined aria-hidden="true" />
          <span className="runner-update-pill-label">{indicator.pill}</span>
          {indicator.short && <span className="runner-update-pill-short">{indicator.short}</span>}
        </button>
      }
    >
      <p className="runner-update-popover-body">{indicator.body}</p>
      {shown.length > 0 && (
        <ul className="runner-update-popover-turns">
          {shown.map((turn) => (
            <li key={turn.id}>
              <Link to={`/sessions/${encodeId(turn.id)}`}>{turn.title}</Link>
              {turn.running && <span>{turn.running}</span>}
            </li>
          ))}
          {more > 0 && <li className="runner-update-popover-more">{runnerUpdateIndicatorMore(more)}</li>}
        </ul>
      )}
      <p className="runner-update-popover-waits">{indicator.waits}</p>
      <div className="runner-update-popover-actions">
        {/* A runner that is stopping has no update to postpone or install now (docs/mocks/runner-stopping). */}
        {!indicator.stopping && <RunnerUpdateLaterMenu runnerId={runner.id} />}
        {!indicator.stopping && runnerTakesUpdateNow(runner) && <RunnerUpdateNowButton runner={runner} machine={machine} />}
        <Link className="runner-update-popover-open" to={`/settings/machines/${encodeId(runner.id)}`}>
          {runnerUpdateIndicatorOpen(machine)}
        </Link>
      </div>
    </Popover>
  );
}
