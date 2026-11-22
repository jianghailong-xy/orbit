import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { restoreLandingCheck } from './project-integration-line';
import {
  CHANGE_SELECT,
  recordSettingChange,
  sameSettingValue,
  settingChangeView,
  type LandingCheckExemptValue,
  type LandingCheckValue,
  type ProjectSettingChangeView,
  type SettingValue,
} from './project-setting-change';

export const SETTING_CHANGE_NOT_REVERTIBLE = 'SETTING_CHANGE_NOT_REVERTIBLE';
export const SETTING_CHANGE_ALREADY_REVERTED = 'SETTING_CHANGE_ALREADY_REVERTED';
export const SETTING_CHANGE_NOT_CURRENT = 'SETTING_CHANGE_NOT_CURRENT';
export const SETTING_CHANGE_TASK_GONE = 'SETTING_CHANGE_TASK_GONE';

/** The record an owner reverts, read before the transaction: 404 when this project has no such record. */
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

function refused(code: string, message: string): ConflictException {
  return new ConflictException({ code, message: `${message}. Nothing was written` });
}

/**
 * The owner putting one coordinator change back to its old value, inside the caller's transaction (§12.15
 * P-R1, board D7). It is refused 409 for a change that is not the coordinator's, one already reverted, and one
 * whose new value is no longer the field's value. Otherwise the field is written as the owner's own, so the
 * coordinator's next cardless write of it is refused, and the revert is its own OWNER row naming the change.
 */
export async function putSettingChangeBack(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  row: Awaited<ReturnType<typeof readSettingChange>>,
): Promise<ProjectSettingChangeView> {
  if (row.origin !== 'COORDINATOR') {
    throw refused(SETTING_CHANGE_NOT_REVERTIBLE, 'only a change the coordinator made without a card can be reverted: '
      + 'this one is the owner\'s own or was approved on a card');
  }
  const field = row.field as 'LANDING_CHECK' | 'TASK_LANDING_CHECK_EXEMPT';
  const oldValue = row.oldValue as unknown as SettingValue;
  const newValue = row.newValue as unknown as SettingValue;
  const notCurrent = () => refused(SETTING_CHANGE_NOT_CURRENT,
    'this field has changed since, so putting back the old value would undo a later change');
  const alreadyReverted = () => refused(SETTING_CHANGE_ALREADY_REVERTED, 'this change was already reverted');

  let replaced: SettingValue;
  if (field === 'LANDING_CHECK') {
    const done = await restoreLandingCheck(tx, projectId, newValue as LandingCheckValue, oldValue as LandingCheckValue,
      async () => {
        if (await tx.projectSettingChange.findFirst({ where: { revertsChangeId: row.id }, select: { id: true } })) {
          throw alreadyReverted();
        }
      });
    if (done === null) throw notCurrent();
    replaced = done;
  } else {
    const [locked] = await tx.$queryRaw<Array<{ exempt: boolean; reason: string | null }>>(Prisma.sql`
      SELECT "landing_check_exempt" AS "exempt", "landing_check_exempt_reason" AS "reason" FROM "task"
       WHERE "id" = ${row.taskId}::uuid AND "owner_id" = ${ownerId}::uuid AND "project_id" = ${projectId}::uuid
         FOR NO KEY UPDATE`);
    if (!locked) {
      throw refused(SETTING_CHANGE_TASK_GONE,
        'the task this change is about is no longer in this project, so there is nothing to put back');
    }
    if (await tx.projectSettingChange.findFirst({ where: { revertsChangeId: row.id }, select: { id: true } })) {
      throw alreadyReverted();
    }
    const now: LandingCheckExemptValue = { exempt: locked.exempt, reason: locked.reason };
    if (!sameSettingValue(field, newValue, now)) throw notCurrent();
    const old = oldValue as LandingCheckExemptValue;
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
    replaced = now;
  }
  const revert = await tx.projectSettingChange.create({
    data: {
      ownerId, projectId, taskId: row.taskId, field, origin: 'OWNER',
      oldValue: replaced as unknown as Prisma.InputJsonValue,
      newValue: oldValue as unknown as Prisma.InputJsonValue,
      revertsChangeId: row.id,
    },
    select: CHANGE_SELECT,
  });
  return settingChangeView(revert);
}
