import type { ReactNode } from 'react';
import { ClockCircleOutlined, RightOutlined } from '@ant-design/icons';
import type { BackgroundWake } from '../lib/backgroundWake';
import { formatSpan } from '../lib/watches';
import { Pre, relTime } from './Transcript';

/** Scheduled wakeup prompts keep the existing text-line fold inside their details. */
const TAIL_LINES = 8;

/** What happened, at a glance. Also what a folded exchange says (Transcript `orbitTurnOf`). */
export function backgroundWakeTitle(_wake?: BackgroundWake): string {
  return 'Scheduled wakeup';
}

/** What the line names after its title: why the wakeup was asked for. */
export function backgroundWakeName(wake: BackgroundWake): string | null {
  return wake.wakeups[0]?.reason ?? null;
}

/**
 * A turn the control plane opened because a wakeup came due (lib/backgroundWake `parseBackgroundWake`), drawn as one event line in the agent's stream — the
 * grammar `⊘ interrupted` already uses — rather than as a card on the reader's side of the
 * conversation. The card it replaced sat where the person's own messages sit, in their tint, so a
 * run of wakes read as somebody cutting in and split one answer into pieces; a quarter of the turns
 * on that side of this deployment's transcripts were wakes, and after nearly all of them the agent
 * simply carried on with the same work.
 *
 * It is no anchor for the sticky bar (no `data-orbit-round`): the bar keeps naming the question the
 * answer around it belongs to. Why it was asked for, who queued it and what the agent read open
 * beneath it, behind a native disclosure so they still open in a static export.
 *
 * A background job's end, new output or stall draws no line here any more (board C1): the job is one
 * card from start to end (JobCard), and only a wakeup that came due beside it is drawn.
 *
 * The queued tail draws the same line while the wake waits behind the running turn, dashed, with
 * the queue's status line under it, so it keeps its shape when a runner takes it.
 *
 * A wake written into a running turn (a steer) sits in that turn's own stream, and how far it got is
 * the line's to say — the same words a steer's bubble uses (lib/steerDelivery).
 */
export function BackgroundWakeCard({
  wake,
  seq,
  ts,
  undelivered,
  queued,
  steer,
}: {
  wake: BackgroundWake;
  /** Unset while the wake is still queued: it is no event yet, so ⌘F has nothing to land on. */
  seq?: number;
  ts?: string;
  /** The runner has not confirmed the engine received the turn. */
  undelivered?: boolean;
  /** The queued tail's status line, while the wake still waits for its turn. */
  queued?: ReactNode;
  /** How far a wake written into the running turn has got (`steerDeliveryState(...).label`). */
  steer?: string;
}) {
  const name = backgroundWakeName(wake);
  return (
    <div className={`bgwake is-ok${queued ? ' is-queued' : ''}`} data-seq={seq}>
      <details className="bgwake-fold">
        <summary className="bgwake-row">
          <span className="bgwake-mark is-pending">
            <ClockCircleOutlined />
          </span>
          <span className="bgwake-title">{backgroundWakeTitle(wake)}</span>
          {name && <span className="bgwake-name">{name}</span>}
          {ts && <span className="bgwake-time">{relTime(ts)}</span>}
          <span className="bgwake-details-label">
            Details
            <RightOutlined className="bgwake-caret" />
          </span>
        </summary>
        <div className="bgwake-body">
          <ul className="bgwake-wakeups">
            {wake.wakeups.map((wakeup, i) => (
              <li className="bgwake-wakeup" key={`${wakeup.dueAt ?? ''}:${i}`}>
                {wakeup.reason && <div className="bgwake-wakeup-reason">{wakeup.reason}</div>}
                <div className="bgwake-wakeup-meta">
                  {wakeup.delaySeconds !== null && `Asked for ${formatSpan(wakeup.delaySeconds * 1000)} out`}
                  {wakeup.delaySeconds !== null && wakeup.dueAt && ' · '}
                  {wakeup.dueAt && `came due ${relTime(wakeup.dueAt)}`}
                </div>
                {wakeup.prompt !== '' && <Pre text={wakeup.prompt} threshold={TAIL_LINES} />}
              </li>
            ))}
          </ul>
          <div className="bgwake-meta">Queued by a scheduled wakeup, not typed by you</div>
          <details className="bgwake-raw">
            <summary>What the agent received</summary>
            <pre>{wake.text}</pre>
          </details>
        </div>
      </details>
      {undelivered && <div className="bgwake-undelivered">The session has not confirmed it received this.</div>}
      {steer && <div className="bgwake-steer">{steer}</div>}
      {queued && <div className="bgwake-queued">{queued}</div>}
    </div>
  );
}
