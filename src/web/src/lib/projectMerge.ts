import type { ProjectIntegrationInFlight, ProjectLandTask, ProjectPromotionView } from '@orbit/shared';
import { api } from '../api';
import { jobPhases } from '../components/ProjectPanoramaHeader';
import { mainBranchName } from './projectStart';

/**
 * The merge into main on the project's sessions view (owner decision 2026-10-06): the card under the
 * progress strip while a candidate asks, merges or is blocked; the merge check's live line before
 * any of that; the coordinator conversation's one line in place of the card it used to draw; and
 * every merge already made as a row on the view's own timeline.
 *
 * Mirrors OrbitKit's `PromotionCards` page/event/timeline helpers, `ProjectMergeCard` and
 * `ProjectTimeline` word for word — `ProjectMergeCopyParityTests` reads this file.
 */

/** A branch as a person says it: `main`, not `refs/heads/main`. The branch a candidate merges into is
 *  the project's main branch, and every sentence here names it the one way the project page does,
 *  `mainBranchName(promotion.upstreamRef)`. */
function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** The line a candidate that is no longer on offer leaves behind. */
export const NO_LONGER_ON_OFFER = 'This merge is no longer on offer';
/** The trailing word on the conversation's line while the candidate is asking. */
export const REVIEW = 'Review';
/** The page card's badge while it asks. */
export const NEEDS_YOU = 'Needs you';
/** The page card's way into the full review. */
export const DETAILS = 'Details';
/** B's sentence on the page card, where it stands alone rather than as the `You` row's value. */
export const PAGE_NOTHING_TO_DO =
  'Nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t.';
/** The checking card's last line when a pass is merged by the project's Automatic setting. */
export const ON_PASS_MERGES = 'Merges on its own when it passes.';
/** The checking card's last line when a pass puts the asking card in front of the reader. */
export const ON_PASS_ASKS = 'Asks you when it passes.';

/** The way into the round's landing session (contract §2.9 LS6, board v4 04, owner 2026-10-19):
 *  under the merge card while it is confirmed, and beside Cancel while it is being cancelled. The
 *  same words the Landing card and the jobs list use for the same door. */
export const OPEN_LANDING = 'Open landing';
/** The others beside the merge job, when the card does not list them: `+1 job queued`. */
export function moreJobsQueued(count: number): string | null {
  const others = count - 1;
  if (others <= 0) return null;
  return `+${others} job${others === 1 ? '' : 's'} queued`;
}
/** The card's title once the owner has asked a confirmed merge to stop (§3.3 M-T10). */
export const CANCELLING_THE_MERGE = 'Cancelling the merge…';
/** And when the ask came too late: the push is the fact now. */
export const TOO_LATE_TO_CANCEL = 'Too late to cancel — the push has started';
/** What a cancel asked before the push does: the runner stops at its next report. */
export const CANCEL_STOPS_SOON =
  'Stops at the runner’s next report, within 30 s · nothing has been pushed';
/** And that this is not yet an outcome: the push may still start first. */
export const CANCEL_MAY_STILL_MERGE =
  'If the push starts before it stops, the merge goes through and this card says so.';
/** The cancelled-in-progress card's one press, no longer a press. */
export const CANCEL_REQUESTED = 'Cancel requested';
/** The head's clause while a stop has been asked for and not yet answered. */
export const STOP_REQUESTED = 'stop requested';
/** The owner's re-check of a timed-out merge check (J-T9, revision 16), on the merge card. */
export const RERUN_THE_CHECK = 'Re-run the check';
/** And the owner's one press that ends a timed-out round (J-T10, §4.6 X-E5). */
export const ABANDON = 'Abandon';
/** What the re-check records as its reason: the card's own door, not a decision made elsewhere. */
export const RERUN_CHECK_REASON = 'Re-run the timed-out check from the merge card.';
/** The landing page's own Re-run the check (§2.9 LS6): the same door and the same record, naming the page it
 *  was pressed on. The owner route takes a reason (`RetryIntegrationDto.reason`), so a page that pressed it
 *  without one was refused. */
export const RERUN_LANDING_CHECK_REASON = 'Re-run the timed-out check from the landing page.';

/** The owner's abandon of one running job (J-T10): it ends, and nothing is queued again. */
export function abandonJob(projectId: string, jobId: string): Promise<unknown> {
  return api(`/projects/${encodeURIComponent(projectId)}/integration/jobs/${encodeURIComponent(jobId)}/abandon`,
    { method: 'POST' });
}

