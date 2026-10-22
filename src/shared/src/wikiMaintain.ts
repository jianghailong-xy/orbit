// Orbit Wiki's maintenance job (contracts/wiki.contract.json `maintenance.job`, migration 0320,
// criterion 3): a committed fact makes a space's maintenance run when the space is due, and the server's
// `maintain` job (`maintenance.job.server`) turns the dossiers since the cursor into proposals.
// wikiContract.spec.ts holds every constant below to the contract JSON.

import { WIKI_LIMITS, WIKI_REVIEW_RULES, type WikiReviewMode } from './wiki';

/** The numbers the job runs by (contract `maintenance.job.rules`). */
export const WIKI_MAINTENANCE_JOB = {
  /** The most sessions one run covers. */
  runSessionsMax: 20,
  /** The most entries the model extracts from one session's dossier (the demo's A2+6). */
  entriesPerSessionMax: 6,
  /** The model calls one run has in flight at once while it extracts. */
  extractConcurrency: 4,
  /**
   * The most ops ended sessions — and, for a server run, the space's ended runs — left waiting that one
   * run of an automatic space adopts and verifies (contract `reviewModes.verification.adoption`): the rest
   * wait for the next run, oldest first.
   */
  adoptOpsMax: 50,
} as const;

/**
 * A maintenance run the server's wiki worker executes (contract `maintenance.job.server`, P8): the job kind
 * `maintain`, the numbers the pipeline holds itself to, and the steps its model calls are filed under. The
 * numbers are the runner's, moved verbatim (`maintenance.job.rules` and `maintenance.job.run.steps`); what
 * changes is who asks — the queue, with the deployment's System model, instead of a clean Claude Code in a
 * session.
 */
export const WIKI_MAINTAIN_JOB = {
  kind: 'maintain',
  /**
   * Background work: a fact made the run, and the owner's own asks sort above it (contract `jobs.priority`). It goes
   * before an articles job of its space made before it that has never been claimed, once (the owner's decision of
   * 2026-10-10).
   */
  priority: 0,
  /** The queue's steps: extraction, and the one plan change a run may propose; `plan_*` is the plan's wait limit. */
  steps: { extract: 'extract', planProposal: 'plan_proposal' },
  /** One extraction's max_tokens: an 8k-token dossier's at most six entries, the import's own budget. */
  extractMaxTokens: 8192,
  /** One plan proposal's max_tokens: a document's new sections in the plan's line format (the runner's 32,000). */
  planMaxTokens: 32_000,
  /** Dossiers one page of the run's read carries (`maintenance.job.rules.pageSessions`). */
  pageSessions: 5,
  /** The most ops one changeset may hold, and — in a Manual space — the most one run may leave waiting. */
  opsPerChangeset: 30,
  opsPerTurn: 5,
  /** A source's quote, at most (`limits.quoteMaxChars`), and how much of the README tells the model what the repository is. */
  quoteMaxChars: 300,
  aboutMaxChars: 300,
  /** One plan proposal's rounds at most, and the items one may be made of (`maintenance.job.docs.rules`). */
  proposalRoundsMax: 3,
  proposalItemsMax: 12,
  /** How long the job waits for one repository operation of the run: the snapshot, a read, a diff, the anchors. */
  repoWaitSeconds: 300,
  /** Reads and diffs in flight at once: each is a fetch in the same checkout on the space's runner. */
  repoOpsInFlight: 2,
  /**
   * The most diffs the anchors step makes (`anchorRules.verify.skip`), one a commit the space's anchors were last
   * checked at, the commits most anchors were checked at first; the anchors checked at the rest are checked again.
   * A diff is one more operation (~1.6 s), worth it only when it spares more than ~26 anchors' checks (~0.06 s
   * each). Replayed over the canary's 19 rounds of 2026-10-08/10, four averaged ~44 s a round against ~47 s for
   * eight and ~53 s for no cap: the commits past the fourth held few anchors, mostly ones that moved again anyway.
   * A skipped entry keeps its check where it was and a checked one moves to the run's commit, so a run leaves at
   * most five such commits behind, whatever came before it.
   */
  anchorDiffsMax: 4,
  /** The directories under docs/ that hold no design document (`maintenance.job.docs.excluded`). */
  docsExcluded: ['docs/mocks/', 'docs/evidence/'],
} as const;

