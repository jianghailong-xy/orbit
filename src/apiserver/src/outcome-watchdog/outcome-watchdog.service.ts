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

  /**
   * Append one SHA-bound worker heartbeat. Sequence and previousDigest are read and written in the
   * same statement, so the ledger is a verifiable chain rather than mutable "last seen" telemetry.
   */
  async appendRuntimeHeartbeat(input: {
    component: string;
    instanceId: string;
    sourceSha: string;
    moduleGraphDigest: string;
    expectationGeneration: string;
    observedAt: Date;
    deadlineAt: Date;
    payload: Record<string, unknown>;
  }): Promise<{ heartbeatDigest: string; sequence: bigint }> {
    assertFullGitSha(input.sourceSha, 'WATCHDOG');
    if (!/^[0-9a-f]{64}$/.test(input.moduleGraphDigest)) {
      throw new Error('WATCHDOG_MODULE_GRAPH_DIGEST_INVALID');
    }
    const [row] = await this.prisma.$queryRaw<Array<{
      heartbeatDigest: string;
      sequence: bigint;
    }>>(Prisma.sql`
      WITH previous AS (
        SELECT h."sequence", h."heartbeat_digest"
          FROM "executable_runtime_heartbeat" h
         WHERE h."component" = ${input.component}::text
           AND h."instance_id" = ${input.instanceId}::text
         ORDER BY h."sequence" DESC LIMIT 1
      ), material AS (
        SELECT coalesce((SELECT "sequence" FROM previous), 0) + 1 AS sequence,
               (SELECT "heartbeat_digest" FROM previous) AS previous_digest,
               ${JSON.stringify(input.payload)}::jsonb AS payload
      ), bound AS (
        SELECT material.*,
               encode(digest(material.payload::text, 'sha256'), 'hex') AS payload_digest
          FROM material
      ), final AS (
        SELECT bound.*,
               encode(digest(jsonb_build_object(
                 'component', ${input.component}::text,
                 'instanceId', ${input.instanceId}::text,
                 'sequence', bound.sequence,
                 'sourceSha', ${input.sourceSha}::text,
                 'moduleGraphDigest', ${input.moduleGraphDigest}::text,
                 'expectationGeneration', ${input.expectationGeneration}::uuid,
                 'observedAt', ${input.observedAt}::timestamptz,
                 'deadlineAt', ${input.deadlineAt}::timestamptz,
                 'payloadDigest', bound.payload_digest,
                 'previousDigest', bound.previous_digest
               )::text, 'sha256'), 'hex') AS heartbeat_digest
          FROM bound
      )
      INSERT INTO "executable_runtime_heartbeat"
        ("id", "component", "instance_id", "sequence", "source_sha",
         "module_graph_digest", "observed_at", "deadline_at", "payload", "payload_digest",
         "previous_digest", "heartbeat_digest", "expectation_generation")
      SELECT gen_random_uuid(), ${input.component}::text, ${input.instanceId}::text, final.sequence,
             ${input.sourceSha}::text, ${input.moduleGraphDigest}::text, ${input.observedAt}::timestamptz,
             ${input.deadlineAt}::timestamptz, final.payload, final.payload_digest,
             final.previous_digest, final.heartbeat_digest, ${input.expectationGeneration}::uuid
        FROM final
      RETURNING "heartbeat_digest" AS "heartbeatDigest", "sequence"
    `);
    if (!row) throw new Error('WATCHDOG_HEARTBEAT_APPEND_FAILED');
    return row;
  }

  async markStaleExecutableAttempts(observedAt: Date, limit = 64): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT executable_acceptance_mark_stale_attempts(
        ${observedAt}::timestamptz, ${limit}::integer
      ) AS count
    `);
    return row?.count ?? 0;
  }

  /**
   * Independent completion-ACK detector. PostgreSQL reads only the durable turn/event/session/task
   * facts and appends immutable observations; it does not read the acceptance executor's typed
   * admission/attempt lane and does not call the monitored /turn-complete transaction.
   */
  async reconcileStaleCompletionAcks(
    observedAt: Date,
    detectionDeltaSeconds: number,
    limit = 64,
  ): Promise<JsonResult> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT completion_ack_reconcile_stale(
        ${observedAt}::timestamptz,
        ${detectionDeltaSeconds}::integer,
        ${limit}::integer
      ) AS result
    `);
    if (!row) throw new Error('COMPLETION_ACK_RECONCILIATION_MISSING');
    return asResult(row.result);
  }

  /**
   * Independently audit delivery of an already-canonical completion-ACK obligation. Durable
   * coordinator Session/event/turn/action fingerprints own the deadline; observing the same
   * fingerprint again cannot extend it. A stale latest receipt is append-only revoked and the
   * same 0198 coordination is requeued by PostgreSQL in the same transaction.
   */
  async reconcileStaleCompletionAckDeliveries(
    observedAt: Date,
    detectionDeltaSeconds: number,
    limit = 64,
  ): Promise<JsonResult> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT completion_ack_reconcile_stale_deliveries(
        ${observedAt}::timestamptz,
        ${detectionDeltaSeconds}::integer,
        ${limit}::integer
      ) AS result
    `);
    if (!row) throw new Error('COMPLETION_ACK_DELIVERY_RECONCILIATION_MISSING');
    return asResult(row.result);
  }

  /** Supplemental evidence from the HTTP edge after the monitored transaction has rolled back. */
  async recordCompletionAckFailure(input: {
    sessionId: string;
    turnId: string;
    leaseGeneration: string | null;
    errorFingerprint: string;
    observedAt: Date;
    evidenceSource: Record<string, unknown>;
  }): Promise<JsonResult | null> {
    const [scope] = await this.prisma.$queryRaw<Array<{
      tenantId: string;
      projectId: string;
      taskId: string;
      sessionId: string;
      turnId: string;
      leaseGeneration: string | null;
    }>>(Prisma.sql`
      SELECT task.owner_id AS "tenantId", task.project_id AS "projectId",
             task.id AS "taskId", session.id AS "sessionId", turn.id AS "turnId",
             turn.lease_generation AS "leaseGeneration"
        FROM conversation_turn turn
        JOIN session ON session.id = turn.session_id
        JOIN task ON task.id = session.task_id
       WHERE session.id = ${input.sessionId}::uuid
         AND turn.id = ${input.turnId}::uuid
         AND task.project_id IS NOT NULL
       LIMIT 1
    `);
    if (!scope) return null;
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT completion_ack_record_failure(
        ${scope.tenantId}::uuid,
        ${scope.projectId}::uuid,
        ${scope.taskId}::uuid,
        ${scope.sessionId}::uuid,
        ${scope.turnId}::uuid,
        ${input.leaseGeneration ?? scope.leaseGeneration}::uuid,
        'CONTROL_PLANE_COMMIT_REJECTED'::text,
        ${input.errorFingerprint}::text,
        ${input.observedAt}::timestamptz,
        ${JSON.stringify(input.evidenceSource)}::jsonb
      ) AS result
    `);
    if (!row) throw new Error('COMPLETION_ACK_FAILURE_FACT_MISSING');
    return asResult(row.result);
  }

  /** ACK success closes every fingerprint-specific obligation for this exact turn. */
  async recordCompletionAckRecovery(input: {
    sessionId: string;
    turnId: string;
    observedAt: Date;
    evidenceSource: Record<string, unknown>;
  }): Promise<JsonResult> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT completion_ack_record_recovery(
        ${input.sessionId}::uuid,
        ${input.turnId}::uuid,
        ${input.observedAt}::timestamptz,
        ${JSON.stringify(input.evidenceSource)}::jsonb
      ) AS result
    `);
    if (!row) throw new Error('COMPLETION_ACK_RECOVERY_FACT_MISSING');
    return asResult(row.result);
  }

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
