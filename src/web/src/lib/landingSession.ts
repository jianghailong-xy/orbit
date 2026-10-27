import type {
  IntegrationJobKind,
  IntegrationTimelineEntry,
  IntegrationTimelineSection,
  ProjectPromotionView,
  SessionLandingView,
} from '@orbit/shared';
import {
  LANDING_LIVENESS_WORDS,
  jobPhases,
  jobWords,
  landingClock,
  landingClockTime,
  landingRoundClause,
} from '../components/ProjectPanoramaHeader';
import { DEFAULT_MAIN_BRANCH, mainBranchName } from './projectStart';
import { routeId } from './idCodec';

/**
 * One landing in a project's Landings window (contract §2.9 LS1, LS6, LS7; design §3; mockups v4
 * `docs/mocks/landing-session/v4/05-landing-session-page`, and since revision 28 the window of
 * `docs/mocks/landings-one-window`): what a LANDING session's card and its record say, and the
 * conditions its owner doors appear under. The single landing page these were drawn on is now the
 * window focused on that landing.
 *
 * Everything here is read from `GET /sessions/:id`'s landing view — the subject, its newest
 * attempt, the phase/round/check facts the runner reported, and the timeline the server already
 * wrote in English. The one exception is the merge round's own sentence (`onPass`) and the
 * receipt a settled round shows: those are the promotion row's, read beside the landing the way
 * the merge card reads it, because the landing view neither copies a decision (LS4) nor carries
 * the candidate's tasks.
 *
 * Words live here once so the three clients can say the same thing: web defines them, OrbitKit's
 * copy-parity tests read this file, and Kotlin may only use the Swift set.
 */

/**
 * What the page says. The landing view has no words of its own — the timeline's sentences are
 * the server's — so every client-visible literal this page adds is here.
 */
export const LANDING_PAGE_COPY = {
  /** The page's own word for the subject, beside the title (mockup 05's `Landing` chip). */
  CHIP: 'Landing',
  RUN_BY_ORBIT: 'Run by Orbit',

  /** A TASK subject's title when no session row exists yet and the task is not read. */
  LAND: 'Land',
  /** A PROMOTION subject's title while its row does not exist: `Merge project/<id> → main · #n`. */
  MERGE_ROUND: 'Merge project',
  INTO_MAIN: 'main',

  LANDED: 'Landed',
  ALREADY_LANDED: 'Already landed',
  NOTHING_TO_LAND: 'Nothing to land',
  HANDLED: 'Handled',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
  DELETED: 'Deleted',
  MERGED_INTO: 'Merged into',
  NOW_ON: 'Now on',
  LANDED_ON: 'Landed on',
  ALREADY_ON: 'Already on',
  NOT_LANDED: 'Not landed',
  NOT_MERGED: 'Not merged',
  READY: 'Ready',
  PASSED_CHECK: 'Passed the check · waiting for the owner',
  PASSED_ON_THE_TREE: '✓ Passed on the combined tree',
  LANDED_EXACTLY: 'Landed exactly the tested tree',
  AS_A_MERGE_COMMIT: 'as a merge commit',
  BY_FAST_FORWARD: 'by fast-forward',
  AUTOMATICALLY: 'automatically',
  BY_YOU: 'by you',

  QUEUED: 'queued',
  CANCELLING: 'Cancelling',
  TIMED_OUT: 'Timed out',
  UPDATE_UNAVAILABLE: 'Update unavailable',
  TASK_ACCEPTANCE: 'Task acceptance',
  MERGE_CHECK: 'Merge check',
  RUNNING: 'running',
  CHECKS_FAILED: 'checks failed',
  EXIT: 'exit',
  AFTER: 'after',
  ON_THE_COMBINED_TREE: 'on the combined tree',
  NOTHING_PUSHED_CLAUSE: 'nothing was pushed',
  STOPPED_WITH_AN_ERROR: 'Stopped with an error',
  COULD_NOT_MERGE: 'Could not merge',
  CONFLICT: 'conflict',
  STOPPED_NOT_LANDED: 'Stopped · not landed',
  TASK_ACCEPTANCE_EXITED: (code: string, expected: string): string =>
    `Task acceptance exited ${code} (expected ${expected}) on the combined tree`,
  CHECKS_TIMED_OUT: 'A check timed out on the combined tree',

  /** The timed-out card's one line about the claim: who took it, when, and where it stopped. */
  TOOK_IT_AT: 'took it at',
  STOPPED_AT: 'stopped at',
  THE_RUNNER: 'The runner',
  RUNNER: 'Runner',
  NO_REPORT_FOR: 'No report for',
  NO_REPORT_FROM: 'No report from',
  SINCE: 'since',
  LIMIT: 'limit',
  NOTHING_WAS_PUSHED: 'Nothing was pushed',
  MAY_HAVE_BEEN_PUSHED: 'May have been pushed',
  NOTHING_PUSHED_SENTENCE:
    'Nothing was pushed — the runner reports before it pushes, and it never did.',
  MAY_HAVE_PUSHED_SENTENCE:
    'May have been pushed — an older runner reports only between steps, so Orbit can’t rule it out.',
  MAY_HAVE_PUSHED_AT: (time: string): string =>
    `May have been pushed — it reported starting the push at ${time}, then went silent.`,

  /** The menu and the two presses that leave this page (design §3, LS6). */
  OPEN_TASK: 'Open Task',
  OPEN_SOURCE_SESSION: 'Open Source Session',
  OPEN_COORDINATOR: 'Open Coordinator',
  /** The footer's way in, which the board draws with a lower-case word. */
  OPEN_COORDINATOR_LINK: 'Open coordinator',
  REVIEW_CARD: 'Review Card',
  STOP_LANDING: 'Stop Landing',
  CANCEL_MERGE: 'Cancel Merge',
  ABANDON: 'Abandon',
  RETRY: 'Retry',
  RERUN_THE_CHECK: 'Re-run the check',
  BEFORE_PUSH_ONLY: 'Before the push only · nothing pushed yet',
  CANCEL_BEFORE_PUSH: 'Before the push only · stops at the runner’s next report',
  ENDS_NOTHING_PUSHED: 'Ends this attempt · nothing was pushed',
  ENDS_MAY_HAVE_PUSHED: 'Ends this attempt · it may have been pushed',
  STOP_FAILED: 'Stop failed',
  CANCEL_FAILED: 'Cancel failed',
  ABANDON_FAILED: 'Abandon failed',
  RETRY_FAILED: 'Retry failed',
  RERUN_FAILED: 'Re-run failed',
  RERUN_END: 'Re-run ends this check and queues the next one on the same candidate.',
  ABANDON_END: 'Abandon only ends it; the candidate goes back to you.',
  NO_RETRY_MERGE:
    'No Retry: a confirmed merge ends by Abandon, or finishes when a new process on the runner takes it over.',
  LEGACY_PUSH_VARIANT:
    'An older runner (reports only between steps): may have been pushed — Orbit can’t rule it out.',

  LOADING_LANDING: 'Loading this landing…',
  LOADING_LOG: 'Loading the log…',
  LOG_UNAVAILABLE: 'Couldn’t read this log',
  LOG_EMPTY: 'This check printed nothing.',
  SHOW_MORE: 'Show more',
  LOG: 'Log',
  OLDER_ATTEMPTS_HIDDEN: 'Older attempts are not shown here.',
  BYTES_OMITTED: (bytes: number): string => `${bytes} bytes omitted`,
  /** The window's read-only footer names who decides (LS6: nothing to type here). */
  DECISIONS_THE_COORDINATOR: 'Decisions: the coordinator',
} as const;

