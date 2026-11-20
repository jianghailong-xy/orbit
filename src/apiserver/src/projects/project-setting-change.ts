import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * The record of the coordinator's cardless landing-check changes (docs/project-integration-line-contract.md
 * §12.15 P-R1, migration 1390).
 *
 * Kept apart from the project ruling ledger (0970): a ruling row holds an owner's own quote and its
 * `source_kind` is closed to ASK_OWNER and TURN, both of which say where the OWNER said something. This is an
 * agent's act with a reason, so it would have bent both.
 *
 * Insert-only. A row is written in the transaction of the write it records, for the coordinator's cardless
 * writes alone; an owner write or a card write leaves none. The owner's revert writes the old value back as
 * the owner's own value and leaves the row as it was.
 */

export const SETTING_CHANGE_REASON_MAX_CHARS = 280;
export const SETTING_CHANGES_READ_MAX = 100;

export type SettingChangeField = 'LANDING_CHECK' | 'TASK_LANDING_CHECK_EXEMPT';

/** The project's landing check as one value: what a LANDING_CHECK row holds before and after. */
export interface LandingCheckValue {
  command: string | null;
  timeoutSeconds: number | null;
  none: boolean;
}

/** One task's exemption as one value: what a TASK_LANDING_CHECK_EXEMPT row holds before and after. */
export interface LandingCheckExemptValue {
  exempt: boolean;
  reason: string | null;
}

export interface ProjectSettingChangeView {
  id: string;
  projectId: string;
  taskId: string | null;
  field: SettingChangeField;
  oldValue: LandingCheckValue | LandingCheckExemptValue;
  newValue: LandingCheckValue | LandingCheckExemptValue;
  reason: string;
  writtenBySessionId: string;
  createdAt: string;
}

/** The reason a cardless write names: required, trimmed, at most 280 characters. Throws 400 `code` otherwise. */
export function requiredChangeReason(raw: unknown, code: string, argument: string): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason) {
    throw new BadRequestException({
      code,
      message: `${argument} is required for a change made without the owner's card: say in a sentence why. Nothing was written`,
    });
  }
  if (reason.length > SETTING_CHANGE_REASON_MAX_CHARS) {
    throw new BadRequestException({
      code,
      message: `${argument} is at most ${SETTING_CHANGE_REASON_MAX_CHARS} characters. Nothing was written`,
    });
  }
  return reason;
}

/** One row, in the transaction of the write it records. */
export async function recordSettingChange(
  tx: Pick<Prisma.TransactionClient, 'projectSettingChange'>,
  input: {
    ownerId: string;
    projectId: string;
    taskId?: string;
    field: SettingChangeField;
    oldValue: LandingCheckValue | LandingCheckExemptValue;
    newValue: LandingCheckValue | LandingCheckExemptValue;
    reason: string;
    sessionId: string;
  },
): Promise<void> {
  await tx.projectSettingChange.create({
    data: {
      ownerId: input.ownerId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      field: input.field,
      oldValue: input.oldValue as unknown as Prisma.InputJsonValue,
      newValue: input.newValue as unknown as Prisma.InputJsonValue,
      reason: input.reason,
      writtenBySessionId: input.sessionId,
    },
    select: { id: true },
  });
}

export const CHANGE_SELECT = {
  id: true, projectId: true, taskId: true, field: true, oldValue: true, newValue: true,
  reason: true, writtenBySessionId: true, createdAt: true,
} as const;

type ChangeRow = Prisma.ProjectSettingChangeGetPayload<{ select: typeof CHANGE_SELECT }>;

export function settingChangeView(row: ChangeRow): ProjectSettingChangeView {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    field: row.field as SettingChangeField,
    oldValue: row.oldValue as unknown as ProjectSettingChangeView['oldValue'],
    newValue: row.newValue as unknown as ProjectSettingChangeView['newValue'],
    reason: row.reason,
    writtenBySessionId: row.writtenBySessionId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The project's records, newest first. One statement. */
export async function readSettingChanges(
  db: Pick<PrismaService, 'projectSettingChange'>,
  ownerId: string,
  projectId: string,
): Promise<ProjectSettingChangeView[]> {
  const rows = await db.projectSettingChange.findMany({
    where: { ownerId, projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SETTING_CHANGES_READ_MAX,
    select: CHANGE_SELECT,
  });
  return rows.map(settingChangeView);
}
