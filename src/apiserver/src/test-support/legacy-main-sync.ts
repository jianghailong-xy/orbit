import { PrismaClient } from '@prisma/client';

/**
 * Turn the line-sync item a MAIN_SYNC conflict just opened into the task-level item the code before
 * docs/design/project-line-upstream-sync.md opened for it (§4.6 item 7: "items opened before T5b deploys"), for the
 * specs that pin how such a LEGACY item behaves: its old M2 predicate with the same-task exemption, its MAIN_SYNC
 * cell and doors, the reopen recipe and the moved-branch rerun.
 *
 * The conflict itself is reported through the result route, so every other fact of it (the job's terminal row, its
 * events, the landing session, the delivery) is the product's own. Then, as that older code left it: the item names
 * the task, is keyed by the job (`IC:<jobId>`) and carries the failure payload without the line-sync fields, and
 * there is no held generation: that code queued none, so the row is removed (with its facts) and the task's next
 * landing is generation 2 again, as the legacy specs count it.
 */
export async function asLegacyMainSyncItem(
  db: PrismaClient,
  input: { projectId: string; taskId: string },
): Promise<string> {
  return db.$transaction(async (tx) => {
    const item = await tx.projectOpenItem.findFirstOrThrow({
      where: { projectId: input.projectId, dedupeKey: { startsWith: 'IMS:' }, state: 'OPEN' },
    });
    const task = await tx.task.findUniqueOrThrow({ where: { id: input.taskId }, select: { title: true } });
    const {
      subject: _subject, upstreamRef: _upstreamRef, upstreamSha: _upstreamSha, heldTaskIds: _held, attempts: _attempts,
      ...payload
    } = item.payload as Record<string, unknown>;
    await tx.projectOpenItem.update({
      where: { id: item.id },
      data: {
        taskId: input.taskId,
        dedupeKey: `IC:${item.integrationJobId}`,
        title: `Merge conflict: ${task.title}`,
        payload: payload as never,
      },
    });
    await tx.projectIntegrationJob.deleteMany({ where: { taskId: input.taskId, kind: 'LAND_TASK', state: 'QUEUED' } });
    return item.id;
  });
}
