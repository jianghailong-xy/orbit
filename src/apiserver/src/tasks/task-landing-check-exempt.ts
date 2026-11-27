import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { decidedLine, readProjectCodebase } from '../projects/project-integration-line';
import { requiredChangeReason, type LandingCheckExemptValue } from '../projects/project-setting-change';

/**
 * One task exempt from its project's landing check (docs/project-integration-line-contract.md §12.15
 * P-C2, columns §12.14, migration 1350).
 *
 * The landing check is the project's gate onto its own branch (§11 K1); the merge check before
 * upstream (§3 M-S3) is the gate onto main and is not touched here. So the exemption is a working
 * decision the coordinator may make for one task, with a reason, on a PROJECT_BRANCH line only: on a
 * MAIN line the landing check IS the check work passes on its way into upstream, and nobody but the
 * owner's own door may skip that (revision 39).
 *
 * Writers: the project's current coordinator session, or the owner at their own door (no session).
 * The task's acceptance still runs when it lands (`checksFor`).
 *
 * §12.15 P-R1: the coordinator's write leaves a record (`recordSettingChange`), so it names a reason whether it
 * exempts or takes the exemption back; the owner's write leaves none and stamps the task, after which the
 * coordinator's cardless write of this field is refused.
 */

export const MAX_LANDING_CHECK_EXEMPT_REASON_CHARS = 280;

export const LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH = 'LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH';
export const LANDING_CHECK_EXEMPT_REASON_REQUIRED = 'LANDING_CHECK_EXEMPT_REASON_REQUIRED';
export const LANDING_CHECK_EXEMPT_REASON_TOO_LONG = 'LANDING_CHECK_EXEMPT_REASON_TOO_LONG';
export const LANDING_CHECK_EXEMPT_REASON_WITHOUT_EXEMPTION = 'LANDING_CHECK_EXEMPT_REASON_WITHOUT_EXEMPTION';
export const LANDING_CHECK_EXEMPT_COORDINATOR_ONLY = 'LANDING_CHECK_EXEMPT_COORDINATOR_ONLY';
export const LANDING_CHECK_EXEMPT_SET_BY_OWNER = 'LANDING_CHECK_EXEMPT_SET_BY_OWNER';

/** The three columns as a write leaves them. */
export interface LandingCheckExemptColumns {
  landingCheckExempt: boolean;
  landingCheckExemptReason: string | null;
  landingCheckExemptBySessionId: string | null;
  /** Stamped by the owner's own write; absent from the coordinator's. */
  landingCheckExemptOwnerSetAt?: Date;
}

/** What `landingCheckExemptWrite` decided: the columns to write and, for the coordinator's write, its record. */
export interface LandingCheckExemptWrite {
  columns: LandingCheckExemptColumns;
  /**
   * The row P-R1 keeps for this write, in the same transaction: COORDINATOR with the reason and session when the
   * coordinator wrote it, OWNER when the owner did (their reason, if they gave one).
   */
  record: {
    origin: 'COORDINATOR' | 'OWNER';
    sessionId: string | null;
    reason: string | null;
    oldValue: LandingCheckExemptValue;
    newValue: LandingCheckExemptValue;
  } | null;
}

/**
 * What a create or an update that names the exemption writes, or null when it names neither field or
 * changes nothing. Throws the refusal otherwise, before anything is written.
 *
 * `projectId` is the project the task is in after this write; `actingSessionId` is the session the
 * write came from, absent for the owner's own door.
 */
