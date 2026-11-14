import { Prisma } from '@prisma/client';
import type { EngineProviderSeedAnchor } from '../providers/engine-provider';
import { legacySessionEngine, recordedEngine } from '../providers/session-engine';
import { agentProviderSeed, type AgentProviderSeed } from './workspace-provider';

/**
 * The anchor an unattended start follows when neither the request nor a task pin names an engine or
 * provider (docs/workspace-default-model-design.md §2.1): a session a person chose, rather than the
 * workspace's newest person-opened conversation, which a one-off question can move.
 *
 *  • an unpinned run of a project's task: the project's current coordinator session;
 *  • a coordinator re-created, replaced or judging: the project's previous coordinator session;
 *  • an MCP child naming no engine: its parent session.
 *
 * Null when there is no anchor — a task outside a project, a project with no coordinator session
 * (none ever opened, or the one it names is gone or trashed) — and the caller falls back to the workspace seed
 * (workspace-provider.ts). An anchor carries the session it came from, so a refusal names it (§2.3,
 * engine-provider.ts `fromAnchor`).
 */
export type AnchorSeed = AgentProviderSeed & { anchor: EngineProviderSeedAnchor };

export const ANCHOR_ROLE = {
  coordinator: "the project's coordinator session",
  previousCoordinator: "the project's previous coordinator session",
  parent: 'the parent session',
} as const;

const ANCHOR_SESSION_SELECT = {
  id: true,
  title: true,
  engine: true,
  provider: true,
  providerBuiltin: true,
  model: true,
  ownerId: true,
} as const;

type AnchorSessionRow = Prisma.SessionGetPayload<{ select: typeof ANCHOR_SESSION_SELECT }>;

async function anchorOf(db: Prisma.TransactionClient, row: AnchorSessionRow, role: string): Promise<AnchorSeed> {
  // The engine it ran on: recorded, else derived by the rules a seed is (workspace-provider.ts).
  const engine = recordedEngine(row.engine) ?? await legacySessionEngine(db, row);
  return {
    engine,
    provider: row.provider,
    providerBuiltin: row.providerBuiltin,
    model: row.model ?? null,
    anchor: { role, sessionId: row.id, title: row.title },
  };
}

/** A session's own pair as an anchor, or null when there is no such session of this owner. */
export async function sessionAnchor(
  db: Prisma.TransactionClient,
  ownerId: string,
  sessionId: string,
  role: string,
): Promise<AnchorSeed | null> {
  const row = await db.session.findFirst({ where: { id: sessionId, ownerId }, select: ANCHOR_SESSION_SELECT });
  return row ? anchorOf(db, row, role) : null;
}

/**
 * The anchor of each task's unpinned run: its project's current coordinator session, whenever the project
 * has one that is not trashed. `coordinator_enabled` is not read: it is the project's Automatic switch
 * (may the platform hand exceptions to the coordinator, land on main by itself), not whether a
 * coordinator exists. Tasks with none are absent from the map.
 */
export async function taskRunAnchors(
  db: Prisma.TransactionClient,
  taskIds: readonly string[],
): Promise<Map<string, AnchorSeed>> {
  const anchors = new Map<string, AnchorSeed>();
  const ids = [...new Set(taskIds)];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await db.task.findMany({
      where: {
        id: { in: ids.slice(offset, offset + 500) },
        project: { coordinatorSession: { deletedAt: null } },
      },
      select: { id: true, project: { select: { coordinatorSession: { select: ANCHOR_SESSION_SELECT } } } },
    });
    for (const row of rows) {
      const session = row.project?.coordinatorSession;
      if (session) anchors.set(row.id, await anchorOf(db, session, ANCHOR_ROLE.coordinator));
    }
  }
  return anchors;
}

/** One task's unpinned-run anchor, or null. */
export async function taskRunAnchor(db: Prisma.TransactionClient, taskId: string): Promise<AnchorSeed | null> {
  return (await taskRunAnchors(db, [taskId])).get(taskId) ?? null;
}

/** What a task's unpinned run starts on: its anchor, else its workspace's seed. */
export async function taskRunSeed(
  db: Prisma.TransactionClient,
  taskId: string | null | undefined,
  workspaceId: string,
): Promise<AgentProviderSeed> {
  return (taskId ? await taskRunAnchor(db, taskId) : null) ?? agentProviderSeed(db, workspaceId);
}

/**
 * The anchor of a coordinator about to be opened — re-created, replaced, or a judgment: the session
 * the project names as its coordinator now, which is the previous one by the time a new one opens.
 * Read whether or not it was trashed: what was chosen for it is still what the project runs on.
 */
export async function previousCoordinatorAnchor(
  db: Prisma.TransactionClient,
  projectId: string,
  role: string = ANCHOR_ROLE.previousCoordinator,
): Promise<AnchorSeed | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { coordinatorSession: { select: ANCHOR_SESSION_SELECT } },
  });
  const session = project?.coordinatorSession;
  return session ? anchorOf(db, session, role) : null;
}

/**
 * The `seed` a door hands resolveEngineProvider: its anchor, else the workspace's seed, else nothing
 * (the floor). Undefined when there is neither, as before anchors.
 */
export function anchoredSeed(
  db: Prisma.TransactionClient,
  anchor: (() => Promise<AnchorSeed | null>) | undefined,
  workspaceId: string | null | undefined,
): (() => Promise<AgentProviderSeed | null>) | undefined {
  if (!anchor && !workspaceId) return undefined;
  return async () => (anchor ? await anchor() : null) ?? (workspaceId ? agentProviderSeed(db, workspaceId) : null);
}
