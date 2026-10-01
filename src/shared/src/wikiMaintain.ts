// Orbit Wiki's maintenance job (contracts/wiki.contract.json `maintenance.job`, migration 0320,
// criterion 3): a committed fact makes a space's «Wiki maintenance» task when the space is due, the
// task's run (`orbit wiki maintain`) turns the dossiers since the cursor into proposals, and the task's
// own check (`orbit wiki check`) judges the run by the cursor it moved and the ops it had refused.
// wikiContract.spec.ts holds every constant below to the contract JSON.

import { WIKI_LIMITS, WIKI_REVIEW_RULES, type WikiCursorOutcome, type WikiReviewMode } from './wiki';

/** The numbers the job runs by (contract `maintenance.job.rules`). */
export const WIKI_MAINTENANCE_JOB = {
  /** The most sessions one run covers: the position its task expects is no further than this many. */
  runSessionsMax: 20,
  /** The most entries the model extracts from one session's dossier (the demo's A2+6). */
  entriesPerSessionMax: 6,
  /** The model calls one run has in flight at once while it extracts. */
  extractConcurrency: 4,
  /** The budget the task declares for its check, in seconds: the check reads two rows. */
  checkTimeoutSeconds: 300,
  /**
   * The most ops ended sessions left waiting that one run of an automatic space adopts and verifies
   * (contract `reviewModes.verification.adoption`): the rest wait for the next run, oldest first.
   */
  adoptOpsMax: 50,
} as const;

/** What made a maintenance task: the backlog reached the threshold, or its oldest fact the age. */
export const WIKI_MAINTENANCE_DUE = ['backlog', 'age'] as const;
export type WikiMaintenanceDue = (typeof WIKI_MAINTENANCE_DUE)[number];

/**
 * Why a fact that found the space due made no task (contract `maintenance.job.held`), kept on the
 * cursor row until a task is made: the space's runs for the UTC day are used up, or — in a Manual
 * space, where everything waits for the owner — the review queue has no room for a run's proposals.
 */
export const WIKI_MAINTENANCE_HELD_REASONS = ['daily_limit_reached', 'review_queue_full'] as const;
export type WikiMaintenanceHeldReason = (typeof WIKI_MAINTENANCE_HELD_REASONS)[number];

/**
 * How many sessions a run may cover (contract `maintenance.job.runSize`), so that what it can propose
 * fits the guardrails it runs under at most `entriesPerSessionMax` entries a session:
 *
 *   - Manual: everything waits for the owner, so a run fits what one session may leave waiting
 *     (`limits.opsPerSession`) and what the space's review queue has room for;
 *   - Tiered and Automatic: what the mode applies counts against the circuit breaker, so a space holding
 *     `breakerMinActiveEntries` or more active entries takes no more than its breaker percentage;
 *   - a smaller space has no breaker, and a run covers `runSessionsMax`.
 *
 * 0 means a run could propose nothing: a Manual space whose queue is full.
 */
export function wikiMaintenanceRunSessions(input: { mode: WikiReviewMode; activeEntries: number; pendingInSpace: number }): number {
  const { runSessionsMax, entriesPerSessionMax } = WIKI_MAINTENANCE_JOB;
  let room: number;
  if (input.mode === 'manual') {
    room = Math.min(WIKI_LIMITS.opsPerSession, Math.max(0, WIKI_LIMITS.pendingOpsPerSpace - input.pendingInSpace));
  } else if (input.activeEntries >= WIKI_REVIEW_RULES.breakerMinActiveEntries) {
    room = Math.floor((input.activeEntries * WIKI_REVIEW_RULES.breakerMaxChangedPercent) / 100);
  } else {
    return runSessionsMax;
  }
  return Math.min(runSessionsMax, Math.floor(room / entriesPerSessionMax));
}

/** The acceptance command a maintenance task is made with: its run is judged by what it did. */
export function wikiMaintenanceCheckCommand(spaceId: string, expectToken: string): string {
  return `orbit wiki check --space ${spaceId} --expect-cursor ${expectToken}`;
}

/** `GET /api/runner/wiki/spaces/:id/maintenance/run`: what a maintenance run starts from. */
export interface WikiMaintenanceRunContext {
  spaceId: string;
  title: string;
  /** The space's repository: what the run's checkout must be a clone of. */
  repo: { urlNorm: string | null; rootCommitSha: string | null };
  reviewMode: WikiReviewMode;
  /**
   * The space's active entries now. Not what the run's circuit breaker is counted against: that is the entries
   * active when the run began, its own adds since taken off, and a dry run says it (`WikiBreakerReading`).
   */
  activeEntries: number;
  breaker: { minActiveEntries: number; maxChangedPercent: number };
  /** The workspace the space's maintenance runs in, with its work directory as stored (`~` unexpanded). */
  workspace: { id: string; workDir: string | null } | null;
  /** The topics an entry may name, for the extraction's topic table. */
  topics: Array<{ slug: string; title: string; description: string | null }>;
  /** The run's task, and the position its check expects the cursor to reach; null for a run no fact made. */
  taskId: string | null;
  expect: string | null;
  /** How many sessions this run may cover (wikiMaintenanceRunSessions). */
  runSessions: number;
}

