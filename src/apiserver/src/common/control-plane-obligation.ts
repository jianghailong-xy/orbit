import {
  completionAckObligationsBy,
  readCompletionAckObligations,
  type CompletionAckObligation,
  type CompletionAckObligationScope,
} from './completion-ack-obligation';
import {
  autoDispatchObligationsBy,
  readAutoDispatchObligations,
  type AutoDispatchObligation,
} from './auto-dispatch-obligation';
import { PrismaService } from '../prisma/prisma.service';

export type ControlPlaneObligation = CompletionAckObligation | AutoDispatchObligation;

/**
 * One operational overlay for task/project readers. Completion ACK and automatic dispatch are
 * independent canonical protocols, but a reader must not know which table made work non-silent.
 */
export async function readControlPlaneObligations(
  prisma: PrismaService,
  scope: CompletionAckObligationScope,
): Promise<ControlPlaneObligation[]> {
  const [completionAcks, autoDispatch] = await Promise.all([
    readCompletionAckObligations(prisma, scope),
    scope.sessionIds
      ? Promise.resolve([])
      : readAutoDispatchObligations(prisma, {
          tenantId: scope.tenantId,
          projectIds: scope.projectIds,
          taskIds: scope.taskIds,
        }),
  ]);
  return [...completionAcks, ...autoDispatch].sort((left, right) => {
    const a = String(left.obligationId);
    const b = String(right.obligationId);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function controlPlaneObligationsBy(
  rows: readonly ControlPlaneObligation[],
  key: 'projectId' | 'taskId' | 'sessionId',
): Map<string, ControlPlaneObligation[]> {
  // Keep the protocol-specific reducers as the tested identity boundary, then concatenate their
  // results. sessionId can only belong to completion ACK today.
  // CompletionAckObligation predates the literal fact-kind type and therefore declares `string`;
  // split once at this adapter boundary and keep that legacy wire type out of every caller.
  const completionRows = rows.filter(
    (row) => row.factKind !== 'AUTO_DISPATCH_BLOCKED',
  ) as CompletionAckObligation[];
  const completion = completionAckObligationsBy(completionRows, key);
  const combined = new Map<string, ControlPlaneObligation[]>(completion);
  if (key === 'sessionId') return combined;
  const automaticRows = rows.filter(
    (row) => row.factKind === 'AUTO_DISPATCH_BLOCKED',
  ) as AutoDispatchObligation[];
  const automatic = autoDispatchObligationsBy(automaticRows, key);
  for (const [id, obligations] of automatic) {
    combined.set(id, [...(combined.get(id) ?? []), ...obligations]);
  }
  return combined;
}
