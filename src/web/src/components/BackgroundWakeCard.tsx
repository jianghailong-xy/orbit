import type { ReactNode } from 'react';
import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, DownOutlined, RightOutlined } from '@ant-design/icons';
import { stripAnsi } from '../lib/ansi';
import type { BackgroundWake, BackgroundWakeJob } from '../lib/backgroundWake';
import { formatSpan } from '../lib/watches';
import { Pre, relTime } from './Transcript';

/** Scheduled wakeup prompts keep the existing text-line fold inside their details. */
const TAIL_LINES = 8;

const isFailed = (job: BackgroundWakeJob) => job.status === 'failed' || job.status === 'killed';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** How one job came out, as the word its row closes on — null while it has only written something. */
function status(job: BackgroundWakeJob): string | null {
  if (job.status === 'killed') return job.killReason ? `killed: ${job.killReason}` : 'killed';
  if (job.exitCode !== null) return `exit ${job.exitCode}`;
  return job.ended ? job.status : null;
}

/** What happened, at a glance. */
function title(wake: BackgroundWake): string {
  const { jobs } = wake;
  if (jobs.length === 0) return 'Scheduled wakeup';
  if (jobs.length > 1) return `${jobs.length} background jobs finished`;
  if (!jobs[0].ended) return 'Background job has new output';
  return isFailed(jobs[0]) ? 'Background job failed' : 'Background job finished';
}

/** What the line names after its title: the one job, or why the wakeup was asked for. Several jobs
 *  are counted by the title and named in the fold. */
function lineName(wake: BackgroundWake): string | null {
  const { jobs } = wake;
  if (jobs.length === 1) return jobs[0].description || jobs[0].command;
  if (jobs.length === 0) return wake.wakeups[0]?.reason ?? null;
  return null;
}

/** The word the line closes on: the one job's, or how many of several failed. */
function lineStatus(wake: BackgroundWake): string | null {
  const { jobs } = wake;
  if (jobs.length === 1) return status(jobs[0]);
  const failed = jobs.filter(isFailed);
  return failed.length > 0 ? `${failed.length} of ${jobs.length} failed` : null;
}

function JobMark({ job }: { job: BackgroundWakeJob }) {
  if (isFailed(job)) return <CloseCircleFilled />;
  return job.ended ? <CheckCircleFilled /> : <ClockCircleOutlined />;
}

/** Native disclosure also works in a static export; CSS bounds wrapped output to three lines. */
function FailedOutput({ text }: { text: string }) {
  const clean = stripAnsi(text);
  return (
    <details className="bgwake-output">
      <summary aria-label="输出末尾">
        <span className="bgwake-output-label">输出末尾</span>
        <span className="chat-pre bgwake-output-preview">{clean}</span>
        <span className="bgwake-output-action">
          <span className="bgwake-output-expand">展开输出</span>
          <span className="bgwake-output-collapse">收起输出</span>
          <DownOutlined />
        </span>
      </summary>
      <pre className="chat-pre bgwake-output-full">{clean}</pre>
    </details>
  );
}

/**
 * A turn the control plane opened because a background job had news, or a wakeup came due
 * (lib/backgroundWake `parseBackgroundWake`), drawn as one event line in the agent's stream — the
 * grammar `⊘ interrupted` already uses — rather than as a card on the reader's side of the
 * conversation. The card it replaced sat where the person's own messages sit, in their tint, so a
 * run of wakes read as somebody cutting in and split one answer into pieces; a quarter of the turns
 * on that side of this deployment's transcripts were wakes, and after nearly all of them the agent
 * simply carried on with the same work.
 *
 * It is no anchor for the sticky bar (no `data-sticky-label`): the bar keeps naming the question the
 * answer around it belongs to. The command, the ids, who queued it and what the agent read open
 * beneath it, behind a native disclosure so they still open in a static export. A failure stays
 * loud: the line takes the error tone and the output's tail stays out of the fold, since that is
 * what woke anybody.
 *
 * The queued tail draws the same line while the wake waits behind the running turn, dashed, with
 * the queue's status line under it, so it keeps its shape when a runner takes it.
 *
 * A job that ended while a turn was running is written into that turn (a steer), so its line sits in
 * the running turn's own stream, and how far it got is the line's to say — using a steer's delivery
 * state (lib/steerDelivery), with a compact receipt once confirmed.
 */
