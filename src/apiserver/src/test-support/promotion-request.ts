import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * Existing promotion-transition fixtures predate K7 and state no project criteria. Seed the
 * committed coordinator request those scenarios now require, leaving their transition assertions
 * intact. This is a historical fact fixture, not an authority check: where the old fixture has
 * no standing coordinator, its requesting session is a history reference (0509). The K7 cases
 * exercise the real request door, including its current-coordinator check, separately.
 */
export async function seedPromotionRequest(db: PrismaClient, projectId: string): Promise<void> {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { coordinatorSessionId: true } });
  await db.projectPromotionRequest.create({ data: {
    projectId, sessionId: project.coordinatorSessionId ?? randomUUID(),
    reason: 'Exercise this existing promotion transition before all project criteria are satisfied.',
  } });
}
