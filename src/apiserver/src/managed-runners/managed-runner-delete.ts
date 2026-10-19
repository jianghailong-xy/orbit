import { ConflictException } from '@nestjs/common';
import { MANAGED_RUNNER_DELETE_REFUSED, MANAGED_RUNNER_ROTATE_REFUSED } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * Refuse to hard-delete a managed runner's row, whatever the switch says
 * (docs/managed-runner-design.md, "Retention explicit deletion and backup"). `workspace.runner_id`
 * cascades, so the delete would take the default workspace with it, and the mapping that records
 * the runner's data volume holds the row (ON DELETE RESTRICT). Releasing compute never needs it.
 */
export async function refuseManagedRunnerDeletion(prisma: Pick<PrismaService, 'managedRunner'>, runnerId: string): Promise<void> {
  const mapped = await prisma.managedRunner.findUnique({ where: { runnerId }, select: { id: true } });
  if (mapped) {
    throw new ConflictException({
      code: MANAGED_RUNNER_DELETE_REFUSED,
      message: 'This is a managed runner; it is removed through the managed runner deletion workflow, not by unregistering it.',
    });
  }
}

/**
 * Refuse the owner's rotation of a managed runner's credential, whatever the switch says
 * (docs/managed-runner-design.md, "Identity and durable mapping"). Its credential belongs to one
 * generation: the manager issues it into that generation's bootstrap Secret and replaces it only
 * when the generation advances. A rotated token would be a credential no instance was issued, and
 * in the owner's hands a second holder of the managed runner's identity.
 */
export async function refuseManagedRunnerRotation(prisma: Pick<PrismaService, 'managedRunner'>, runnerId: string): Promise<void> {
  const mapped = await prisma.managedRunner.findUnique({ where: { runnerId }, select: { id: true } });
  if (mapped) {
    throw new ConflictException({
      code: MANAGED_RUNNER_ROTATE_REFUSED,
      message: "This is a managed runner; its credential is issued for each generation by the manager and cannot be rotated by hand.",
    });
  }
}