/**
 * Whether a detail is a landing (LS6). The renderer is chosen by this and by nothing on a list
 * row: a list row's `kind` is `'session'`/`'project'`, and `sessionKind` is the detail's own flag.
 */
export function isLandingSessionDetail<T extends { sessionKind?: string | null }>(
  detail: T | null | undefined,
): detail is T & { sessionKind: 'LANDING' } {
  return detail?.sessionKind === 'LANDING';
}

/** The read a card is drawn from: when this device last got an answer, and whether that read failed. */
export interface LandingObservation {
  updatedAt?: number;
  failed?: boolean;
}

/** The read-time facts §7.2 V6 takes from the project's integration read (the landing view does not
 *  carry them): the step's start, the merge check's usual duration, and the project's main branch. */
export interface LandingFacts {
  stepStartedAt?: string | null;
  typicalMs?: number | null;
  main?: string | null;
}

const MINUTE = 60_000;
const LEASE_STALE_MS = 90_000;

/** Whether this device has lost the server: its last read failed, or is more than 90 s old. */
export function landingReadUnavailable(now: number, observation: LandingObservation): boolean {
  const stale = observation.updatedAt !== undefined && now - observation.updatedAt > LEASE_STALE_MS;
  return observation.failed === true || stale;
}

/**
 * §2.7a's cadence for a landing page: a RUNNING attempt four seconds, a queued one (or a stopped
 * one waiting for its next attempt) fifteen, and nothing once the subject has settled.
 */
export function landingRefetchMs(
  landing: Pick<SessionLandingView, 'settledAt' | 'currentAttempt'> | null | undefined,
): number | false {
  if (!landing || landing.settledAt) return false;
  return landing.currentAttempt?.state === 'RUNNING' ? 4_000 : 15_000;
}

/** The page title: the session row's own (server-managed) title, or the one the view can spell. */
export function landingHeaderTitle(
  landing: SessionLandingView | null | undefined,
  rowTitle: string | null | undefined,
  taskTitle?: string | null,
): string {
  if (rowTitle) return rowTitle;
  if (!landing) return LANDING_PAGE_COPY.CHIP;
  if (landing.subject === 'PROMOTION') {
    const project = routeId(landing.projectId) ?? landing.projectId;
    return `${LANDING_PAGE_COPY.MERGE_ROUND} ${project} → ${LANDING_PAGE_COPY.INTO_MAIN} · #${landing.episode}`;
  }
  return taskTitle ? `${LANDING_PAGE_COPY.LAND} · ${taskTitle}` : LANDING_PAGE_COPY.LAND;
}

function instant(value: string | null | undefined): number {
  const at = value == null ? NaN : Date.parse(String(value));
  return Number.isFinite(at) ? at : NaN;
}

function minutes(ms: number): number {
  return Math.max(0, Math.floor(ms / MINUTE));
}

/** `17m 41s`, `1h 05m` — the check's own duration, as the timeline's sentences spell one. */
export function landingDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1_000));
  const hours = Math.floor(total / 3_600);
  const mins = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  return `${mins}m ${String(seconds).padStart(2, '0')}s`;
}

/** The attempt's section of the timeline, when the view carries one. */
function sectionOf(
  landing: SessionLandingView,
  jobId: string,
): IntegrationTimelineSection | null {
  return landing.timeline?.sections.find((section) => section.jobId === jobId) ?? null;
}

/**
 * When the attempt FIRST started: the claim it is on now minus the takeovers. The landing view
 * carries the current claim's start only, so the timeline's own first claim line is the fact —
 * and it is the same fact the head says as `first started 17:03`.
 */
export function landingFirstStartedAt(
  landing: SessionLandingView,
  jobId: string,
): string | null {
  const section = sectionOf(landing, jobId);
  if (!section) return null;
  const claims = section.entries
    .filter((entry) => entry.kind === 'CLAIMED' || entry.kind === 'TAKEN_OVER')
    .sort((a, b) => instant(a.at) - instant(b.at));
  return claims[0]?.at ?? null;
}

/** The first line that says the runner reported starting a push, if the timeline holds one. */
function pushReport(
  landing: SessionLandingView,
  jobId: string,
): { reported: boolean; at: string | null } {
  const section = sectionOf(landing, jobId);
  const entry = section?.entries.find((line) =>
    line.kind === 'PUSH_REFUSED' || line.phase === 'PUSH' || line.phase === 'VERIFY');
  return { reported: entry != null, at: entry?.at ?? null };
}

