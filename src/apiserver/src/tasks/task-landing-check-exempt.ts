import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { decidedLine, readProjectCodebase } from '../projects/project-integration-line';

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
 */

export const MAX_LANDING_CHECK_EXEMPT_REASON_CHARS = 280;

export const LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH = 'LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH';
export const LANDING_CHECK_EXEMPT_REASON_REQUIRED = 'LANDING_CHECK_EXEMPT_REASON_REQUIRED';
export const LANDING_CHECK_EXEMPT_REASON_TOO_LONG = 'LANDING_CHECK_EXEMPT_REASON_TOO_LONG';
export const LANDING_CHECK_EXEMPT_REASON_WITHOUT_EXEMPTION = 'LANDING_CHECK_EXEMPT_REASON_WITHOUT_EXEMPTION';
export const LANDING_CHECK_EXEMPT_COORDINATOR_ONLY = 'LANDING_CHECK_EXEMPT_COORDINATOR_ONLY';

/** The three columns as a write leaves them. */
export interface LandingCheckExemptColumns {
  landingCheckExempt: boolean;
  landingCheckExemptReason: string | null;
  landingCheckExemptBySessionId: string | null;
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
  },
): Promise<LandingCheckExemptColumns | null> {
  if (input.exempt === undefined && input.reason === undefined) return null;
  const exempt = input.exempt ?? input.currentlyExempt;
  const reason = input.reason?.trim() || null;
  if (!exempt) {
    if (reason !== null) {
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
  const cleared = { landingCheckExempt: false, landingCheckExemptReason: null, landingCheckExemptBySessionId: null };
  if (!project) {
    // The owner may still take back an exemption left on a task that has since left its project.
    if (!exempt && !input.actingSessionId) return cleared;
    throw needsProjectBranch('this task is in no project, so it lands on no project branch');
  }
  if (input.actingSessionId && input.actingSessionId !== project.coordinatorSessionId) {
    throw new ForbiddenException({
      code: LANDING_CHECK_EXEMPT_COORDINATOR_ONLY,
      message: 'only the project\'s current coordinator session, or the owner, may change whether a task is '
        + 'exempt from the landing check. Nothing was written',
    });
  }
  if (!exempt) return cleared;
  const binding = await readProjectCodebase(prisma, input.projectId!);
  const line = binding ? decidedLine(binding) : null;
  if (line !== 'PROJECT_BRANCH') {
    throw needsProjectBranch(line === 'MAIN'
      ? 'this project lands on main, where its landing check is the check work passes on its way into main'
      : 'this project has not decided to land on a project branch yet');
  }
  return {
    landingCheckExempt: true,
    landingCheckExemptReason: reason,
    landingCheckExemptBySessionId: input.actingSessionId ?? null,
  };
}

function needsProjectBranch(why: string): ConflictException {
  return new ConflictException({
    code: LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH,
    message: `a task can be exempt from the landing check only on a project-branch line: ${why}. Nothing was written`,
  });
}
