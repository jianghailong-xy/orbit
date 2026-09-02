import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, ProjectAcceptanceVerdict, ProjectStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';

/**
 * N5: append-only conclusions and derived acceptance over a disposable, fully migrated PostgreSQL.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/projects/project-acceptance-events.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
async function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

async function connect(): Promise<{ db: PrismaClient; acceptance: ProjectAcceptanceService }> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  return { db, acceptance: new ProjectAcceptanceService(db as unknown as PrismaService) };
}

async function fixture(db: PrismaClient, label: string, criteria = 'Build succeeds') {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@acceptance-events.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, acceptanceCriteria: criteria },
  });
  return { ownerId, projectId };
}

async function humanConclusion(
  acceptance: ProjectAcceptanceService,
  target: { ownerId: string; projectId: string },
  verdicts: ProjectAcceptanceVerdict[],
) {
  const version = await acceptance.openRun(target.ownerId, target.projectId, {
    decidedBy: 'COORDINATOR_AGENT',
  });
  return acceptance.finalizeRun(
    target.ownerId,
    target.projectId,
    version.id,
    verdicts.map((verdict, index) => ({
      ordinal: index + 1,
      verdict,
      summary: `${verdict} on durable evidence`,
      evidence: { command: 'npm test', exitCode: verdict === ProjectAcceptanceVerdict.PASS ? 0 : 1 },
    })),
  );
}

async function settle(
  db: PrismaClient,
  acceptance: ProjectAcceptanceService,
  target: { ownerId: string; projectId: string },
) {
  await db.$transaction(async (tx) => {
    await ProjectAcceptanceService.lockProject(
      tx as Prisma.TransactionClient,
      target.projectId,
      target.ownerId,
      'FOR UPDATE',
    );
    const gate = await acceptance.assertDoneAllowed(tx as Prisma.TransactionClient, target.projectId);
    await tx.project.update({
      where: { id: target.projectId },
      data: { status: ProjectStatus.DONE, acceptedRunId: gate.runId },
    });
  });
}

test('new merge evidence advances the evidence version and keeps a derived PASS without reopening an attempt', { skip }, async () => {
  const { db, acceptance } = await connect();
  try {
    const target = await fixture(db, 'merge-carries-pass');
    const passed = await humanConclusion(acceptance, target, [ProjectAcceptanceVerdict.PASS]);
    await settle(db, acceptance, target);

    const merged = await acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'release-main',
      targetBranch: 'main',
      contentHash: 'a'.repeat(64),
      detail: { tree: 'current main' },
    });
    assert.equal(merged.changed, true);
    assert.notEqual(merged.acceptanceRunId, passed.id, 'the evidence set advanced automatically');
    assert.notEqual(merged.evidenceVersion, passed.evidenceVersion);

    const gate = await acceptance.evaluateGate(target.projectId);
    assert.equal(gate.allowed, true, String(gate.reason ?? 'derived PASS unexpectedly disappeared'));
    assert.doesNotMatch(String(gate.reason ?? ''), /ACCEPTANCE_EVIDENCE_STALE/);

    const project = await db.project.findUniqueOrThrow({
      where: { id: target.projectId },
      select: { status: true, acceptedRunId: true },
    });
    assert.deepEqual(project, {
      status: ProjectStatus.DONE,
      acceptedRunId: merged.acceptanceRunId,
    });

    const event = await db.projectAcceptanceConclusion.findFirstOrThrow({
      where: { projectId: target.projectId, verdict: ProjectAcceptanceVerdict.PASS },
    });
    assert.equal(event.decidedBy, 'USER');
    assert.ok(event.decidedById, 'who is mandatory');
    assert.ok(event.decidedAt instanceof Date, 'when is mandatory');
    assert.equal(event.evidenceVersion.toString(), passed.evidenceVersion);

    await assert.rejects(
      db.projectAcceptanceConclusion.update({
        where: { id: event.id },
        data: { summary: 'rewrite history' },
      }),
      /ACCEPTANCE_CONCLUSION_IMMUTABLE/,
    );
    await assert.rejects(
      db.projectAcceptanceConclusion.create({
        data: {
          projectId: target.projectId,
          evidenceRunId: event.evidenceRunId,
          evidenceVersion: event.evidenceVersion,
          ordinal: event.ordinal,
          criterionKey: event.criterionKey,
          criterionText: event.criterionText,
          definitionId: event.definitionId,
          definitionRevision: event.definitionRevision,
          verdict: ProjectAcceptanceVerdict.PASS,
          decidedBy: 'COORDINATOR_AGENT',
          decidedById: randomUUID(),
        },
      }),
      /project_acceptance_conclusion_pass_authority_chk/,
    );

    const columns = await db.$queryRaw<Array<{ columnName: string; nullable: string }>>(Prisma.sql`
      SELECT column_name AS "columnName", is_nullable AS "nullable"
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'project_acceptance_conclusion'
         AND column_name IN ('decided_by_id', 'decided_at', 'evidence_version')
       ORDER BY column_name
    `);
    assert.deepEqual(columns, [
      { columnName: 'decided_at', nullable: 'NO' },
      { columnName: 'decided_by_id', nullable: 'NO' },
      { columnName: 'evidence_version', nullable: 'NO' },
    ]);

    // The gate DOES have a stale-evidence branch — 0222 restored 0150's body, whose whole point is
    // that a superseded or reopened run stops being a claim about now. What this asserts is that
    // merge evidence does not TAKE that branch: the assertion above is on the answer, this one is
    // on the branch being present to answer with, so a gate that silently lost it would not read
    // as a passing test.
    const [gateDefinition] = await db.$queryRaw<Array<{ definition: string }>>(Prisma.sql`
      SELECT pg_get_functiondef('project_acceptance_done_gate()'::regprocedure) AS definition
    `);
    assert.match(gateDefinition?.definition ?? '', /ACCEPTANCE_EVIDENCE_STALE: acceptance run % was superseded/);
  } finally {
    await db.$disconnect();
  }
});

test('a newer non-PASS conclusion automatically removes a project from the completed state', { skip }, async () => {
  const { db, acceptance } = await connect();
  try {
    const target = await fixture(db, 'refutation-reopens');
    await humanConclusion(acceptance, target, [ProjectAcceptanceVerdict.PASS]);
    await settle(db, acceptance, target);

    const merged = await acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'release-main',
      targetBranch: 'main',
      contentHash: 'b'.repeat(64),
    });
    assert.ok(merged.acceptanceRunId);
    await acceptance.finalizeRun(
      target.ownerId,
      target.projectId,
      merged.acceptanceRunId!,
      [{ ordinal: 1, verdict: ProjectAcceptanceVerdict.FAIL, summary: 'new evidence refutes it' }],
    );
    // The legacy conclusion is append-only evidence, not a second Project-status writer. Drive the
    // same newer fact through the canonical evaluator before asserting the derived reopen.

    const project = await db.project.findUniqueOrThrow({
      where: { id: target.projectId },
      select: { status: true, acceptedRunId: true },
    });
    assert.deepEqual(project, { status: ProjectStatus.OPEN, acceptedRunId: null });
    const gate = await acceptance.evaluateGate(target.projectId);
    assert.equal(gate.allowed, false);
    assert.equal(gate.runId, null);
    assert.equal(typeof gate.code, 'string');
    assert.equal(typeof gate.reason, 'string');
  } finally {
    await db.$disconnect();
  }
});

test('two concurrent evaluators receive one current evidence version and leave no competing open attempts', { skip }, async () => {
  const { db, acceptance } = await connect();
  try {
    const target = await fixture(db, 'concurrent-evaluation');
    const other = new ProjectAcceptanceService(db as unknown as PrismaService);
    const [left, right] = await Promise.all([
      acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' }),
      other.openRun(target.ownerId, target.projectId, { decidedBy: 'COORDINATOR_AGENT' }),
    ]);
    assert.equal(left.id, right.id);
    assert.equal(left.evidenceVersion, right.evidenceVersion);
    assert.equal(
      await db.projectAcceptanceRun.count({ where: { projectId: target.projectId } }),
      1,
    );
    assert.equal(
      await db.projectAcceptanceRun.count({
        where: { projectId: target.projectId, supersededAt: null, verdict: null },
      }),
      1,
    );
  } finally {
    await db.$disconnect();
  }
});

test('the PostgreSQL target is a disposable database', { skip }, async () => {
  await verifyDisposableDatabase();
});
