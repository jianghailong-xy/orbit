import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertFullGitSha,
  sanitizeWatchdogPayload,
  validateWatchdogContract,
  type WatchdogContract,
} from './outcome-watchdog';

type JsonResult = Record<string, unknown>;

function asResult(value: Prisma.JsonValue): JsonResult {
  return value as unknown as JsonResult;
}

/**
 * Database adapter for the independent watchdog process. It intentionally injects only Prisma:
 * importing the reconciler, projection, coordinator or action services here would turn their
 * process health into the watchdog's process health and defeat the boundary this module exists for.
 */
@Injectable()
export class OutcomeWatchdogService {
  constructor(private readonly prisma: PrismaService) {}

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ tenantId: string }>>(Prisma.sql`
      SELECT DISTINCT tenant_id AS "tenantId"
        FROM outcome_fact_stream
       ORDER BY tenant_id
    `);
    return rows.map((row) => row.tenantId);
  }

  async collect(input: {
    authenticatedTenantId: string;
    tenantId: string;
    contract: WatchdogContract;
    collectorSha: string;
    targetSha: string;
    observedAt?: Date;
  }): Promise<JsonResult> {
    validateWatchdogContract(input.contract);
    assertFullGitSha(input.collectorSha, 'COLLECTOR');
    assertFullGitSha(input.targetSha, 'TARGET');
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_watchdog.collect(
        ${input.authenticatedTenantId}::uuid,
        ${input.tenantId}::uuid,
        ${JSON.stringify(input.contract)}::jsonb,
        ${input.collectorSha},
        ${input.targetSha},
        ${input.observedAt ?? new Date()}::timestamptz
      ) AS result
    `);
    if (!row) throw new Error('OUTCOME_WATCHDOG_SAMPLE_MISSING');
    return asResult(row.result);
  }

  async ingestInbox(input: {
    authenticatedTenantId: string;
    tenantId: string;
    projectId: string;
    eventKey: string;
    payload: unknown;
    receivedLogicalTime: string;
  }): Promise<JsonResult> {
    const sanitized = sanitizeWatchdogPayload(input.payload);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_watchdog.ingest_inbox(
        ${input.authenticatedTenantId}::uuid,
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.eventKey},
        ${JSON.stringify(sanitized.payload)}::jsonb,
        ${BigInt(input.receivedLogicalTime)}::bigint
      ) AS result
    `);
    if (!row) throw new Error('OUTCOME_WATCHDOG_INBOX_RECEIPT_MISSING');
    return asResult(row.result);
  }

  async completeInbox(input: {
    authenticatedTenantId: string;
    tenantId: string;
    inboxId: string;
    state?: 'PROCESSED' | 'DEAD';
  }): Promise<JsonResult> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_watchdog.complete_inbox(
        ${input.authenticatedTenantId}::uuid,
        ${input.tenantId}::uuid,
        ${input.inboxId}::uuid,
        ${input.state ?? 'PROCESSED'}
      ) AS result
    `);
    if (!row) throw new Error('OUTCOME_WATCHDOG_INBOX_COMPLETION_MISSING');
    return asResult(row.result);
  }

  async readInbox(input: {
    authenticatedTenantId: string;
    tenantId: string;
    inboxId: string;
  }): Promise<JsonResult | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue | null }>>(Prisma.sql`
      SELECT outcome_watchdog.read_inbox(
        ${input.authenticatedTenantId}::uuid,
        ${input.tenantId}::uuid,
        ${input.inboxId}::uuid
      ) AS result
    `);
    return row?.result ? asResult(row.result) : null;
  }

  async submitEvidence(input: {
    authenticatedTenantId: string;
    tenantId: string;
    projectId: string;
    evidenceKey: string;
    evidenceKind: string;
    window: { seconds: number; logicalTicks: number; kind?: string };
    denominator: string;
    minSampleSize: number;
    collectorSha: string;
    targetSha: string;
    payload: unknown;
  }): Promise<JsonResult> {
    assertFullGitSha(input.collectorSha, 'COLLECTOR');
    assertFullGitSha(input.targetSha, 'TARGET');
    const sanitized = sanitizeWatchdogPayload(input.payload);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_watchdog.submit_evidence(
        ${input.authenticatedTenantId}::uuid,
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.evidenceKey},
        ${input.evidenceKind},
        ${JSON.stringify(input.window)}::jsonb,
        ${input.denominator},
        ${input.minSampleSize},
        ${input.collectorSha},
        ${input.targetSha},
        ${JSON.stringify(sanitized.payload)}::jsonb
      ) AS result
    `);
    if (!row) throw new Error('OUTCOME_WATCHDOG_EVIDENCE_RECEIPT_MISSING');
    return asResult(row.result);
  }

  async replay(input: {
    authenticatedTenantId: string;
    tenantId: string;
    collectorSha: string;
    targetSha: string;
  }): Promise<JsonResult> {
    assertFullGitSha(input.collectorSha, 'COLLECTOR');
    assertFullGitSha(input.targetSha, 'TARGET');
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_watchdog.replay_samples(
        ${input.authenticatedTenantId}::uuid,
        ${input.tenantId}::uuid,
        ${input.collectorSha},
        ${input.targetSha}
      ) AS result
    `);
    if (!row) throw new Error('OUTCOME_WATCHDOG_REPLAY_RECEIPT_MISSING');
    return asResult(row.result);
  }
}
