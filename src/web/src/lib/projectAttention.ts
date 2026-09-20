import {
  OWNER_ITEM_PUSH_KINDS,
  type CoordinatorLeadKind,
  type OwnerItemKind,
  type OwnerItemPushKind,
  type ProjectListAttention,
  type ProjectListIntegration,
} from '@orbit/shared';
import type { ProjectSection, SectionProject } from '../components/ProjectSections';
import type { ProjectPanoramaBuckets } from '../components/ProjectPanoramaHeader';

/**
 * The projects index is an execution-and-attention router, not a second activity feed.
 *
 * A row first answers whether a canonical obligation requires intervention, then whether work is
 * actively running. When neither applies, the row answers who must act next. Time then decides
 * where it sits among rows that need the same kind of action. This keeps three different signals
 * in their own jobs:
 *
 *   - counts describe scale;
 *   - time describes how long a condition has existed;
 *   - the section describes current execution or the next kind of action.
 *
 * In particular, raw `ready` count never ranks projects. Splitting one unit of work into ten
 * thousand shards must not make the project ten thousand times more important.
 */

export interface AttentionProject {
  /** A final, deterministic tie-breaker after every user-visible key agrees. */
  id: string;
  title: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  createdAt: string;
  _count: { tasks: number };
  buckets: ProjectPanoramaBuckets;
  /** The most recent task write in the project, or null when it has no tasks. */
  lastActivityAt: string | null;
  /** Durable open-blocker ownership aggregated by GET /projects. Optional for older servers. */
  attention?: ProjectAttentionSummary;
  /** Where this project's finished work lands (§7.1 V1). Absent on a server that sends none, and
   *  null on a project that has not decided a line and has not integrated anything yet. */
  integration?: ProjectListIntegration | null;
}

/**
 * The blocker summary, declared once for the server that writes it and the client that draws it:
 * `@orbit/shared`'s `ProjectListAttention` (§7.0). The name is this module's — the rows here are
 * what the page reads it through — and the declaration is not.
 */
export type ProjectAttentionSummary = ProjectListAttention;

export type AttentionSectionKey =
  | 'attention'
  | 'running'
  | 'ready'
  | 'waiting'
  | 'definition'
  | 'completed';

export type AttentionReason =
  // The four things a project can be waiting on its OWNER for, each one an item somebody has to
  // act on rather than a count of blockers (§7.1 V2). They are named after the item's own kind, in
  // the same words the phone's banner uses.
  | OwnerItemPushKind
  // What the project's COORDINATOR is holding, on its way to being handled: it says the project is
  // moving, so it never lands in Needs attention (§7.1 V2).
  | 'coordinator-handling'
  | 'needs-user'
  | 'auto-remediation'
  | 'no-activity-running'
  | 'no-activity-ready'
  | 'ready-to-close';

