import type { ProjectSection, SectionProject } from '../components/ProjectSections';
import type { ProjectPanoramaBuckets } from '../components/ProjectPanoramaHeader';

/**
 * The projects index is an attention router, not a second activity feed.
 *
 * A row first answers who must act next. Only then does its time decide where it sits among rows
 * that need the same kind of action. This keeps three different signals in their own jobs:
 *
 *   - counts describe scale;
 *   - time describes how long a condition has existed;
 *   - the section describes the next kind of action.
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
}

export interface ProjectAttentionSummary {
  userBlockers: number;
  coordinatorBlockers: number;
  systemBlockers: number;
  maxSeverity: 'INFO' | 'WARNING' | 'CRITICAL' | null;
  attentionSinceAt: string | null;
  nextCheckAt: string | null;
}

export type AttentionSectionKey =
  | 'attention'
  | 'running'
  | 'ready'
  | 'waiting'
  | 'definition'
  | 'completed';

export type AttentionReason =
  | 'needs-user'
  | 'failed'
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
    note: 'Needs you, failures, quiet work, or closure · reason/severity first, then oldest signal',
  },
  {
    key: 'running',
    title: 'Running',
    note: 'Work in flight · newest task activity first',
  },
  {
    key: 'ready',
    title: 'Ready',
    note: 'Can start now, nothing running · oldest task activity first',
  },
  {
    key: 'waiting',
    title: 'Waiting',
    note: 'Only dependency-blocked work remains · oldest task activity first',
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

/**
 * FAILED is deliberately absent from the five panorama buckets. `_count.tasks` is the complete
 * task count, so the remainder is exactly the FAILED count under the current closed TaskStatus
 * enum. Clamp at zero so a temporarily inconsistent aggregate never invents failed work.
 */
export function failedTaskCount(project: AttentionProject): number {
  const { running, ready, blocked, done, cancelled } = project.buckets;
  return Math.max(0, project._count.tasks - running - ready - blocked - done - cancelled);
}

/** Whole quiet days, or null when the timestamp is missing, invalid, future, or still fresh. */
function quietDays(lastActivityAt: string | null, now: number): number | null {
  const rank = instantRank(lastActivityAt);
  if (rank === Number.NEGATIVE_INFINITY) return null;
  const quiet = now - rank;
  return quiet < QUIET_MS ? null : Math.floor(quiet / DAY_MS);
}

/**
 * Why an OPEN project must leave the normal lifecycle lanes and lead the page.
 *
 * The order is intentional and is also the order inside Needs attention: a durable USER-owned
 * blocker leads because nobody else can clear it; an observed failure is stronger evidence than
 * silence; closing settled work is useful but not an operational fault.
 */
export function attentionReasonOf(project: AttentionProject, now: number): AttentionReason | null {
  if (project.status !== 'OPEN') return null;
  if ((project.attention?.userBlockers ?? 0) > 0) return 'needs-user';
  if (failedTaskCount(project) > 0) return 'failed';

  const quiet = quietDays(project.lastActivityAt, now);
  if (project.buckets.running > 0 && quiet !== null) return 'no-activity-running';
  if (project.buckets.running === 0 && project.buckets.ready > 0 && quiet !== null) {
    return 'no-activity-ready';
  }

  const { running, ready, blocked, done, cancelled } = project.buckets;
  if (running + ready + blocked === 0 && done + cancelled > 0) return 'ready-to-close';
  return null;
}

/** Every project lands in exactly one lane. Earlier predicates have higher authority. */
export function attentionSectionOf(project: AttentionProject, now: number): AttentionSectionKey {
  if (project.status !== 'OPEN') return 'completed';
  if (attentionReasonOf(project, now)) return 'attention';
  if (project._count.tasks === 0) return 'definition';
  if (project.buckets.running > 0) return 'running';
  if (project.buckets.ready > 0) return 'ready';
  if (project.buckets.blocked > 0) return 'waiting';

  // TaskStatus is closed and FAILED is the only status outside the five buckets, so reaching this
  // fallback means an inconsistent payload. It is safer to ask for definition than to claim work
  // is running or waiting when neither fact exists.
  return 'definition';
}

const ATTENTION_REASON_RANK: Record<AttentionReason, number> = {
  'needs-user': 0,
  failed: 1,
  'no-activity-running': 2,
  'no-activity-ready': 3,
  'ready-to-close': 4,
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
      if (left === 'needs-user' && right === 'needs-user') {
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

  if (reason === 'failed') {
    const failed = failedTaskCount(project);
    return { tone: 'warning', text: `${failed} failed task${failed === 1 ? '' : 's'}` };
  }

  if (reason === 'ready-to-close') {
    const { running, ready, blocked, done, cancelled } = project.buckets;
    const settled = done + cancelled;
    return {
      tone: 'brand',
      text: `${settled}/${running + ready + blocked + settled} settled · still open`,
    };
  }

  const days = quietDays(project.lastActivityAt, now);
  if (days === null) return null;
  if (reason === 'no-activity-running') {
    return { tone: 'warning', text: `Running · no activity ${days}d` };
  }
  return { tone: 'warning', text: `Ready · no activity ${days}d` };
}
