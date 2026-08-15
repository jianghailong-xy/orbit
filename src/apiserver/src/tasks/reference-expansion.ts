import { Injectable } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { classifyFailure, FailureCause } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * `orbit-list:<uuid>` / `orbit-task:<uuid>` inside a markdown link, the same custom scheme the
 * transcript already renders attachments with (`orbit-attachment:<id>`). Matching the URI rather
 * than the link text is what lets the composer show a chip reading "FineWeb CC-MAIN-2025-26"
 * while the wire carries an id.
 */
const REFERENCE_RE = /\(\s*<?orbit-(list|task):([0-9a-fA-F-]{36})>?\s*\)/g;

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
    const [byStatus, live, failures] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { listId: id },
        _count: { _all: true },
      }),
      this.prisma.session.count({
        where: { task: { listId: id }, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
      }),
      this.prisma.session.findMany({
        where: { task: { listId: id }, status: RunStatus.FAILED },
        select: { error: true },
      }),
    ]);
    const counts = byStatus.map((r) => `${r.status} ${r._count._all}`).join(' / ') || '(无任务)';
    const causes = failures.reduce<Partial<Record<FailureCause, number>>>((acc, s) => {
      const c = classifyFailure(s.error);
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {});
    const causeLine =
      Object.entries(causes)
        .map(([k, v]) => `${k} ${v}`)
        .join(' / ') || '无';
    return [
      `<referenced-list id="${list.id}">`,
      `  标题   ${list.title}`,
      `  规模   ${counts}`,
      `  在跑   ${live}`,
      `  失败归因 ${causeLine}`,
      `  策略   ${list.paused ? '已暂停' : '运行中'} · 并发上限 ${list.maxConcurrent ?? '无'} · ` +
        `作业指导 ${list.instructions ? '已设置' : '无'} · 完成时验收 ${list.verifyOnDone ? '开' : '关'}`,
      `  明细请用 tasklist_get / task_list / task_get 自取——这里只给形状，不给内容。`,
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
      : '从未运行';
    return [
      `<referenced-task id="${task.id}">`,
      `  标题   ${task.title}`,
      `  状态   ${task.status}${task.isForeman ? ' · 协调任务' : ''}${task.verifiesTaskId ? ' · 验收任务' : ''}`,
      `  所属   ${task.list?.title ?? '(无列表)'} · 负责 ${task.assignee?.name ?? '(未指派)'}`,
      `  运行   共 ${runs} 次，其中执行过 turn 的 ${executed} 次；最近一次：${lastLine}`,
      `  详情请用 task_get 自取。`,
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
    const id = m[2].toLowerCase();
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id });
    if (out.length >= MAX_REFERENCES) break;
  }
  return out;
}