/**
 * Whose failure a failed maintenance run was (contract `maintenance.job.recovery.failureKinds`), as its run
 * row and the space's health say it: `infra` — the platform under the run: its runner went offline, its
 * engine never came up, the server answered 5xx or could not be reached, the disk filled — or `content` —
 * the run's own: what it read, what the model answered, what the server refused, its turn limit. Only an
 * infra failure is run again by the platform.
 */
export const WIKI_MAINTENANCE_FAILURE_KINDS = ['infra', 'content'] as const;
export type WikiMaintenanceFailureKind = (typeof WIKI_MAINTENANCE_FAILURE_KINDS)[number];

/** What made a maintenance run: the backlog reached the threshold, or its oldest fact the age. */
export const WIKI_MAINTENANCE_DUE = ['backlog', 'age'] as const;
export type WikiMaintenanceDue = (typeof WIKI_MAINTENANCE_DUE)[number];

/**
 * Catch-up (contract `maintenance.job.catchUp`, criterion 3 revision 4, the owner's choice of 2026-10-02): a
 * space whose oldest fact the wiki has not taken in is more than `behindHours` old is behind, and catches up —
 * the end of its latest run makes the next, a run on a local endpoint or one that failed is not counted against
 * the day, and its documents wait until it is behind no more — until its last `pauseAfterFailures` runs all
 * failed, which pauses it until a run succeeds.
 */
export const WIKI_MAINTENANCE_CATCH_UP = {
  behindHours: 24,
  pauseAfterFailures: 3,
} as const;

/**
 * How a run was made, kept on its row (`wiki_maintenance_run.catch_up`): `active` — the space behind and
 * catching up; `paused` — behind, its last runs all failed. A run made while the space was not behind has none.
 */
export const WIKI_MAINTENANCE_CATCH_UP_STATES = ['active', 'paused'] as const;
export type WikiMaintenanceCatchUp = (typeof WIKI_MAINTENANCE_CATCH_UP_STATES)[number];

/** Whether a space whose oldest fact after its cursor is `oldestPendingAt` is behind at `now`: read when asked, never waited for. */
export function wikiMaintenanceBehind(oldestPendingAt: Date | null, now: Date): boolean {
  return oldestPendingAt !== null && now.getTime() - oldestPendingAt.getTime() > WIKI_MAINTENANCE_CATCH_UP.behindHours * 3_600_000;
}

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

/** What a run reports when it ends, kept as it was said (contract `maintenance.job.report`). */
export interface WikiMaintenanceReport {
  /** The step the run stopped at, when it did not succeed. */
  stoppedAt?: string;
  /**
   * The run moved the space's cursor past the sessions whose ops it recorded, as soon as they were recorded
   * (`POST …/maintenance/advance`): a step that failed after it fails the run, and the next run does not read
   * those sessions again. A run from a runner that does not do this, or one that failed before, says nothing.
   */
  cursorAdvanced?: boolean;
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
  /**
   * The anchors step's counts (contract `maintenance.job.server.anchors`): the entries whose checks the run
   * wrote, and of them the ones left changed or missing; `skipped` the entries whose anchors were all already
   * checked at the run's commit and were left alone. A run before 2026-10-10 re-checked every entry and
   * reported no `skipped`.
   */
  anchors?: { entries: number; changed: number; missing: number; skipped?: number };
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

/**
 * Why a run wrote no document: the space has no confirmed plan, its server writes none yet, or the run was
 * made while the space was behind, whose documents wait until it has caught up (`maintenance.job.catchUp.docs`).
 */
export const WIKI_MAINTENANCE_DOCS_SKIPPED = ['no_confirmed_plan', 'no_server_support', 'catching_up'] as const;
export type WikiMaintenanceDocsSkipped = (typeof WIKI_MAINTENANCE_DOCS_SKIPPED)[number];

