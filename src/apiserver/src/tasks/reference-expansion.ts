import { Injectable } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { classifyFailure, FailureCause, toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { countTaskWorkCarriers } from '../sessions/task-work-carrier';

/**
 * `orbit-list:<id>` / `orbit-task:<id>` inside a markdown link, the same custom scheme the
 * transcript already renders attachments with (`orbit-attachment:<id>`). Matching the URI rather
 * than the link text is what lets the composer show a chip reading "FineWeb CC-MAIN-2025-26"
 * while the wire carries an id.
 *
 * Either id spelling, like the attachment scheme: what clients hold is the base62 public id, and
 * pinning this to the 36-char uuid made every reference the composer produced expand to nothing —
 * silently, since an unmatched reference is indistinguishable from a message with none.
 */
const REFERENCE_RE = /\(\s*<?orbit-(list|task):([0-9a-zA-Z-]+)>?\s*\)/g;

/** How many distinct references one message may expand. */
const MAX_REFERENCES = 8;

interface Reference {
  kind: 'list' | 'task';
  id: string;
}

/**
 * Turns `#`-references in an outgoing message into context the agent can act on.
 *
 * Expanded at delivery rather than when the message is stored. Two reasons, and the second is
 * the load-bearing one:
 *
 *  - The transcript keeps what the person actually typed. Rewriting it would put a block of
 *    generated status text into their own message.
 *  - The summary is computed at the moment the run receives it. A 500-task list's counts change
 *    every minute; expanding at send time would hand the agent a snapshot that was already stale
 *    when it arrived, and it would have no way to know.
 *
 * What is injected is the *shape* of the thing and its id — never its contents. This
 * deployment's task descriptions total ~11 MB; a list reference that inlined them would blow the
 * context window on one message. The agent already has task_list / task_get / tasklist_get, so
 * an entry point is worth more than a dump, and it can fetch what it actually needs.
 *
 * That id is spelled base62, the same as the `id` those tools answer with — and the same one the
 * agent has to pass back to reach the row it names. Prose is the one boundary
 * `PublicIdInterceptor` cannot reach, since it rewrites response *fields* and a delivered message
 * is not one, so the encode happens here, where the id becomes text. An entry point spelled
 * unlike every other id in the run is not one.
 */
@Injectable()
export class ReferenceExpansionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a `<referenced-*>` block for every reference in `content`, or return it unchanged when
   * there are none — which is the overwhelmingly common case, so it costs one regex scan and no
   * queries.
   *
   * Scoped to `ownerId`: a reference naming something the sender does not own expands to nothing
   * rather than to an error. The message is still theirs to send, and a stray id in prose should
   * not fail delivery of the turn that carries it.
   */
  async expand(ownerId: string, content: string | null | undefined): Promise<string | null | undefined> {
    if (!content) return content;
    const refs = parseReferences(content);
    if (refs.length === 0) return content;
    const blocks: string[] = [];
    for (const ref of refs) {
      const block =
        ref.kind === 'list'
          ? await this.describeList(ownerId, ref.id)
          : await this.describeTask(ownerId, ref.id);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) return content;
    return `${content}\n\n${blocks.join('\n\n')}`;
  }

  private async describeList(ownerId: string, id: string): Promise<string | null> {
    const list = await this.prisma.taskList.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        paused: true,
        maxConcurrent: true,
        instructions: true,
        verifyOnDone: true,
      },
    });
    if (!list) return null;
    const [byStatus, live, failures, conditions] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { listId: id },
        _count: { _all: true },
      }),
      // The list's tasks a work session is carrying, as `tasklist_get` counts them.
      countTaskWorkCarriers(
        this.prisma,
        Prisma.sql`carrier."task_id" IN (
          SELECT list_task."id" FROM "task" list_task WHERE list_task."list_id" = ${id}::uuid)`,
      ),
      this.prisma.session.findMany({
        where: { task: { listId: id }, status: RunStatus.FAILED },
        select: { error: true },
      }),
      // "为什么卡住了" is the reason people reference a list at all, and the answer is here rather
      // than in any of the counts above — a quota or disk hold leaves every number looking healthy.
      this.prisma.taskListEvent.findMany({
        where: { listId: id },
        orderBy: { lastSeenAt: 'desc' },
        take: 4,
      }),
    ]);
    const counts = byStatus.map((r) => `${r.status} ${r._count._all}`).join(' / ') || '(no tasks)';
    const causes = failures.reduce<Partial<Record<FailureCause, number>>>((acc, s) => {
      const c = classifyFailure(s.error);
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {});
    const causeLine =
      Object.entries(causes)
        .map(([k, v]) => `${k} ${v}`)
        .join(' / ') || 'none';
    return [
      `<referenced-list id="${uuidToBase62(list.id)}">`,
      `  Title       ${list.title}`,
      `  Tasks       ${counts}`,
      `  Running     ${live}`,
      `  Failures    ${causeLine}`,
      `  Policy      ${list.paused ? 'paused' : 'running'} · concurrency cap ${list.maxConcurrent ?? 'none'} · ` +
        `instructions ${list.instructions ? 'set' : 'none'} · verify on done ${list.verifyOnDone ? 'on' : 'off'}`,
      ...(conditions.length > 0
        ? [
            `  Conditions  ${conditions
              .map((c) => `${c.kind}(${c.detail}, last seen ${c.lastSeenAt.toISOString()})`)
              .join('; ')}`,
          ]
        : []),
      `  For the details, fetch them yourself with tasklist_get / task_list / task_get — this gives ` +
        `the shape, not the contents.`,
      `</referenced-list>`,
    ].join('\n');
  }

  private async describeTask(ownerId: string, id: string): Promise<string | null> {
    const task = await this.prisma.task.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        status: true,
        isForeman: true,
        verifiesTaskId: true,
        list: { select: { title: true } },
        assignee: { select: { name: true } },
      },
    });
    if (!task) return null;
    const [runs, lastRun] = await Promise.all([
      this.prisma.session.count({ where: { taskId: id } }),
      this.prisma.session.findFirst({
        where: { taskId: id },
        orderBy: { createdAt: 'desc' },
        select: { status: true, numTurns: true, error: true },
      }),
    ]);
    // The evidence question, answered up front — it is the one that decided every verification
    // verdict that mattered here, and the one a reader is least likely to think to ask.
    const executed = await this.prisma.session.count({
      where: { taskId: id, numTurns: { gt: 0 } },
    });
    const lastLine = lastRun
      ? `${lastRun.status}${lastRun.error ? ` (${classifyFailure(lastRun.error)})` : ''}, ${lastRun.numTurns} turns`
      : 'never run';
    // Read back by the clients, which draw the block as a card (web lib/referencedTask.ts, OrbitKit
    // Transcript/ReferencedTask.swift): a label or a sentence reworded here is reworded there too.
    return [
      `<referenced-task id="${uuidToBase62(task.id)}">`,
      `  Title    ${task.title}`,
      `  Status   ${task.status}${task.isForeman ? ' · coordinating task' : ''}` +
        `${task.verifiesTaskId ? ' · verification task' : ''}`,
      `  List     ${task.list?.title ?? '(no list)'} · assignee ${task.assignee?.name ?? '(unassigned)'}`,
      `  Runs     ${runs} in total, ${executed} of them took a turn; last: ${lastLine}`,
      `  For the details, fetch them yourself with task_get.`,
      `</referenced-task>`,
    ].join('\n');
  }
}

/**
 * The references in `content`, de-duplicated and capped.
 *
 * De-duplication matters more than it looks: a person naturally mentions the same list twice in
 * one message ("pause X, and tell me why X stalled"), and expanding it twice would spend context
 * repeating itself.
 */
export function parseReferences(content: string): Reference[] {
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const m of content.matchAll(REFERENCE_RE)) {
    const kind = m[1] as 'list' | 'task';
    // Normalised so the two spellings of one id dedupe against each other, and so a value that
    // is neither is dropped rather than reaching a `::uuid` cast: prose is allowed to contain
    // anything, and a malformed reference must cost the expansion, not the delivery.
    let id: string;
    try {
      id = toUuid(m[2]);
    } catch {
      continue;
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id });
    if (out.length >= MAX_REFERENCES) break;
  }
  return out;
}
