import { Prisma } from '@prisma/client';

/**
 * When each of `workspaceIds` was last used: the later of the start and the last turn of its newest
 * conversation (absent = never ran one). What Settings' Workspaces nav orders its recent rows by.
 *
 * Read the way `lastProviderByWorkspace` reads the workspace list: one `LIMIT 1` per id walking
 * session_workspace_id_created_at_idx, so the list never scans a workspace's whole history. The
 * price is that a conversation older than the newest one, continued since, does not move the date.
 */
export async function lastActiveByWorkspace(
  prisma: Prisma.TransactionClient,
  workspaceIds: string[],
): Promise<Map<string, Date>> {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ workspace_id: string; last_active_at: Date | null }>>(Prisma.sql`
    WITH a(id) AS (SELECT unnest(ARRAY[${Prisma.join(ids)}]::uuid[]))
    SELECT a.id::text AS workspace_id, GREATEST(s.created_at, s.last_turn_at) AS last_active_at
    FROM a
    CROSS JOIN LATERAL (
      SELECT created_at, last_turn_at
      FROM "session"
      WHERE workspace_id = a.id AND kind = 'CONVERSATION'
      ORDER BY created_at DESC
      LIMIT 1
    ) s
  `);
  const out = new Map<string, Date>();
  for (const row of rows ?? []) if (row.last_active_at) out.set(row.workspace_id, new Date(row.last_active_at));
  return out;
}

/** How many conversations one workspace holds, not counting the trashed ones or the sessions spawned
 *  from another: the "N sessions" in its Settings page's header. Read for one workspace only. */
export async function workspaceSessionCount(prisma: Prisma.TransactionClient, workspaceId: string): Promise<number> {
  return prisma.session.count({
    where: { workspaceId, sessionKind: 'CONVERSATION', parentSessionId: null, deletedAt: null },
  });
}
