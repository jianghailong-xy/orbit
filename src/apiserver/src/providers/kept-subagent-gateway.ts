import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Whether an ended session's gateway token still serves a SubAgent its coordinator left running when it handed over
 * (docs/coordinator-handoff-v2-design.md §1, runner-go session_keep_work.go).
 *
 * A SubAgent's child engine reaches its model through the gateways on a token bound to the parent session: its own
 * (mintSubagentPoolLoginToken) or the parent's, which it inherits. Each gateway serves a token only while that session
 * is open, so once a handover completed the parent, the kept child's next model call was refused with 401
 * `orbit_gateway_token_invalid` and its turn failed (production, 2026-11-17: a Codex SubAgent FAILED about 13 s after
 * its coordinator handed over, mid-sleep, at its next poll).
 *
 * A session that ended because its handoff completed (or is completing) keeps serving its tokens while one of its
 * SubAgent runs is still RUNNING; the run's end, which the runner reports, ends that. Every other end refuses them as
 * before. Asked only of a session that is no longer open, so an open session's request costs no extra read.
 */
export async function servesKeptSubagent(
  prisma: Pick<PrismaClient | Prisma.TransactionClient, 'coordinatorHandoff' | 'subagentRun'>,
  sessionId: string,
): Promise<boolean> {
  const handoff = await prisma.coordinatorHandoff.findFirst({
    where: { fromSessionId: sessionId, state: { in: ['COMPLETED', 'HANDING_OVER'] } },
    select: { id: true },
  });
  if (!handoff) return false;
  const running = await prisma.subagentRun.findFirst({
    where: { sessionId, status: 'RUNNING' },
    select: { id: true },
  });
  return running !== null;
}
