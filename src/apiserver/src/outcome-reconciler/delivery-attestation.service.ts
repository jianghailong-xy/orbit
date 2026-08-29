import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  evaluateDeliveryObligation,
  type DeliveryAttestation,
  type DeliveryAttestationResult,
  type DeliveryEvidenceSet,
  type DeliveryEvaluation,
  type DeliveryPolicyMode,
} from './delivery-attestation';

export interface RegisterDeliveryBindingInput {
  schemaVersion: 1;
  goalId: string;
  goalRevision: string;
  canonicalBindingDigest: string;
  policyMode: DeliveryPolicyMode;
  repositoryProvider: string;
  repositoryId: string;
  repositoryDigest: string;
  targetRef: string;
  currentTargetSha: string;
  currentTargetContentDigest: string;
  artifactDigest: string;
  evaluationPlanDigest: string;
  acceptanceCommandDigest: string;
  integrationProviderIdentity: string;
  verificationProviderIdentity: string;
  asOfLogicalTime: string;
  idempotencyKey: string;
}

export interface RecordDeliveryAttestationInput {
  schemaVersion: 1;
  deliveryBindingDigest: string;
  bindingRevisionDigest: string;
  providerReceiptId: string;
  providerIdentity: string;
  repositoryProvider: string;
  repositoryId: string;
  repositoryDigest: string;
  targetRef: string;
  targetSha: string;
  targetContentDigest: string;
  artifactDigest: string;
  result: DeliveryAttestationResult;
  externalEffectState: DeliveryAttestation['externalEffectState'];
  verifiedAt: string;
  verifiedLogicalTime: string;
  idempotencyKey: string;
}

export interface RecordCleanTargetVerificationInput {
  schemaVersion: 1;
  deliveryBindingDigest: string;
  bindingRevisionDigest: string;
  providerReceiptId: string;
  providerIdentity: string;
  repositoryDigest: string;
  targetRef: string;
  targetSha: string;
  targetContentDigest: string;
  artifactDigest: string;
  evaluationPlanDigest: string;
  acceptanceCommandDigest: string;
  environment: 'CLEAN_TARGET_SHA';
  result: 'PASS' | 'FAIL' | 'ERROR';
  exitCode: number;
  skipCount: number;
  verifiedAt: string;
  verifiedLogicalTime: string;
  idempotencyKey: string;
}

export interface DeliveryBindingReceipt {
  deliveryBindingId: string;
  deliveryBindingDigest: string;
  bindingRevisionDigest: string;
  replayed: boolean;
}

export interface DeliveryEvidenceReceipt {
  attestationId?: string;
  verificationId?: string;
  receiptDigest: string;
  replayed: boolean;
}

export interface DeliveryProviderContext {
  tenantId: string;
  authenticatedProviderIdentity: string;
}

/**
 * Thin durable boundary around the pure reducer. Recording evidence never mutates or clears an
 * obligation row: `evaluate` reads the append-only ledger and derives what is active now.
 */
@Injectable()
export class DeliveryAttestationService {
  constructor(private readonly prisma: PrismaService) {}

  async registerBinding(
    tenantId: string,
    projectId: string,
    input: RegisterDeliveryBindingInput,
  ): Promise<DeliveryBindingReceipt> {
    const [row] = await this.prisma.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_register_delivery_binding(
        ${tenantId}::uuid, ${projectId}::uuid, ${JSON.stringify(input)}::jsonb
      ) AS receipt
    `);
    if (!row) throw new Error('Delivery binding registration returned no receipt');
    return row.receipt as unknown as DeliveryBindingReceipt;
  }

  async recordAttestation(
    context: DeliveryProviderContext,
    projectId: string,
    input: RecordDeliveryAttestationInput,
  ): Promise<DeliveryEvidenceReceipt> {
    const [row] = await this.prisma.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_record_delivery_attestation(
        ${context.tenantId}::uuid, ${projectId}::uuid,
        ${context.authenticatedProviderIdentity}, ${JSON.stringify(input)}::jsonb
      ) AS receipt
    `);
    if (!row) throw new Error('Delivery attestation ingress returned no receipt');
    return row.receipt as unknown as DeliveryEvidenceReceipt;
  }

  async recordVerification(
    context: DeliveryProviderContext,
    projectId: string,
    input: RecordCleanTargetVerificationInput,
  ): Promise<DeliveryEvidenceReceipt> {
    const [row] = await this.prisma.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_record_delivery_verification(
        ${context.tenantId}::uuid, ${projectId}::uuid,
        ${context.authenticatedProviderIdentity}, ${JSON.stringify(input)}::jsonb
      ) AS receipt
    `);
    if (!row) throw new Error('Clean-target verification ingress returned no receipt');
    return row.receipt as unknown as DeliveryEvidenceReceipt;
  }

  async evidence(
    tenantId: string,
    projectId: string,
    deliveryBindingDigest: string,
  ): Promise<DeliveryEvidenceSet> {
    const [row] = await this.prisma.$queryRaw<Array<{ evidence: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_read_delivery_evidence(
        ${tenantId}::uuid, ${projectId}::uuid, ${deliveryBindingDigest}
      ) AS evidence
    `);
    if (!row) throw new Error('Delivery evidence ledger returned no value');
    return row.evidence as unknown as DeliveryEvidenceSet;
  }

  async evaluate(
    tenantId: string,
    projectId: string,
    deliveryBindingDigest: string,
  ): Promise<DeliveryEvaluation> {
    return evaluateDeliveryObligation(
      await this.evidence(tenantId, projectId, deliveryBindingDigest),
    );
  }
}
