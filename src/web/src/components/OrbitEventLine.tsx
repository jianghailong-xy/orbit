import type { ReactNode } from 'react';
import { RightOutlined } from '@ant-design/icons';
import { describeNote } from '../lib/deliveredMessage';
import { relTime } from './Transcript';

/** The title of the line a turn carrying only Orbit's blocks draws (OrbitEventLine). */
export const ORBIT_EVENT_TITLE = 'From Orbit';

/** The mark it opens on: neutral, Orbit's own `⊕`, neither a success nor a failure. */
export const ORBIT_EVENT_MARK = '⊕';

/** What the line names after its title: the blocks as describeNote names them, `context` when it
 *  names none. */
export function orbitEventName(note: string): string {
  return describeNote(note) || 'context';
}

/**
 * A turn Orbit opened whose note is a block no dedicated line knows (owner rule 2026-11-16: the
 * right side of a conversation is only for words the person typed). Before this, such a turn fell
 * through to the reader's own bubble: an empty bubble on their side with only `⊕ Orbit attached:
 * context` and the raw block — which is how a SubAgent's end first reached the owner.
 *
 * It is one event line in the agent's stream, in BackgroundWakeCard's grammar: a neutral mark,
 * `From Orbit`, the block's name, when, and `Details ›` opening the raw blocks the agent read. It is
 * no anchor for the sticky bar (no `data-orbit-round`), and it never returns to the composer.
 */
export function OrbitEventLine({
  note,
  seq,
  ts,
  undelivered,
  queued,
  steer,
}: {
  /** The recorded note: the blocks the agent read. */
  note: string;
  /** Unset while the turn is still queued: it is no event yet. */
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** The queued tail's status line, while the turn still waits. */
  queued?: ReactNode;
  /** How far a turn written into the running turn has got (`steerDeliveryState(...).label`). */
  steer?: string;
}) {
  return (
    <div className={`bgwake orbitwake is-ok${queued ? ' is-queued' : ''}`} data-seq={seq}>
      <details className="bgwake-fold">
        <summary className="bgwake-row">
          <span className="bgwake-mark orbitwake-mark">{ORBIT_EVENT_MARK}</span>
          <span className="bgwake-title">{ORBIT_EVENT_TITLE}</span>
          <span className="bgwake-name">{orbitEventName(note)}</span>
          {ts && <span className="bgwake-time">{relTime(ts)}</span>}
          <span className="bgwake-details-label">
            Details
            <RightOutlined className="bgwake-caret" />
          </span>
        </summary>
        <div className="bgwake-body">
          <details className="bgwake-raw" open>
            <summary>What the agent read</summary>
            <pre>{note}</pre>
          </details>
        </div>
      </details>
      {undelivered && <div className="bgwake-undelivered">The session has not confirmed it received this.</div>}
      {steer && <div className="bgwake-steer">{steer}</div>}
      {queued && <div className="bgwake-queued">{queued}</div>}
    </div>
  );
}
