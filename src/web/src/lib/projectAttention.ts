import type { ProjectSection, SectionProject } from '../components/ProjectSections';
import { stalledOnReady, type ProjectPanoramaBuckets } from '../components/ProjectPanoramaHeader';

/**
 * WHERE a project goes on the index, and IN WHAT ORDER inside it.
 *
 * The list used to be one flat run of `createdAt desc`. That key was never rendered, so the order
 * could neither be predicted before reading nor checked afterwards — and it answered a question
 * nobody was asking: when a project was FILED says nothing about whether it needs the reader now.
 * Under it, a project with nine ready tasks and nothing running sat seventh.
 *
 * So the page is cut by what the reader can do about each project, and every section states its
 * own ordering in its header. Two rules hold this together and neither is optional:
 *
 *   1. Every value a section sorts on is ON the row it sorts — `ready` in the row's bucket
 *      numbers, `lastActivityAt` in its last column. An order whose key is invisible is
 *      indistinguishable from no order at all, which is what `createdAt desc` was.
 *   2. Every header's small print is TRUE of every row under it, including the awkward ones
 *      (see `attentionSectionOf` for which those are). A header that describes most of its
 *      section is a header the reader stops trusting.
 *
 * Lives in lib rather than in ProjectsPage because deciding the order is separable from drawing
 * a row, and because the rules below are what the suite asserts directly.
 */

/** What this module needs of a project. The row carries much more; none of it changes the order. */
export interface AttentionProject {
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  buckets: ProjectPanoramaBuckets;
  /** ISO instant of the project's most recent task write, or null on one with no tasks. */
  lastActivityAt: string | null;
}

export type AttentionSectionKey = 'stalled' | 'wrapping-up' | 'running' | 'completed';

/**
 * The four sections, in the order they are read.
 *
 * Stalled is FIRST and In progress is third, which is the page's whole premise: work that is
 * already running does not need the reader, and work that could run but isn't does. Wrapping up
 * sits between them because closing a finished project is a smaller ask than starting a stalled
 * one, but it is still an ask — unlike anything below it.
 *
 * `note` is the header's small print, and it says two things in one line: what lands in this
 * section, and what orders it. Both halves are checked against `attentionSectionOf` and
 * `orderWithinSection` by the suite, because a note that drifts from the code is worse than none.
 */
const SECTIONS: ReadonlyArray<{
  key: AttentionSectionKey;
  title: string;
  note: string;
  defaultCollapsed?: boolean;
}> = [
  {
    key: 'stalled',
    title: 'Stalled',
    note: 'Nothing running, work outstanding · most ready first, then newest activity',
  },
  {
    key: 'wrapping-up',
    title: 'Wrapping up',
    note: 'Every task settled, project still open · newest activity first',
  },
  {
    key: 'running',
    title: 'In progress',
    note: 'Work in flight, or no tasks filed yet · newest activity first',
  },
  {
    key: 'completed',
    title: 'Completed',
    // Finished work is the list's background, not its subject: counted, one click from being
    // read, and not spending a row apiece on the way to what still needs doing.
    note: 'Newest activity first · folded by default',
    defaultCollapsed: true,
  },
];