/**
 * Whether a stop or cancel has been ASKED for and the runner has not answered yet (J-T8/M-T10).
 * The ask is a committed fact in the landing's timeline; the attempt stays RUNNING until the
 * runner's own result, so the card says `Cancelling` instead of pretending it already stopped.
 */
export function landingCancelling(landing: SessionLandingView): boolean {
  const attempt = landing.currentAttempt;
  if (!attempt || attempt.state !== 'RUNNING') return false;
  const section = sectionOf(landing, attempt.jobId);
  return (section?.entries ?? []).some((entry) =>
    entry.kind === 'STOP_REQUESTED' && entry.claim === attempt.claim);
}

/** The facts a landing status card renders. */
export interface LandingAttemptCard {
  /** `Landing`, `Merge check`, `Merge to main` — the head's word. */
  word: string;
  /** The step, `queued`, `Timed out`, `Update unavailable`, or the terminal verdict. */
  state: string;
  /** The head's right slot: the step's clock, or a word (`Timed out`, `Not landed`, …). */
  right: string;
  rightIsClock: boolean;
  /** The line under the word: state, the V6 clauses, the claim and the freshness. */
  detail: string;
  /** `Merge check 2m 40s of 60m · usually ~18m`, under the head; null for a queued attempt. */
  budget: string | null;
  /** How far through its budget the current step is, for the quiet meter under the head. */
  progress: number | null;
  /** `Output 3s ago · Updated just now` — the two server facts, in §7.2 V6's words. */
  live: string | null;
  /** The heartbeat is fresh (LIVE or QUIET): the card draws the green freshness dot. */
  fresh: boolean;
  /** Where the check's USUAL duration sits on its budget bar, for the board's little tick. */
  usualProgress: number | null;
  /** What stopped it, in a sentence under the head (a failed check, a conflict, an error). */
  failure: string | null;
  running: boolean;
  timedOut: boolean;
  /** The attempt stopped on a failure (`LANDING_FAILURE_STATES`): the head's red ✕ and red word. */
  stoppedOnFailure: boolean;
}

/**
 * The results an attempt stops on as a failure: a check that failed, a conflict, an error. The status
 * card's head wears the red ✕ and the red word for them (board 02 d), read from the attempt's state
 * alone, never from its sentence; CANCELLED and every other ending keep the quiet head. OrbitKit
 * `LandingPageCopy.failureStates` and Kotlin `LandingSessionModel.FAILURE_STATES` hold the same three.
 */
export const LANDING_FAILURE_STATES: readonly string[] = ['CHECK_FAILED', 'CONFLICT', 'ERROR'];

/**
 * The status card over the subject's newest attempt: the landing row's head (owner 2026-10-11)
 * with §7.2 V6's rows under it.
 *
 * Liveness is the server's word, read at the moment of the view: LIVE and QUIET let the local
 * clock run, SILENT freezes it at the runner's last word, LEGACY freezes it at the read (its
 * runner reports only at step boundaries, so its quiet is the protocol), and LEASE_EXPIRED is the
 * one timeout — the card then draws the server's own `Timed out` head and stops.
 */
