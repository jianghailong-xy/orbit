import { uuidToBase62 } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { criterionKeyOf } from './project-acceptance';
import { readCriterionSatisfaction } from './project-criterion-satisfaction';
import { readLiveRulings } from './project-ruling';

/**
 * The state digest a successor coordinator opens with (docs/coordinator-handoff-v2-design.md §3).
 *
 * A successor used to spend its first turn reading project_get and task_list (17.6k tokens on the
 * 11-16 handoff) before it could say where things stand. The replacement renders the same facts
 * into the opening instead: one line per acceptance criterion (met or not), the owner rulings in
 * force, the open items, and one line per task (title, status, criterion). It is dated, because it
 * is a snapshot: the opening says a later read wins over it.
 *
 * Bounded by characters, not by the project's size: at most `STATE_DIGEST_MAX_CHARS`, which a
 * project of 40 tasks fits whole. Each section has a share, each line a length, and what does not
 * fit is counted on one line naming the read that has it.
 */

/** The digest's hard ceiling, in characters (≈4k tokens). */
export const STATE_DIGEST_MAX_CHARS = 16_000;

/** How many tasks the reader brings in at most; the digest counts the rest. */
const TASKS_READ_MAX = 400;

/** Per-line lengths, so one long title cannot take a section's share. */
const LINE_MAX = { criterion: 220, ruling: 280, openItem: 160, task: 90 } as const;

/** Each section's share of the ceiling; tasks get whatever the others leave. */
const SECTION_MAX = { criteria: 3_500, rulings: 3_000, openItems: 2_000 } as const;

/** Statuses a task is finished in: listed after the ones still moving, so truncation drops these first. */
const SETTLED: ReadonlySet<string> = new Set(['DONE', 'CANCELLED']);

export interface StateDigestInput {
  asOf: Date;
  criteria: ReadonlyArray<{ key: string; text: string; satisfied: boolean | null }>;
  rulings: ReadonlyArray<{ id: string; ruling: string; createdAt: string }>;
  openItems: ReadonlyArray<{ id: string; kind: string; assignee: string; title: string; taskId: string | null }>;
  /** Oldest first; the renderer puts unsettled ones first. */
  tasks: ReadonlyArray<{ id: string; title: string; status: string; criterionKey: string | null }>;
  /** Every task of the project, including any the reader did not bring in. */
  taskTotal: number;
  tasksByStatus: Readonly<Record<string, number>>;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Lines that fit `budget` characters, with a closing line counting those that did not.
 * `more(n)` is reserved for up front, so the count always fits beside what was kept.
 */
function fit(lines: string[], budget: number, more: (n: number) => string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const reserve = i === lines.length - 1 ? 0 : more(lines.length - i).length + 1;
    if (used + lines[i].length + 1 + reserve > budget) {
      kept.push(more(lines.length - i));
      return kept;
    }
    kept.push(lines[i]);
    used += lines[i].length + 1;
  }
  return kept;
}

