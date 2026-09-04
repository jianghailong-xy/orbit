/**
 * The completion-evidence envelope, against real PostgreSQL.
 *
 * Four inputs, because those are the four answers the envelope exists to separate:
 *
 *  - an envelope whose citations resolve to NOTHING is refused. "I did the work" with no handle
 *    is a report, and the whole point of the citation layer is that a report cannot pass as
 *    evidence;
 *  - an envelope citing another task's row is refused, and refused DIFFERENTLY: it resolved, just
 *    not here, and telling a submitter "nothing matched" when the truth is "that is not yours"
 *    sends them looking for a typo;
 *  - a declared command that is not what the cited `tool_call` ran is refused, byte for byte;
 *  - a legal submission comes back with its revision AND with what each citation resolved to, so
 *    the submitter learns whether the handles held instead of inferring it from silence.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const CRITERION_TEXT = 'task_evidence_submit refuses an envelope whose citations resolve to nothing';
const GREEN_COMMAND = 'npm run test:outcome-reconciler:fast-gate';
const CHECKPOINT_SHA = '4d1f0b6c2a8e77935cc0a1b2d3e4f50617283940';
const ARTIFACT_REF = 'git-bundle://orbit/evidence-envelope/4d1f0b6c.bundle';
const MERGED_SHA = 'a0b1c2d3e4f5061728394a5b6c7d8e9f01234567';

async function empty(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "task", "session", "project", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * One owner, two tasks, and every kind of row the envelope is allowed to cite.
 *
 * The subject task gets a green tool call, a failed one, an accepted checkpoint (which carries
 * both a commit and a portable artifact) and a landed merge receipt. The second task gets a tool
 * call of its own, which is the row the cross-task input cites.
 */
async function fixture(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const otherTaskId = randomUUID();
  const otherSessionId = randomUUID();
  const criterionId = randomUUID();

  await db.user.create({
    data: { id: ownerId, email: `envelope-${ownerId}@invalid.test`, name: 'Envelope', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'envelope-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'envelope-workspace', enabled: true },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: 'evidence envelope and citation checking' },
  });
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId,
      ordinal: 1,
      text: CRITERION_TEXT,
      verificationMethod: 'the pg spec asserts the refusal code and requiredAction',
      // Written by the definition's own BEFORE trigger; the placeholder only has to satisfy the
      // column's 64-hex CHECK on the way in.
      contentHash: '0'.repeat(64),
    },
  });

  for (const [id, title] of [[taskId, 'submit evidence with handles'], [otherTaskId, 'a neighbour task']] as const) {
    await db.task.create({
      data: {
        id,
        ownerId,
        projectId,
        title,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        assigneeId: workspaceId,
        status: TaskStatus.IN_PROGRESS,
        acceptanceCriteria: 'the envelope resolves at least one citation',
      },
    });
  }
  for (const [id, taskFor, title] of [
    [sessionId, taskId, 'evidence source'],
    [otherSessionId, otherTaskId, 'neighbour source'],
  ] as const) {
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId: taskFor,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: 'run the task',
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
  }

  await db.toolCall.createMany({
    data: [
      {
        sessionId,
        name: 'Bash',
        toolUseId: 'toolu_green',
        input: { command: GREEN_COMMAND, description: 'run the fast gate' },
        isError: false,
      },
      {
        sessionId,
        name: 'Bash',
        toolUseId: 'toolu_red',
        input: { command: 'npm run build', description: 'build' },
        isError: true,
      },
      {
        sessionId: otherSessionId,
        name: 'Bash',
        toolUseId: 'toolu_neighbour',
        input: { command: 'npm test', description: 'the neighbour task ran this' },
        isError: false,
      },
    ],
  });

  // Recorded before the scope revision below, exactly as it happens in life: a merge receipt with
  // no checkpoint behind it is refused once the task is checkpoint-managed (§7 CP3), and this task
  // becomes managed the moment a scope revision at its current revision exists.
  await db.sessionMergeReceipt.create({
    data: {
      id: randomUUID(),
      ownerId,
      sessionId,
      taskId,
      projectId,
      result: 'MERGED',
      sourceBranch: 'orbit/session-envelope',
      sourceSha: MERGED_SHA,
      targetBranch: 'main',
      targetShaBefore: 'b'.repeat(40),
      targetShaAfter: 'c'.repeat(40),
      recordedBy: 'RUNNER',
      idempotencyKey: 'envelope-merge-1',
    },
  });
  await db.taskScopeRevision.create({
    data: {
      id: randomUUID(),
      taskId,
      ownerId,
      revision: 1,
      scopeHash: 'd'.repeat(64),
      title: 'submit evidence with handles',
      reason: 'fixture',
    },
  });
  await db.taskCheckpoint.create({
    data: {
      id: randomUUID(),
      taskId,
      ownerId,
      projectId,
      seq: 1n,
      scopeRevision: 1,
      scopeHash: 'd'.repeat(64),
      kind: 'WIP_RED',
      branch: 'orbit/session-envelope',
      commitSha: CHECKPOINT_SHA,
      treeSha: 'e'.repeat(40),
      baseSha: 'f'.repeat(40),
      artifactKind: 'GIT_BUNDLE',
      artifactRef: ARTIFACT_REF,
      artifactDigest: '1'.repeat(64),
      contentDigest: '2'.repeat(64),
      dedupKey: `envelope-checkpoint-${taskId}`,
      recordedBy: 'WORKER',
      sessionId,
    },
  });

  return { ownerId, workspaceId, projectId, taskId, sessionId, otherTaskId, otherSessionId, criterionId };
}