export function BackgroundWakeCard({
  wake,
  seq,
  ts,
  undelivered,
  queued,
  steer,
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
  /** How far a wake written into the running turn has got (`steerDeliveryState(...).label`). */
  steer?: string;
  /**
   * Whatever else the same note carried, as its own folded entry.
   *
   * It rides in the fold because nobody typed this turn: delivery appends to a turn whose content
   * is empty, so putting the leftover block back in a user bubble drew an empty bubble under the
   * wake — a message with no words in it, signed with the reader's own name.
   */
  attached?: ReactNode;
}) {
  const failed = wake.jobs.some(isFailed);
  // A wakeup, or a job that has only written something: nothing has come out either way yet.
  const pending = !failed && (wake.jobs.length === 0 || wake.jobs.some((job) => !job.ended));
  const several = wake.jobs.length > 1;
  const name = lineName(wake);
  // A job started without a description is named by its command: one line of it here, all of it
  // in the fold.
  const nameIsCommand = wake.jobs.length === 1 && !wake.jobs[0].description;
  const closing = lineStatus(wake);
  return (
    <div className={`bgwake ${failed ? 'is-failed' : 'is-ok'}${queued ? ' is-queued' : ''}`} data-seq={seq}>
      <details className="bgwake-fold">
        <summary className="bgwake-row">
          <span className={`bgwake-mark${pending ? ' is-pending' : ''}`}>
            {failed ? <CloseCircleFilled /> : pending ? <ClockCircleOutlined /> : <CheckCircleFilled />}
          </span>
          <span className="bgwake-title">{title(wake)}</span>
          {name && <span className={`bgwake-name${nameIsCommand ? ' is-command' : ''}`}>{name}</span>}
          {closing && <span className="bgwake-status">{closing}</span>}
          {ts && <span className="bgwake-time">{relTime(ts)}</span>}
          <span className="bgwake-details-label">
            {wake.jobs.length > 0 ? '任务详情' : '详情'}
            <RightOutlined className="bgwake-caret" />
          </span>
        </summary>
        <div className="bgwake-body">
          {wake.jobs.length > 0 && (
            <ul className="bgwake-jobs">
              {wake.jobs.map((job) => (
                <li className="bgwake-job" key={job.id}>
                  {/* A lone job is the line itself, so its row here only names it in full where a
                      description did the naming; several each name themselves, with how they ended. */}
                  {(several || job.description) && (
                    <div className="bgwake-job-head">
                      {several && (
                        <span className={`bgwake-job-mark ${isFailed(job) ? 'is-failed' : job.ended ? 'is-ok' : 'is-running'}`}>
                          <JobMark job={job} />
                        </span>
                      )}
                      <span className="bgwake-job-name">{job.description || job.command}</span>
                      {several && status(job) && <span className="bgwake-job-exit">{status(job)}</span>}
                    </div>
                  )}
                  {/* The command, whenever the row above did not already spell it out. */}
                  {(job.description || !several) && <div className="bgwake-job-cmd">{job.command}</div>}
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
          )}
          <div className="bgwake-meta">
            {wake.jobs.length > 0
              ? 'Queued by a background job, not typed by you'
              : 'Queued by a scheduled wakeup, not typed by you'}
          </div>
          <details className="bgwake-raw">
            <summary>What the agent received</summary>
            <pre>{wake.text}</pre>
          </details>
          {attached}
        </div>
      </details>
      {/* The failure stays visible while its output and job metadata unfold independently. */}
      {wake.jobs.filter((job) => isFailed(job) && job.outputTail !== '').map((job) => (
        <div className="bgwake-tail" key={job.id}>
          {several && <div className="bgwake-tail-name">{job.description || job.command}</div>}
          <FailedOutput text={job.outputTail} />
        </div>
      ))}
      {undelivered && <div className="bgwake-undelivered">The session has not confirmed it received this.</div>}
      {steer && <div className="bgwake-steer">{steer === 'Sent into this turn' ? '已送达当前轮次' : steer}</div>}
      {queued && <div className="bgwake-queued">{queued}</div>}
    </div>
  );
}
