import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  type ClaimPermissionModeSubstitutionReason,
  PERMISSION_MODE_CORRECTED_EVENT_SUBTYPE,
  PermissionMode,
  type PermissionModeChangeCause,
  RunEventType,
  type SessionPermissionModeChange,
  SESSION_PERMISSION_MODE_CHANGES_LIMIT,
} from '@orbit/shared';

/**
 * The mode a session's engine is actually running in (session.actual_permission_mode, migration 1805), kept apart
 * from `session.permission_mode`, the owner's intent, which only an explicit pick writes.
 *
 * Where it is read from:
 *  - a claim or reclaim records the mode it hands the runner (CLAIM). For Codex, Kimi, OpenCode and Antigravity,
 *    which report no mode, that is the whole answer. Not one that hands its turn to a Claude engine still running
 *    (claimRecordsMode): that engine is not spawned again in the claim's mode, so what it reported stands;
 *  - Claude Code's init frame, carried in the runner's Agent Tools report (`agentTools.permissionMode`), records what
 *    the engine itself says (ENGINE_REPORT, or RESPAWN when a reload re-spawned it since the last record);
 *  - a `setconfig` turn's acknowledgement, and a `reload` handed to the runner, record the mode they carried
 *    (OWNER_PICK, or ORBIT_CHANGE when Orbit made the change, which the turn's key says: configTurnKey);
 *  - a runner's `permission_mode_corrected` event records a correction it made by itself (RUNNER_CORRECTION).
 *
 * Every change is one row of session_permission_mode_change naming its cause; recording the mode already recorded
 * writes nothing. A claim that hands another mode than the session asked for says so on its row: the mode asked for
 * and why (migration 1807, queue/claim-permission-mode.ts).
 */

const KNOWN_MODES = new Set<string>(Object.values(PermissionMode));

/** Whether a value from a runner or a turn's payload is a mode this server knows. */
export function isKnownPermissionMode(mode: unknown): mode is PermissionMode {
  return typeof mode === 'string' && KNOWN_MODES.has(mode);
}

/**
 * Whether a claim or reclaim records the mode it hands the runner as the session's actual mode (CLAIM). Not when it
 * hands its turn to a Claude engine the runner names as still running (its claim's `residentEngines`, runner-go
 * sessionPool.residentEngineSessionIDs): that engine is not spawned again in the claim's mode, and the mode it last
 * reported is what runs until it reports again, or a re-spawn or a setconfig acknowledgement says otherwise. A claim
 * that spawns an engine is recorded, as is every claim of an engine that reports no mode of its own, for which the
 * mode handed is the whole answer. Should the engine be recycled after the runner named it, the one spawned in its
 * place reports the mode it settles on (its init frame), which is recorded then.
 */
export function claimRecordsMode(provider: string, engineResident: boolean): boolean {
  return !(engineResident && provider === CLAUDE_REPORT_ENGINE);
}

/** A claim's mode that is not the one the session asked for: the mode asked for, and why (claimPermissionMode). */
export interface ClaimedModeSubstitution {
  requestedMode: PermissionMode;
  reason: ClaimPermissionModeSubstitutionReason;
}

/**
 * Record that the session's engine now runs in `mode`, and why. One statement: it locks the session row, moves the
 * two columns only when the mode differs from the one recorded, and inserts the change row only then. Returns
 * whether anything changed. A mode this server does not know is ignored. clock_timestamp(), not now(): two changes
 * recorded in one transaction must not share a time, or the detail could not order them. `substitution` is a CLAIM's
 * only, and rides on its row.
 */