export function landingAttemptCard(
  landing: SessionLandingView,
  now: number,
  observation: LandingObservation = {},
  facts: LandingFacts = {},
): LandingAttemptCard | null {
  const attempt = landing.currentAttempt;
  if (!attempt) return null;
  const main = facts.main ?? DEFAULT_MAIN_BRANCH;
  const word = jobWords(main)[attempt.kind] ?? LANDING_PAGE_COPY.CHIP;
  const unavailable = landingReadUnavailable(now, observation);
  const timedOut = attempt.timedOut || attempt.liveness === 'LEASE_EXPIRED';
  const readAt = observation.updatedAt;

  // A read this device could not make is said first: whatever the last read said — even a timeout
  // the server judged — is frozen at `Update unavailable`, and no door opens on it (LS6).
  if (unavailable) {
    const stepStart = instant(facts.stepStartedAt)
      || instant(attempt.check?.startedAt)
      || instant(attempt.startedAt);
    const frozenAt = Math.min(now, readAt ?? now);
    const stepClock = Number.isFinite(stepStart)
      ? landingClock(Math.max(0, frozenAt - stepStart)) : '0m 0s';
    const budgetMinutes = attempt.check ? Math.round(attempt.check.budgetSeconds / 60) : null;
    const updated = readAt !== undefined ? minutes(now - readAt) : null;
    return {
      word,
      state: LANDING_PAGE_COPY.UPDATE_UNAVAILABLE,
      right: stepClock,
      rightIsClock: true,
      detail: LANDING_PAGE_COPY.UPDATE_UNAVAILABLE,
      budget: attempt.check && budgetMinutes !== null
        ? `${checkLabel(attempt.check.name)} ${stepClock} ${LANDING_LIVENESS_WORDS.OF} ${budgetMinutes}m`
        : null,
      progress: null,
      live: updated === null ? null : `Updated ${updated}m ago`,
      fresh: false,
      usualProgress: null,
      failure: null,
      running: false,
      timedOut: false,
      stoppedOnFailure: false,
    };
  }

  if (timedOut) {
    const silentSince = instant(attempt.heartbeatAt) || instant(attempt.startedAt);
    const silent = Number.isFinite(silentSince) ? minutes(now - silentSince) : 0;
    const limit = attempt.limitSeconds != null
      ? `${LANDING_PAGE_COPY.LIMIT} ${Math.round(attempt.limitSeconds / 60)}m`
      : null;
    return {
      word,
      state: LANDING_PAGE_COPY.TIMED_OUT,
      right: LANDING_PAGE_COPY.TIMED_OUT,
      rightIsClock: false,
      detail: [`${LANDING_PAGE_COPY.NO_REPORT_FOR} ${silent}m`, limit].filter(Boolean).join(' · '),
      budget: null,
      progress: null,
      live: null,
      fresh: false,
      usualProgress: null,
      failure: null,
      running: false,
      timedOut: true,
      stoppedOnFailure: false,
    };
  }

  if (attempt.state === 'QUEUED' || attempt.claim === 0) {
    const queuedAt = instant(attempt.startedAt);
    return {
      word,
      state: LANDING_PAGE_COPY.QUEUED,
      right: Number.isFinite(queuedAt) ? landingClock(now - queuedAt) : '0m 0s',
      rightIsClock: true,
      detail: [LANDING_PAGE_COPY.QUEUED, attempt.blockingReason?.summary ?? null]
        .filter((part): part is string => part != null)
        .join(' · '),
      budget: null,
      progress: null,
      live: null,
      fresh: false,
      usualProgress: null,
      failure: null,
      running: false,
      timedOut: false,
      stoppedOnFailure: false,
    };
  }

  if (attempt.state !== 'RUNNING') {
    return terminalCard(landing, attempt, word, unavailable);
  }

  // The current step's clock: the check's own start when one is in flight, else the step's, and
  // the claim's as the last fallback. SILENT freezes it at the runner's last word and LEGACY at
  // the read; a read this device could not make freezes both at the read itself.
  const stepStart = instant(facts.stepStartedAt)
    || instant(attempt.check?.startedAt)
    || instant(attempt.startedAt);
  const heartbeat = instant(attempt.heartbeatAt);
  const liveness = unavailable ? null : attempt.liveness;
  const elapsedAt = unavailable ? Math.min(now, readAt ?? now)
    : liveness === 'SILENT' ? (Number.isFinite(heartbeat) ? heartbeat : stepStart)
      : liveness === 'LEGACY' ? (readAt ?? now)
        : now;
  const stepClock = Number.isFinite(stepStart) ? landingClock(Math.max(0, elapsedAt - stepStart)) : '0m 0s';
  const budgetMinutes = attempt.check ? Math.round(attempt.check.budgetSeconds / 60) : null;

  const clauses: string[] = [];
  if (liveness === 'LIVE') {
    const moved = instant(attempt.outputMovedAt);
    if (Number.isFinite(moved)) clauses.push(`output ${Math.max(0, Math.round((now - moved) / 1000))}s ago`);
  } else if (liveness === 'QUIET') {
    const moved = instant(attempt.outputMovedAt);
    if (Number.isFinite(moved)) clauses.push(`no output for ${minutes(now - moved)}m`);
    if (budgetMinutes !== null) {
      clauses.push(`${LANDING_LIVENESS_WORDS.WITHIN_ITS} ${budgetMinutes}m ${LANDING_LIVENESS_WORDS.BUDGET}`);
    }
  } else if (liveness === 'SILENT') {
    const since = Number.isFinite(heartbeat) ? heartbeat : stepStart;
    const who = attempt.runnerName
      ? `no word from runner ${attempt.runnerName}`
      : 'no word from the runner';
    clauses.push(`${who} for ${Number.isFinite(since) ? minutes(now - since) : 0}m`);
  } else if (liveness === 'LEGACY') {
    clauses.push('reports only between steps');
  }
  if (facts.typicalMs != null) {
    clauses.push(`usually ~${Math.round(facts.typicalMs / MINUTE)}m`);
  }
  if (attempt.claim >= 1) {
    clauses.push(`claim ${attempt.claim}`);
    if (attempt.round != null) clauses.push(landingRoundClause(attempt.round, attempt.kind));
  }
  if (attempt.claim > 1) {
    const first = landingFirstStartedAt(landing, attempt.jobId);
    const started = Number.isFinite(instant(attempt.startedAt))
      ? landingClockTime(attempt.startedAt) : '--:--';
    clauses.push(first
      ? `Taken over ${started} · first started ${landingClockTime(first)}`
      : `Taken over ${started}`);
  }
  // Freshness is the runner's own last report, not this app's read: a successful refresh does
  // not make a silent job look active (the same rule the landing row's line follows).
  const freshnessAt = Number.isFinite(heartbeat) ? heartbeat : (readAt ?? now);
  const age = liveness === 'SILENT' ? null : minutes(now - freshnessAt);
  if (age !== null) {
    clauses.push(age === 0 ? 'updated just now' : `updated ${age}m ago`);
  }

  const phase = attempt.phase ? jobPhases(main)[attempt.phase] ?? LANDING_PAGE_COPY.RUNNING : null;
  const state = landingCancelling(landing) ? LANDING_PAGE_COPY.CANCELLING
    : phase ?? LANDING_PAGE_COPY.RUNNING;
  const outputMoved = instant(attempt.outputMovedAt);
  const outputAge = Number.isFinite(outputMoved) ? Math.max(0, Math.round((now - outputMoved) / 1000)) : null;
  const updatedWord = age === null ? null : age === 0 ? 'Updated just now' : `Updated ${age}m ago`;
  const live = liveness === 'LIVE'
    ? [outputAge === null ? null : `Output ${outputAge}s ago`, updatedWord].filter(Boolean).join(' · ')
    : liveness === 'QUIET'
      ? [
        Number.isFinite(outputMoved) ? `No output for ${minutes(now - outputMoved)}m` : null,
        budgetMinutes !== null ? `within its ${budgetMinutes}m budget` : null,
        updatedWord,
      ].filter(Boolean).join(' · ')
      : liveness === 'SILENT'
        ? (() => {
          const since = Number.isFinite(heartbeat) ? heartbeat : stepStart;
          const who = attempt.runnerName ? `runner ${attempt.runnerName}` : 'the runner';
          return `No word from ${who} for ${Number.isFinite(since) ? minutes(now - since) : 0}m`;
        })()
        : liveness === 'LEGACY'
          ? ['Reports only between steps', updatedWord].filter(Boolean).join(' · ')
          : updatedWord;

  return {
    word,
    state,
    right: budgetMinutes === null ? stepClock : `${stepClock} ${LANDING_LIVENESS_WORDS.OF} ${budgetMinutes}m`,
    rightIsClock: true,
    detail: [state, ...clauses].join(' · '),
    budget: attempt.check
      ? `${checkLabel(attempt.check.name)} ${stepClock} ${LANDING_LIVENESS_WORDS.OF} ${budgetMinutes}m`
        + (facts.typicalMs != null ? ` · usually ~${Math.round(facts.typicalMs / MINUTE)}m` : '')
      : null,
    progress: attempt.check && Number.isFinite(stepStart)
      ? Math.max(0, Math.min(1, (elapsedAt - stepStart) / (attempt.check.budgetSeconds * 1_000)))
      : null,
    live,
    fresh: liveness === 'LIVE' || liveness === 'QUIET',
    usualProgress: attempt.check && facts.typicalMs != null
      ? Math.max(0, Math.min(1, facts.typicalMs / (attempt.check.budgetSeconds * 1_000)))
      : null,
    failure: null,
    running: true,
    timedOut: false,
    stoppedOnFailure: false,
  };
}

