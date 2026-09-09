/**
 * A LOOSENING EDIT DOES NOT TAKE EFFECT. IT BECOMES A PROPOSAL.
 *
 * This is the second half of "the ruler may only walk toward strictness on its own".
 * `criteria-seal-additive.pg.spec.ts` witnesses the first half — a tightening edit lands where it
 * is made — and it is what makes this file mean anything: "the loosening did not land" is a
 * statement about a write path that is known to be able to land things.
 *
 * WHAT EACH CASE HAS TO WITNESS, AND WHY "NOTHING CHANGED" IS NOT ENOUGH ON ITS OWN
 * --------------------------------------------------------------------------------
 * Every assertion below that the criteria did not move is vacuously true of a request that was
 * refused at the door, of a fixture that sent nothing, and of a run that never reached the write.
 * So each case pairs it with a POSITIVE that only a request which went all the way through can
 * produce: exactly one new `project_ratified_action_intent` row, whose `action_digest` this file
 * recomputes from the request it sent. The two together say "the edit arrived, was understood, and
 * was held" rather than "something did not happen".
 *
 * THE DIGEST IS RECOMPUTED, NOT READ BACK
 * ---------------------------------------
 * `expectedActionDigest` below hashes with `node:crypto` directly and builds the digested object
 * out of what THIS FILE sent. It shares no code with the write path except `canonicalJson`, the
 * repo-wide key-sorting helper every digest uses. If the server ever hashed something else — the
 * baseline, the supersession link, a server-invented id — the recomputation stops matching.
 *
 * WHICH SHAPES OF LOOSENING ARE SENDABLE AT ALL
 * ---------------------------------------------
 * Migration 0233 removed `completionCriterion`, `acceptanceCommand`, `acceptanceExpectedExitCode`
 * and `evidenceTaskId` from a project criterion, and `dto.ts` now refuses all four outright, so
 * the classical loosenings (a laxer exit code, a rung down the ladder) cannot be expressed by any
 * caller. What remains sendable is what (1) to (3) below send: DROPPING a criterion, REWORDING one
 * — undecidable in direction, and therefore `WEAKENING` by the safe default — and doing both at
 * once. (4) is the other side of the same call: the two shapes that still land, so that the three
 * holds above are a decision this write path made rather than a write path that cannot write.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-weakening-intent.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { canonicalJson } from './canonical-json';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { classifyCriteriaEdit } from './criteria-edit-classification';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How the criteria say they are to be judged. Restated byte for byte by every edit below. */
const METHOD = 'A person reads the criterion and says whether it holds';

const FIRST = 'a loosening edit does not take effect where it is made';
const SECOND = 'the proposal names the standard set it was composed against';
const THIRD = 'the criterion this fixture deletes, to make the deletion a loosening';
/** Case 2's edit: the same assertion as FIRST, said differently. Direction undecidable. */
const REWORDED = 'an edit that only rewords a criterion is held, because nothing can read its direction';

/** One criterion exactly as `action.request` states it — the shape the digest is taken over. */
interface ProposedCriterion {
  id: string | null;
  ordinal: number;
  text: string;
  verificationMethod: string;
  completionCriterionOverrideReason: string | null;
}

