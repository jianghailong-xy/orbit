import { INTEGRATION_CLAIM_STALE_MS, type IntegrationJobState, type TaskIntegrationView } from '@orbit/shared';
import { DEFAULT_MAIN_BRANCH } from '../lib/projectStart';
import { formatSpan } from '../lib/watches';
import { LANDING_NO_REPORT_YET, jobPhases, landingNoReportFor } from './ProjectPanoramaHeader';

/**
 * A task's newest LAND_TASK, as the server's read model describes it
 * (`docs/project-integration-line-contract.md` §2.7a) — on the task's page and on the project's
 * integration view, in the same words, from the same fields.
 *
 * DONE is the task's status; this is its landing. The two are drawn apart because a DONE task whose
 * work is still waiting, running or stopped is not on its branch yet, and a page that showed only
 * the first read as finished work that had not arrived anywhere.
 *
 * Read-only by design: no retry, merge or release button. Those stay behind the owner-only doors
 * and the exception cards that already hold them; this only says what is happening and why.
 */

type Tone = 'muted' | 'blue' | 'green' | 'red' | 'amber';

/** What each state of a landing attempt is called, wherever one is shown. */
export const LANDING_LABELS: Record<IntegrationJobState, string> = {
  QUEUED: 'Waiting to land',
  RUNNING: 'Landing',
  LANDED: 'Landed',
  ALREADY_LANDED: 'Already landed',
  NOTHING_TO_LAND: 'Nothing to land',
  READY: 'Ready to merge',
  CONFLICT: 'Landing conflict',
  CHECK_FAILED: 'Landing checks failed',
  ERROR: 'Landing error',
  CANCELLED: 'Landing cancelled',
  SUPERSEDED: 'Landing superseded',
};

const TONES: Record<IntegrationJobState, Tone> = {
  QUEUED: 'amber',
  RUNNING: 'blue',
  LANDED: 'green',
  ALREADY_LANDED: 'green',
  NOTHING_TO_LAND: 'muted',
  READY: 'amber',
  CONFLICT: 'red',
  CHECK_FAILED: 'red',
  ERROR: 'red',
  CANCELLED: 'muted',
  SUPERSEDED: 'muted',
};

/**
 * The badge a task's page puts beside its status: the newest attempt when there is one, otherwise
 * where the receipts say the work is — on `main`, the project's main branch by name. Null when the
 * task has no landing to speak of.
 */
export function landingBadge(
  integration: TaskIntegrationView | null | undefined,
  main: string = DEFAULT_MAIN_BRANCH,
): { label: string; tone: Tone } | null {
  const job = integration?.landTask;
  if (job) return { label: LANDING_LABELS[job.state] ?? job.state, tone: TONES[job.state] ?? 'muted' };
  switch (integration?.state) {
    // Done code work on a line whose landing has not been queued yet (§2.3 J-T1d).
    case 'QUEUED': return { label: LANDING_LABELS.QUEUED, tone: TONES.QUEUED };
    case 'ON_INTEGRATION_LINE': return { label: LANDING_LABELS.LANDED, tone: TONES.LANDED };
    case 'ON_UPSTREAM': return { label: `On ${main}`, tone: 'green' };
    default: return null;
  }
}

/** Whether a task's page should keep reading: the landing is waiting or moving. */
export function landingIsLive(integration: TaskIntegrationView | null | undefined): 'RUNNING' | 'QUEUED' | null {
  const state = integration?.landTask?.state ?? integration?.state;
  return state === 'RUNNING' || state === 'QUEUED' ? state : null;
}

const STOPPED = new Set<IntegrationJobState>(['CONFLICT', 'CHECK_FAILED', 'ERROR']);

