import { useContext, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { DownOutlined, RightOutlined, UpOutlined } from '@ant-design/icons';
import { subagentFinishedOk, type SubagentFinished, type SubagentFinishedRun } from '../lib/subagentFinished';
import { ExportCtx, MD, relTime } from './Transcript';

/** What happened, at a glance: one run's end, or how many ended. */
export function subagentFinishedTitle(wake: SubagentFinished): string {
  if (wake.runs.length > 1) return `${wake.runs.length} SubAgents finished`;
  return subagentFinishedOk(wake.runs[0]) ? 'SubAgent finished' : 'SubAgent did not finish';
}

/** The word chip the line closes on: the one run's end, or how many of several did not finish. */
export function subagentFinishedStatus(wake: SubagentFinished): string {
  if (wake.runs.length === 1) return wake.runs[0].status.toLowerCase();
  const failed = wake.runs.filter((run) => !subagentFinishedOk(run)).length;
  return failed > 0 ? `${failed} of ${wake.runs.length} failed` : 'done';
}

/** The `delegate` card a run was started from, where it is on the page (ToolView marks it). */
const delegateCardOf = (runId: string): HTMLElement | null =>
  typeof document === 'undefined'
    ? null
    : Array.from(document.querySelectorAll<HTMLElement>('[data-subagent-run]')).find(
        (card) => card.dataset.subagentRun === runId,
      ) ?? null;

/** A run's result as Markdown, three lines of it until the reader asks for the rest. */
function ResultPreview({ text }: { text: string }) {
  const exporting = useContext(ExportCtx) !== null;
  const [open, setOpen] = useState(false);
  // Whether three lines hold all of it — measured, so a short result offers nothing to open. Until a
  // layout says so (and wherever there is none) the offer stays.
  const [fits, setFits] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The clamp sits on the Markdown's own box, so that is the box that overflows.
    const el = ref.current?.firstElementChild;
    if (el && el.scrollHeight > 0) setFits(el.scrollHeight <= el.clientHeight + 1);
  }, [text]);
  // A file has no script to open it with: all of it is there.
  const clamped = !exporting && !open;
  return (
    <div className="sawake-result">
      <div ref={ref} className={`sawake-result-md${clamped ? ' is-clamped' : ''}`}>
        <MD>{text}</MD>
      </div>
      {!exporting && (open || !fits) && (
        <button type="button" className="sawake-result-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show full result'}
          {open ? <UpOutlined /> : <DownOutlined />}
        </button>
      )}
    </div>
  );
}

/** Under a lone run's line: why it ended if it did not finish, then what it handed back. */
function RunOutcome({ run }: { run: SubagentFinishedRun }) {
  const ok = subagentFinishedOk(run);
  if (ok && run.result === '') return null;
  return (
    <div className={`sawake-outcome${ok ? '' : ' is-failed'}`}>
      {run.reason && <div className="sawake-reason">{run.reason}</div>}
      {run.result !== '' ? <ResultPreview text={run.result} /> : <div className="sawake-noresult">No result</div>}
    </div>
  );
}

/** One of several runs: its mark, name and end, and one line of what it handed back. */
function RunRow({ run }: { run: SubagentFinishedRun }) {
  const ok = subagentFinishedOk(run);
  const first = run.result.split('\n').find((text) => text.trim() !== '') ?? '';
  const line = first || run.reason || 'No result';
  return (
    <li className={`sawake-run${ok ? ' is-ok' : ' is-failed'}`}>
      <div className="sawake-run-head">
        <span className="sawake-run-mark">{ok ? '✓' : '✕'}</span>
        <span className="sawake-run-name">{run.description}</span>
        <span className="bgwake-status">{run.status.toLowerCase()}</span>
      </div>
      <div className={`sawake-run-line${!first && run.reason ? ' is-reason' : ''}${!first && !run.reason ? ' is-empty' : ''}`}>
        <MD>{line}</MD>
      </div>
    </li>
  );
}