/** The owner's re-check of a candidate's failed-or-timed-out check (J-T9, §4.7 H1). */
export function recheckPromotion(projectId: string, promotionId: string): Promise<unknown> {
  return api(`/projects/${encodeURIComponent(projectId)}/promotions/${encodeURIComponent(promotionId)}/integration/retry`,
    { method: 'POST', body: { reason: RERUN_CHECK_REASON } });
}

/**
 * The landing session THIS ROUND of merging into main belongs to (§2.9 LS1, LS6): the candidate's
 * own while it carries one (`CHECKING`, `CONFIRMED`, `RECHECKING`), else the active merge job's —
 * the same session, read from the job while the candidate row does not name it.
 */
export function promotionLandingSessionId(
  promotion: ProjectPromotionView | null | undefined,
  integration: { inFlightJobs?: readonly ProjectIntegrationInFlight[] } | null | undefined,
): string | null {
  if (promotion?.landingSessionId) return promotion.landingSessionId;
  const job = (integration?.inFlightJobs ?? []).find((entry) => isMergeJob(entry));
  return job?.landingSessionId ?? null;
}

type Stage = 'asking' | 'merging' | 'merged' | 'blocked';

/** Which of the card's four states a candidate is in, or null for one nothing is waiting on. */
function stage(promotion: ProjectPromotionView | null | undefined): Stage | null {
  switch (promotion?.state) {
    case 'READY':
      return 'asking';
    case 'CONFIRMED':
    case 'RECHECKING':
      return 'merging';
    case 'MERGED':
      return 'merged';
    case 'BLOCKED':
      return 'blocked';
    default:
      return null;
  }
}

/** The two job kinds that are about main: their live line belongs to the merge card, while a task
 *  landing on the project branch keeps the progress strip's line. */
export const MERGE_JOB_KINDS: readonly string[] = ['CHECK_PROMOTION', 'LAND_PROMOTION'];

export function isMergeJob(inFlight: Pick<ProjectIntegrationInFlight, 'kind'> | null | undefined): boolean {
  return inFlight?.kind != null && MERGE_JOB_KINDS.includes(inFlight.kind);
}

export type MergeCardShape = 'checking' | 'asking' | 'merging' | 'blocked';

/** What the sessions view draws under its progress strip about main, or null for nothing. */
export function mergeCardShape(
  promotion: ProjectPromotionView | null | undefined,
  inFlight: Pick<ProjectIntegrationInFlight, 'kind'> | null | undefined,
): MergeCardShape | null {
  const at = stage(promotion);
  if (at === 'asking' || at === 'merging' || at === 'blocked') return at;
  return isMergeJob(inFlight) ? 'checking' : null;
}

/**
 * What the merge check running now leads to when it passes, under its live line (owner decision
 * 2026-10-15, from the 2026-10-06 board docs/mocks/project-merge-sessions-page/02-card-states.html):
 * merged by the project's Automatic setting, or the asking card. The server's answer (`onPass`), as
 * the project stands; null for a candidate that is not being checked, and from a server that does
 * not say.
 */
export function promotionOnPassLine(promotion: ProjectPromotionView | null | undefined): string | null {
  if (promotion?.state !== 'CHECKING') return null;
  if (promotion.onPass === 'MERGE') return ON_PASS_MERGES;
  if (promotion.onPass === 'ASK') return ON_PASS_ASKS;
  return null;
}

/** The card's heading on the sessions view. The branch is the line under it — the view is the
 *  project's own, so the heading says only what is being asked of main. */
export function promotionPageTitle(promotion: ProjectPromotionView): string {
  const into = mainBranchName(promotion.upstreamRef);
  switch (stage(promotion)) {
    case 'asking':
      return `Merge into ${into}?`;
    case 'merging':
      if (promotion.execution?.state === 'QUEUED') return `Merge into ${into} queued`;
      if (promotion.execution?.state !== 'RUNNING') return `Merge into ${into} confirmed`;
      if (promotion.execution.phase === 'CHECK') return `Re-checking before merging into ${into}…`;
      return `Merging into ${into}…`;
    case 'merged':
      return promotion.merged?.automatic ? `✓ Merged into ${into} automatically` : `✓ Merged into ${into}`;
    case 'blocked':
      return `Can’t merge into ${into} yet`;
    default:
      return NO_LONGER_ON_OFFER;
  }
}

/** `2 tasks · 10 files` — what the card carries, under the branch line that says how many commits. */
export function promotionPageCounts(promotion: ProjectPromotionView): string {
  const tasks = plural(promotion.taskIds.length, 'task');
  return promotion.filesChanged != null ? `${tasks} · ${plural(promotion.filesChanged, 'file')}` : tasks;
}

