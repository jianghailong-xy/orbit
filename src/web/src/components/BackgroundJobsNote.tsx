import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled } from '@ant-design/icons';
import type { BackgroundJobRow, BackgroundJobs } from '../lib/backgroundJobs';

/**
 * The `<background-jobs>` block a returning engine is handed, as rows rather than as the block's own
 * `｜`-separated lines (lib/backgroundJobs `parseBackgroundJobs`).
 *
 * It stays inside the folded entry under the person's words — the block is context appended to their
 * message, not a turn of its own, so it never becomes a card the way a wake does (BackgroundWakeCard).
 * What changes is only what opening the fold shows: the outcome first, the command as the row, the
 * ids last, and the two sentences addressed to the agent — along with the absolute output paths and
 * the Monitor section — back behind the verbatim fold they were always meant to be read from.
 */
export function BackgroundJobsNote({ jobs }: { jobs: BackgroundJobs }) {
  return (
    <div className="bgjobs">
      <Section title="Still running" jobs={jobs.running} />
      <Section title="Ended while you were away" jobs={jobs.ended} />
      <details className="bgjobs-raw">
        <summary>What the agent received</summary>
        <pre>{jobs.text}</pre>
      </details>
    </div>
  );
}

function Section({ title, jobs }: { title: string; jobs: BackgroundJobRow[] }) {
  if (jobs.length === 0) return null;
  return (
    <>
      <div className="bgjobs-group">{title}</div>
      <ul className="bgjobs-list">
        {jobs.map((job) => (
          <li className="bgjobs-job" key={job.id}>
            <div className="bgjobs-head">
              <span className={`bgjobs-mark ${mark(job)}`}>
                {job.status === '' ? (
                  <ClockCircleOutlined />
                ) : job.status === 'completed' ? (
                  <CheckCircleFilled />
                ) : (
                  <CloseCircleFilled />
                )}
              </span>
              {/* The command is the row: a job carries no description here, and three rows headed
                  by their kind would all read "job". Clamped in CSS — the whole of a forty-line
                  heredoc is in the fold below. */}
              <span className="bgjobs-name">{job.command || job.id}</span>
              {outcome(job) && <span className="bgjobs-outcome">{outcome(job)}</span>}
            </div>
            <div className="bgjobs-meta">
              {job.id} · {job.kind}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

const mark = (job: BackgroundJobRow) =>
  job.status === '' ? 'is-running' : job.status === 'completed' ? 'is-ok' : 'is-failed';

/** How it came out, in the block's own words: an exit code, or the status and why. */
function outcome(job: BackgroundJobRow): string {
  if (job.exitCode !== null) return `exit ${job.exitCode}`;
  if (job.status === '') return '';
  return job.reason ? `${job.status} · ${job.reason}` : job.status;
}
