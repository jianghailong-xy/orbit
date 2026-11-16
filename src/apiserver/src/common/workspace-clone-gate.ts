import { Prisma } from '@prisma/client';

/**
 * The dispatch gate of a GitHub workspace (docs/github-workspace-design.md §6): while its clone is not READY, its
 * sessions stay queued. PENDING and CLONING read WORKSPACE_CLONING, FAILED reads WORKSPACE_CLONE_FAILED; a workspace
 * that does not come from GitHub has no clone state and is never held.
 *
 * Three callers agree on it exactly, which is why it is written once: the session claim, which hands a held session
 * no slot; the session list, which names the gate to the person waiting (queuedReason); and the auto-run sweep, which
 * starts no run of a task assigned to such a workspace, beside its disk and quota gates. The reasons are spelt as the
 * design names them.
 */
export const WORKSPACE_CLONING = 'WORKSPACE_CLONING';
export const WORKSPACE_CLONE_FAILED = 'WORKSPACE_CLONE_FAILED';

/** True while the workspace `workspaceIdSql` names is a clone that is not READY. */
export function workspaceCloneHoldSql(workspaceIdSql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "workspace" clone_gate
     WHERE clone_gate."id" = ${workspaceIdSql}
       AND clone_gate."clone_state" IS NOT NULL
       AND clone_gate."clone_state" <> 'READY'
  )`;
}

/** The reason the gate names for the workspace `workspaceIdSql` names, or NULL when it holds nothing. */
export function workspaceCloneReasonSql(workspaceIdSql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    SELECT CASE clone_gate."clone_state"
             WHEN 'FAILED' THEN ${WORKSPACE_CLONE_FAILED}::text
             ELSE ${WORKSPACE_CLONING}::text
           END
      FROM "workspace" clone_gate
     WHERE clone_gate."id" = ${workspaceIdSql}
       AND clone_gate."clone_state" IS NOT NULL
       AND clone_gate."clone_state" <> 'READY'
  )`;
}

/** The same gate on a clone state already read: the reason, or null. */
export function workspaceCloneReason(cloneState: string | null | undefined): typeof WORKSPACE_CLONING | typeof WORKSPACE_CLONE_FAILED | null {
  if (cloneState == null || cloneState === 'READY') return null;
  return cloneState === 'FAILED' ? WORKSPACE_CLONE_FAILED : WORKSPACE_CLONING;
}