/**
 * Which section one project belongs to. Total by construction — every project lands somewhere.
 *
 * The order of the tests below is the definition, since the plain rules overlap and do not cover
 * everything on their own:
 *
 *   - `status !== 'OPEN'` rather than DONE-or-CANCELLED by name, so a status this page has not
 *     heard of still lands in a section instead of falling off the list.
 *   - `running > 0` wins over ready work: a project can be both running and holding ready tasks,
 *     and something IS being served there, so it is not stalled.
 *   - `blocked > 0` with nothing running and nothing ready is NOT a rule the design stated, and
 *     it is reachable: every open task can be waiting on a prerequisite in ANOTHER project. It
 *     is stalled in the plainest sense — nothing running and nothing that can start — so it goes
 *     to Stalled, where `ready = 0` puts it at the tail, below every project with work to pick up.
 *     The header says "nothing running, work outstanding" rather than "has ready tasks" so that
 *     it is true of these rows too.
 *   - An OPEN project whose tasks are ALL settled is Wrapping up: nothing left to run, and a
 *     status that still says otherwise.
 *   - An OPEN project with NO TASKS AT ALL falls through to In progress, at the tail.
 *     Deliberately not Wrapping up: that section says "every task settled", and a project that
 *     has never had a task has settled nothing — it would be the only row there that had
 *     finished no work, under a header claiming it had. In progress is where a just-created
 *     project belongs anyway, and it needs no special case in the sort: `lastActivityAt` is null
 *     on a project with no tasks, and null sorts last (see `activityRank`), so it arrives at the
 *     tail on its own. The header's "or no tasks filed yet" is what keeps that honest.
 */
export function attentionSectionOf(project: AttentionProject): AttentionSectionKey {
  if (project.status !== 'OPEN') return 'completed';

  const { running, ready, blocked, done, cancelled } = project.buckets;

  if (running > 0) return 'running';
  // The project page's own predicate, imported rather than restated: "ready in the list and
  // running on the project page" is a worse answer than either number alone would have been.
  if (stalledOnReady(project.buckets)) return 'stalled';
  if (blocked > 0) return 'stalled';
  if (done + cancelled > 0) return 'wrapping-up';
  return 'running';
}

/**
 * An instant as a number, with "never" as the smallest one there is.
 *
 * Null is a project with no tasks, and it sorts BELOW every real instant rather than above: it
 * has not been quiet since some date, it has never been anything. An unparseable value is read
 * the same way — a comparator that returns NaN sorts in whatever order the engine happens to
 * pick, which is precisely the invisible randomness this module exists to remove.
 */
function activityRank(at: string | null): number {
  if (!at) return -Infinity;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Most recent first. The value is on the row, in its last column.
 *
 * Compared rather than subtracted: two projects that have BOTH never had a task rank -Infinity
 * apiece, and `-Infinity - -Infinity` is NaN. A sort reads that as "no opinion" only because the
 * spec coerces it to zero, and two brand-new projects is an ordinary thing for an account to
 * have — not a place to be leaning on that coercion.
 */
function byActivityDesc(a: AttentionProject, b: AttentionProject): number {
  const left = activityRank(a.lastActivityAt);
  const right = activityRank(b.lastActivityAt);
  if (left === right) return 0;
  return right > left ? 1 : -1;
}

/**
 * How one section is ordered. Returns a new array — the query cache's own array is never sorted
 * in place.
 *
 * Stalled leads with `ready` because that is the size of the ask: the project with 6,118 tasks
 * that could start and nothing starting them is the first thing on the page. Ties break on
 * activity rather than on the incoming order, so two projects with the same ready count are still
 * in an order the reader can predict from the row — a stable-but-arbitrary tie is unverifiable,
 * which is the same defect as an unrendered sort key.
 *
 * Every other section orders by activity alone. Completed included: what a finished project was
 * last doing is the only thing about it still worth ranking, and it is the number on the row.
 */
export function orderWithinSection<T extends AttentionProject>(
  key: AttentionSectionKey,
  projects: readonly T[],
): T[] {
  if (key !== 'stalled') return [...projects].sort(byActivityDesc);
  return [...projects].sort((a, b) => b.buckets.ready - a.buckets.ready || byActivityDesc(a, b));
}

/**
 * The whole index, cut into its four sections and ordered inside each.
 *
 * Empty sections are left in: `ProjectSections` drops them, and dropping them here would mean
 * two places deciding what an empty section is.
 */
export function projectAttentionSections<T extends AttentionProject & SectionProject>(
  all: readonly T[],
): ProjectSection<T>[] {
  return SECTIONS.map((section) => ({
    ...section,
    projects: orderWithinSection(
      section.key,
      all.filter((p) => attentionSectionOf(p) === section.key),
    ),
  }));
}