const SECTIONS: ReadonlyArray<{
  key: AttentionSectionKey;
  title: string;
  note: string;
  defaultCollapsed?: boolean;
}> = [
  {
    key: 'attention',
    title: 'Needs attention',
    note:
      'Owner-only decisions, stale coordination, non-convergence, quiet work, or closure · reason/severity first, then oldest signal',
  },
  {
    key: 'running',
    title: 'Running',
    note: 'Fresh work in flight · newest task activity first',
  },
  {
    key: 'ready',
    title: 'Ready',
    note: 'Can start now, nothing running · oldest task activity first',
  },
  {
    key: 'waiting',
    title: 'Waiting',
    note: 'Dependency-blocked or verification-gated work remains · oldest task activity first',
  },
  {
    key: 'definition',
    title: 'Needs definition',
    note: 'No tasks filed yet · title A–Z',
  },
  {
    key: 'completed',
    title: 'Completed',
    note: 'Closed projects · newest task activity first · folded by default',
    defaultCollapsed: true,
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** One full day without a task write is an operational exception, not ordinary turn latency. */
export const QUIET_MS = DAY_MS;

function instantRank(at: string | null | undefined): number {
  if (!at) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function byInstantDesc(leftAt: string | null | undefined, rightAt: string | null | undefined): number {
  const left = instantRank(leftAt);
  const right = instantRank(rightAt);
  if (left === right) return 0;
  return right > left ? 1 : -1;
}

/** Oldest real instant first. Missing/invalid instants are unknown and therefore sort last. */
function byInstantAsc(leftAt: string | null | undefined, rightAt: string | null | undefined): number {
  const left = instantRank(leftAt);
  const right = instantRank(rightAt);
  if (left === right) return 0;
  if (left === Number.NEGATIVE_INFINITY) return 1;
  if (right === Number.NEGATIVE_INFINITY) return -1;
  return left < right ? -1 : 1;
}

function byId(a: AttentionProject, b: AttentionProject): number {
  return a.id.localeCompare(b.id);
}

function autoRemediationBlockerCount(project: AttentionProject): number {
  return (
    (project.attention?.coordinatorBlockers ?? 0) +
    (project.attention?.systemBlockers ?? 0)
  );
}

/** The four owner items in the order a tie between them is settled — the contract's own order. */
const OWNER_ITEM_KINDS: readonly OwnerItemKind[] = [
  'PROMOTION_APPROVAL',
  'COORDINATOR_QUESTION',
  'ESCALATED',
  'FUSE_PAUSED',
];

/** The four reasons, derived from the one table that maps an item kind to its chip — so a fifth
 *  owner-facing kind reaches this list without anybody remembering to add it here. */
const OWNER_ITEM_REASONS: readonly string[] = Object.values(OWNER_ITEM_PUSH_KINDS);

/** Whether this reason is one of the four items waiting on the owner (§7.1 V2). */
function isOwnerItemReason(reason: AttentionReason | null): reason is OwnerItemPushKind {
  return reason !== null && OWNER_ITEM_REASONS.includes(reason);
}

type ProjectOwnerItem = NonNullable<ProjectAttentionSummary['ownerItems']>[number];

/**
 * The owner item the row leads with: the one that has waited longest, with a fixed kind order
 * settling a tie.
 *
 * Iterated in that order rather than in whatever order the array arrived, because two items that
 * have waited equally long must produce the same chip on every read — a row whose label flickered
 * between two true statements would make the reader look twice at a fact that had not changed.
 */
function leadOwnerItem(project: AttentionProject): ProjectOwnerItem | null {
  const items = project.attention?.ownerItems ?? [];
  let lead: ProjectOwnerItem | null = null;
  for (const kind of OWNER_ITEM_KINDS) {
    const item = items.find((candidate) => candidate.kind === kind);
    if (!item) continue;
    if (!lead || byInstantAsc(item.oldestWaitingSince, lead.oldestWaitingSince) < 0) lead = item;
  }
  return lead;
}

/**
 * Current servers report FAILED explicitly. The remainder is retained only as rolling-deploy
 * compatibility with an older server, and still keeps failed work in the denominator.
 */
export function failedTaskCount(project: AttentionProject): number {
  if (project.buckets.failed != null) return project.buckets.failed;
  const { running, ready, blocked, done, cancelled } = project.buckets;
  const awaitingVerification = project.buckets.awaitingVerification ?? 0;
  return Math.max(
    0,
    project._count.tasks - running - ready - blocked - awaitingVerification - done - cancelled,
  );
}

/** Whole quiet days, or null when the timestamp is missing, invalid, future, or still fresh. */
function quietDays(lastActivityAt: string | null, now: number): number | null {
  const rank = instantRank(lastActivityAt);
  if (rank === Number.NEGATIVE_INFINITY) return null;
  const quiet = now - rank;
  return quiet < QUIET_MS ? null : Math.floor(quiet / DAY_MS);
}

/**
 * Why an OPEN project needs a visible attention signal.
 *
 * Raw FAILED counts are evidence, never a human-attention rule: a failed task is reported by the
 * row's own status, and it is a durable open blocker — not the tally — that says somebody must act.
 */
export function attentionReasonOf(project: AttentionProject, now: number): AttentionReason | null {
  if (project.status !== 'OPEN') return null;

  // An item sitting on the OWNER outranks everything else the row could say: it is the one fact
  // that names a piece of work a person has to go and do, and the four of them are what mock 1's
  // chips print. Not `attention?.userBlockers` — a blocker is a tag somebody applied, and this is
  // an exception the platform routed to them and is waiting for.
  const lead = leadOwnerItem(project);
  if (lead) return OWNER_ITEM_PUSH_KINDS[lead.kind];

  if (autoRemediationBlockerCount(project) > 0) return 'auto-remediation';
  if ((project.attention?.userBlockers ?? 0) > 0) return 'needs-user';

  const quiet = quietDays(project.lastActivityAt, now);
  if (project.buckets.running > 0 && quiet !== null) return 'no-activity-running';
  if (project.buckets.running === 0 && project.buckets.ready > 0 && quiet !== null) {
    return 'no-activity-ready';
  }

  const { running, ready, blocked, done, cancelled } = project.buckets;
  const awaitingVerification = project.buckets.awaitingVerification ?? 0;
  if (
    running + ready + blocked + awaitingVerification + failedTaskCount(project) === 0
    && done + cancelled > 0
  ) return 'ready-to-close';

  // Last, and only when nothing else is wrong: an exception the coordinator is working is the
  // project moving, so it explains a chip and never moves a row (§7.1 V2). Every reason above is
  // something the reader has to act on, and a coordinator's exception is not.
  if (project.attention?.coordinatorItems) return 'coordinator-handling';
  return null;
}

/**
 * Every project lands in exactly one lane. A routed control-plane repair is stronger than fresh
 * execution; otherwise attention takes priority once a run has gone quiet or no work is active.
 */
export function attentionSectionOf(project: AttentionProject, now: number): AttentionSectionKey {
  if (project.status !== 'OPEN') return 'completed';
  const reason = attentionReasonOf(project, now);

  // These blockers are not passive metadata: they are canonical work Orbit has already routed to
  // its coordinator/system. Keeping the row in Running would hide the broken control loop behind
  // unrelated fresh activity in the same project.
  if (reason === 'auto-remediation') return 'attention';

  // Nor is an item waiting on a person passive metadata, and it is stronger still: mock 1 keeps a
  // project with four tasks in flight in Needs attention while its branch waits to be merged.
  // Fresh activity is ordinary by comparison — somebody is asking the reader for something.
  if (isOwnerItemReason(reason)) return 'attention';

  const quietRunning = project.buckets.running > 0
    && quietDays(project.lastActivityAt, now) !== null;
  if (project.buckets.running > 0 && !quietRunning) return 'running';

  // A coordinator working an exception is the project moving; it earns the lane its activity
  // earns, which is where mock 1 draws it — brand chip, Running section (§7.1 V2).
  if (reason && reason !== 'coordinator-handling') return 'attention';
  if (project._count.tasks === 0) return 'definition';
  if (project.buckets.ready > 0) return 'ready';
  if (project.buckets.blocked > 0 || (project.buckets.awaitingVerification ?? 0) > 0) {
    return 'waiting';
  }
  // A normal failure is waiting on its automatic continuation, not waiting on the owner.
  if (failedTaskCount(project) > 0) return 'waiting';

  // Current payloads are exhaustive, so reaching this fallback means an inconsistent or mixed-
  // version payload. It is safer to ask for definition than to claim work is running or waiting
  // when neither fact exists.
  return 'definition';
}

const ATTENTION_REASON_RANK: Record<AttentionReason, number> = {
  // One tier, not four: which of the four an owner is asked about is a fact about the project, and
  // the reader's queue is that they are asked at all. Inside the tier the longest wait goes first,
  // which is what the chip beside it prints.
  'approve-merge-to-main': 1,
  'coordinator-question': 1,
  'escalated-to-you': 1,
  'fuse-paused': 1,
  'needs-user': 2,
  'auto-remediation': 3,
  'no-activity-running': 4,
  'no-activity-ready': 5,
  'ready-to-close': 6,
  // Never drawn in this lane — a coordinator's exception does not move a row — so this number
  // orders nothing. It is here because the `Record` is what makes a new reason a compile error
  // rather than a row that sorts as if it had no reason at all.
  'coordinator-handling': 7,
};

const ATTENTION_SEVERITY_RANK: Record<NonNullable<ProjectAttentionSummary['maxSeverity']>, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

const ATTENTION_SEVERITY_LABEL: Record<NonNullable<ProjectAttentionSummary['maxSeverity']>, string> = {
  CRITICAL: 'Critical',
  WARNING: 'Warning',
  INFO: 'Info',
};

/** Compact age for the human-attention chip. Future/invalid instants make no age claim. */
function elapsedDayLabel(at: string | null | undefined, now: number): string | null {
  const rank = instantRank(at);
  if (rank === Number.NEGATIVE_INFINITY || rank > now) return null;
  const days = Math.floor((now - rank) / DAY_MS);
  return days === 0 ? '<1d' : `${days}d`;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long an item has been waiting, for the chips that name one: `20m`, `2h`, `3d`.
 *
 * Finer than `elapsedDayLabel` because of what it is attached to. A day is the right resolution for
 * "this project has gone quiet" — nothing about it changed at 4pm — while a merge approval or a
 * question is an errand, and the owner reads a half-hour wait and an eighteen-hour one differently.
 * Past a day the two agree, and both say `<n>d`.
 */
function elapsedLabel(at: string | null | undefined, now: number): string | null {
  const rank = instantRank(at);
  if (rank === Number.NEGATIVE_INFINITY || rank > now) return null;
  const waited = now - rank;
  if (waited < MINUTE_MS) return '<1m';
  if (waited < HOUR_MS) return `${Math.floor(waited / MINUTE_MS)}m`;
  if (waited < DAY_MS) return `${Math.floor(waited / HOUR_MS)}h`;
  return `${Math.floor(waited / DAY_MS)}d`;
}

/** What the coordinator is doing with the item it holds, by the item's kind (§7.1 V2). */
const COORDINATOR_LEAD_COPY: Record<CoordinatorLeadKind, string> = {
  INTEGRATION_CONFLICT: 'resolving a merge conflict',
  INTEGRATION_CHECK_FAILED: 'checks failed',
  INTEGRATION_ERROR: 'handling an integration error',
  TASK_FAILED: 'handling a failed task',
};

/**
 * What the row says the owner must do, by the item's kind — the words the waiting time is appended
 * to (§7.1 V2).
 *
 * A `Record` over a closed set, like `ATTENTION_REASON_RANK`: a fifth owner-facing kind is a
 * sentence somebody has to write, and it should say so at the compiler rather than draw an empty
 * chip nobody looks at twice.
 */
const OWNER_ITEM_SAYS: Record<OwnerItemKind, (item: ProjectOwnerItem) => string> = {
  PROMOTION_APPROVAL: () => 'Needs you · Approve merge to main',
  COORDINATOR_QUESTION: (item) =>
    `Needs you · ${item.count} question${item.count === 1 ? '' : 's'} from coordinator`,
  ESCALATED: (item) => `Needs you · ${item.count} escalated to you`,
  FUSE_PAUSED: () => 'Paused · coordinator stopped itself',
};

/** Returns a new array; the React Query cache's array is never sorted in place. */
export function orderWithinSection<T extends AttentionProject>(
  key: AttentionSectionKey,
  projects: readonly T[],
  now: number,
): T[] {
  return [...projects].sort((a, b) => {
    if (key === 'attention') {
      const left = attentionReasonOf(a, now);
      const right = attentionReasonOf(b, now);
      const byReason = (left ? ATTENTION_REASON_RANK[left] : Number.MAX_SAFE_INTEGER)
        - (right ? ATTENTION_REASON_RANK[right] : Number.MAX_SAFE_INTEGER);
      if (byReason) return byReason;
      if (isOwnerItemReason(left) && isOwnerItemReason(right)) {
        const byWait = byInstantAsc(
          leadOwnerItem(a)?.oldestWaitingSince,
          leadOwnerItem(b)?.oldestWaitingSince,
        );
        if (byWait) return byWait;
      }
      if (
        (left === 'needs-user' && right === 'needs-user') ||
        (left === 'auto-remediation' && right === 'auto-remediation')
      ) {
        const leftSeverity = a.attention?.maxSeverity;
        const rightSeverity = b.attention?.maxSeverity;
        const bySeverity = (leftSeverity ? ATTENTION_SEVERITY_RANK[leftSeverity] : Number.MAX_SAFE_INTEGER)
          - (rightSeverity ? ATTENTION_SEVERITY_RANK[rightSeverity] : Number.MAX_SAFE_INTEGER);
        if (bySeverity) return bySeverity;
        const byAttentionAge = byInstantAsc(
          a.attention?.attentionSinceAt,
          b.attention?.attentionSinceAt,
        );
        if (byAttentionAge) return byAttentionAge;
      }
      return byInstantAsc(a.lastActivityAt, b.lastActivityAt) || byId(a, b);
    }
    if (key === 'running' || key === 'completed') {
      return byInstantDesc(a.lastActivityAt, b.lastActivityAt) || byId(a, b);
    }
    if (key === 'definition') {
      return a.title.localeCompare(b.title) || byId(a, b);
    }
    return byInstantAsc(a.lastActivityAt, b.lastActivityAt) || byId(a, b);
  });
}

/** The complete index contract: fixed lanes, total classification, and a visible order per lane. */
export function projectAttentionSections<T extends AttentionProject & SectionProject>(
  all: readonly T[],
  now: number,
): ProjectSection<T>[] {
  return SECTIONS.map((section) => ({
    ...section,
    projects: orderWithinSection(
      section.key,
      all.filter((project) => attentionSectionOf(project, now) === section.key),
      now,
    ),
  }));
}

export type AttentionChipTone = 'warning' | 'brand';

export interface AttentionChip {
  tone: AttentionChipTone;
  text: string;
}

/** The row-level explanation for why a project leads the page. */
export function attentionChipOf(project: AttentionProject, now: number): AttentionChip | null {
  const reason = attentionReasonOf(project, now);
  if (!reason) return null;

  // What the owner has to go and do, and how long it has been waiting for them. The four are one
  // sentence with the kind's own words in it, so the chip and the phone's banner and the card that
  // opens behind the tap all name the same thing (§7.6 V12).
  if (isOwnerItemReason(reason)) {
    const item = leadOwnerItem(project);
    if (!item) return null;
    const age = elapsedLabel(item.oldestWaitingSince, now);
    const says = OWNER_ITEM_SAYS[item.kind](item);
    return { tone: 'warning', text: [says, age].filter(Boolean).join(' · ') };
  }

  if (reason === 'coordinator-handling') {
    const held = project.attention?.coordinatorItems;
    if (!held) return null;
    const age = elapsedLabel(held.oldestWaitingSince, now);
    return {
      tone: 'brand',
      text: ['Coordinator', COORDINATOR_LEAD_COPY[held.leadKind], age].filter(Boolean).join(' · '),
    };
  }

  if (reason === 'needs-user') {
    const blockers = project.attention?.userBlockers ?? 0;
    const severity = project.attention?.maxSeverity;
    const age = elapsedDayLabel(project.attention?.attentionSinceAt, now);
    return {
      tone: 'warning',
      text: [
        'Needs you',
        severity ? ATTENTION_SEVERITY_LABEL[severity] : null,
        age,
        `${blockers} blocker${blockers === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · '),
    };
  }

  if (reason === 'auto-remediation') {
    const blockers = autoRemediationBlockerCount(project);
    const userBlockers = project.attention?.userBlockers ?? 0;
    const severity = project.attention?.maxSeverity;
    const age = elapsedDayLabel(project.attention?.attentionSinceAt, now);
    return {
      tone: 'warning',
      text: [
        'Auto-remediation',
        'Coordinator-owned',
        severity ? ATTENTION_SEVERITY_LABEL[severity] : null,
        age,
        `${blockers} blocker${blockers === 1 ? '' : 's'}`,
        userBlockers > 0 ? `${userBlockers} need you` : null,
      ].filter(Boolean).join(' · '),
    };
  }

  if (reason === 'ready-to-close') {
    const { running, ready, blocked, done, cancelled } = project.buckets;
    const awaitingVerification = project.buckets.awaitingVerification ?? 0;
    const failed = failedTaskCount(project);
    const settled = done + cancelled;
    return {
      tone: 'brand',
      text: `${settled}/${running + ready + blocked + awaitingVerification + failed + settled} settled · still open`,
    };
  }

  const days = quietDays(project.lastActivityAt, now);
  if (days === null) return null;
  if (reason === 'no-activity-running') {
    return { tone: 'warning', text: `Running · no activity ${days}d` };
  }
  return { tone: 'warning', text: `Ready · no activity ${days}d` };
}

/** Where a project's finished work lands, as the row states it beside the title. */
export interface IntegrationChip {
  /** The branch's name. On a `MAIN` line it is the upstream the project merges into. */
  text: string;
  /** Whether to draw the branch mark: a project branch is a branch, `main` is where everything
   *  ends up, and the mock marks only the first. */
  branch: boolean;
}

/**
 * The line a row lands on (§7.1 V1/V2): `project/bg-jobs` for a project branch, `main` for a project
 * that merges straight into it.
 *
 * Stated in the branch's own name rather than as the word "main" always: a project whose upstream
 * is called `master` or `develop` would otherwise be told a branch it does not merge into. Nothing
 * at all when no line has been decided and nothing has integrated — a project that has not chosen
 * is not one that chose main.
 */
export function integrationChipOf(project: AttentionProject): IntegrationChip | null {
  const integration = project.integration;
  if (!integration) return null;
  return { text: integration.ref, branch: integration.line === 'PROJECT_BRANCH' };
}
