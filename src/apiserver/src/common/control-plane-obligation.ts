import {
  autoDispatchObligationsBy,
  readAutoDispatchObligations,
  type AutoDispatchObligation,
} from './auto-dispatch-obligation';
import { PrismaService } from '../prisma/prisma.service';

export type ControlPlaneObligation = AutoDispatchObligation;

export interface ControlPlaneObligationScope {
  tenantId: string;
  projectIds?: readonly string[];
  taskIds?: readonly string[];
  sessionIds?: readonly string[];
}

/**
 * One operational overlay for task/project readers.
 *
 * Automatic dispatch is the only canonical protocol behind it since 0220 removed completion ACK,
 * but the indirection stays: a reader must not know which table made work non-silent, and a
 * session-scoped read must keep returning nothing rather than leaking a task-scoped obligation.
 */
export async function readControlPlaneObligations(
  prisma: PrismaService,
  scope: ControlPlaneObligationScope,
): Promise<ControlPlaneObligation[]> {
  if (scope.sessionIds) return [];
  const rows = await readAutoDispatchObligations(prisma, {
    tenantId: scope.tenantId,
    projectIds: scope.projectIds,
    taskIds: scope.taskIds,
  });
  return [...rows].sort((left, right) => {
    const a = String(left.obligationId);
    const b = String(right.obligationId);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function controlPlaneObligationsBy(
  rows: readonly ControlPlaneObligation[],
  key: 'projectId' | 'taskId' | 'sessionId',
): Map<string, ControlPlaneObligation[]> {
  if (key === 'sessionId') return new Map();
  return autoDispatchObligationsBy(rows, key);
}