export async function recordActualPermissionMode(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  sessionId: string,
  mode: unknown,
  cause: PermissionModeChangeCause,
  client?: string | null,
  substitution?: ClaimedModeSubstitution | null,
): Promise<boolean> {
  if (!isKnownPermissionMode(mode)) return false;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH "prev" AS (
      SELECT "id", "actual_permission_mode" AS "from_mode" FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE
    ), "moved" AS (
      UPDATE "session" AS s
      SET "actual_permission_mode" = ${mode}, "actual_permission_mode_at" = clock_timestamp()
      FROM "prev"
      WHERE s."id" = "prev"."id" AND "prev"."from_mode" IS DISTINCT FROM ${mode}
      RETURNING "prev"."from_mode"
    )
    INSERT INTO "session_permission_mode_change"
      ("id", "session_id", "from_mode", "to_mode", "cause", "client", "requested_mode", "reason", "created_at")
    SELECT ${randomUUID()}::uuid, ${sessionId}::uuid, "moved"."from_mode", ${mode}, ${cause}, ${client ?? null},
      ${substitution?.requestedMode ?? null}, ${substitution?.reason ?? null}, clock_timestamp()
    FROM "moved"
    RETURNING "id"
  `;
  return rows.length > 0;
}

/**
 * What a batch of runner events says about the mode the engine runs in, recorded in seq order:
 *  - Claude Code's init frame, which the runner forwards as the Agent Tools report's `permissionMode` (runner-go
 *    agent_tools_report.go) and sends again whenever it changes. ENGINE_REPORT, or RESPAWN when the batch said
 *    before it that the runner restarted the engine (`resumed`). Only Claude's: the other engines' reports restate
 *    the mode they were handed, which the claim recorded already;
 *  - a runner's own correction (`permission_mode_corrected`, carrying `mode`): RUNNER_CORRECTION.
 */
export async function recordEngineReportedModes(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  sessionId: string,
  events: ReadonlyArray<{ type: string; seq: number; payload?: unknown }>,
): Promise<void> {
  let respawned = false;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== RunEventType.SYSTEM) continue;
    const payload = (e.payload ?? {}) as { subtype?: unknown; agentTools?: unknown; mode?: unknown };
    if (payload.subtype === 'resumed') {
      respawned = true;
    } else if (payload.subtype === 'agent_tools') {
      const report = payload.agentTools as { engine?: unknown; permissionMode?: unknown } | null | undefined;
      if (report?.engine !== CLAUDE_REPORT_ENGINE) continue;
      await recordActualPermissionMode(db, sessionId, report.permissionMode, respawned ? 'RESPAWN' : 'ENGINE_REPORT');
    } else if (payload.subtype === PERMISSION_MODE_CORRECTED_EVENT_SUBTYPE) {
      await recordActualPermissionMode(db, sessionId, payload.mode, 'RUNNER_CORRECTION');
    }
  }
}

/** The engine name a Claude Code Agent Tools report carries (runner-go providerClaude). */
const CLAUDE_REPORT_ENGINE = 'claude';

/** Who asked for a config change (SessionsService.updateConfig): the owner, or Orbit itself. */
export type ConfigChangeOrigin = 'OWNER' | 'ORBIT';

/**
 * The key a setconfig/reload turn of updateConfig is filed under. Orbit's own changes carry ORBIT_CONFIG_TURN_PREFIX,
 * so the mode change they cause is not put down to the owner; the payload the runner reads stays as it was. Only the
 * server writes control turns: no door takes a client's key for one.
 */
export function configTurnKey(origin: ConfigChangeOrigin): string {
  return origin === 'ORBIT' ? `${ORBIT_CONFIG_TURN_PREFIX}${randomUUID()}` : randomUUID();
}
const ORBIT_CONFIG_TURN_PREFIX = 'orbit-config:';

/** The cause a delivered or acknowledged config turn is recorded with, read off its key. */
export function causeOfConfigTurn(clientTurnId: string | null | undefined): PermissionModeChangeCause {
  return clientTurnId?.startsWith(ORBIT_CONFIG_TURN_PREFIX) ? 'ORBIT_CHANGE' : 'OWNER_PICK';
}

/** A control turn's payload, or {} when it is not a JSON object. */
export function configTurnPayload(content: string | null | undefined): { permissionMode?: unknown } {
  try {
    const parsed: unknown = JSON.parse(content ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The session detail's mode changes as its `include` reads them: the newest SESSION_PERMISSION_MODE_CHANGES_LIMIT. */
export const PERMISSION_MODE_CHANGES_INCLUDE = {
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: SESSION_PERMISSION_MODE_CHANGES_LIMIT,
  select: { fromMode: true, toMode: true, cause: true, client: true, requestedMode: true, reason: true, createdAt: true },
} satisfies Prisma.Session$permissionModeChangesArgs;

/** Those rows as the detail answers them, oldest first. None read (an older row shape) is none. A claim's substitution
 *  is carried only on the row that made one, so every other row keeps the shape it had. */
export function permissionModeChangesOf(
  rows: ReadonlyArray<{
    fromMode: string | null;
    toMode: string;
    cause: string;
    client: string | null;
    requestedMode?: string | null;
    reason?: string | null;
    createdAt: Date;
  }> | undefined,
): SessionPermissionModeChange[] {
  return [...(rows ?? [])].reverse().map((row) => ({
    fromMode: row.fromMode,
    toMode: row.toMode,
    cause: row.cause as PermissionModeChangeCause,
    client: row.client,
    at: row.createdAt.toISOString(),
    ...(row.requestedMode && row.reason
      ? { requestedMode: row.requestedMode, reason: row.reason as ClaimPermissionModeSubstitutionReason }
      : {}),
  }));
}
