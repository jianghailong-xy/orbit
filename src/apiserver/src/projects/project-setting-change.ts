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

export type SettingChangeOrigin = 'COORDINATOR' | 'OWNER' | 'CARD';

export type SettingValue = LandingCheckValue | LandingCheckExemptValue;

export interface ProjectSettingChangeView {
  id: string;
  projectId: string;
  taskId: string | null;
  field: SettingChangeField;
  /** Who wrote it: the coordinator with no card, the owner at their own door, or a card the owner answered. */
  origin: SettingChangeOrigin;
  oldValue: SettingValue;
  newValue: SettingValue;
  /** Always set for a COORDINATOR change; an owner may give one with an exemption. */
  reason: string | null;
  writtenBySessionId: string | null;
  /** The change an owner's revert put back, on the revert's own row; null on every other. */
  revertsChangeId: string | null;
  /** When an owner's revert put this change back; null when none did. */
  revertedAt: string | null;
  /** True only for a COORDINATOR change nothing reverted whose new value is still the field's value. */
  revertible: boolean;
  createdAt: string;
}

export function landingCheckValueOf(
  row: { landingCheckCommand?: string | null; landingCheckTimeoutSeconds?: number | null; landingCheckNone?: boolean },
): LandingCheckValue {
  return {
    command: row.landingCheckCommand ?? null,
    timeoutSeconds: row.landingCheckTimeoutSeconds ?? null,
    none: row.landingCheckNone ?? false,
  };
}

/** Is `value` what the field holds now? An exemption's reason counts only while it is exempt. */
export function sameSettingValue(field: SettingChangeField, a: SettingValue, b: SettingValue): boolean {
  if (field === 'LANDING_CHECK') {
    const x = a as LandingCheckValue;
    const y = b as LandingCheckValue;
    return x.command === y.command && x.timeoutSeconds === y.timeoutSeconds && x.none === y.none;
  }
  const x = a as LandingCheckExemptValue;
  const y = b as LandingCheckExemptValue;
  return x.exempt === y.exempt && (!x.exempt || x.reason === y.reason);
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
    origin: SettingChangeOrigin;
    oldValue: SettingValue;
    newValue: SettingValue;
    reason?: string | null;
    sessionId?: string | null;
    revertsChangeId?: string;
  },
): Promise<void> {
  await tx.projectSettingChange.create({
    data: {
      ownerId: input.ownerId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      field: input.field,
      origin: input.origin,
      oldValue: input.oldValue as unknown as Prisma.InputJsonValue,
      newValue: input.newValue as unknown as Prisma.InputJsonValue,
      reason: input.reason ?? null,
      writtenBySessionId: input.sessionId ?? null,
      revertsChangeId: input.revertsChangeId ?? null,
    },
    select: { id: true },
  });
}

export const CHANGE_SELECT = {
  id: true, projectId: true, taskId: true, field: true, origin: true, oldValue: true, newValue: true,
  reason: true, writtenBySessionId: true, revertsChangeId: true, createdAt: true,
} as const;

type ChangeRow = Prisma.ProjectSettingChangeGetPayload<{ select: typeof CHANGE_SELECT }>;

export function settingChangeView(
  row: ChangeRow,
  revertedAt: Date | null = null,
  revertible = false,
): ProjectSettingChangeView {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    field: row.field as SettingChangeField,
    origin: row.origin as SettingChangeOrigin,
    oldValue: row.oldValue as unknown as SettingValue,
    newValue: row.newValue as unknown as SettingValue,
    reason: row.reason,
    writtenBySessionId: row.writtenBySessionId,
    revertsChangeId: row.revertsChangeId,
    revertedAt: revertedAt?.toISOString() ?? null,
    revertible,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The project's history, newest first: three statements at most (the rows, the binding, the tasks the
 * exemption rows name), and one when there is none. Each coordinator change says whether it was reverted and
 * whether Revert is still offered on it (§12.15 P-R1, board D7).
 */
export async function readSettingChanges(
  db: Pick<PrismaService, 'projectSettingChange' | 'projectCodebase' | 'task'>,
  ownerId: string,
  projectId: string,
): Promise<ProjectSettingChangeView[]> {
  const rows = await db.projectSettingChange.findMany({
    where: { ownerId, projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SETTING_CHANGES_READ_MAX,
    select: CHANGE_SELECT,
  });
  if (rows.length === 0) return [];
  const revertedAt = new Map<string, Date>();
  for (const row of rows) if (row.revertsChangeId) revertedAt.set(row.revertsChangeId, row.createdAt);
  const binding = rows.some((row) => row.field === 'LANDING_CHECK')
    ? await db.projectCodebase.findFirst({
      where: { projectId, slot: 'primary' },
      select: { landingCheckCommand: true, landingCheckTimeoutSeconds: true, landingCheckNone: true },
    })
    : null;
  const taskIds = [...new Set(rows.flatMap((row) => (row.taskId ? [row.taskId] : [])))];
  const tasks = taskIds.length > 0
    ? await db.task.findMany({
      where: { id: { in: taskIds }, ownerId, projectId },
      select: { id: true, landingCheckExempt: true, landingCheckExemptReason: true },
    })
    : [];
  const taskNow = new Map(tasks.map((task) => [task.id, {
    exempt: task.landingCheckExempt, reason: task.landingCheckExemptReason,
  } satisfies LandingCheckExemptValue]));
  return rows.map((row) => {
    const field = row.field as SettingChangeField;
    const now: SettingValue | null = field === 'LANDING_CHECK'
      ? (binding ? landingCheckValueOf(binding) : null)
      : taskNow.get(row.taskId ?? '') ?? null;
    const reverted = revertedAt.get(row.id) ?? null;
    const revertible = row.origin === 'COORDINATOR' && reverted === null && now !== null
      && sameSettingValue(field, row.newValue as unknown as SettingValue, now);
    return settingChangeView(row, reverted, revertible);
  });
}
