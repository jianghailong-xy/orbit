import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { classifyFailure, FailureCause, toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { releaseWasFailureFilter } from '../common/session-release';
import { LEGACY_STATUS_SELECT, legacySessionStatus } from '../sessions/session-legacy-words';
import { countTaskWorkCarriers } from '../sessions/task-work-carrier';
import { readProjectPanorama } from '../projects/project-panorama';

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
const REFERENCE_RE = /\(\s*<?orbit-(list|task|session|project):([0-9a-zA-Z-]+)>?\s*\)/g;

/**
 * An Orbit web URL naming a session, project or task — the way people point at a session most
 * (206 of 413 references on production, 2026-11-28; docs/composer-references-design.md §1). Any
 * origin: what makes it a reference is that the id resolves to something the sender owns, and a
 * deployment reached by two names is still one deployment.
 */
const URL_RE =
  /https?:\/\/[^\s<>()"'`]+?\/(sessions|projects|tasks)\/([0-9A-Za-z]{20,22}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9A-Za-z-])/g;

/**
 * A bare id: a base62 public id (21–22 characters, mixing digits, upper and lower case, as every
 * one of 128 bits does) or a canonical uuid, standing on its own rather than inside a path or a
 * link. The other half of how people point at a session (209 of 413). A match is only a candidate:
 * it becomes a reference when it resolves to a session, project or task the sender owns, which is
 * what keeps a commit hash, a key or a word of base62 from turning into one.
 */
const BARE_RE =
  /(?<![0-9A-Za-z_/.:-])([0-9A-Za-z]{21,22}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9A-Za-z_-])/g;

/** How many distinct references one message may expand. */
const MAX_REFERENCES = 8;

/** How many bare candidates one message may look up: a pasted log is not a reason for a long query. */
const MAX_BARE_CANDIDATES = 32;

type ReferenceKind = 'list' | 'task' | 'session' | 'project';

interface Reference {
  kind: ReferenceKind;
  id: string;
}

/** Who sent the message being expanded, and from where. */
export interface ExpandOptions {
  /**
   * The owner typed this message themselves. Only then are sessions, projects, pasted URLs and bare
   * ids recognised: an agent's `session_send` and Orbit's own notices are delivered as they always
   * were (design §8 decision B), and a guest's or a Feishu sender's id never makes the owner's agent
   * read out another of the owner's sessions.
   */
  byOwner?: boolean;
  /** The session receiving the message: a reference to itself says nothing new and is skipped. */
  sessionId?: string;
  /** The runner it runs on, so a referenced session can say whether it is on this machine. */
  runnerId?: string | null;
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

  /** The project card's lane counts (projects/project-panorama.ts); a field so a spec can answer it. */
  panorama: typeof readProjectPanorama = readProjectPanorama;

  /**
   * Append a `<referenced-*>` block for every reference in `content`, or return it unchanged when
   * there are none — which is the overwhelmingly common case, so it costs one regex scan and no
   * queries.
   *
   * Scoped to `ownerId`: a reference naming something the sender does not own expands to nothing
   * rather than to an error. The message is still theirs to send, and a stray id in prose should
   * not fail delivery of the turn that carries it.
   */
  async expand(
    ownerId: string,
    content: string | null | undefined,
    opts: ExpandOptions = {},
  ): Promise<string | null | undefined> {
    if (!content) return content;
    let refs = parseReferences(content, { recognise: opts.byOwner === true });
    if (opts.byOwner) refs = await this.withBareIds(ownerId, content, refs);
    if (opts.sessionId) refs = refs.filter((r) => !(r.kind === 'session' && r.id === opts.sessionId));
    if (refs.length === 0) return content;
    const blocks: string[] = [];
    for (const ref of refs.slice(0, MAX_REFERENCES)) {
      const block =
        ref.kind === 'list'
          ? await this.describeList(ownerId, ref.id)
          : ref.kind === 'task'
            ? await this.describeTask(ownerId, ref.id)
            : ref.kind === 'session'
              ? await this.describeSession(ownerId, ref.id, opts.runnerId ?? null)
              : await this.describeProject(ownerId, ref.id);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) return content;
    return `${content}\n\n${blocks.join('\n\n')}`;
  }

  /**
   * `refs` plus the bare ids in `content` that name a session, project or task the owner has, in the
   * order they appear. Three indexed lookups by primary key, and none when the message holds no
   * candidate — the common case.
   */
  private async withBareIds(ownerId: string, content: string, refs: Reference[]): Promise<Reference[]> {
    const known = new Set(refs.map((r) => r.id));
    const candidates = parseBareIds(content).filter((id) => !known.has(id));
    if (candidates.length === 0 || refs.length >= MAX_REFERENCES) return refs;
    const [sessions, projects, tasks] = await Promise.all([
      this.prisma.session.findMany({ where: { id: { in: candidates }, ownerId }, select: { id: true } }),
      this.prisma.project.findMany({ where: { id: { in: candidates }, ownerId }, select: { id: true } }),
      this.prisma.task.findMany({ where: { id: { in: candidates }, ownerId }, select: { id: true } }),
    ]);
    const kindOf = new Map<string, ReferenceKind>([
      ...tasks.map((r) => [r.id, 'task'] as const),
      ...projects.map((r) => [r.id, 'project'] as const),
      ...sessions.map((r) => [r.id, 'session'] as const),
    ]);
    const out = [...refs];
    for (const id of candidates) {
      const kind = kindOf.get(id);
      if (kind) out.push({ kind, id });
    }
    return out;
  }

  /**
   * What the agent needs to look into a session someone pointed at — the question behind ~70% of
   * session references ("it finished but still shows Running", "why did it fail"). Facts and ids,
   * never its conversation: `session_get` reads that.
   *
   * `List shows` is the phase every client's session list draws the row from, beside the facts it is
   * derived from, so a mismatch between what the person sees and what happened is visible on the
   * first read. `Runs on` says outright when it is another machine — a third of the sessions people
   * reference — so the agent does not go looking for local logs that are not there.
   */
  private async describeSession(ownerId: string, id: string, runnerId: string | null): Promise<string | null> {
    const s = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        openedBy: true,
        createdAt: true,
        lastTurnAt: true,
        numTurns: true,
        phase: true,
        ...LEGACY_STATUS_SELECT,
        error: true,
        deletedAt: true,
        branch: true,
        branchMerged: true,
        mergeStatus: true,
        worktreeDirty: true,
        assignedRunnerId: true,
        assignedRunner: { select: { name: true } },
        workspace: { select: { name: true } },
        task: { select: { id: true, title: true, status: true, project: { select: { id: true, title: true } } } },
        coordinatorForProject: { select: { id: true, title: true } },
      },
    });
    if (!s) return null;
    const pendingApprovals = await this.prisma.approval.count({ where: { sessionId: id, status: 'PENDING' } });
    const where =
      s.assignedRunnerId == null
        ? 'no runner yet'
        : `runner ${s.assignedRunner?.name ?? '(unnamed)'}` +
          (runnerId == null ? '' : s.assignedRunnerId === runnerId ? ' (this runner)' : ' (not this runner)');
    const status = s.sessionKind === 'LANDING' ? null : legacySessionStatus(s);
    const project = s.coordinatorForProject ?? s.task?.project ?? null;
    const lines = [
      `<referenced-session id="${uuidToBase62(s.id)}">`,
      `  Title       ${s.title}`,
      `  Opened      ${s.createdAt.toISOString()} by ${s.openedBy.toLowerCase()} · workspace ${s.workspace?.name ?? '(none)'}`,
      `  Runs on     ${where}`,
      `  List shows  ${s.phase ?? 'unknown'}${status ? ` · status ${status}` : ''}${s.deletedAt ? ' · in Trash' : ''}`,
      `  Turns       ${s.numTurns}; last ${s.lastTurnOutcome ?? 'none'}${s.lastTurnAt ? ` at ${s.lastTurnAt.toISOString()}` : ''}` +
        `${s.finishedAt ? ' · released' : ''}`,
      ...(s.task
        ? [`  Task        "${s.task.title}" (id ${uuidToBase62(s.task.id)}) ${s.task.status}`]
        : []),
      ...(project
        ? [`  Project     "${project.title}" (id ${uuidToBase62(project.id)})${s.coordinatorForProject ? ' · its coordinator' : ''}`]
        : []),
      ...(s.branch
        ? [
            `  Code        branch ${s.branch} · merged ${s.branchMerged == null ? 'unknown' : s.branchMerged ? 'yes' : 'no'}` +
              `${s.mergeStatus ? ` (${s.mergeStatus})` : ''}` +
              `${s.worktreeDirty == null ? '' : s.worktreeDirty ? ' · uncommitted changes' : ' · nothing uncommitted'}`,
          ]
        : []),
      `  Last error  ${s.error ? firstLine(s.error) : 'none'}`,
      `  Pending     ${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'}`,
      `  For its output and status, call session_get; this gives the facts, not the conversation.`,
      `</referenced-session>`,
    ];
    return lines.join('\n');
  }

  /**
   * Where a project stands — "what is left", the question behind a `#` project reference: its task
   * lanes as the project card counts them (readProjectPanorama), what is blocking it, and what waits
   * on the owner, with its coordinator to ask. Which criteria are met is project_get's to answer.
   */
  private async describeProject(ownerId: string, id: string): Promise<string | null> {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        status: true,
        coordinatorSessionId: true,
        coordinatorSession: { select: { phase: true } },
      },
    });
    if (!project) return null;
    const [{ buckets, shape }, blockers, ownerItems, criteria] = await Promise.all([
      this.panorama(this.prisma, ownerId, id),
      this.prisma.projectBlocker.count({ where: { projectId: id, resolvedAt: null } }),
      // Counted, never assigned: the census in push/owner-item-push-sites.spec.ts is of the writers.
      this.prisma.projectOpenItem.count({ where: { projectId: id, state: 'OPEN', assignee: { equals: 'OWNER' } } }),
      this.prisma.projectAcceptanceCriterionDefinition.count({ where: { projectId: id } }),
    ]);
    const lanes = (
      [
        ['running', buckets.running],
        ['ready', buckets.ready],
        ['blocked', buckets.blocked],
        ['awaiting verification', buckets.awaitingVerification],
        ['done', buckets.done],
        ['failed', buckets.failed],
        ['cancelled', buckets.cancelled],
      ] as const
    )
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' / ');
    return [
      `<referenced-project id="${uuidToBase62(project.id)}">`,
      `  Title        ${project.title}`,
      `  Status       ${project.status}`,
      `  Tasks        ${shape.taskCount} in total${lanes ? `: ${lanes}` : ''}`,
      `  Criteria     ${criteria} stated; project_get says which are met`,
      `  Blockers     ${blockers} open · ${ownerItems} item${ownerItems === 1 ? '' : 's'} waiting on the owner`,
      `  Coordinator  ${project.coordinatorSessionId ? `session ${uuidToBase62(project.coordinatorSessionId)} · ${project.coordinatorSession?.phase ?? 'unknown'}` : 'none'}`,
      `  For the details, fetch them yourself with project_get / task_list — this gives the shape, not the contents.`,
      `</referenced-project>`,
    ].join('\n');
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
        where: { task: { listId: id }, ...releaseWasFailureFilter() },
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
        select: { ...LEGACY_STATUS_SELECT, numTurns: true, error: true },
      }),
    ]);
    // The evidence question, answered up front — it is the one that decided every verification
    // verdict that mattered here, and the one a reader is least likely to think to ask.
    const executed = await this.prisma.session.count({
      where: { taskId: id, numTurns: { gt: 0 } },
    });
    const lastLine = lastRun
      // The word derived from the facts (plan §3.1). A task's run is never a LANDING container, so no landing row.
      ? `${legacySessionStatus(lastRun)}${lastRun.error ? ` (${classifyFailure(lastRun.error)})` : ''}, ${lastRun.numTurns} turns`
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
export function parseReferences(content: string, opts: { recognise?: boolean } = {}): Reference[] {
  const seen = new Set<string>();
  const out: Reference[] = [];
  const push = (kind: ReferenceKind, raw: string): void => {
    // Normalised so the two spellings of one id dedupe against each other, and so a value that
    // is neither is dropped rather than reaching a `::uuid` cast: prose is allowed to contain
    // anything, and a malformed reference must cost the expansion, not the delivery.
    let id: string;
    try {
      id = toUuid(raw);
    } catch {
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ kind, id });
  };
  // In the order they were written, links and URLs alike, so the cap keeps the first ones.
  const found: Array<{ at: number; kind: ReferenceKind; raw: string }> = [];
  for (const m of content.matchAll(REFERENCE_RE)) {
    const kind = m[1] as ReferenceKind;
    // A session or project link is the composer's chip on the owner's message; elsewhere (an agent's
    // message, Orbit's notice) only the two kinds expanded before are, so their prompts do not grow.
    if (!opts.recognise && (kind === 'session' || kind === 'project')) continue;
    found.push({ at: m.index, kind, raw: m[2] });
  }
  if (opts.recognise) {
    for (const m of content.matchAll(URL_RE)) {
      const kind = ({ sessions: 'session', projects: 'project', tasks: 'task' } as const)[m[1] as 'sessions'];
      found.push({ at: m.index, kind, raw: m[2] });
    }
  }
  found.sort((a, b) => a.at - b.at);
  for (const f of found) {
    push(f.kind, f.raw);
    if (out.length >= MAX_REFERENCES) break;
  }
  return out;
}

/**
 * The bare ids in `content`, as uuids, de-duplicated and capped. A base62 candidate must mix
 * digits, upper and lower case, as a random 128-bit id almost always does and a word never does.
 */
export function parseBareIds(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(BARE_RE)) {
    const raw = m[1];
    if (!raw.includes('-') && !(/[0-9]/.test(raw) && /[A-Z]/.test(raw) && /[a-z]/.test(raw))) continue;
    try {
      out.add(toUuid(raw));
    } catch {
      continue;
    }
    if (out.size >= MAX_BARE_CANDIDATES) break;
  }
  return [...out];
}

/** An error's first line, short enough for a facts block. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