function checkLabel(name: string): string {
  return name === 'MERGE_CHECK' ? LANDING_PAGE_COPY.MERGE_CHECK : LANDING_PAGE_COPY.TASK_ACCEPTANCE;
}

/** `Merge check` / `Task acceptance`, the names the check rows use. */
export function landingCheckLabel(name: string): string {
  return checkLabel(name);
}

/** The card for an attempt that has ended but whose subject has not: what stopped it. */
function terminalCard(
  landing: SessionLandingView,
  attempt: NonNullable<SessionLandingView['currentAttempt']>,
  word: string,
  unavailable: boolean,
): LandingAttemptCard {
  const mergeJob = attempt.kind !== 'LAND_TASK';
  const checks = landing.checks;
  const failed = checks.find((check) => {
    const result = check as { exitCode?: unknown; expectedExitCode?: unknown; timedOut?: unknown };
    return result.timedOut === true
      || (result.exitCode != null && result.exitCode !== result.expectedExitCode);
  }) as {
    name?: string; exitCode?: number | null; expectedExitCode?: number;
    timedOut?: boolean; durationMs?: number;
  } | undefined;
  const label = failed?.name ? checkLabel(failed.name) : LANDING_PAGE_COPY.TASK_ACCEPTANCE;
  const clause = failed?.timedOut
    ? `${LANDING_PAGE_COPY.CHECKS_FAILED} · ${LANDING_PAGE_COPY.CHECKS_TIMED_OUT.toLowerCase()}`
    : failed
      ? `${LANDING_PAGE_COPY.CHECKS_FAILED} · ${LANDING_PAGE_COPY.EXIT} ${failed.exitCode ?? '—'} `
        + `${LANDING_PAGE_COPY.AFTER} ${landingDuration(failed.durationMs)}`
      : attempt.state === 'CONFLICT'
        ? `${LANDING_PAGE_COPY.COULD_NOT_MERGE} · ${LANDING_PAGE_COPY.CONFLICT}`
        : attempt.state === 'ERROR'
          ? LANDING_PAGE_COPY.STOPPED_WITH_AN_ERROR
          : LANDING_PAGE_COPY.STOPPED_NOT_LANDED;
  const failure = failed
    ? `${failed.timedOut ? `${label} timed out ${LANDING_PAGE_COPY.ON_THE_COMBINED_TREE}` : LANDING_PAGE_COPY.TASK_ACCEPTANCE_EXITED(String(failed.exitCode ?? '—'), String(failed.expectedExitCode ?? 0))} · ${LANDING_PAGE_COPY.NOTHING_PUSHED_CLAUSE}`
    : attempt.state === 'CONFLICT' ? `${LANDING_PAGE_COPY.COULD_NOT_MERGE} · ${LANDING_PAGE_COPY.CONFLICT}`
      : attempt.state === 'ERROR' ? `${LANDING_PAGE_COPY.STOPPED_WITH_AN_ERROR} · ${LANDING_PAGE_COPY.NOTHING_PUSHED_CLAUSE}`
        // A merge check that ended READY passed and waits for the owner: nothing stopped it.
        : attempt.kind === 'CHECK_PROMOTION' && attempt.state === 'READY' ? null
          : LANDING_PAGE_COPY.STOPPED_NOT_LANDED;
  return {
    word,
    state: attempt.state === 'READY' ? LANDING_PAGE_COPY.READY : clause,
    right: attempt.state === 'READY'
      ? LANDING_PAGE_COPY.READY
      : mergeJob ? LANDING_PAGE_COPY.NOT_MERGED : LANDING_PAGE_COPY.NOT_LANDED,
    rightIsClock: false,
    detail: attempt.state === 'READY' ? LANDING_PAGE_COPY.PASSED_CHECK : clause,
    budget: null,
    progress: null,
    live: null,
    fresh: false,
    usualProgress: null,
    failure: unavailable ? null : failure,
    running: false,
    timedOut: false,
    stoppedOnFailure: LANDING_FAILURE_STATES.includes(attempt.state),
  };
}

/** A settled subject's card: the outcome the round (or the task's segment) reached. */
export interface LandingOutcomeCard {
  title: string;
  right: string;
  detail: string | null;
  /** `Now on main · 2 tasks`, and the titles under it. */
  tasksHeading: string | null;
  tasks: string[];
  checkLine: string | null;
  treeLine: string | null;
  ok: boolean;
}

function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/**
 * The settled page's head (mockup 05c): the outcome, the commit it landed, the tasks that are now
 * on main, the check that passed and the tree it tested. A merge round reads those from its own
 * receipt (`merged`), the row that keeps them; a task segment reads what the landing view keeps.
 */
