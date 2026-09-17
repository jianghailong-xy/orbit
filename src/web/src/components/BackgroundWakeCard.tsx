import type { ReactNode } from 'react';
import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, CodeOutlined } from '@ant-design/icons';
import type { BackgroundWake, BackgroundWakeJob } from '../lib/backgroundWake';
import { formatSpan } from '../lib/watches';
import { Pre, relTime } from './Transcript';

/** How much of a failed job's output the card shows before folding the rest away. */
const TAIL_LINES = 8;

const isFailed = (job: BackgroundWakeJob) => job.status === 'failed' || job.status === 'killed';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What became of one job, in the words the result line ends with. */
function outcome(job: BackgroundWakeJob): string {
  if (!job.ended) return 'has new output';
  if (job.status === 'killed') return job.killReason ? `was killed: ${job.killReason}` : 'was killed';
  return job.exitCode === null ? `ended ${job.status}` : `exited ${job.exitCode}`;
}

/** What happened, at a glance. */
function title(wake: BackgroundWake): string {
  const { jobs } = wake;
  if (jobs.length === 0) return 'Scheduled wakeup';
  if (jobs.length > 1) return `${jobs.length} background jobs finished`;
  if (!jobs[0].ended) return 'Background job has new output';
  return isFailed(jobs[0]) ? 'Background job failed' : 'Background job finished';
}

/** The one line under it that says how it came out, in words — which is also what the sticky bar at
 *  the top of the transcript names this turn with, so the two say the same thing. */
function summaryText(wake: BackgroundWake): string {
  const { jobs } = wake;
  if (jobs.length === 0) return wake.wakeups[0]?.reason ?? 'It came due.';
  if (jobs.length === 1) return `${jobs[0].description || jobs[0].command} ${outcome(jobs[0])}.`;
  const failed = jobs.filter(isFailed);
  if (failed.length > 0) return `${failed.length} of ${jobs.length} failed.`;
  return jobs.every((job) => job.exitCode === 0)
    ? `All ${jobs.length} exited 0.`
    : `All ${jobs.length} finished.`;
}

/** That same line as the card draws it, with the lone job's name in bold. */
function summary(wake: BackgroundWake): ReactNode {
  const { jobs } = wake;
  if (jobs.length !== 1) return summaryText(wake);
  return (
    <>
      <strong>{jobs[0].description || jobs[0].command}</strong> {outcome(jobs[0])}.
    </>
  );
}

/**
 * A turn the control plane opened because a background job had news, or a wakeup came due
 * (lib/backgroundWake `parseBackgroundWake`) — drawn as the control plane's rather than as a message
 * the user typed, which is what it looked like while the whole block sat unrecognised in a bubble.
 *
 * Built like the card a watch's wake gets (WatchWakeCard), down to the two tones: the brand tint for
 * a job that finished, the warning tint for one that failed or was killed, as Watch triggered and
 * Watch expired take them. What the agent actually read stays one native disclosure away, so it
 * still opens in a static export.
 *
 * The queued tail draws the same card while the wake waits behind the running turn, with the queue's
 * status line at its foot, so it keeps its shape when a runner takes it.
 */
