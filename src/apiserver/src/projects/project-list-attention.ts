import { Prisma, type ProjectStatus } from '@prisma/client';
import {
  COORDINATOR_LEAD_KINDS,
  type CoordinatorLeadKind,
  type ProjectListAttention as WireProjectListAttention,
  type ProjectListCoordinatorItems as WireProjectListCoordinatorItems,
  type ProjectListOwnerItem as WireProjectListOwnerItem,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { escalatesAt } from './open-item-escalation.service';
import { openItemOwed, ownerItemKind } from './project-open-item';
import { DONE_REQUEST_KIND } from './project-done-request';
import { START_REQUEST_KIND } from './project-start-request';

export type ProjectAttentionSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * The durable facts the projects index needs to answer who must act next.
 *
 * Owner and recovery deliberately stay separate. USER means a person owns the next action;
 * TIME/EVENT/HUMAN says how the condition can clear. Treating recovery or blocker kind as the
 * actor would turn expected system waits into human alerts.
 *
 * The two item fields are the same answer one step closer to the reader (§7.1 V1): a count of
 * blockers says a project is stuck, and the item behind the count says what the person is being
 * asked to do and how long they have been asked. `@orbit/shared` declares the wire shape once for
 * this server and every client; the three item fields are required HERE, where they are always
 * computed, and optional there, where a client may be reading a server that predates them.
 */
export interface ProjectListAttention extends WireProjectListAttention<Date> {
  ownerItems: Array<WireProjectListOwnerItem<Date>>;
  coordinatorItems: WireProjectListCoordinatorItems<Date> | null;
  startRequest: { waitingSince: Date } | null;
  doneRequest: { waitingSince: Date } | null;
}

export function emptyProjectListAttention(): ProjectListAttention {
  return {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
    ownerItems: [],
    coordinatorItems: null,
    startRequest: null,
    doneRequest: null,
  };
}

interface AttentionRow extends ProjectListAttention {
  projectId: string;
}

/**
 * One kind's open items on one project, as the aggregate returns them — grouped, never listed: the
 * list row names one action, and the items themselves are the project page's card (§4.8).
 */
interface OpenItemRow {
  projectId: string;
  kind: string;
  assignee: string;
  assigneeReason: string;
  count: number;
  oldestWaitingSince: Date;
  nextEscalationAt: Date | null;
}

/**
 * This kind is one a coordinator can hold, or null (§7.1 V1/V2).
 *
 * A cast with a reason rather than a guess: migration 0278's `project_open_item_owner_only_chk`
 * refuses `PROMOTION_APPROVAL`/`COORDINATOR_QUESTION`/`FUSE_PAUSED` on anything but the owner, so a
 * row whose assignee is the coordinator is one of the four the shared constant names — and a client
 * reading a kind outside it would have no chip to print it with.
 */
function coordinatorLeadKind(kind: string): CoordinatorLeadKind | null {
  return (COORDINATOR_LEAD_KINDS as readonly string[]).includes(kind)
    ? (kind as CoordinatorLeadKind)
    : null;
}

/**
 * Every open blocker and every open exception item on the requested projects, grouped into one
 * bounded result row per project per kind.
 *
 * Two statements rather than one join: blockers and items are different populations on different
 * tables, and a join would multiply the two counts against each other whenever a project had both.
 * Both are bounded by the page and both are grouped by the key the caller reads them through.
 */
export async function readProjectListAttention(
  prisma: PrismaService,
  ownerId: string,
  status?: ProjectStatus,
): Promise<Map<string, ProjectListAttention>> {
  const narrowed = status
    ? Prisma.sql`AND proj."status" = ${status}::project_status`
    : Prisma.empty;

  const narrowedItems = status
    ? Prisma.sql`AND proj."status" = ${status}::project_status`
    : Prisma.empty;

  const [rows, items] = await Promise.all([
    readBlockers(prisma, ownerId, narrowed),
    readOpenItems(prisma, ownerId, narrowedItems),
  ]);

  const attention = new Map<string, ProjectListAttention>();
  for (const { projectId, ...blockers } of rows) {
    attention.set(projectId, {
      ...blockers,
      ownerItems: [],
      coordinatorItems: null,
      startRequest: null,
      doneRequest: null,
    });
  }
  // A project with items and no open blockers is the common case, not an edge one: the blockers
  // are the older signal, and a merge approval or a question is filed without either.
  const forProject = (projectId: string): ProjectListAttention => {
    const existing = attention.get(projectId);
    if (existing) return existing;
    const fresh = emptyProjectListAttention();
    attention.set(projectId, fresh);
    return fresh;
  };

  for (const row of items) {
    const project = forProject(row.projectId);
    // The coordinator asking to start a project nobody has started ("Ready to start"): the owner's
    // from birth and none of the four, so it has a field of its own. The read below has already
    // left out a request on a started project, as the needs-you count does (`projectsReadyToStart`).
    if (row.kind === START_REQUEST_KIND) {
      if (!project.startRequest || row.oldestWaitingSince < project.startRequest.waitingSince) {
        project.startRequest = { waitingSince: row.oldestWaitingSince };
      }
      continue;
    }
    // Its counterpart at the other end ("Ready to close"): the coordinator asking to record an OPEN
    // project done. The read below leaves out a request on a project that is no longer OPEN, as the
    // needs-you count does (`projectsReadyToClose`).
    if (row.kind === DONE_REQUEST_KIND) {
      if (!project.doneRequest || row.oldestWaitingSince < project.doneRequest.waitingSince) {
        project.doneRequest = { waitingSince: row.oldestWaitingSince };
      }
      continue;
    }
    // The owner's four, by the same function the push and the Needs-you count use: a second
    // derivation of "is this the owner's" would be a third answer to one question (§4.1).
    const ownerKind = ownerItemKind(row);
    if (ownerKind) {
      const merged = project.ownerItems.find((item) => item.kind === ownerKind);
      if (!merged) {
        project.ownerItems.push({
          kind: ownerKind,
          count: row.count,
          oldestWaitingSince: row.oldestWaitingSince,
        });
      } else {
        merged.count += row.count;
        if (row.oldestWaitingSince < merged.oldestWaitingSince) {
          merged.oldestWaitingSince = row.oldestWaitingSince;
        }
      }
      continue;
    }
    // An item the owner holds that is not one of the four (an assignment with no story behind it)
    // is not a coordinator item either: it is nothing this read has a name for.
    if (row.assignee !== 'COORDINATOR') continue;
    const leadKind = coordinatorLeadKind(row.kind);
    if (!leadKind) continue;
    const held = project.coordinatorItems;
    if (!held) {
      project.coordinatorItems = {
        count: row.count,
        leadKind,
        oldestWaitingSince: row.oldestWaitingSince,
        // In-flight fixes and handling deliberately have no deadline; a null here means the
        // coordinator's whole queue is currently making progress.
        nextEscalationAt: row.nextEscalationAt,
      };
      continue;
    }
    held.count += row.count;
    // The chip names the kind that has waited longest, which is the one this aggregate calls the
    // lead — so the two halves of the answer move together.
    if (row.oldestWaitingSince < held.oldestWaitingSince) {
      held.oldestWaitingSince = row.oldestWaitingSince;
      held.leadKind = leadKind;
    }
    if (row.nextEscalationAt != null
      && (held.nextEscalationAt == null || row.nextEscalationAt < held.nextEscalationAt)) {
      held.nextEscalationAt = row.nextEscalationAt;
    }
  }
  return attention;
}

async function readBlockers(
  prisma: PrismaService,
  ownerId: string,
  narrowed: Prisma.Sql,
): Promise<AttentionRow[]> {
  return prisma.$queryRaw<AttentionRow[]>(Prisma.sql`
    SELECT blocker.project_id AS "projectId",
           (count(*) FILTER (WHERE blocker.owner = 'USER'))::int AS "userBlockers",
           (count(*) FILTER (WHERE blocker.owner = 'COORDINATOR'))::int AS "coordinatorBlockers",
           (count(*) FILTER (WHERE blocker.owner = 'SYSTEM'))::int AS "systemBlockers",
           (max(blocker.severity) FILTER (WHERE blocker.owner = 'USER'))::text AS "maxSeverity",
           min(coalesce(blocker.escalated_at, blocker.first_seen_at))
             FILTER (WHERE blocker.owner = 'USER') AS "attentionSinceAt",
           min(blocker.next_check_at)
             FILTER (WHERE blocker.escalated_at IS NULL) AS "nextCheckAt"
      FROM project_blocker blocker
      JOIN project proj ON proj.id = blocker.project_id
                       AND proj.owner_id = ${ownerId}::uuid
     WHERE blocker.resolved_at IS NULL ${narrowed}
     GROUP BY blocker.project_id`);
}

/**
 * Every open exception item on the requested projects, one row per project per kind, assignee and
 * assignee reason (§7.1 V1).
 *
 * Grouped in the database rather than read out and folded here: a project's items are read to be
 * counted, and the count is the database's own answer. `waiting_since` is the moment the wait
 * began — reset when the owner sends an item back to the coordinator (§4.7) — which is what the
 * row's chip prints.
 *
 * `next_escalation_at` is the soonest deadline among the coordinator's items: the first one that
 * will stop being theirs, as the clock decides it (`escalatesAt`). An in-flight fix/handling row has
 * no deadline, so SQL `min()` skips it; when every held row is in flight the aggregate is NULL.
 *
 * A start request counts only while its project has not been started: the start answers it in the
 * same transaction, and a request somehow left open beside a start asks nobody anything. Any item
 * counts only while it is owed (`openItemOwed`), for the same reason: one about a candidate or a
 * task that has moved on asks nobody anything either, whether or not anything has closed it yet.
 */
async function readOpenItems(
  prisma: PrismaService,
  ownerId: string,
  narrowed: Prisma.Sql,
): Promise<OpenItemRow[]> {
  return prisma.$queryRaw<OpenItemRow[]>(Prisma.sql`
    SELECT item.project_id AS "projectId",
           item.kind::text AS "kind",
           item.assignee::text AS "assignee",
           item.assignee_reason::text AS "assigneeReason",
           (count(*))::int AS "count",
           min(item.waiting_since) AS "oldestWaitingSince",
           min(${escalatesAt('item')}) AS "nextEscalationAt"
      FROM project_open_item item
      JOIN project proj ON proj.id = item.project_id
                       AND proj.owner_id = ${ownerId}::uuid
     WHERE item.state = 'OPEN' ${narrowed}
       AND (item.kind <> 'START_REQUEST' OR proj.started_at IS NULL)
       AND ${openItemOwed('item')}
       AND (item.kind <> 'DONE_REQUEST' OR proj."status" = 'OPEN')
     GROUP BY item.project_id, item.kind, item.assignee, item.assignee_reason`);
}
