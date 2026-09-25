import { Injectable } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import {
  deriveSessionRunState,
  toUuid,
  uuidToBase62,
  type LinkPreview,
  type LinkPreviewKind,
  type LinkPreviewList,
  type LinkPreviewProject,
  type LinkPreviewRef,
  type LinkPreviewSession,
  type LinkPreviewTask,
  type LinkPreviewWatching,
  type LinkPreviewWiki,
  type LinkPreviewsResponse,
  type WikiAnchorInput,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { readProjectPanorama } from '../projects/project-panorama';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';

/** A project's card before its coordinator's card is attached. */
type ProjectRead = Omit<LinkPreviewProject<Date>, 'coordinator'>;

/** A ref's id as a UUID, or null when it is neither a public id nor a UUID. */
function uuidOf(id: string): string | null {
  try {
    return toUuid(id);
  } catch {
    return null;
  }
}

/**
 * An entry's first anchor, as the record it is — or null on an entry that has none.
 *
 * The FIRST and not all of them: a card draws one line, and `anchors` is a jsonb column a
 * proposal may fill with eight records carrying commands and paths. The one that leads is the one
 * the entry was filed under, which is the order they were written in.
 */
function firstAnchor(raw: unknown): WikiAnchorInput | null {
  if (!Array.isArray(raw)) return null;
  const first = raw[0];
  if (!first || typeof first !== 'object') return null;
  const { type } = first as { type?: unknown };
  return typeof type === 'string' ? (first as WikiAnchorInput) : null;
}

/**
 * The cards for links to Orbit objects in a conversation: one batch read for every card it shows.
 *
 * Each kind is read the way its own page reads it, so a card cannot say something its page does
 * not: a session is its list row (`SessionsService.listRowsByIds`), a project's lanes are
 * `readProjectPanorama`'s, a list's tallies are the task page's (`TasksService.taskCounts`), and a
 * task's pill is drawn from the task list's live overlays (`TasksService.withRunning`). A wiki
 * entry is the one kind whose page has nothing of its own to say: the row IS the current revision
 * (`wikiCards`), so there is no second reading for a card to drift from.
 *
 * Only the caller's own objects are read. Everything else — another account's, deleted, an id that
 * names nothing — is `unavailable`, and the three are the same answer, so the response says nothing
 * about whether an object exists in somebody else's account.
 */
@Injectable()
export class LinkPreviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly tasks: TasksService,
  ) {}

  async read(ownerId: string, refs: readonly LinkPreviewRef[]): Promise<LinkPreviewsResponse<Date>> {
    const asked = refs.map((ref) => ({ kind: ref.kind, id: ref.id, uuid: uuidOf(ref.id) }));
    const idsOf = (kind: LinkPreviewKind) => [
      ...new Set(asked.flatMap((ref) => (ref.kind === kind && ref.uuid ? [ref.uuid] : []))),
    ];
    const [projects, tasks, lists, wiki] = await Promise.all([
      this.projects(ownerId, idsOf('project')),
      this.taskCards(ownerId, idsOf('task')),
      this.lists(ownerId, idsOf('list')),
      this.wikiCards(ownerId, idsOf('wiki')),
    ]);
    // One read for every session card, the projects' coordinators among them.
    const coordinatorIds = [...projects.values()].flatMap((p) =>
      p.coordinatorSessionId ? [p.coordinatorSessionId] : [],
    );
    const sessions = await this.sessionCards(ownerId, [...new Set([...idsOf('session'), ...coordinatorIds])]);

    const previews = asked.map(({ kind, id, uuid }): LinkPreview<Date> => {
      // Spelled here rather than by PublicIdInterceptor, which would also add a `publicId` twin —
      // to every item but the ones whose id did not decode, and those have to look like the rest.
      const address = { id: uuid ? uuidToBase62(uuid) : id };
      const unavailable = { kind, ...address, state: 'unavailable' as const };
      if (!uuid) return unavailable;
      switch (kind) {
        case 'session': {
          const session = sessions.get(uuid);
          return session ? { kind, ...address, state: 'ok', session } : unavailable;
        }
        case 'task': {
          const task = tasks.get(uuid);
          return task ? { kind, ...address, state: 'ok', task } : unavailable;
        }
        case 'project': {
          const project = projects.get(uuid);
          if (!project) return unavailable;
          // A coordinator in Trash is not one the card can show or lead to: the project reads as
          // having none.
          const coordinator = project.coordinatorSessionId
            ? sessions.get(project.coordinatorSessionId) ?? null
            : null;
          return {
            kind,
            ...address,
            state: 'ok',
            project: { ...project, coordinatorSessionId: coordinator?.id ?? null, coordinator },
          };
        }
        case 'list': {
          const list = lists.get(uuid);
          return list ? { kind, ...address, state: 'ok', list } : unavailable;
        }
        case 'wiki': {
          const entry = wiki.get(uuid);
          return entry ? { kind, ...address, state: 'ok', wiki: entry } : unavailable;
        }
      }
    });
    return { previews };
  }

  private async sessionCards(
    ownerId: string,
    ids: string[],
  ): Promise<Map<string, LinkPreviewSession<Date>>> {
    if (ids.length === 0) return new Map();
    const [rows, clocks, watching] = await Promise.all([
      this.sessions.listRowsByIds(ownerId, ids),
      // The one card field the list row does not carry.
      this.prisma.session.findMany({
        where: { id: { in: ids }, ownerId },
        select: { id: true, updatedAt: true },
      }),
      this.watching(ownerId, ids),
    ]);
    const updatedAt = new Map(clocks.map((clock) => [clock.id, clock.updatedAt]));
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          title: row.title,
          status: row.status,
          runStatus: row.runStatus,
          runState: row.runState,
          sessionState: row.sessionState,
          lifecycleState: row.lifecycleState,
          endReason: row.endReason,
          error: row.error,
          retryAt: row.retryAt,
          engineTurnActive: row.engineTurnActive,
          pendingApprovals: row.pendingApprovals,
          waitingKind: row.waitingKind,
          runningBgCount: row.runningBgCount,
          runningBgJobCount: row.runningBgJobCount,
          watching: watching.get(row.id) ?? null,
          // The name is never null on a workspace the row joined; the join's type just cannot say so.
          workspace: row.workspace ? { id: row.workspace.id, name: row.workspace.name ?? '' } : null,
          model: row.model,
          numTurns: row.numTurns,
          createdAt: row.createdAt,
          lastTurnAt: row.lastTurnAt,
          updatedAt: updatedAt.get(row.id) ?? row.createdAt,
          projectId: row.projectId,
          projectTitle: row.projectTitle,
        },
      ]),
    );
  }

  /**
   * The live RESUME_SESSION watches parked on each session, counted the way the session list words
   * them (`watchingWord` on the web, `WatchSessionSummary.word` natively).
   */
  private async watching(ownerId: string, sessionIds: string[]): Promise<Map<string, LinkPreviewWatching>> {
    const watches = await this.prisma.watch.findMany({
      where: {
        ownerId,
        observerSessionId: { in: sessionIds },
        action: 'RESUME_SESSION',
        state: { in: ['ACTIVE', 'PAUSED'] },
      },
      select: {
        observerSessionId: true,
        state: true,
        targets: { where: { state: { not: 'GONE' } }, select: { targetKind: true, targetResourceId: true } },
      },
    });
    const bySession = new Map<string, { active: number; paused: number; targets: Set<string> }>();
    for (const watch of watches) {
      if (!watch.observerSessionId) continue;
      const entry = bySession.get(watch.observerSessionId) ?? { active: 0, paused: 0, targets: new Set() };
      bySession.set(watch.observerSessionId, entry);
      if (watch.state === 'ACTIVE') {
        entry.active += 1;
        for (const target of watch.targets) entry.targets.add(`${target.targetKind}:${target.targetResourceId}`);
      } else {
        entry.paused += 1;
      }
    }
    return new Map(
      [...bySession].map(([id, entry]) => [
        id,
        { active: entry.active, paused: entry.paused, targets: entry.targets.size },
      ]),
    );
  }

  private async taskCards(ownerId: string, ids: string[]): Promise<Map<string, LinkPreviewTask<Date>>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.task.findMany({
      where: { id: { in: ids }, ownerId },
      select: {
        id: true,
        title: true,
        status: true,
        updatedAt: true,
        project: { select: { id: true, title: true } },
        assignee: { select: { id: true, name: true } },
      },
    });
    if (rows.length === 0) return new Map();
    const [live, runs] = await Promise.all([
      this.tasks.withRunning(ownerId, rows, true),
      // How many sessions each task has had, and the newest of them, in one pass over its own.
      this.prisma.$queryRaw<
        Array<{
          taskId: string;
          runs: number;
          status: RunStatus;
          endReason: string | null;
          numTurns: number;
          endedAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT DISTINCT ON (s.task_id)
               s.task_id AS "taskId",
               (count(*) OVER (PARTITION BY s.task_id))::int AS "runs",
               s.status, s.end_reason AS "endReason", s.num_turns AS "numTurns",
               s.finished_at AS "endedAt"
          FROM session s
         WHERE s.owner_id = ${ownerId}::uuid
           AND s.task_id = ANY(${rows.map((row) => row.id)}::uuid[])
         ORDER BY s.task_id, s.created_at DESC, s.id DESC`),
    ]);
    const lastRuns = new Map(runs.map((run) => [run.taskId, run]));
    return new Map(
      live.map((task) => {
        const last = lastRuns.get(task.id);
        return [
          task.id,
          {
            title: task.title,
            status: task.status,
            running: task.running,
            queued: task.queued,
            project: task.project,
            assignee: task.assignee,
            runs: last?.runs ?? 0,
            lastRun: last
              ? {
                  status: last.status,
                  runState: deriveSessionRunState(last),
                  numTurns: last.numTurns,
                  endedAt: last.endedAt,
                }
              : null,
            updatedAt: task.updatedAt,
          },
        ];
      }),
    );
  }

  private async projects(ownerId: string, ids: string[]): Promise<Map<string, ProjectRead>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.project.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true, title: true, status: true, coordinatorSessionId: true },
    });
    return new Map(
      await Promise.all(
        rows.map(async (row): Promise<[string, ProjectRead]> => {
          const { buckets, shape } = await readProjectPanorama(this.prisma, ownerId, row.id);
          return [
            row.id,
            {
              title: row.title,
              status: row.status,
              // The lanes partition the project, so this is also their sum.
              total: shape.taskCount,
              buckets,
              coordinatorSessionId: row.coordinatorSessionId,
            },
          ];
        }),
      ),
    );
  }

  /**
   * The wiki entry a card stands for, read from `wiki_entry` itself.
   *
   * From the table and not through a page's service, because a card says exactly what one row
   * already holds: the entry's own columns are its current revision's (0307 keeps the lineage's
   * title, summary, topics and anchors beside `current_revision`). Nothing here is derived, so
   * nothing here can disagree with the page it leads to, and the wiki module stays free of a
   * dependency on the conversation's.
   *
   * A retired or superseded entry is answered as itself rather than as `unavailable`: the entry
   * outlives both, its page still reads, and the card is how a reader learns an agent is no longer
   * being handed this note.
   */
  private async wikiCards(ownerId: string, ids: string[]): Promise<Map<string, LinkPreviewWiki>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.wikiEntry.findMany({
      where: { id: { in: ids }, ownerId },
      select: {
        id: true,
        kind: true,
        title: true,
        summary: true,
        trust: true,
        status: true,
        anchorState: true,
        anchorCheckedRef: true,
        anchors: true,
        space: { select: { id: true, slug: true } },
      },
    });
    return new Map(
      rows.map((row): [string, LinkPreviewWiki] => [
        row.id,
        {
          spaceId: uuidToBase62(row.space.id),
          spaceSlug: row.space.slug,
          kind: row.kind as LinkPreviewWiki['kind'],
          title: row.title,
          summary: row.summary,
          trust: row.trust as LinkPreviewWiki['trust'],
          status: row.status as LinkPreviewWiki['status'],
          anchorState: row.anchorState as LinkPreviewWiki['anchorState'],
          anchorCheckedRef: row.anchorCheckedRef,
          anchor: firstAnchor(row.anchors),
        },
      ]),
    );
  }

  private async lists(ownerId: string, ids: string[]): Promise<Map<string, LinkPreviewList>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.taskList.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true, title: true },
    });
    return new Map(
      await Promise.all(
        rows.map(async (row): Promise<[string, LinkPreviewList]> => [
          row.id,
          { title: row.title, counts: await this.tasks.taskCounts(ownerId, { listId: row.id }) },
        ]),
      ),
    );
  }
}