/** What a run reports when it ends, kept as it was said (contract `maintenance.job.report`). */
export interface WikiMaintenanceReport {
  /** The step the run stopped at, when it did not succeed. */
  stoppedAt?: string;
  sessions: number;
  dossiers: number;
  unchanged: number;
  offTopic: number;
  entries: { extracted: number; kept: number; dropped: number; foreign: number; principles: number };
  /** `heldBack` is what the review queue's quotas held back; `heldBackByBreaker` what the run's circuit breaker did. */
  ops: {
    proposed: number;
    recorded: number;
    refused: number;
    selfCheckDropped: number;
    heldBack: number;
    heldBackByBreaker: number;
    applied: number;
    waiting: number;
  };
  verification?: {
    verified: number;
    failed: number;
    /**
     * Every op the run got no verdict for — its own after both passes, and the adopted ones: none of them is
     * live, each keeps waiting for its verification, and the next run adopts it. None of them fails the run.
     * An older runner does not report it: its run failed when one of its own ops got no verdict.
     */
    waitingForNextRun?: number;
    /** What the run adopted of what ended sessions left waiting, counted apart from its own ops. */
    adopted?: { ops: number; verified: number; failed: number };
  };
  anchors?: { entries: number; changed: number; missing: number };
  /** The topic articles a run before criterion 3's revision 3 rewrote; a run now writes the plan's sections (docs). */
  articles?: { written: number; unchanged: number; failed: number };
  docs?: WikiMaintenanceDocsReport;
  tokens: { input: number; output: number; calls: number };
  seconds: number;
}

/**
 * What a run did to the space's documents (contract `maintenance.job.docs`): the sections it took up and
 * why — the entries that changed and fit them, the repository material they cite that changed on
 * origin/main, a withdrawn sentence, or a section no build wrote — what became of them, the files whose
 * disappearance withdrew sentences, and the one plan proposal it made at most. With no confirmed plan it
 * writes nothing and says so (skipped).
 */
export interface WikiMaintenanceDocsReport {
  planVersion: number | null;
  skipped?: WikiMaintenanceDocsSkipped;
  repoSha?: string;
  affected: { byEntries: number; byRepo: number; stale: number; unwritten: number; total: number };
  withdrawn: { paths: number; sentences: number };
  sections: { written: number; unchanged: number; failed: number };
  /** Design documents new on origin/main that no section cites, and entries that fit no section. */
  unplaced: { designDocs: number; entries: number };
  proposal: { outcome: 'proposed' | 'failed'; id?: string; doc?: string; newDoc?: boolean; facts?: number; rounds?: number; error?: string; reason?: string } | null;
  /** What the step spent: its model calls — the sections' and the proposal's — and its time. */
  tokens: { input: number; output: number; calls: number };
  seconds: number;
  /** What stopped the step, when something did: the run still succeeds, and the next run takes it up. */
  error?: string;
}

/** The numbers a run's documents step goes by (contract `maintenance.job.docs.rules`). */
export const WIKI_MAINTENANCE_DOCS_RULES = {
  /** The gate rounds a plan proposal has: the first, and two more with every error handed back. */
  proposalRoundsMax: 3,
  /** The most pieces of knowledge with no place one proposal is asked about; the rest wait for the next run. */
  proposalItemsMax: 12,
} as const;

/** Why a run wrote no document: the space has no confirmed plan, or its server writes none yet. */
export const WIKI_MAINTENANCE_DOCS_SKIPPED = ['no_confirmed_plan', 'no_server_support'] as const;
export type WikiMaintenanceDocsSkipped = (typeof WIKI_MAINTENANCE_DOCS_SKIPPED)[number];

/** `GET /api/runner/wiki/spaces/:id/maintenance/check`: `orbit wiki check`'s verdict. */
export interface WikiMaintenanceCheck {
  spaceId: string;
  expect: string;
  /** The cursor as it stands, as a token. */
  position: string | null;
  reached: boolean;
  run: {
    taskId: string;
    sessionId: string | null;
    outcome: WikiCursorOutcome | null;
    opsRefused: number | null;
    endedAt: string | null;
  } | null;
  ok: boolean;
  /** Why it is not ok, one sentence each. */
  problems: string[];
}