export function landingOutcomeCard(
  landing: SessionLandingView,
  promotion: ProjectPromotionView | null | undefined,
): LandingOutcomeCard | null {
  if (!landing.settledAt) return null;
  const settledAt = landingClockTime(landing.settledAt);
  const main = mainBranchName(promotion?.upstreamRef);
  const target = landing.currentAttempt?.targetRef;
  const checks = landing.checks as Array<{ durationMs?: number; timedOut?: boolean; exitCode?: number; expectedExitCode?: number }>;
  const duration = checks.reduce((total, check) => total + (check.durationMs ?? 0), 0);
  const passed = checks.length > 0 && checks.every((check) =>
    check.timedOut !== true && (check.exitCode == null || check.exitCode === check.expectedExitCode));
  const checkLine = passed ? `${LANDING_PAGE_COPY.PASSED_ON_THE_TREE} · ${landingDuration(duration)}` : null;
  const tree = shortSha(promotion?.landsTreeSha);
  const treeLine = tree
    ? `${LANDING_PAGE_COPY.LANDED_EXACTLY} ${tree} · ${promotion?.landsAs === 'MERGE_COMMIT'
      ? LANDING_PAGE_COPY.AS_A_MERGE_COMMIT : LANDING_PAGE_COPY.BY_FAST_FORWARD}`
    : null;

  switch (landing.settledAs) {
    case 'MERGED': {
      const merged = promotion?.merged ?? null;
      const titles = (promotion?.tasks ?? []).map((task) => task.title);
      return {
        title: `${LANDING_PAGE_COPY.MERGED_INTO} ${main}`,
        right: merged ? landingClockTime(merged.at) : settledAt,
        detail: [
          shortSha(merged?.sha),
          promotion ? plural(promotion.taskIds.length, 'task') : null,
          merged ? (merged.automatic ? LANDING_PAGE_COPY.AUTOMATICALLY : LANDING_PAGE_COPY.BY_YOU) : null,
        ].filter((part): part is string => part != null).join(' · ') || null,
        tasksHeading: promotion
          ? `${LANDING_PAGE_COPY.NOW_ON} ${main} · ${plural(promotion.taskIds.length, 'task')}`
          : `${LANDING_PAGE_COPY.NOW_ON} ${main}`,
        tasks: titles,
        checkLine,
        treeLine,
        ok: true,
      };
    }
    case 'LANDED':
      return {
        title: LANDING_PAGE_COPY.LANDED,
        right: settledAt,
        detail: target ? `${LANDING_PAGE_COPY.LANDED_ON} ${branchName(target)}` : null,
        tasksHeading: null, tasks: [], checkLine, treeLine: null, ok: true,
      };
    case 'ALREADY_LANDED':
      return {
        title: LANDING_PAGE_COPY.ALREADY_LANDED,
        right: settledAt,
        detail: target ? `${LANDING_PAGE_COPY.ALREADY_ON} ${branchName(target)}` : null,
        tasksHeading: null, tasks: [], checkLine, treeLine: null, ok: true,
      };
    case 'NOTHING_TO_LAND':
      return {
        title: LANDING_PAGE_COPY.NOTHING_TO_LAND, right: settledAt, detail: null,
        tasksHeading: null, tasks: [], checkLine: null, treeLine: null, ok: true,
      };
    case 'HANDLED':
      return {
        title: LANDING_PAGE_COPY.HANDLED, right: settledAt, detail: null,
        tasksHeading: null, tasks: [], checkLine: null, treeLine: null, ok: false,
      };
    case 'DECLINED':
      return {
        title: LANDING_PAGE_COPY.DECLINED, right: settledAt, detail: null,
        tasksHeading: null, tasks: [], checkLine: null, treeLine: null, ok: false,
      };
    case 'CANCELLED':
      return {
        title: LANDING_PAGE_COPY.CANCELLED, right: settledAt, detail: null,
        tasksHeading: null, tasks: [], checkLine: null, treeLine: null, ok: false,
      };
    case 'DELETED':
      return {
        title: LANDING_PAGE_COPY.DELETED, right: settledAt, detail: null,
        tasksHeading: null, tasks: [], checkLine: null, treeLine: null, ok: false,
      };
    default:
      return {
        title: landing.settledAs ?? LANDING_PAGE_COPY.HANDLED, right: settledAt, detail: null,
        tasksHeading: null, tasks: [], checkLine: null, treeLine: null, ok: false,
      };
  }
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//u, '');
}

/** The receipt a merge row opens to in the Landings window (board 03 e): what is now on main, the
 *  check that passed on the combined tree, and the tree that landed. */
export interface LandingMergeReceipt {
  /** `Now on main · 2 tasks`. */
  heading: string;
  tasks: string[];
  checkLine: string | null;
  treeLine: string | null;
}

/**
 * A merge round's receipt, from its merged record (`promotions/merged`): the record keeps the tasks,
 * the checks that passed on the combined tree and the tree that landed. The round's landing view
 * adds its checks where the record carries none; a merge older than landing sessions has only the
 * record, and a round past the read's 20 records only its landing view.
 */
export function landingMergeReceipt(
  promotion: ProjectPromotionView | null | undefined,
  landing: SessionLandingView | null | undefined,
): LandingMergeReceipt {
  const main = mainBranchName(promotion?.upstreamRef);
  const recorded = (promotion?.checks ?? []) as Array<{ durationMs?: number; timedOut?: boolean; exitCode?: number; expectedExitCode?: number }>;
  const checks = recorded.length > 0
    ? recorded
    : (landing?.checks ?? []) as Array<{ durationMs?: number; timedOut?: boolean; exitCode?: number; expectedExitCode?: number }>;
  const passed = checks.length > 0 && checks.every((check) =>
    check.timedOut !== true && (check.exitCode == null || check.exitCode === check.expectedExitCode));
  const duration = checks.reduce((total, check) => total + (check.durationMs ?? 0), 0);
  const tree = shortSha(promotion?.landsTreeSha);
  return {
    heading: promotion
      ? `${LANDING_PAGE_COPY.NOW_ON} ${main} · ${plural(promotion.taskIds.length, 'task')}`
      : `${LANDING_PAGE_COPY.NOW_ON} ${main}`,
    tasks: (promotion?.tasks ?? []).map((task) => task.title),
    checkLine: passed ? `${LANDING_PAGE_COPY.PASSED_ON_THE_TREE} · ${landingDuration(duration)}` : null,
    treeLine: tree
      ? `${LANDING_PAGE_COPY.LANDED_EXACTLY} ${tree} · ${promotion?.landsAs === 'MERGE_COMMIT'
        ? LANDING_PAGE_COPY.AS_A_MERGE_COMMIT : LANDING_PAGE_COPY.BY_FAST_FORWARD}`
      : null,
  };
}