export async function landingCheckExemptWrite(
  prisma: Pick<PrismaService, 'project' | 'projectCodebase'>,
  input: {
    ownerId: string;
    projectId: string | null | undefined;
    actingSessionId: string | undefined;
    exempt: boolean | undefined;
    reason: string | null | undefined;
    /** Whether the task is exempt before this write; false for a create. */
    currentlyExempt: boolean;
    /** The task's exemption reason before this write; null for a create. */
    currentReason?: string | null;
    /** Whether the owner has written or reverted this task's exemption; false for a create. */
    ownerHasWritten?: boolean;
  },
): Promise<LandingCheckExemptWrite | null> {
  if (input.exempt === undefined && input.reason === undefined) return null;
  const exempt = input.exempt ?? input.currentlyExempt;
  const reason = input.reason?.trim() || null;
  const bySession = !!input.actingSessionId;
  if (!exempt) {
    if (reason !== null && !bySession) {
      throw new BadRequestException({
        code: LANDING_CHECK_EXEMPT_REASON_WITHOUT_EXEMPTION,
        message: 'landingCheckExemptReason explains landingCheckExempt true; this write leaves the task not exempt. '
          + 'Nothing was written',
      });
    }
    if (!input.currentlyExempt) return null;
  } else {
    if (reason === null) {
      throw new BadRequestException({
        code: LANDING_CHECK_EXEMPT_REASON_REQUIRED,
        message: 'exempting a task from the landing check needs landingCheckExemptReason: say in a sentence why '
          + 'the project\'s landing check has nothing to say about this task. Nothing was written',
      });
    }
    if (reason.length > MAX_LANDING_CHECK_EXEMPT_REASON_CHARS) {
      throw new BadRequestException({
        code: LANDING_CHECK_EXEMPT_REASON_TOO_LONG,
        message: `landingCheckExemptReason is at most ${MAX_LANDING_CHECK_EXEMPT_REASON_CHARS} characters. `
          + 'Nothing was written',
      });
    }
  }
  const project = input.projectId
    ? await prisma.project.findFirst({
      where: { id: input.projectId, ownerId: input.ownerId },
      select: { coordinatorSessionId: true },
    })
    : null;
  const cleared: LandingCheckExemptColumns = {
    landingCheckExempt: false, landingCheckExemptReason: null, landingCheckExemptBySessionId: null,
    ...(bySession ? {} : { landingCheckExemptOwnerSetAt: new Date() }),
  };
  if (!project) {
    // The owner may still take back an exemption left on a task that has since left its project.
    if (!exempt && !bySession) return { columns: cleared, record: null };
    throw needsProjectBranch('this task is in no project, so it lands on no project branch');
  }
  if (input.actingSessionId && input.actingSessionId !== project.coordinatorSessionId) {
    throw new ForbiddenException({
      code: LANDING_CHECK_EXEMPT_COORDINATOR_ONLY,
      message: 'only the project\'s current coordinator session, or the owner, may change whether a task is '
        + 'exempt from the landing check. Nothing was written',
    });
  }
  if (bySession && input.ownerHasWritten) {
    throw new ForbiddenException({
      code: LANDING_CHECK_EXEMPT_SET_BY_OWNER,
      message: 'the account owner has written or reverted this task\'s landing-check exemption, so it stays '
        + 'theirs: this session cannot change it without their card. Nothing was written',
    });
  }
  const before: LandingCheckExemptValue = { exempt: input.currentlyExempt, reason: input.currentReason ?? null };
  const recordOf = (after: LandingCheckExemptValue): LandingCheckExemptWrite['record'] => bySession
    ? { origin: 'COORDINATOR', sessionId: input.actingSessionId!, reason: reason!, oldValue: before, newValue: after }
    : { origin: 'OWNER', sessionId: null, reason, oldValue: before, newValue: after };
  if (!exempt) {
    // The coordinator's taking it back is a recorded write too, and says why.
    if (bySession) requiredChangeReason(reason, LANDING_CHECK_EXEMPT_REASON_REQUIRED, 'landingCheckExemptReason');
    return { columns: cleared, record: recordOf({ exempt: false, reason: null }) };
  }
  const binding = await readProjectCodebase(prisma, input.projectId!);
  const line = binding ? decidedLine(binding) : null;
  if (line !== 'PROJECT_BRANCH') {
    throw needsProjectBranch(line === 'MAIN'
      ? 'this project lands on main, where its landing check is the check work passes on its way into main'
      : 'this project has not decided to land on a project branch yet');
  }
  return {
    columns: {
      landingCheckExempt: true,
      landingCheckExemptReason: reason,
      landingCheckExemptBySessionId: input.actingSessionId ?? null,
      ...(bySession ? {} : { landingCheckExemptOwnerSetAt: new Date() }),
    },
    record: recordOf({ exempt: true, reason }),
  };
}

function needsProjectBranch(why: string): ConflictException {
  return new ConflictException({
    code: LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH,
    message: `a task can be exempt from the landing check only on a project-branch line: ${why}. Nothing was written`,
  });
}