export function renderStateDigest(input: StateDigestInput): string {
  const stamp = input.asOf.toISOString().slice(0, 16).replace('T', ' ');
  const ordinal = new Map(input.criteria.map((c, i) => [c.key, `C${i + 1}`]));
  const met = input.criteria.filter((c) => c.satisfied === true).length;
  const counts = Object.entries(input.tasksByStatus)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${status} ${n}`)
    .join(', ');

  const header = [
    `<state_digest as_of="${input.asOf.toISOString()}">`,
    `This project as Orbit's records stood at ${stamp} UTC, when this conversation was opened: `
      + `${input.taskTotal} task(s)${counts ? ` (${counts})` : ''}; `
      + `${input.criteria.length} acceptance criteria, ${met} met.`,
  ];
  const close = '</state_digest>';

  const criteria = [
    '',
    'Acceptance criteria (number · met or not · text · criterionKey):',
    ...(input.criteria.length === 0
      ? ['(none stated)']
      : fit(
        input.criteria.map((c, i) => `C${i + 1} · ${c.satisfied === true ? 'met' : c.satisfied === false ? 'not met' : 'not answered'} · ${clip(c.text, LINE_MAX.criterion)} · ${c.key}`),
        SECTION_MAX.criteria,
        (n) => `… ${n} more criteria not shown; project_get has them.`,
      )),
  ];
  const rulings = [
    '',
    'Owner rulings in force (project_ruling; oldest first):',
    ...(input.rulings.length === 0
      ? ['(none recorded)']
      : fit(
        input.rulings.map((r) => `- ${r.createdAt.slice(0, 10)} · ${clip(r.ruling, LINE_MAX.ruling)} · ${r.id}`),
        SECTION_MAX.rulings,
        (n) => `… ${n} more rulings not shown; project_get has them.`,
      )),
  ];
  const openItems = [
    '',
    'Open items (kind · waiting on · title · task):',
    ...(input.openItems.length === 0
      ? ['(none)']
      : fit(
        input.openItems.map((o) => `- ${o.kind} · ${o.assignee} · ${clip(o.title, LINE_MAX.openItem)}${o.taskId ? ` · task ${o.taskId}` : ''} · ${o.id}`),
        SECTION_MAX.openItems,
        (n) => `… ${n} more open items not shown.`,
      )),
  ];

  const sorted = [
    ...input.tasks.filter((t) => !SETTLED.has(t.status)),
    ...input.tasks.filter((t) => SETTLED.has(t.status)),
  ];
  const unread = Math.max(0, input.taskTotal - sorted.length);
  const used = [...header, ...criteria, ...rulings, ...openItems, close].join('\n').length;
  const taskHead = ['', 'Tasks (title · status · criterion · id; unfinished first):'];
  const taskBudget = STATE_DIGEST_MAX_CHARS - used - taskHead.join('\n').length - 2;
  const taskLines = sorted.map((t) => {
    const criterion = t.criterionKey ? (ordinal.get(t.criterionKey) ?? t.criterionKey) : 'no criterion';
    return `- ${clip(t.title, LINE_MAX.task)} · ${t.status} · ${criterion} · ${t.id}`;
  });
  const moreTasks = (n: number) => `… ${n + unread} more tasks not shown; task_list has every one.`;
  const tasks = [
    ...taskHead,
    ...(input.taskTotal === 0
      ? ['(none yet)']
      : taskLines.length === 0
        ? [moreTasks(0)]
        : (() => {
          const kept = fit(taskLines, taskBudget, moreTasks);
          // `fit` counts only the lines it was handed; tasks the reader never brought in are counted too.
          return unread > 0 && kept.length === taskLines.length ? [...kept, moreTasks(0)] : kept;
        })()),
  ];

  return [...header, ...criteria, ...rulings, ...openItems, ...tasks, close].join('\n');
}

/** An id as the tools take it; a non-uuid (a unit-test row) passes through. */
function base62(id: string): string {
  try {
    return uuidToBase62(id);
  } catch {
    return id;
  }
}

/** The digest of one project, read as of now. Six statements; none is per task. */
export async function readStateDigest(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
  asOf = new Date(),
): Promise<string> {
  const [definitions, satisfaction, rulings, openItems, tasks, byStatus] = await Promise.all([
    prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId, project: { ownerId } },
      orderBy: { ordinal: 'asc' },
      select: { id: true, text: true },
    }),
    readCriterionSatisfaction(prisma, ownerId, projectId),
    readLiveRulings(prisma, ownerId, projectId),
    prisma.projectOpenItem.findMany({
      where: { projectId, ownerId, state: 'OPEN' },
      orderBy: { waitingSince: 'asc' },
      select: { id: true, kind: true, assignee: true, title: true, taskId: true },
    }),
    prisma.task.findMany({
      where: { projectId, ownerId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: TASKS_READ_MAX,
      select: { id: true, title: true, status: true, criterionDefinitionId: true },
    }),
    prisma.projectTaskStatusCount.findMany({
      where: { projectId, count: { gt: 0 } },
      select: { status: true, count: true },
    }),
  ]);
  const answered = new Map(satisfaction.map((row) => [row.definitionId, row.satisfied]));
  return renderStateDigest({
    asOf,
    criteria: definitions.map((d) => ({ key: criterionKeyOf(d.id), text: d.text, satisfied: answered.get(d.id) ?? null })),
    rulings: rulings.map((r) => ({ id: base62(r.id), ruling: r.ruling, createdAt: r.createdAt })),
    openItems: openItems.map((o) => ({
      id: base62(o.id), kind: o.kind, assignee: o.assignee, title: o.title, taskId: o.taskId ? base62(o.taskId) : null,
    })),
    tasks: tasks.map((t) => ({
      id: base62(t.id),
      title: t.title,
      status: t.status,
      criterionKey: t.criterionDefinitionId ? criterionKeyOf(t.criterionDefinitionId) : null,
    })),
    taskTotal: byStatus.reduce((total, row) => total + row.count, 0),
    tasksByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.count])),
  });
}