/** Which of the owner's doors the landing view's own facts open (LS6: none is inferred here). */
export interface LandingGates {
  stop: boolean;
  cancel: boolean;
  abandon: boolean;
  retry: boolean;
  recheck: boolean;
}

export const NO_LANDING_GATES: LandingGates = {
  stop: false, cancel: false, abandon: false, retry: false, recheck: false,
};

/**
 * The doors the newest attempt's own facts open. Every condition is the view's: the job's kind,
 * whether it is in flight, the server's `timedOut`/`liveness`, the phase the runner reported, and
 * the push line the timeline recorded. A read this device could not make opens nothing — a door
 * pressed against a stale fact is a decision made on nothing.
 */
export function landingGates(
  landing: SessionLandingView,
  observation: LandingObservation,
  now: number,
): LandingGates {
  if (landing.settledAt || landingReadUnavailable(now, observation)) return NO_LANDING_GATES;
  const attempt = landing.currentAttempt;
  if (!attempt) return NO_LANDING_GATES;
  const expired = attempt.timedOut || attempt.liveness === 'LEASE_EXPIRED';
  const inFlight = attempt.state === 'RUNNING' || attempt.state === 'QUEUED';
  if (!inFlight) return NO_LANDING_GATES;
  // The two facts the server publishes for exactly this decision (§2.9 LS6): `retryable` is the
  // queue's own answer to whether the owner's Retry takes this attempt, and `pushBoundaryPassed`
  // is J-T4's boundary computed from the claim. Neither rule is re-derived here.
  const pastPush = attempt.pushBoundaryPassed === true;
  const cancelling = landingCancelling(landing);
  return {
    stop: attempt.kind === 'LAND_TASK' && !expired && !pastPush && !cancelling,
    cancel: attempt.kind === 'LAND_PROMOTION' && !expired && !pastPush && !cancelling,
    abandon: attempt.state === 'RUNNING' && expired,
    retry: attempt.retryable === true,
    recheck: attempt.timedOut === true && attempt.kind === 'CHECK_PROMOTION'
      && landing.promotionId != null,
  };
}

/** What a landing menu row does; the page owns the navigation and the press. */
export type LandingMenuAction =
  | 'OPEN_TASK'
  | 'OPEN_SOURCE_SESSION'
  | 'OPEN_COORDINATOR'
  | 'REVIEW_CARD'
  | 'STOP'
  | 'CANCEL'
  | 'ABANDON'
  | 'RETRY'
  | 'RERUN_THE_CHECK';

/** One row of the ⋯ menu the landing page draws (mockups v4 05 d, h). */
export interface LandingMenuItem {
  key: string;
  action: LandingMenuAction;
  label: string;
  /** The consequence line under the label — the two stop doors and Abandon carry one. */
  sub: string | null;
  danger: boolean;
}

/**
 * The ⋯ menu's rows, in the order the board draws them: the ways to look at this work, then the
 * doors the landing view's facts open. No Copy Link (design §3, owner 2026-10-19) and no other
 * row invented by the client.
 */
export function landingMenuItemList(
  landing: SessionLandingView,
  gates: LandingGates,
  options: { hasCoordinator: boolean; hasReview: boolean; nothingPushed: boolean },
): LandingMenuItem[] {
  const items: LandingMenuItem[] = [];
  if (landing.taskId) {
    items.push({ key: 'task', action: 'OPEN_TASK', label: LANDING_PAGE_COPY.OPEN_TASK, sub: null, danger: false });
  }
  // A merge round names the session of the task that landed last, not a source this round worked
  // in: the board's merge-round menu is Review Card and Open Coordinator alone (05 d).
  if (landing.subject === 'TASK' && landing.currentAttempt?.sourceSessionId) {
    items.push({
      key: 'source', action: 'OPEN_SOURCE_SESSION', label: LANDING_PAGE_COPY.OPEN_SOURCE_SESSION,
      sub: null, danger: false,
    });
  }
  if (options.hasCoordinator) {
    items.push({
      key: 'coordinator', action: 'OPEN_COORDINATOR', label: LANDING_PAGE_COPY.OPEN_COORDINATOR,
      sub: null, danger: false,
    });
  }
  if (landing.subject === 'PROMOTION' && options.hasReview) {
    items.push({ key: 'review', action: 'REVIEW_CARD', label: LANDING_PAGE_COPY.REVIEW_CARD, sub: null, danger: false });
  }
  if (gates.stop) {
    items.push({
      key: 'stop', action: 'STOP', label: LANDING_PAGE_COPY.STOP_LANDING,
      sub: LANDING_PAGE_COPY.BEFORE_PUSH_ONLY, danger: true,
    });
  }
  if (gates.cancel) {
    items.push({
      key: 'cancel', action: 'CANCEL', label: LANDING_PAGE_COPY.CANCEL_MERGE,
      sub: LANDING_PAGE_COPY.CANCEL_BEFORE_PUSH, danger: true,
    });
  }
  if (gates.abandon) {
    items.push({
      key: 'abandon', action: 'ABANDON', label: LANDING_PAGE_COPY.ABANDON,
      // J12's verdict, not the sentence the card draws: a check never pushes, so its Abandon ends
      // an attempt that provably never reached main even though no push line is written for it.
      sub: options.nothingPushed
        ? LANDING_PAGE_COPY.ENDS_NOTHING_PUSHED
        : LANDING_PAGE_COPY.ENDS_MAY_HAVE_PUSHED,
      danger: true,
    });
  }
  if (gates.retry) {
    items.push({ key: 'retry', action: 'RETRY', label: LANDING_PAGE_COPY.RETRY, sub: null, danger: false });
  }
  if (gates.recheck) {
    items.push({
      key: 'recheck', action: 'RERUN_THE_CHECK', label: LANDING_PAGE_COPY.RERUN_THE_CHECK,
      sub: null, danger: false,
    });
  }
  return items;
}