export function BackgroundWakeCard({
  wake,
  seq,
  ts,
  undelivered,
  queued,
  attached,
}: {
  wake: BackgroundWake;
  /** Unset while the wake is still queued: it is no event yet, so ⌘F has nothing to land on. */
  seq?: number;
  ts?: string;
  /** The runner has not confirmed the engine received the turn. */
  undelivered?: boolean;
  /** The queued tail's status line, while the wake still waits for its turn. */
  queued?: ReactNode;
  /**
   * Whatever else the same note carried, as its own folded entry.
   *
   * It rides in the card because nobody typed this turn: delivery appends to a turn whose content
   * is empty, so putting the leftover block back in a user bubble drew an empty bubble under the
   * card — a message with no words in it, signed with the reader's own name.
   */
  attached?: ReactNode;
}) {
  const failed = wake.jobs.some(isFailed);
  // A wakeup's own reason is already the result line when it is all this turn carries.
  const showReason = wake.jobs.length > 0 || wake.wakeups.length > 1;
  return (
    <div className="bgwake-wrap">
      {/* The sticky bar at the top of the transcript names this turn off these two attributes: it
          scans for user bubbles and would otherwise either skip the wake (naming an earlier
          question instead, and scrolling to it) or, as iOS did, call it the person's own. */}
      <div
        className={`bgwake ${failed ? 'is-failed' : 'is-ok'}${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-sticky-label={title(wake)}
        data-sticky-text={summaryText(wake)}
      >
        <div className="bgwake-title">
          {wake.jobs.length === 0 ? <ClockCircleOutlined /> : <CodeOutlined />} {title(wake)}
        </div>
        <div className="bgwake-why">{summary(wake)}</div>
        {wake.jobs.length > 0 && (
          <ul className="bgwake-jobs">
            {wake.jobs.map((job) => (
              <li className="bgwake-job" key={job.id}>
                <div className="bgwake-job-head">
                  <span className={`bgwake-job-mark ${isFailed(job) ? 'is-failed' : job.ended ? 'is-ok' : 'is-running'}`}>
                    {isFailed(job) ? <CloseCircleFilled /> : job.ended ? <CheckCircleFilled /> : <ClockCircleOutlined />}
                  </span>
                  <span className="bgwake-job-name">{job.description || job.command}</span>
                  {job.exitCode !== null && <span className="bgwake-job-exit">exit {job.exitCode}</span>}
                </div>
                {/* The command, when the description already named the row — otherwise the row is it. */}
                {job.description && <div className="bgwake-job-cmd">{job.command}</div>}
                {/* Why it failed is the whole reason this turn woke anybody: the tail comes out of
                    the fold, collapsed past a few lines like any other block of output. */}
                {isFailed(job) && job.outputTail !== '' && <Pre text={job.outputTail} threshold={TAIL_LINES} />}
                <div className="bgwake-job-meta">
                  {job.id}
                  {job.outputTo !== null &&
                    ` · ${job.outputTo === 0 ? 'no output' : `${formatBytes(job.outputTo)} of output`}`}
                </div>
              </li>
            ))}
          </ul>
        )}
        {wake.wakeups.length > 0 && (
          <ul className="bgwake-wakeups">
            {wake.wakeups.map((wakeup, i) => (
              <li className="bgwake-wakeup" key={`${wakeup.dueAt ?? ''}:${i}`}>
                {showReason && wakeup.reason && <div className="bgwake-wakeup-reason">{wakeup.reason}</div>}
                <div className="bgwake-wakeup-meta">
                  {wakeup.delaySeconds !== null && `Asked for ${formatSpan(wakeup.delaySeconds * 1000)} out`}
                  {wakeup.delaySeconds !== null && wakeup.dueAt && ' · '}
                  {wakeup.dueAt && `came due ${relTime(wakeup.dueAt)}`}
                </div>
                {wakeup.prompt !== '' && <Pre text={wakeup.prompt} threshold={TAIL_LINES} />}
              </li>
            ))}
          </ul>
        )}
        <div className="bgwake-meta">
          {wake.jobs.length > 0
            ? 'Queued by a background job, not typed by you'
            : 'Queued by a scheduled wakeup, not typed by you'}
          {ts ? ` · ${relTime(ts)}` : ''}
        </div>
        {undelivered && (
          <div className="bgwake-undelivered">The session has not confirmed it received this.</div>
        )}
        <details className="bgwake-raw">
          <summary>What the agent received</summary>
          <pre>{wake.text}</pre>
        </details>
        {attached}
        {queued && <div className="bgwake-queued">{queued}</div>}
      </div>
    </div>
  );
}