/** `refs/heads/project/x` as a branch is spoken of. */
function branchOf(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function Instant({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  const at = new Date(value);
  return (
    <time dateTime={value} title={value}>
      {Number.isFinite(at.getTime())
        ? at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
        : value}
    </time>
  );
}

export function LandTaskStatus({
  integration,
  taskStatus,
  now = Date.now(),
  main = DEFAULT_MAIN_BRANCH,
}: {
  integration: TaskIntegrationView;
  /** The task's own status, printed apart from the landing; omitted where the row already says it. */
  taskStatus?: string;
  /** Passed in so a test reads a fixed clock; the hosts give it now. Only the "no report" age uses
   *  it — every other fact here is an instant the server sent. */
  now?: number;
  /** The project's main branch by name, where its work ends up; main where the host holds no read
   *  that names it. */
  main?: string;
}) {
  const badge = landingBadge(integration, main);
  if (!badge) return null;
  const job = integration.landTask ?? null;
  const step = job?.phase && (job.state === 'RUNNING' || STOPPED.has(job.state)) ? jobPhases(main)[job.phase] : null;
  const receipt = integration.state === 'ON_INTEGRATION_LINE' || integration.state === 'ON_UPSTREAM';
  // A claimed job whose runner has gone quiet: no report at all, or none since the claim lease the
  // server itself uses. Said apart from the state and from `blockingReason`, because a silent
  // runner is neither a stop nor a timeout — the job's own verdict is the only thing that ever
  // says "timed out", and it arrives as `blockingReason.summary` below.
  const heartbeat = job?.heartbeatAt ? Date.parse(job.heartbeatAt) : Number.NaN;
  const reported = Number.isFinite(heartbeat);
  const silent = job?.state === 'RUNNING' && (!reported || now - heartbeat > INTEGRATION_CLAIM_STALE_MS);
  const noReport = !silent ? null
    : reported ? landingNoReportFor(Math.max(0, Math.floor((now - heartbeat) / 60_000)))
      : LANDING_NO_REPORT_YET;
  return (
    <div className="land-task-status" data-land-task-state={job?.state ?? integration.state}>
      <div className="land-task-status-head">
        {taskStatus ? <span className="land-task-task-state">Task {taskStatus}</span> : null}
        <span className={`tdp-badge tone-${badge.tone}`}>{badge.label}</span>
        {job ? <span className="land-task-generation">generation {job.generation}</span> : null}
        {step ? <span className="land-task-step">{job!.state === 'RUNNING' ? step : `stopped while ${step}`}</span> : null}
        {noReport ? <span className="land-task-no-report" data-no-report="true">{noReport}</span> : null}
      </div>
      {job?.blockingReason ? (
        <div className="land-task-reason" data-blocking-reason={job.blockingReason.code}>
          {job.blockingReason.summary}
        </div>
      ) : null}
      {!job && integration.state === 'QUEUED' ? (
        <div className="land-task-reason">Waiting to land: the landing has not been queued yet</div>
      ) : null}
      {receipt && job && job.state !== 'LANDED' && job.state !== 'ALREADY_LANDED' ? (
        // A receipt says where the work IS, and no attempt after it takes that back.
        <div className="land-task-receipt">
          Its work is on {integration.state === 'ON_UPSTREAM' ? main : 'the project branch'} by an existing receipt.
        </div>
      ) : null}
      {job ? (
        <dl className="land-task-facts">
          <div><dt>Target</dt><dd><code title={job.targetRef}>{branchOf(job.targetRef)}</code></dd></div>
          <div><dt>Queue wait</dt><dd>{job.waitMs < 1000 ? '0s' : formatSpan(job.waitMs)}</dd></div>
          <div><dt>Queued</dt><dd><Instant value={job.queuedAt} /></dd></div>
          <div><dt>Started</dt><dd><Instant value={job.startedAt} /></dd></div>
          <div><dt>Heartbeat</dt><dd><Instant value={job.heartbeatAt} /></dd></div>
          <div><dt>Finished</dt><dd><Instant value={job.finishedAt} /></dd></div>
        </dl>
      ) : null}
    </div>
  );
}