/** A submittable envelope. Every call below names the criterion key, which is only known once
 * the fixture has been created, so the default here is a placeholder rather than a usable key. */
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    claim: 'the fast gate passed on this branch',
    criterion: { key: 'replaced-by-every-caller', text: CRITERION_TEXT },
    checks: [{ kind: 'TOOL_CALL', ref: 'toolu_green', command: GREEN_COMMAND, succeeded: true }],
    gaps: ['the full-api suite was not run in this session'],
    ...overrides,
  };
}

/**
 * The receipt, as a reader of it sees it.
 *
 * Structural and with both receipt fields OPTIONAL on purpose: this spec has to be able to run —
 * and fail — against a build that does not echo them yet. Asserting their presence through the
 * response TYPE would turn a missing behaviour into a compile error, which stops every other spec
 * in the suite and proves nothing about this one. So the witness is the value at run time.
 */
interface EvidenceReceiptView {
  id: string;
  revision: string;
  evidence: Record<string, unknown>;
  citations?: { kind: string; ref: string; resolved: boolean; reason: string | null }[] | null;
  criterionMatch?: { key: string; text: string; matchesLive: boolean } | null;
}

/** A refusal is only useful if the submitter can act on it, so both halves are asserted. */
async function refusal(promise: Promise<unknown>, code: string, requiredAction: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BadRequestException, `expected a BadRequestException, got ${error}`);
    const body = error.getResponse() as { code?: string; requiredAction?: string };
    assert.equal(body.code, code);
    assert.equal(body.requiredAction, requiredAction);
    return true;
  });
}

