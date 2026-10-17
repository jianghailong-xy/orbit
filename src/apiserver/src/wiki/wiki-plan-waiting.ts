import { wikiSpaceSettings, type WikiPlanJob, type WikiPlanVersion } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isRunnerOnline } from '../runners/runners.service';
import { wikiPlanJobRowOfSpace, wikiPlanJobStateOf } from './wiki-plan-job';

/**
 * How many things of a space's plan wait on its owner (contract `space.list.planWaiting`): what the
 * drawer, the web sidebar and the Wiki's Activity badge add to the proposals waiting in Review — the sum
 * of the Activity page's amber banners. Counted here, once, exactly as the clients count it beside Plan —
 * web `wikiPlanPending` (lib/wikiPlan.ts), OrbitKit `WikiPlanLogic.pending` — and held to the vectors they
 * are held to: every case of `src/shared/src/wiki-docs.fixture.json` `plan.states` that says `pending`
 * (wiki-plan-waiting.spec.ts).
 *
 * One each for: the draft, revision or build on its way that is held — by the server, or not started
 * while the maintenance workspace's runner is offline; the draft or revision that failed with no version
 * stored since; the draft waiting to be confirmed; and every proposal waiting. What is only going on — a
 * draft or the documents being written, a job queued — waits on nobody, and a build that failed is not
 * counted, as the clients do not count it.
 */

type Db = PrismaService;

/** What the count reads of a space's plan. `GET …/plan`'s answer (`WikiPlanState`) is one. */
export interface WikiPlanWaitingState {
  confirmed: Pick<WikiPlanVersion, 'createdAt'> | null;
  draft: Pick<WikiPlanVersion, 'createdAt'> | null;
  proposals: readonly unknown[];
  job: Pick<WikiPlanJob, 'kind' | 'state' | 'startedAt' | 'requestedAt'> | null;
}

/** `runnerOnline`: the maintenance workspace's runner, as the clients read it; null when unknown. */
export function wikiPlanWaiting(state: WikiPlanWaitingState, runnerOnline: boolean | null): number {
  const job = state.job;
  // `wikiPlanOpenJob(state) ?? wikiPlanBuildJob(state)`: the job on its way, whatever it does.
  const going = job && (job.state === 'queued' || job.state === 'held' || job.state === 'running') ? job : null;
  // `wikiPlanHeld`: held by the server, or not started on a runner that is offline.
  const held = going !== null && (going.state === 'held' || (!going.startedAt && runnerOnline === false));
  // `wikiPlanFailedJob`: a draft or a revision that failed, which no version stored since has answered.
  const newest = state.draft ?? state.confirmed;
  const failed = job !== null && job.state === 'failed' && job.kind !== 'build'
    && !(newest && Date.parse(newest.createdAt) > Date.parse(job.requestedAt));
  return (held ? 1 : 0) + (failed ? 1 : 0) + (state.draft ? 1 : 0) + state.proposals.length;
}

/**
 * The count of each of the owner's spaces, from what the plan's read is made of rather than a plan read
 * each: its versions in force and waiting, its proposals waiting, the job that read shows
 * (`wikiPlanJobRowOfSpace`), and whether the maintenance workspace's runner is online.
 */
export async function wikiPlanWaitingOfSpaces(
  prisma: Db,
  ownerId: string,
  spaces: ReadonlyArray<{ id: string; settings: unknown }>,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const ids = spaces.map((space) => space.id);
  if (ids.length === 0) return new Map();
  const [versions, proposals, jobs, online] = await Promise.all([
    prisma.wikiPlan.findMany({
      where: { ownerId, spaceId: { in: ids }, status: { in: ['draft', 'confirmed'] } },
      select: { spaceId: true, status: true, createdAt: true },
    }),
    prisma.wikiPlanProposal.findMany({ where: { ownerId, spaceId: { in: ids }, status: 'pending' }, select: { spaceId: true } }),
    Promise.all(ids.map((id) => wikiPlanJobRowOfSpace(prisma, ownerId, id))),
    maintenanceRunnersOnline(prisma, ownerId, spaces, now),
  ]);
  const counts = new Map<string, number>();
  ids.forEach((spaceId, i) => {
    const version = (status: string) => {
      const row = versions.find((v) => v.spaceId === spaceId && v.status === status);
      return row ? { createdAt: row.createdAt.toISOString() } : null;
    };
    const row = jobs[i];
    counts.set(spaceId, wikiPlanWaiting({
      confirmed: version('confirmed'),
      draft: version('draft'),
      proposals: proposals.filter((proposal) => proposal.spaceId === spaceId),
      job: row
        ? {
          kind: row.kind as WikiPlanJob['kind'],
          state: wikiPlanJobStateOf(row),
          startedAt: row.startedAt?.toISOString() ?? null,
          requestedAt: row.createdAt.toISOString(),
        }
        : null,
    }, online.get(spaceId) ?? null));
  });
  return counts;
}

/**
 * Whether each space's maintenance runner is online, as the clients read it (web
 * `useWikiMaintenanceWhere`, OrbitKit `wikiMaintenanceRunnerOnline`): the workspace the space's
 * maintenance names, found among the owner's workspaces, and that workspace's runner among the owner's
 * runners — online by the runners list's own rule (`isRunnerOnline`). Absent — unknown — when the space
 * names no workspace, or the workspace is gone or has no runner.
 */
async function maintenanceRunnersOnline(
  prisma: Db,
  ownerId: string,
  spaces: ReadonlyArray<{ id: string; settings: unknown }>,
  now: Date,
): Promise<Map<string, boolean>> {
  const named = new Map<string, string>();
  for (const space of spaces) {
    const workspaceId = wikiSpaceSettings(space.settings).maintenance.workspaceId;
    if (workspaceId) named.set(space.id, workspaceId);
  }
  if (named.size === 0) return new Map();
  const workspaces = await prisma.workspace.findMany({
    where: { ownerId, id: { in: [...new Set(named.values())] }, deletedAt: null },
    select: { id: true, runnerId: true },
  });
  const runnerOf = new Map(workspaces.map((workspace) => [workspace.id, workspace.runnerId]));
  const runnerIds = [...new Set(workspaces.map((workspace) => workspace.runnerId).filter((id): id is string => id !== null))];
  const runners = runnerIds.length === 0
    ? []
    : await prisma.runner.findMany({ where: { ownerId, id: { in: runnerIds } }, select: { id: true, status: true, lastHeartbeatAt: true } });
  const runnerById = new Map(runners.map((runner) => [runner.id, runner]));
  const online = new Map<string, boolean>();
  for (const [spaceId, workspaceId] of named) {
    const runnerId = runnerOf.get(workspaceId);
    const runner = runnerId ? runnerById.get(runnerId) : undefined;
    if (runner) online.set(spaceId, isRunnerOnline(runner, now.getTime()));
  }
  return online;
}