/** The titles of the tasks a candidate carries, at most `limit`, and how many more there are. */
export function promotionTaskTitles(
  promotion: ProjectPromotionView,
  limit = 3,
): { shown: string[]; more: number } {
  const shown = (promotion.tasks ?? []).slice(0, Math.max(0, limit)).map((task) => task.title);
  return { shown, more: Math.max(promotion.taskIds.length, promotion.tasks?.length ?? 0) - shown.length };
}

/** `project/bg-jobs · 7 commits ahead of main`. */
export function promotionBranchLine(promotion: ProjectPromotionView): string {
  const branch = shortRef(promotion.sourceRef);
  if (promotion.commitsAhead == null) return branch;
  return `${branch} · ${plural(promotion.commitsAhead, 'commit')} ahead of ${mainBranchName(promotion.upstreamRef)}`;
}

/** `✓ Checks passed · no conflicts` — the proof the asking card is drawn on, in one line. */
export function promotionChecksSummary(promotion: ProjectPromotionView): { text: string; clean: boolean } {
  const passed = (check: ProjectPromotionView['checks'][number]): boolean =>
    !check.timedOut && check.exitCode === check.expectedExitCode;
  const checks = promotion.checks.length === 0
    ? 'No checks recorded'
    : promotion.checks.some((check) => check.timedOut)
      ? 'Checks timed out'
      : promotion.checks.every(passed) ? '✓ Checks passed' : '✕ Checks failed';
  const upstream = promotion.conflicts.length > 0
    ? `${plural(promotion.conflicts.length, 'file')} conflict with ${mainBranchName(promotion.upstreamRef)}`
    : 'no conflicts';
  return {
    text: `${checks} · ${upstream}`,
    clean: promotion.checks.length > 0 && promotion.checks.every(passed) && promotion.conflicts.length === 0,
  };
}

/** The word the card prints before `promotionBlockedBy`'s sentence. */
export const BLOCKED_BY = 'Blocked by';

/**
 * WHO IS IN FRONT OF THIS MERGE, when the project's own line is busy — the sentence that turns
 * "Coordinator is resolving it" into an answer.
 *
 * A blocked candidate says why IT cannot merge (`promotionBlockedLine`); this says what the platform
 * is doing about the branch until it can. The landings a project has in flight are the project's own
 * read (`ProjectIntegrationView.landTasks`), and one of them is holding the line this merge has to
 * go through — it targets either the branch the candidate merges FROM or the branch it merges INTO.
 * Its `blockingReason` is the server's sentence about what holds THAT landing, and it names the job
 * or the task in front of it, so the chain is read off two rows rather than inferred here: nothing
 * in this function looks at a clock, a heartbeat or a task status.
 *
 * Null when the line is doing nothing on those branches: a card with nothing to name says nothing,
 * rather than inventing a step to point at.
 */
export function promotionBlockedBy(
  promotion: ProjectPromotionView,
  landings: readonly ProjectLandTask[] | null | undefined,
): string | null {
  const sameBranch = (a: string, b: string): boolean => shortRef(a) === shortRef(b);
  const holding = (landings ?? []).find((landing) => {
    const job = landing.integration?.landTask;
    if (!job || (job.state !== 'QUEUED' && job.state !== 'RUNNING')) return false;
    return sameBranch(job.targetRef, promotion.sourceRef) || sameBranch(job.targetRef, promotion.upstreamRef);
  });
  const job = holding?.integration.landTask;
  if (!holding || !job) return null;
  const state = job.state === 'RUNNING'
    ? (job.phase ? jobPhases(mainBranchName(promotion.upstreamRef))[job.phase] ?? 'running' : 'running')
    : 'queued';
  const parts = [
    `“${holding.taskTitle}” is landing on the project line`,
    state,
    job.blockingReason?.summary ?? null,
  ].filter((part): part is string => part !== null);
  return parts.join(' · ');
}

/**
 * D's reason with its files: `2 files conflict with main: a.go, b.go`, three named at most.
 *
 * The reason the job gave comes first (`blockedReason`, migration 0409): a candidate whose branch
 * is already on main, and one whose job errored, are blocked with no checks and no conflicts, and
 * reading those two arrays said a check had failed when none had run. A candidate blocked before the
 * reason was recorded has none, and is read off the two arrays as it always was.
 */
