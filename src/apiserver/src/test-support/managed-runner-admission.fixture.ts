import { MANAGED_ADMISSION_DENIAL_MARKER } from '../managed-runners/managed-runner-admission';
import { reviewPodAdmission } from '../managed-runners/managed-runner-admission.controller';
import type { ManagedRunnerProfile } from '../managed-runners/managed-runner-profile';
import type { PrismaService } from '../prisma/prisma.service';
import type { FakeAdmissionWebhook, FakeKubeCluster } from './fake-kube-client';

/**
 * The optional environment's admission guard, installed in a fake cluster: every Pod create and
 * update there is decided by the webhook's own decision over the test's database
 * (reviewPodAdmission), and refused with the message the real webhook sends.
 */
export function managedRunnerAdmissionWebhook(prisma: Pick<PrismaService, 'managedRunner'>, profile: ManagedRunnerProfile): FakeAdmissionWebhook {
  return async (request) => {
    const decision = await reviewPodAdmission(prisma, profile, request);
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, message: `${MANAGED_ADMISSION_DENIAL_MARKER}: ${decision.code}: ${decision.message}` };
  };
}

export function installManagedRunnerAdmission(cluster: FakeKubeCluster, prisma: Pick<PrismaService, 'managedRunner'>, profile: ManagedRunnerProfile): FakeKubeCluster {
  cluster.admission = managedRunnerAdmissionWebhook(prisma, profile);
  return cluster;
}
