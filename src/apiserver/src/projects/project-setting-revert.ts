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

/**
 * The owner putting one record's old value back, as their own value: the landing check then reads
 * `setBy OWNER`, and a task's exemption carries the owner's stamp, so the coordinator's next cardless write
 * of either is refused (P-R1). The record stays; reverting twice writes the same value twice.
 */
export async function revertSettingChange(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
  changeId: string,
): Promise<ProjectSettingChangeView> {
  const row = await prisma.projectSettingChange.findFirst({
    where: { id: changeId, ownerId, projectId },
    select: CHANGE_SELECT,
  });
  if (!row) throw new NotFoundException('setting change not found');
  await prisma.$transaction(async (tx) => {
    if (row.field === 'LANDING_CHECK') {
      await restoreLandingCheck(tx, projectId, row.oldValue as unknown as LandingCheckValue);
      return;
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
  });
  return settingChangeView(row);
}