suite('the evidence envelope is checked against rows, and the receipt says what resolved', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);
  const f = await fixture(db);
  const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);
  const actor = { type: CreatorType.AGENT, id: f.workspaceId };
  // The key a reader is given for a stated criterion is the definition row's public id
  // (`criterionKeyOf`), which is what an envelope has to name.
  const key = uuidToBase62(f.criterionId);
  const submit = async (evidence: unknown, idempotencyKey: string): Promise<EvidenceReceiptView> => (
    service.submit(
      f.ownerId,
      f.taskId,
      actor,
      { sourceSessionId: f.sessionId, evidence: evidence as Record<string, unknown>, idempotencyKey },
    )
  );

  // Layer 1. Types and presence, and nothing beyond the four fields: a fifth key would be a field
  // no card renders and no reader is told about.
  await t.test('shape: four fields, of the stated types, and no fifth', async () => {
    await refusal(
      submit({ claim: 'it passed', criterion: { key, text: CRITERION_TEXT }, checks: [] }, 'shape-1'),
      'EVIDENCE_ENVELOPE_INVALID',
      'SUBMIT_THE_FOUR_FIELD_ENVELOPE',
    );
    await refusal(
      submit({ ...envelope({ criterion: { key, text: CRITERION_TEXT } }), notes: 'extra' }, 'shape-2'),
      'EVIDENCE_ENVELOPE_INVALID',
      'SUBMIT_THE_FOUR_FIELD_ENVELOPE',
    );
    await refusal(
      submit(envelope({
        criterion: { key, text: CRITERION_TEXT },
        checks: [{ kind: 'COMMIT', ref: CHECKPOINT_SHA, command: GREEN_COMMAND }],
      }), 'shape-3'),
      'EVIDENCE_ENVELOPE_INVALID',
      'SUBMIT_THE_FOUR_FIELD_ENVELOPE',
    );
  });

  await t.test('input 1: an envelope nothing can be checked against is refused', async () => {
    await refusal(
      submit(envelope({
        criterion: { key, text: CRITERION_TEXT },
        checks: [{ kind: 'TOOL_CALL', ref: 'toolu_never_happened' }],
      }), 'unresolvable'),
      'EVIDENCE_NO_RESOLVABLE_CITATION',
      'CITE_THIS_TASKS_OWN_ROWS',
    );
    // Citing nothing at all is the same fact said more briefly, and gets the same answer.
    await refusal(
      submit(envelope({ criterion: { key, text: CRITERION_TEXT }, checks: [] }), 'empty-checks'),
      'EVIDENCE_NO_RESOLVABLE_CITATION',
      'CITE_THIS_TASKS_OWN_ROWS',
    );
  });

  await t.test('input 2: a row that exists under another task is refused as out of scope', async () => {
    await refusal(
      submit(envelope({
        criterion: { key, text: CRITERION_TEXT },
        checks: [{ kind: 'TOOL_CALL', ref: 'toolu_neighbour', command: 'npm test' }],
      }), 'cross-task'),
      'EVIDENCE_CITATION_OUT_OF_SCOPE',
      'CITE_THIS_TASKS_OWN_ROWS',
    );
  });

  await t.test('input 3: the declaration must match the cited tool call', async () => {
    // Byte for byte: one trailing space is a different command.
    await refusal(
      submit(envelope({
        criterion: { key, text: CRITERION_TEXT },
        checks: [{ kind: 'TOOL_CALL', ref: 'toolu_green', command: `${GREEN_COMMAND} ` }],
      }), 'command-mismatch'),
      'EVIDENCE_CITATION_COMMAND_MISMATCH',
      'QUOTE_THE_CITED_COMMAND_EXACTLY',
    );
    // The same layer's other half. `tool_call` has no exit-code column, so `isError` is the only
    // outcome there is to contradict — and declaring success over it is contradicting it.
    await refusal(
      submit(envelope({
        criterion: { key, text: CRITERION_TEXT },
        checks: [{ kind: 'TOOL_CALL', ref: 'toolu_red', command: 'npm run build', succeeded: true }],
      }), 'contradicts-result'),
      'EVIDENCE_CITATION_CONTRADICTS_TOOL_RESULT',
      'DO_NOT_CLAIM_SUCCESS_OVER_A_FAILED_TOOL_CALL',
    );
  });

  await t.test('a refused envelope writes no revision at all', async () => {
    assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 0);
  });

  // Input 4. Every kind has a resolver, so every kind is cited here — and one citation
  // deliberately resolves to nothing, because a `resolved` that is always true would tell the
  // submitter nothing.
  const cited = [
    { kind: 'TOOL_CALL', ref: 'toolu_green', command: GREEN_COMMAND, succeeded: true },
    { kind: 'COMMIT', ref: CHECKPOINT_SHA },
    { kind: 'COMMIT', ref: MERGED_SHA },
    { kind: 'ARTIFACT', ref: ARTIFACT_REF },
    { kind: 'ARTIFACT', ref: 'git-bundle://nowhere.bundle' },
  ];
  await t.test('input 4: a legal submission returns its revision and every citation', async () => {
    const accepted = await submit(
      envelope({ criterion: { key, text: CRITERION_TEXT }, checks: cited }),
      'accepted-1',
    );
    assert.equal(accepted.revision, '1');
    assert.deepEqual(
      accepted.citations?.map((citation) => [citation.kind, citation.ref, citation.resolved]),
      [
        ['TOOL_CALL', 'toolu_green', true],
        ['COMMIT', CHECKPOINT_SHA, true],
        ['COMMIT', MERGED_SHA, true],
        ['ARTIFACT', ARTIFACT_REF, true],
        ['ARTIFACT', 'git-bundle://nowhere.bundle', false],
      ],
    );
    assert.equal(accepted.citations?.[0].reason, null);
    assert.equal(typeof accepted.citations?.at(-1)?.reason, 'string', 'an unresolved citation says why');
    assert.deepEqual(accepted.criterionMatch, { key, text: CRITERION_TEXT, matchesLive: true });

    // A replay is answered with the same receipt, not with a bare row: the retry that never saw
    // the first answer is exactly the caller who still needs to be told what resolved.
    const replay = await submit(
      envelope({ criterion: { key, text: CRITERION_TEXT }, checks: cited }),
      'accepted-1',
    );
    assert.equal(replay.id, accepted.id);
    assert.equal(replay.citations?.length, 5);
  });

  await t.test('a stale or unknown criterion is reported, never refused', async () => {
    // Editing a project's criteria must not retroactively invalidate evidence that was true when
    // it was written, so this lane reports and the citation lane refuses.
    const stale = await submit(envelope({
      claim: 'the fast gate passed, quoting wording that has since moved',
      criterion: { key, text: 'wording this project no longer uses' },
    }), 'stale-criterion');
    assert.equal(stale.revision, '2');
    assert.equal(stale.criterionMatch?.matchesLive, false);
    const unknownKey = await submit(envelope({
      claim: 'the fast gate passed, naming a criterion this project does not have',
      criterion: { key: 'notacriterionkey', text: CRITERION_TEXT },
    }), 'unknown-criterion');
    assert.equal(unknownKey.criterionMatch?.matchesLive, false);
  });

  await t.test('the ledger stores the envelope and re-derives no citation', async () => {
    // Which rows a citation resolved to is a fact about the moment it was submitted; the rows it
    // named may have been deleted since, and a `resolved` that quietly meant "as of now" would be
    // a different fact under the same name.
    const ledger: EvidenceReceiptView[] = await service.list(f.ownerId, f.taskId);
    assert.deepEqual(ledger.map((row) => row.revision), ['1', '2', '3']);
    assert.equal(ledger[0].citations, null);
    assert.equal(ledger[0].criterionMatch, null);
    assert.equal((ledger[0].evidence as { checks: unknown[] }).checks.length, 5);
    assert.equal((ledger[0].evidence as { claim: string }).claim, 'the fast gate passed on this branch');
  });
});
