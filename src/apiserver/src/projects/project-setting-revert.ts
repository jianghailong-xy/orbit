import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { restoreLandingCheck } from './project-integration-line';
import {
  CHANGE_SELECT,
  settingChangeView,
  type LandingCheckExemptValue,
  type LandingCheckValue,
  type ProjectSettingChangeView,
} from './project-setting-change';

/** The record an owner reverts, read before the transaction: null when this project has no such record. */
export async function readSettingChange(
  prisma: Pick<PrismaService, 'projectSettingChange'>,
  ownerId: string,
  projectId: string,
  changeId: string,
) {
  const row = await prisma.projectSettingChange.findFirst({
    where: { id: changeId, ownerId, projectId },
    select: CHANGE_SELECT,
  });
  if (!row) throw new NotFoundException('setting change not found');
  return row;
}

/**
 * The owner putting one record's old value back, as their own value, inside the caller's transaction: the
 * landing check then reads `setBy OWNER`, and a task's exemption carries the owner's stamp, so the
 * coordinator's next cardless write of either is refused (§12.15 P-R1). The record stays; reverting twice
 * writes the same value twice.
 */
export async function putSettingChangeBack(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  row: Awaited<ReturnType<typeof readSettingChange>>,
): Promise<ProjectSettingChangeView> {
  if (row.field === 'LANDING_CHECK') {
    await restoreLandingCheck(tx, projectId, row.oldValue as unknown as LandingCheckValue);
    return settingChangeView(row);
  }
  const old = row.oldValue as unknown as LandingCheckExemptValue;
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "task"
     WHERE "id" = ${row.taskId}::uuid AND "owner_id" = ${ownerId}::uuid AND "project_id" = ${projectId}::uuid
       FOR NO KEY UPDATE`);
  if (!locked) {
    throw new ConflictException({
      code: 'SETTING_CHANGE_TASK_GONE',
      message: 'the task this change is about is no longer in this project, so there is nothing to put back',
    });
  }
  await tx.task.update({
    where: { id: row.taskId! },
    data: {
      landingCheckExempt: old.exempt,
      landingCheckExemptReason: old.exempt ? old.reason : null,
      landingCheckExemptBySessionId: null,
      landingCheckExemptOwnerSetAt: new Date(),
    },
    select: { id: true },
  });
  return settingChangeView(row);
}