/**
 * A turn the control plane opened because a SubAgent ended (lib/subagentFinished
 * `parseSubagentFinished`), drawn as one event line in the agent's stream in the grammar a background
 * job's news uses (BackgroundWakeCard) — not as the reader's own bubble carrying the raw block, which is
 * what it was: a message nobody typed, signed with the reader's name, its protocol sentences for the
 * agent on show.
 *
 * The ✦ is the SubAgent card's own mark and purple, so the line reads back to the card that started
 * it. What it handed back stays out of the fold — it is what the agent goes on from — three lines of
 * it as Markdown. A run that did not finish turns the line red and says why. The run, where its card
 * is, who queued it and what the agent read open beneath, behind a native disclosure so they still
 * open in a static export. The sentences the block closes on are the agent's: they are only in
 * "What the agent read".
 *
 * It is no anchor for the sticky bar (no `data-orbit-round`), and a SubAgent that ended while a turn
 * ran says how far it got the way a steer does, as BackgroundWakeCard does.
 */
export function SubagentFinishedCard({
  wake,
  seq,
  ts,
  undelivered,
  queued,
  steer,
}: {
  wake: SubagentFinished;
  /** Unset while the wake is still queued: it is no event yet. */
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** The queued tail's status line, while the wake still waits for its turn. */
  queued?: ReactNode;
  /** How far a wake written into the running turn has got (`steerDeliveryState(...).label`). */
  steer?: string;
}) {
  const several = wake.runs.length > 1;
  const lone = several ? null : wake.runs[0];
  const failed = !!lone && !subagentFinishedOk(lone);
  // The delegate cards on the page, looked up when the fold opens: a link to a card that is not
  // drawn (folded away, or never loaded) would go nowhere, so there is none.
  const [cards, setCards] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) return;
    setCards(new Set(wake.runs.map((run) => run.runId).filter((id) => delegateCardOf(id) !== null)));
  };
  return (
    <div className={`bgwake sawake ${failed ? 'is-failed' : 'is-ok'}${queued ? ' is-queued' : ''}`} data-seq={seq}>
      <details className="bgwake-fold" onToggle={onToggle}>
        <summary className="bgwake-row">
          <span className="bgwake-mark sawake-mark">✦</span>
          <span className="bgwake-title">{subagentFinishedTitle(wake)}</span>
          {lone && <span className="bgwake-name">{lone.description}</span>}
          <span className="bgwake-status">{subagentFinishedStatus(wake)}</span>
          {ts && <span className="bgwake-time">{relTime(ts)}</span>}
          <span className="bgwake-details-label">
            Details
            <RightOutlined className="bgwake-caret" />
          </span>
        </summary>
        <div className="bgwake-body">
          <ul className="sawake-meta-runs">
            {wake.runs.map((run) => (
              <li key={run.runId}>
                {several && <span className="sawake-meta-name">{run.description} · </span>}
                Run <span className="sawake-run-id">{run.runId}</span>
                {cards.has(run.runId) && (
                  <>
                    {' · '}
                    <a
                      href={`#subagent-${run.runId}`}
                      className="sawake-card-link"
                      onClick={(event) => {
                        event.preventDefault();
                        delegateCardOf(run.runId)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
                      }}
                    >
                      ↑ Its SubAgent card
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="bgwake-meta">Changes left in the working tree, uncommitted</div>
          <div className="bgwake-meta">Queued by a SubAgent, not typed by you</div>
          <details className="bgwake-raw">
            <summary>What the agent read</summary>
            <pre>{wake.text}</pre>
          </details>
        </div>
      </details>
      {lone ? (
        <RunOutcome run={lone} />
      ) : (
        <ul className="sawake-runs">
          {wake.runs.map((run) => (
            <RunRow run={run} key={run.runId} />
          ))}
        </ul>
      )}
      {undelivered && <div className="bgwake-undelivered">The session has not confirmed it received this.</div>}
      {steer && <div className="bgwake-steer">{steer}</div>}
      {queued && <div className="bgwake-queued">{queued}</div>}
    </div>
  );
}
