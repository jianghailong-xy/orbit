import { Prisma } from '@prisma/client';
import { uuidToBase62, type IntegrationCheckResult } from '@orbit/shared';

import { LANDING_FIX_TURN_KEY_PREFIX } from '../sessions/watch-turn-key';
import { shortBranchName } from './project-integration-job';

/**
 * The landing-fix turn (docs/project-integration-line-contract.md §12.5 W6, revision 42): a failed
 * landing of a task, handed to the work session that wrote the work, as one platform turn.
 *
 * Its key is the job's (`landing-fix:v1:<jobId>`): one failed job is one turn, however often it is
 * delivered. Its words come only from rows that no longer change once the job has ended (G6) — the
 * job's own result (its state, phase, refs, commits, conflicting files and checks), the failure lines
 * the runner wrote into `project_integration_job_log` for the red check (`integrate.go#addFailureLines`),
 * the landing session the attempt belongs to, and the task's title as the item that handed it off
 * recorded it. A replay therefore says the same thing byte for byte, and `createTurn` compares it.
 */
export const LANDING_FIX_TURN_PREFIX = LANDING_FIX_TURN_KEY_PREFIX;

export function landingFixTurnId(jobId: string): string {
  return `${LANDING_FIX_TURN_PREFIX}${jobId}`;
}

/** The heading the runner puts above the failure lines it found in a check's whole output. */
export const FAILURE_LINES_HEADING = 'Failure lines from the whole output:';

/** What the turn says, as read from the immutable rows. */
export interface LandingFixFacts {
  taskTitle: string;
  state: 'CONFLICT' | 'CHECK_FAILED';
  phase: string | null;
  targetBranch: string;
  upstreamBranch: string;
  targetSha: string | null;
  /** The upstream tip the job read. Equal to `targetSha` on a line that does not exist on origin yet. */
  upstreamSha: string | null;
  conflicts: string[];
  check: { name: string; command: string; exitCode: number | null; url?: string | null } | null;
  /** The pull request a required GitHub check failed on (docs/design/protected-branch-landing.md §4.5, J-T16). */
  pullRequest?: { number: number; url: string; headSha: string } | null;
  testedSha: string | null;
  failureLines: string[];
  landingSessionId: string | null;
}

/** The item that handed the failure off, as far as the turn reads it. */
export interface LandingFixItem {
  integrationJobId: string;
  title: string;
  payload: unknown;
}

const CHECK_LABELS: Record<string, string> = {
  TASK_ACCEPTANCE: 'task acceptance',
  MERGE_CHECK: 'merge check',
  LANDING_CHECK: 'landing check',
};

/** The check that made a CHECK_FAILED red: the first combined-tree check that ran and missed its exit. */
export function failedCheckOf(checks: unknown): IntegrationCheckResult | null {
  if (!Array.isArray(checks)) return null;
  return (checks as IntegrationCheckResult[]).find((check) => check
    && check.scope !== 'BASELINE'
    && !check.skipped
    && (check.timedOut || check.exitCode !== check.expectedExitCode)) ?? null;
}

/** The lines under the last failure heading in `text`, or null when it has none. */
export function failureLinesIn(text: string | null | undefined): string[] | null {
  if (!text) return null;
  const at = text.lastIndexOf(FAILURE_LINES_HEADING);
  if (at < 0) return null;
  return text.slice(at + FAILURE_LINES_HEADING.length).split('\n').filter((line) => line.trim() !== '');
}

/**
 * Read the facts of the failed job the item names. Null when the job is not a CONFLICT or a
 * CHECK_FAILED any more — which a terminal job never stops being, so null means the item names no such job.
 */
export async function readLandingFixFacts(
  db: Prisma.TransactionClient,
  item: LandingFixItem,
): Promise<LandingFixFacts | null> {
  const job = await db.projectIntegrationJob.findUnique({
    where: { id: item.integrationJobId },
    select: {
      state: true, phase: true, targetRef: true, upstreamRef: true, targetShaBefore: true, upstreamSha: true,
      testedSha: true,
      conflicts: true, checks: true, claimGeneration: true, round: true, landingId: true,
    },
  });
  if (!job || (job.state !== 'CONFLICT' && job.state !== 'CHECK_FAILED')) return null;
  const check = job.state === 'CHECK_FAILED' ? failedCheckOf(job.checks) : null;
  let failureLines: string[] = [];
  if (check) {
    // The log first: it holds the failure section as the runner uploaded it, beside the whole output. The
    // check's own tail carries the same section, and is what an older runner left.
    // Only this check's own log, by its place in the run (the runner's `index`, its position in `checks`): a red
    // LANDING_CHECK is run once more on the baseline under the same name, and that run's whole output, read after
    // this one's failure heading, was taken for failure lines — past the turn's size limit, so nothing was delivered.
    const checkIndex = (job.checks as unknown[]).indexOf(check) + 1;
    const rows = await db.$queryRaw<Array<{ text: string }>>(Prisma.sql`
      SELECT "text" FROM "project_integration_job_log"
       WHERE "job_id" = ${item.integrationJobId}::uuid
         AND "claim_generation" = ${job.claimGeneration}
         AND "round" = ${job.round ?? 1}
         AND "check_name" = ${check.name}
         AND "check_index" = ${checkIndex}
       ORDER BY "seq" ASC`);
    failureLines = failureLinesIn(rows.map((row) => row.text).join(''))
      ?? failureLinesIn(check.outputTail)
      ?? [];
  }
  const landing = job.landingId
    ? await db.projectLanding.findUnique({ where: { id: job.landingId }, select: { sessionId: true } })
    : null;
  const payload = (item.payload ?? {}) as { taskTitle?: unknown; landingSessionId?: unknown };
  return {
    taskTitle: typeof payload.taskTitle === 'string' ? payload.taskTitle : item.title,
    state: job.state,
    phase: job.phase,
    targetBranch: shortBranchName(job.targetRef),
    upstreamBranch: shortBranchName(job.upstreamRef),
    targetSha: job.targetShaBefore,
    upstreamSha: job.upstreamSha,
    conflicts: job.conflicts,
    check: check
      ? { name: check.name, command: check.command, exitCode: check.exitCode, ...(check.github ? { url: check.github.url } : {}) }
      : null,
    ...(check?.github ? { pullRequest: { ...check.github.pullRequest, headSha: check.github.headSha } } : {}),
    testedSha: job.testedSha,
    failureLines,
    landingSessionId: landing?.sessionId
      ?? (typeof payload.landingSessionId === 'string' ? payload.landingSessionId : null),
  };
}