/**
 * The J12 sentence under a timed-out attempt: which jobs can prove nothing was pushed and which
 * cannot. A v2 claim that never recorded a PUSH proves nothing was pushed; everything else — a
 * legacy claim, a takeover of one, a report that named the push — may have been.
 *
 * A merge check gets NO sentence (owner 2026-10-19: "检查作业超时不写推送一句" — CHECK_PROMOTION
 * never pushes, so a push sentence about it is noise on a card that already says what stopped).
 * The claim's own line (`landingTimeoutLine`) still says where the runner was.
 */
export function landingPushSentence(
  landing: SessionLandingView,
  attempt: NonNullable<SessionLandingView['currentAttempt']>,
): string | null {
  if (attempt.kind === 'CHECK_PROMOTION') return null;
  const reported = pushReport(landing, attempt.jobId);
  if (attempt.progressProtocol === 'v2' && !reported.reported) {
    return LANDING_PAGE_COPY.NOTHING_PUSHED_SENTENCE;
  }
  if (reported.at) {
    return LANDING_PAGE_COPY.MAY_HAVE_PUSHED_AT(landingClockTime(reported.at));
  }
  return LANDING_PAGE_COPY.MAY_HAVE_PUSHED_SENTENCE;
}

/** The timed-out card's line about the claim: who took it, when, and where it stopped. */
export function landingTimeoutLine(
  landing: SessionLandingView,
  attempt: NonNullable<SessionLandingView['currentAttempt']>,
  main: string = DEFAULT_MAIN_BRANCH,
): string {
  const who = attempt.runnerName
    ? `${LANDING_PAGE_COPY.RUNNER} ${attempt.runnerName}`
    : LANDING_PAGE_COPY.THE_RUNNER;
  const took = Number.isFinite(instant(attempt.startedAt))
    ? landingClockTime(attempt.startedAt) : '--:--';
  const stopped = attempt.phase
    ? jobPhases(main)[attempt.phase] ?? LANDING_PAGE_COPY.RUNNING
    : LANDING_PAGE_COPY.RUNNING;
  const parts = [
    `${who} ${LANDING_PAGE_COPY.TOOK_IT_AT} ${took} · ${LANDING_PAGE_COPY.STOPPED_AT} ${stopped}`,
    `claim ${attempt.claim}`,
  ];
  if (attempt.round != null) parts.push(landingRoundClause(attempt.round, attempt.kind));
  return parts.join(' · ');
}

/**
 * The grey band a timed-out attempt's section ends with (mockups 05 e, f, i): the runner's last
 * word that never came. Null for an attempt the server has not judged timed out.
 */
export function landingNoReportBand(
  landing: SessionLandingView,
): { text: string; at: string } | null {
  const attempt = landing.currentAttempt;
  if (!attempt?.timedOut) return null;
  const at = attempt.heartbeatAt ?? attempt.startedAt;
  const runner = attempt.runnerName;
  const who = runner ? `${LANDING_PAGE_COPY.NO_REPORT_FROM} ${runner}` : `${LANDING_PAGE_COPY.NO_REPORT_FROM} the runner`;
  return {
    text: `${who} ${LANDING_PAGE_COPY.SINCE} ${landingClockTime(at)}`,
    at,
  };
}

/** A section's state after its title (`Generation 1 · not landed · CHECK_FAILED`). */
export function landingSectionState(state: string): string | null {
  switch (state) {
    case 'CHECK_FAILED':
    case 'CONFLICT':
      return `not landed · ${state}`;
    case 'ERROR':
      return `stopped · ${state}`;
    case 'CANCELLED':
      return 'stopped';
    // A successful section says it in its own lines (the check's `passed`, the result's
    // `Landed on …`); the board's settled round wears no suffix on its headings.
    default:
      return null;
  }
}

/** The result states a timeline line marks as a success: the branch is on its target. */
const LANDING_OK_STATES = new Set(['LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND']);

/**
 * A finished check passed: it did not time out and exited with the code it expected. Read off the
 * line's `data`, the fields the server wrote its sentence from, never off the sentence. A check
 * with no exit code did not pass, unlike on the settled card's check line.
 */
export function landingCheckPassed(entry: IntegrationTimelineEntry): boolean {
  if (entry.kind !== 'CHECK_FINISHED') return false;
  const data = entry.data ?? {};
  return data.timedOut !== true
    && typeof data.exitCode === 'number'
    && data.exitCode === data.expectedExitCode;
}

/**
 * A check or result line that ended well draws ✓, and one that did not draws ✗ (05 a/e/g). `kind`
 * is the job kind of the section the line is in: a merge check that ends READY passed, and its
 * round is ready to merge into main. A merge to main that answers READY handed the candidate back
 * to be checked again and merged nothing (M-T12, J-T13), so it keeps its ✗.
 */
export function landingEntryOk(entry: IntegrationTimelineEntry, kind: IntegrationJobKind): boolean {
  switch (entry.kind) {
    case 'CHECK_FINISHED':
      return landingCheckPassed(entry);
    case 'RESULT':
    case 'RESULT_FALLBACK': {
      const state = String(entry.data?.state);
      return LANDING_OK_STATES.has(state) || (kind === 'CHECK_PROMOTION' && state === 'READY');
    }
    default:
      return false;
  }
}