export function promotionBlockedLine(promotion: ProjectPromotionView): string {
  if (promotion.blockedReason === 'ALREADY_LANDED') {
    return `nothing to merge — ${shortRef(promotion.sourceRef)} is already on ${mainBranchName(promotion.upstreamRef)}`;
  }
  if (promotion.blockedReason === 'ERROR') return 'the merge stopped on an error — no check failed';
  if (promotion.conflicts.length === 0) return 'the checks on the combined tree did not pass';
  const n = promotion.conflicts.length;
  const files = promotion.conflicts.slice(0, 3).join(', ');
  return `${plural(n, 'file')} conflict with ${mainBranchName(promotion.upstreamRef)}: ${files}${n > 3 ? ` and ${n - 3} more` : ''}`;
}

/** B's status, by the merge job's own phase. */
export function promotionMergingStatus(promotion: ProjectPromotionView): string {
  const into = mainBranchName(promotion.upstreamRef);
  const execution = promotion.execution;
  if (execution?.state === 'QUEUED') return `confirmed — queued to merge into ${into}`;
  if (execution?.state !== 'RUNNING') return 'confirmed — waiting for merge execution';
  switch (execution.phase) {
    case 'CHECK':
      return promotion.state === 'RECHECKING'
        ? `${into} moved since the check — re-checking the combined tree`
        : 're-checking the combined tree';
    case 'FETCH': return 'confirmed — fetching the branches';
    case 'MAIN_SYNC': return 'confirmed — syncing the branches';
    case 'REBASE': return 'confirmed — rebasing the branch';
    case 'MERGE': return 'confirmed — preparing the combined tree';
    case 'VERIFY': return 'confirmed — verifying the tested tree';
    case 'PUSH': return `confirmed — publishing the tested tree to ${into}`;
    default: return 'confirmed — starting the merge';
  }
}

/** `+2 more`, under the titles — null when they were all named. */
export function moreTasks(more: number): string | null {
  return more > 0 ? `+${more} more` : null;
}

export type PromotionEventTone = 'needsYou' | 'working' | 'blocked' | 'quiet';

/** D's reason in a few words, for a line too short for the files — the job's own reason first, as
 *  in `promotionBlockedLine`. */
export function promotionBlockedReason(promotion: ProjectPromotionView): string {
  if (promotion.blockedReason === 'ALREADY_LANDED') return 'nothing to merge';
  if (promotion.blockedReason === 'ERROR') return 'check errored';
  return promotion.conflicts.length > 0 ? `${plural(promotion.conflicts.length, 'file')} conflict` : 'checks failed';
}

/** The coordinator conversation's one line for a candidate: same states, same words as the card
 *  on the sessions view, orange only while it waits on the reader. */
export function promotionEventLine(
  promotion: ProjectPromotionView | null | undefined,
): { text: string; tone: PromotionEventTone } {
  const at = stage(promotion);
  if (!promotion || at === null) return { text: NO_LONGER_ON_OFFER, tone: 'quiet' };
  switch (at) {
    case 'asking':
      return { text: `Merge into ${mainBranchName(promotion.upstreamRef)} is waiting for you`, tone: 'needsYou' };
    case 'merging':
      return { text: promotionPageTitle(promotion), tone: 'working' };
    case 'blocked':
      return { text: `${promotionPageTitle(promotion)} · ${promotionBlockedReason(promotion)}`, tone: 'blocked' };
    case 'merged':
      return { text: promotionReceiptLine(promotion), tone: 'quiet' };
  }
}

/** The record's one line in the conversation: `✓ Merged into main · 8d5a868 · 2 tasks`, and
 *  ` · automatically` when nobody pressed Merge. */
export function promotionReceiptLine(promotion: ProjectPromotionView): string {
  return [
    `✓ Merged into ${mainBranchName(promotion.upstreamRef)}`,
    promotion.merged ? promotion.merged.sha.slice(0, 7) : null,
    plural(promotion.taskIds.length, 'task'),
    promotion.merged?.automatic ? 'automatically' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** The timeline row's heading; the check mark is the row's icon. */
export function promotionTimelineTitle(promotion: ProjectPromotionView): string {
  return `Merged into ${mainBranchName(promotion.upstreamRef)}`;
}

/** The timeline row's second line: `8d5a868 · 2 tasks · by you`, or `· automatically`. */
export function promotionTimelineDetail(promotion: ProjectPromotionView): string {
  return [
    promotion.merged ? promotion.merged.sha.slice(0, 7) : null,
    plural(promotion.taskIds.length, 'task'),
    promotion.merged?.automatic ? 'automatically' : 'by you',
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** `5 commits · 10 files`, the receipt's size row — null when the read gave neither. */
export function promotionChangesLine(promotion: ProjectPromotionView): string | null {
  const parts = [
    promotion.commitsAhead != null ? plural(promotion.commitsAhead, 'commit') : null,
    promotion.filesChanged != null ? plural(promotion.filesChanged, 'file') : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}