/**
 * W6's pull request variant (docs/design/protected-branch-landing.md §4.5): a required check GitHub ran on the
 * landing's pull request failed, the pull request stays open, and the fix lands into it.
 */
function pullRequestLandingFixMessage(facts: LandingFixFacts, pr: { number: number; url: string; headSha: string }): string {
  const target = facts.targetBranch;
  const which = `pull request #${pr.number}`;
  return [
    `Orbit could not land your work for "${facts.taskTitle}" on ${target}.`,
    '',
    `The required check "${facts.check?.command ?? 'a check'}" failed on ${which} (${pr.headSha.slice(0, 7)}):`,
    ...(facts.failureLines.length > 0 ? facts.failureLines : ['(GitHub gave no failure lines; the full log is at the link below)']),
    `Full log: ${facts.check?.url ?? pr.url}`,
    '',
    `Nothing was merged. ${target} is unchanged, and ${which} stays open: ${pr.url}`,
    '',
    'Fix it on your own branch, in this checkout:',
    '1. Run what failed until it passes.',
    '2. Commit, then end your turn.',
    '',
    `Orbit updates ${which} with your commit, and GitHub runs the checks again. Do not push ${target}.`,
    'If this is not yours to fix, end your turn without committing and say why; '
      + 'the project\'s coordinator takes it from there.',
    `The full record: landing ${facts.landingSessionId ? uuidToBase62(facts.landingSessionId) : 'not recorded'}.`,
  ].join('\n');
}

/** The turn's words (§12.5 W6). Product copy: English. */
export function landingFixMessage(facts: LandingFixFacts): string {
  if (facts.state === 'CHECK_FAILED' && facts.pullRequest) return pullRequestLandingFixMessage(facts, facts.pullRequest);
  const target = facts.targetBranch;
  const upstream = facts.upstreamBranch !== target ? facts.upstreamBranch : null;
  // A line that does not exist on origin yet starts at the upstream's tip (the runner reads its T0 as U), and
  // there is no line branch to merge. The same words fit a line sitting at that tip: merging it adds nothing.
  const lineAtUpstream = upstream !== null && facts.targetSha !== null && facts.targetSha === facts.upstreamSha;
  const toMerge = lineAtUpstream ? upstream : `${target}${upstream ? ` and ${upstream}` : ''}`;
  const failure = facts.state === 'CONFLICT'
    ? [
        `Conflict while ${conflictVerb(facts.phase, facts.upstreamBranch)} ${target}`
          + `${facts.targetSha ? ` at ${facts.targetSha}` : ''}:`,
        facts.conflicts.length > 0 ? facts.conflicts.join(', ') : '(the runner named no files)',
      ]
    : [
        `The check "${facts.check ? CHECK_LABELS[facts.check.name] ?? facts.check.name : 'a check'}"`
          + `${facts.check?.command ? ` (${facts.check.command})` : ''} failed on the combined tree`
          + `${facts.testedSha ? ` (${facts.testedSha})` : ''}, `
          + `${facts.check?.exitCode != null ? `exit ${facts.check.exitCode}` : 'no exit code'}:`,
        ...(facts.failureLines.length > 0
          ? facts.failureLines
          : ['(no failure lines were recorded; the full output is in the landing record)']),
      ];
  return [
    `Orbit could not land your work for "${facts.taskTitle}" on ${target}.`,
    '',
    ...failure,
    '',
    `Nothing was pushed. ${target} is unchanged.`,
    '',
    'Fix it on your own branch, in this checkout:',
    `1. Merge ${toMerge} into your branch and resolve what conflicts.`,
    '2. Run what failed until it passes.',
    '3. Commit, then end your turn.',
    '',
    `Orbit lands the new commit and runs the checks again by itself. Do not push ${target}.`,
    'If this is not yours to fix, end your turn without committing and say why; '
      + 'the project\'s coordinator takes it from there.',
    `The full record: landing ${facts.landingSessionId ? uuidToBase62(facts.landingSessionId) : 'not recorded'}.`,
  ].join('\n');
}

function conflictVerb(phase: string | null, upstream: string): string {
  switch (phase) {
    case 'REBASE': return 'rebasing onto';
    case 'MAIN_SYNC': return `syncing ${upstream} into`;
    default: return 'merging into';
  }
}