test('a loosening criteria edit changes nothing and files one proposal instead', {
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

  const acceptance = new ProjectAcceptanceService(prisma as unknown as PrismaService);
  const projects = new ProjectsService(prisma as unknown as PrismaService, acceptance);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `weakening-${ownerId}@standard-set.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler cannot loosen itself' },
  });

  /** State the whole collection through the owner's path — the only writer of a definition. */
  async function state(items: Array<{ id?: string; text: string; verificationMethod?: string }>) {
    return projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: item.verificationMethod ?? METHOD,
      })),
    } as never) as Promise<Record<string, unknown>>;
  }

  /** The definitions as the database holds them: the rows the seal is computed from. */
  async function definitions(): Promise<Array<{
    id: string; ordinal: number; revision: number; contentHash: string;
    text: string; verificationMethod: string;
  }>> {
    const { rows } = await sql.query<{
      id: string; ordinal: number; revision: number; content_hash: string;
      text: string; verification_method: string;
    }>(
      `SELECT "id", "ordinal", "revision", "content_hash", "text", "verification_method"
         FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      revision: row.revision,
      contentHash: row.content_hash,
      text: row.text,
      verificationMethod: row.verification_method,
    }));
  }

  /** Every proposal on record for this project, oldest first, read off the table. */
  async function intents(): Promise<Array<{
    id: string;
    effectClass: string;
    actionDigest: string;
    principalType: string;
    triggerKind: string;
    budgetCharge: number;
    commitToken: string;
    contractDigest: string;
    action: {
      request: { kind: string; projectId: string; proposed: ProposedCriterion[] };
      baseline: { seal: string; material: Array<Record<string, unknown>> };
      supersedes: { intentId: string; actionDigest: string; reason: string } | null;
    };
  }>> {
    const { rows } = await sql.query<{
      id: string; effect_class: string; action_digest: string; principal_type: string;
      trigger_kind: string; budget_charge: number; commit_token: string; contract_digest: string;
      action: never;
    }>(
      `SELECT "id", "effect_class", "action_digest", "principal_type", "trigger_kind",
              "budget_charge", "commit_token", "contract_digest", "action"
         FROM "project_ratified_action_intent"
        WHERE "project_id" = $1::uuid ORDER BY "created_at", "id"`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      effectClass: row.effect_class,
      actionDigest: row.action_digest,
      principalType: row.principal_type,
      triggerKind: row.trigger_kind,
      budgetCharge: row.budget_charge,
      commitToken: row.commit_token,
      contractDigest: row.contract_digest,
      action: row.action as never,
    }));
  }

  /** The seal that stands, through the same read path the product's confirmation page uses. */
  async function seal(): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  /**
   * The digest, recomputed from the request rather than read back off the row.
   *
   * Hashed here with `node:crypto` over `canonicalJson`, and over an object this file builds out
   * of what it sent — so this is a second, independent statement of the recipe, and the row has to
   * agree with it.
   */
  function expectedActionDigest(proposed: ProposedCriterion[]): string {
    return createHash('sha256')
      .update(canonicalJson({ kind: 'PROJECT_CRITERIA_WEAKENING', projectId, proposed }))
      .digest('hex');
  }

  /** What the fixture sends, in the two shapes it has to be in: over the wire, and hashed. */
  function retained(row: { id: string; text: string; verificationMethod: string }, ordinal: number) {
    return {
      sent: { id: row.id, text: row.text, verificationMethod: row.verificationMethod },
      digested: {
        id: row.id,
        ordinal,
        text: row.text,
        verificationMethod: row.verificationMethod,
        completionCriterionOverrideReason: null,
      } satisfies ProposedCriterion,
    };
  }

  // ── the fixture: three criteria, stated through the ordinary path ─────────────────────────────
  await state([{ text: FIRST }, { text: SECOND }, { text: THIRD }]);
  const before = await definitions();
  assert.equal(before.length, 3, 'the fixture starts with three criteria');
  const sealBefore = await seal();
  assert.match(sealBefore, /^[0-9a-f]{64}$/);
  assert.deepEqual(await intents(), [], 'and the three ADDITIVE statements above held nothing');

  // ═══ (1) a DELETION is held: nothing moves, and one proposal appears ══════════════════════════

  /** The edit under test: the third criterion dropped, the other two restated byte for byte. */
  const deletion = [retained(before[0], 1), retained(before[1], 2)];
  let firstProposalId = '';

  await t.test('(1) dropping a criterion changes no definition and files one proposal', async () => {
    assert.equal(
      classifyCriteriaEdit(
        before.map((row) => ({
          id: row.id, text: row.text, verificationMethod: row.verificationMethod,
        })),
        deletion.map((item) => item.sent),
      ),
      'WEAKENING',
      'the edit under test has to be the loosening kind, or this file is testing something else',
    );

    const response = await state(deletion.map((item) => item.sent));

    // ── the ruler did not move ──────────────────────────────────────────────────────────────────
    const after = await definitions();
    assert.equal(after.length, 3, 'the criterion the edit dropped is still on record');
    assert.deepEqual(after, before,
      'not one definition row moved: same ids, same text, same revisions, same content hashes');
    assert.deepEqual(after.map((row) => row.text), [FIRST, SECOND, THIRD],
      'the words a reader judges this project by are the words that were there before the edit');
    assert.equal(await seal(), sealBefore,
      'and the standard set therefore still has the identity it had — nothing was re-sealed');

    // ── exactly one proposal, and it is about THIS request ──────────────────────────────────────
    const filed = await intents();
    assert.equal(filed.length, 1, 'exactly one row was added, and it is the proposal');
    const [proposal] = filed;
    firstProposalId = proposal.id;
    assert.equal(proposal.effectClass, 'PROJECT_CRITERIA_WEAKENING');
    assert.equal(proposal.triggerKind, 'MANUAL', 'a criteria edit is somebody asking, not a sweep');
    assert.equal(proposal.principalType, 'OWNER', 'no acting session was on this request');
    assert.equal(proposal.budgetCharge, 0,
      'a held proposal grants no effect, so it must not move the ratified-action budget sum');
    assert.match(proposal.contractDigest, /^[0-9a-f]{64}$/,
      'the BEFORE INSERT trigger accepted it, which means it named the contract that stands');

    assert.equal(
      proposal.actionDigest,
      expectedActionDigest(deletion.map((item) => item.digested)),
      'the digest is recomputable from the request that produced it and from nothing else',
    );
    assert.deepEqual(
      proposal.action.request,
      {
        kind: 'PROJECT_CRITERIA_WEAKENING',
        projectId,
        proposed: deletion.map((item) => item.digested),
      },
      'and the digested object is on the row, so a reader can check the recomputation themselves',
    );

    // ── the proposal names the seal that stood, which is the seal that still stands ─────────────
    assert.equal(proposal.action.baseline.seal, sealBefore,
      'the baseline is the standard set the proposal was composed against');
    assert.equal(proposal.action.supersedes, null, 'it displaced nothing: there was nothing pending');

    // ── the response tells the caller its edit did not happen ───────────────────────────────────
    const held = response.acceptanceCriteriaHold as Record<string, unknown> | undefined;
    assert.ok(held, 'the response carries the proposal, on the very write that was held');
    assert.equal(held.applied, false, 'machine-readably: this edit was NOT applied');
    assert.equal(held.intentId, proposal.id, 'and it is the id of the row that was actually filed');
    assert.equal(held.actionDigest, proposal.actionDigest);
    assert.equal(held.baselineSeal, sealBefore);
    assert.match(String(held.notice), /NOT applied/,
      'the caller is told in words that its edit did not take effect');
    assert.match(String(held.notice), /unchanged/,
      'and that the criteria it is holding are the current ones');
    assert.ok(String(held.notice).includes(proposal.id),
      'the notice names the proposal, so the caller can point at what it filed');

    // The second key is the owner's, and the party proposing a looser ruler does not get it.
    // Serialised whole rather than field by field, so a token that appears anywhere at all — under
    // a name this file never thought to check — still fails this.
    const body = JSON.stringify(response, (_key, value) =>
      (typeof value === 'bigint' ? value.toString() : value));
    assert.match(proposal.commitToken, /^[0-9a-f-]{36}$/, 'the row does hold a commit token');
    assert.equal(body.includes(proposal.commitToken), false,
      'and it is nowhere in the response to the proposer');

    // The criteria in the same response body are the OLD ones — the ones still in force.
    assert.deepEqual(
      (response.acceptanceCriteriaItems as Array<{ text: string }>).map((item) => item.text),
      [FIRST, SECOND, THIRD],
      'the response returns the criteria in force, which are the ones the edit did not replace',
    );
  });

  // ═══ (2) a PURE REWORDING takes the same road ═════════════════════════════════════════════════

  await t.test('(2) rewording a criterion is held too, and displaces the pending proposal', async () => {
    const reword = [
      {
        ...retained(before[0], 1),
        digested: { ...retained(before[0], 1).digested, text: REWORDED },
      },
      retained(before[1], 2),
      retained(before[2], 3),
    ];
    const sent = [
      { id: before[0].id, text: REWORDED, verificationMethod: before[0].verificationMethod },
      reword[1].sent,
      reword[2].sent,
    ];
    assert.equal(
      classifyCriteriaEdit(
        before.map((row) => ({
          id: row.id, text: row.text, verificationMethod: row.verificationMethod,
        })),
        sent,
      ),
      'WEAKENING',
      'a rewriting whose direction cannot be read is WEAKENING by the safe default',
    );

    const response = await state(sent);

    // ── same answer as (1): nothing moved ───────────────────────────────────────────────────────
    assert.deepEqual(await definitions(), before,
      'the reworded criterion still says what it said; no row was rewritten');
    assert.equal(await seal(), sealBefore, 'so the seal is still the one that stood at the start');

    // ── same road as (1): a proposal, recomputable, against the same baseline ────────────────────
    const filed = await intents();
    assert.equal(filed.length, 2, 'this edit filed a proposal of its own rather than landing');
    const proposal = filed[1];
    assert.equal(proposal.effectClass, 'PROJECT_CRITERIA_WEAKENING');
    assert.equal(
      proposal.actionDigest,
      expectedActionDigest(reword.map((item) => item.digested)),
      'recomputable from this request, and different from (1) because the request is different',
    );
    assert.notEqual(proposal.actionDigest, filed[0].actionDigest);
    assert.equal(proposal.action.baseline.seal, sealBefore);
    assert.equal(response.acceptanceCriteriaHold !== undefined, true,
      'and the caller is told, in the same shape as (1)');

    // ── one pending proposal per project: the newer displaces the older, with a reason ──────────
    assert.ok(proposal.action.supersedes, 'the proposal it displaced is named on the row that displaced it');
    assert.equal(proposal.action.supersedes.intentId, firstProposalId);
    assert.equal(proposal.action.supersedes.actionDigest, filed[0].actionDigest,
      'including what the displaced proposal was asking for');
    assert.match(proposal.action.supersedes.reason, /replaced this proposal/,
      'and why it stopped being pending, in words, on the row');
    assert.ok(proposal.action.supersedes.reason.includes(proposal.actionDigest),
      'the reason names what replaced it, so the displacement is checkable and not just asserted');
    assert.equal(
      (response.acceptanceCriteriaHold as Record<string, unknown>).supersededIntentId,
      firstProposalId,
      'the caller is told which proposal its new one took the place of',
    );

    // One key per proposal, and displacing one does not hand its key to the next: `commit_token`
    // is UNIQUE, and the proposal that took over carries its own.
    assert.match(proposal.commitToken, /^[0-9a-f-]{36}$/);
    assert.notEqual(proposal.commitToken, filed[0].commitToken,
      'the displaced proposal\'s one-time key is not reissued to the one that displaced it');

    // Superseded, never rewritten: the displaced row is exactly as it was filed. That is the whole
    // point of putting a proposal on a table whose rows cannot be updated.
    assert.deepEqual(filed[0].action.supersedes, null,
      'the displaced proposal was not edited to say it had been displaced');
    assert.equal(filed[0].actionDigest, expectedActionDigest(deletion.map((item) => item.digested)),
      'and still asks for exactly what it asked for');

    // ── exactly one is pending, and it is the newer one ─────────────────────────────────────────
    const { rows: pending } = await sql.query<{ id: string }>(
      `SELECT i."id" FROM "project_ratified_action_intent" i
        WHERE i."project_id" = $1::uuid
          AND NOT EXISTS (
            SELECT 1 FROM "project_ratified_action_intent" s
             WHERE s."project_id" = i."project_id"
               AND s."action"->'supersedes'->>'intentId' = i."id"::text)`,
      [projectId],
    );
    assert.deepEqual(pending.map((row) => row.id), [proposal.id],
      'a project holds exactly one pending criteria proposal, and it is the newest one');
  });

  // ═══ (3) a criterion the request ADDS has no id yet, and the digest may not invent one ════════

  await t.test('(3) an edit that adds one criterion and drops another is held, and still recomputes', async () => {
    // The one shape in which the digest could stop being recomputable: a criterion the request is
    // ADDING is stored under a uuid the server invents, and a digest taken over that uuid could
    // never be recomputed by the caller who sent the request. It is digested as `id: null` — an
    // addition, not an identity — which is what this case pins down. It is also the classifier's
    // own example of an edit whose addition does not pay for its deletion.
    const ADDED = 'a criterion added by the same edit that drops another one';
    const sent = [
      retained(before[0], 1).sent,
      retained(before[1], 2).sent,
      { text: ADDED, verificationMethod: METHOD },
    ];
    const digested: ProposedCriterion[] = [
      retained(before[0], 1).digested,
      retained(before[1], 2).digested,
      {
        id: null,
        ordinal: 3,
        text: ADDED,
        verificationMethod: METHOD,
        completionCriterionOverrideReason: null,
      },
    ];
    assert.equal(
      classifyCriteriaEdit(
        before.map((row) => ({
          id: row.id, text: row.text, verificationMethod: row.verificationMethod,
        })),
        sent,
      ),
      'WEAKENING',
      'the addition does not pay for the deletion',
    );

    await state(sent);

    assert.deepEqual(await definitions(), before, 'neither the drop nor the addition landed');
    assert.equal(await seal(), sealBefore);
    const filed = await intents();
    assert.equal(filed.length, 3);
    const proposal = filed[2];
    assert.equal(proposal.actionDigest, expectedActionDigest(digested),
      'the digest is over what the request said, so the added criterion is digested with no id');
    assert.equal(proposal.action.request.proposed[2].id, null,
      'and the row shows it: an addition has no identity until it is applied');
    // Every id in the digested request is one the request itself named.
    assert.deepEqual(
      proposal.action.request.proposed.map((item) => item.id),
      [before[0].id, before[1].id, null],
      'no id in the digested request is one the server invented',
    );
  });

  // ═══ (4) the road that DOES land is still open, so the three holds above are a choice ════════

  await t.test('(4) a tightening edit still lands, which is what makes the holds above a choice', async () => {
    const tightened = [
      ...before.map((row, index) => retained(row, index + 1).sent),
      {
        text: 'a fourth criterion, added — which is the ruler getting stricter',
        verificationMethod: METHOD,
      },
    ];
    await state(tightened);

    const after = await definitions();
    assert.equal(after.length, 4, 'the ADDITIVE edit landed through the same method that held (1), (2) and (3)');
    assert.notEqual(await seal(), sealBefore, 'and moved the seal, which the held edits did not');
    assert.equal((await intents()).length, 3, 'while filing no proposal of its own');
  });
});
