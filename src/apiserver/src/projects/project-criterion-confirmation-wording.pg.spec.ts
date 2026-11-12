/**
 * Board 03's stale row and Confirm sheet over a real database (migration 0555): a confirmation keeps
 * the wording it was given for and the screenshot it was given with, and the project document serves
 * both — so once the criterion's text is revised, the STALE row's What changed shows the confirmed
 * words beside the current ones, and the confirmer row shows its screenshot.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-criterion-confirmation-wording.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectCriterionConfirmationService } from './project-criterion-confirmation.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const METHOD = 'Open /privacy on the staging site.';

test('a stale confirmation serves the wording it was given for, and its screenshot, on the project read', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const confirmations = new ProjectCriterionConfirmationService(db);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `wording-${ownerId}@project.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  const projectId = randomUUID();
  await prisma.project.create({ data: { id: projectId, ownerId, title: 'Launch prerequisites' } });
  await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const written = await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: [{
      text: 'The privacy policy is published at /privacy.', verificationMethod: METHOD, satisfiedBy: 'CONFIRMATION',
    }],
  } as never);
  const criterionId = (written.acceptanceCriteriaItems as Array<{ id: string }>)[0].id;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const shot = await prisma.attachment.create({
    data: { ownerId, mimeType: 'image/png', sizeBytes: png.length, fileName: 'privacy.png', data: png },
  });

  await t.test('the owner confirms with a screenshot: the row keeps revision 1\'s words', async () => {
    await confirmations.confirm(ownerId, projectId, criterionId, { kind: 'OWNER' }, {
      note: 'Published and linked from the footer.', attachmentIds: [shot.id], revision: 1,
    });
    const { rows: [row] } = await sql.query<{ criterion_text: string; criterion_verification_method: string; attachment_ids: string[] }>(
      `SELECT "criterion_text", "criterion_verification_method", "attachment_ids"::text[] AS "attachment_ids"
         FROM "project_criterion_confirmation" WHERE "definition_id" = $1::uuid`, [criterionId]);
    assert.equal(row.criterion_text, 'The privacy policy is published at /privacy.');
    assert.equal(row.criterion_verification_method, METHOD);
    assert.deepEqual(row.attachment_ids, [shot.id]);
    const document = await projects.get(ownerId, projectId);
    const item = document.acceptanceCriteriaItems[0] as any;
    assert.equal(item.satisfied, true);
    assert.equal(item.confirmation.state, 'CONFIRMED');
    assert.deepEqual(item.confirmation.current.attachmentIds, [shot.id], 'the confirmer row\'s screenshot');
  });

  await t.test('a rewording makes it stale, and the read serves what was confirmed beside what it says now', async () => {
    // A rewording is held for the owner's decision on the doors; what an approved one writes is the
    // text, and the normalize trigger moves the revision — which is all this read depends on.
    const reworded = await sql.query(
      `UPDATE "project_acceptance_criterion_definition" SET "text" = $2 WHERE "id" = $1::uuid`,
      [criterionId, 'The privacy policy is published at /privacy and names the SMS vendor.']);
    assert.equal(reworded.rowCount, 1);
    const document = await projects.get(ownerId, projectId);
    const item = document.acceptanceCriteriaItems[0] as any;
    assert.equal(item.revision, 2);
    assert.equal(item.text, 'The privacy policy is published at /privacy and names the SMS vendor.');
    assert.equal(item.satisfied, false);
    assert.equal(item.confirmation.state, 'STALE');
    assert.equal(item.confirmation.current.revision, 1);
    assert.equal(item.confirmation.current.criterionText, 'The privacy policy is published at /privacy.');
    assert.equal(item.confirmation.current.criterionVerificationMethod, METHOD);
    assert.deepEqual(item.confirmation.current.attachmentIds, [shot.id]);
    // The done projection carries the same standing to the done card.
    const derived = document.derivedDone.criteria.find((criterion: any) => criterion.definitionId === criterionId) as any;
    assert.equal(derived.confirmation.current.criterionText, 'The privacy policy is published at /privacy.');
  });

  await t.test('an upload of another account is refused, and nothing is written', async () => {
    const strangerId = randomUUID();
    await prisma.user.create({
      data: { id: strangerId, email: `stranger-${strangerId}@project.invalid`, name: 'Stranger', passwordHash: 'x' },
    });
    const theirs = await prisma.attachment.create({
      data: { ownerId: strangerId, mimeType: 'image/png', sizeBytes: png.length, data: png },
    });
    const before = await prisma.projectCriterionConfirmation.count({ where: { definitionId: criterionId } });
    await assert.rejects(confirmations.confirm(ownerId, projectId, criterionId, { kind: 'OWNER' }, { attachmentIds: [theirs.id] }));
    assert.equal(await prisma.projectCriterionConfirmation.count({ where: { definitionId: criterionId } }), before);
  });
});
