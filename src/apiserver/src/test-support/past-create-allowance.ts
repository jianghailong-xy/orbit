import { CreatorType, TaskCompletionCriterion, type PrismaClient } from '@prisma/client';

import { SESSION_CREATE_ALLOWANCE } from '../runner-api/session-create-allowance';

/**
 * Puts a session past its card-free creates (`session-create-allowance.ts`): it has already created
 * SESSION_CREATE_ALLOWANCE tasks, so its next create card is asked of a person. For specs whose
 * subject is the card a person answers, not the allowance.
 */
export async function pastCreateAllowance(
  db: Pick<PrismaClient, 'task'>,
  ownerId: string,
  sessionId: string,
): Promise<void> {
  await db.task.createMany({
    data: Array.from({ length: SESSION_CREATE_ALLOWANCE }, (_, i) => ({
      ownerId,
      title: `already created ${i + 1}`,
      creatorType: CreatorType.AGENT,
      creatorId: ownerId,
      creatorSessionId: sessionId,
      completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
    })),
  });
}
