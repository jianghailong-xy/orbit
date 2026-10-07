import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderRawQuery } from '../test-support/prisma-transaction-double';
import {
  findMergeCheckApproval,
  MERGE_CHECK_AUDIT_TYPE,
  type MergeCheckApproval,
  mergeCheckAuditPayload,
  mergeCheckProposalKey,
  mergeCheckRequestKey,
  PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
} from './project-integration-approval';
import { ProjectsService } from './projects.service';

/**
 * Unit L5-card — the half of "where a project's work lands" an agent session may now propose.
 *
 * The line is still the owner's alone; the merge check is the one field a session reaches, and it
 * reaches it only through a confirmation card the owner has answered for this project, from this
 * session, for exactly this change. These tests hold both ends of that: the comparison has to be
 * about the PROPOSAL rather than about the card's existence, and the write path has to refuse
 * having written nothing when no card covers it.
 *
 * The database-level half — the same three cases against a real server, with a real approval row —
 * is `project-merge-check-approval.pg.spec.ts`, which needs postgres and runs in CI.
 */

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-7000-8000-000000000002';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000a1';
const SESSION_ID = '00000000-0000-7000-8000-0000000000c1';
const APPROVAL_ID = '00000000-0000-7000-8000-0000000000d1';

/** One ALLOWED card a person answered, as `findMany` returns it. */
function card(input: unknown, over: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID, input, decidedById: OWNER_ID,
    status: 'ALLOWED', toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME, sessionId: SESSION_ID,
    ...over,
  };
}

/** The card the runner files for "make this project's merge check `npm test`". */
function filedCard(proposal: Record<string, unknown>) {
  return card({
    projectId: PROJECT_ID,
    projectTitle: 'Checkout rewrite',
    currentMergeCheckCommand: null,
    ...proposal,
  });
}

// ── What a card authorises, and what it does not ──────────────────────────────────────────────

test('a card covers the exact proposal it was filed for, and nothing else', () => {
  const command = { mergeCheckCommand: 'npm test' };
  const key = mergeCheckRequestKey(PROJECT_ID, command);

  // The same tuple read off a CARD's input (which carries the project it is about) and off a
  // REQUEST (which carries it in the URL) has to come out the same, or nothing would ever match.
  assert.equal(mergeCheckProposalKey({ projectId: PROJECT_ID, ...command }), key);
  assert.equal(
    mergeCheckRequestKey(PROJECT_ID, { mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: 900 }),
    mergeCheckRequestKey(PROJECT_ID, { mergeCheckTimeoutSeconds: 900, mergeCheckCommand: 'npm test' }),
    'key order is not part of what was authorised',
  );
  // The case the whole comparison exists for: a card the owner answered for ONE change is not a
  // standing permission to change the field again.
  assert.notEqual(mergeCheckRequestKey(PROJECT_ID, { mergeCheckCommand: 'npm run e2e' }), key);
  assert.notEqual(mergeCheckRequestKey(PROJECT_ID, { mergeCheckCommand: null }), key,
    'clearing the check is a different change from setting it, and needs its own card');
  // A timeout the caller sent is part of the proposal: "the same command, a longer budget" is a
  // different thing to agree to than the command alone.
  assert.notEqual(
    mergeCheckRequestKey(PROJECT_ID, { mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: 3600 }),
    key,
  );
  // And another project's card is another project's card.
  assert.notEqual(
    mergeCheckRequestKey('00000000-0000-7000-8000-0000000000a2', command),
    key,
  );
});

test('a timeout put back to its default is not the same proposal as leaving it alone', () => {
  // Absent means "leave the column as it is"; null means "return it to the default". Two different
  // writes, so a card for one may not carry the other.
  assert.notEqual(
    mergeCheckRequestKey(PROJECT_ID, { mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: null }),
    mergeCheckRequestKey(PROJECT_ID, { mergeCheckCommand: 'npm test' }),
  );
});

// ── Which cards count ─────────────────────────────────────────────────────────────────────────

/**
 * A prisma stub whose one read is the approval table.
 *
 * It applies the `where` it is given, because that is what the database does with it — otherwise a
 * stub that returned everything would answer every test here with a yes, and the PENDING and DENIED
 * cases (whose whole filtering is the query) would be untestable without postgres. The predicate is
 * three lines over the four columns the `where` names; `project-merge-check-approval.pg.spec.ts`
 * proves the real one.
 */
function matchingApprovals(
  cards: Array<Record<string, unknown>>,
  where: Record<string, any>,
): Array<Record<string, unknown>> {
  return cards.filter((row) =>
    row.sessionId === where.sessionId
    && row.toolName === where.toolName
    && row.status === where.status
    && row.decidedById !== null);
}

function approvalReader(cards: Array<Record<string, unknown>>) {
  const queries: any[] = [];
  return {
    queries,
    prisma: {
      approval: {
        findMany: async (args: any) => {
          queries.push(args);
          return matchingApprovals(cards, args.where);
        },
      },
    } as never,
  };
}

test('only an ALLOWED card a person answered is looked at', async () => {
  const { prisma, queries } = approvalReader([filedCard({ mergeCheckCommand: 'npm test' })]);
  const approval = await findMergeCheckApproval(prisma, {
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    settings: { mergeCheckCommand: 'npm test' },
  });

  assert.deepEqual(approval, { approvalId: APPROVAL_ID, decidedById: OWNER_ID });
  // The refusal of a PENDING card, a DENIED one and an auto-allowed one is the QUERY's, so a
  // standing workspace grant cannot answer a question only the owner may: `decidedById` is set by
  // the human decision route and by nothing else.
  assert.deepEqual(queries[0].where, {
    sessionId: SESSION_ID,
    toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
    status: 'ALLOWED',
    decidedById: { not: null },
  });
});

test('a card for another change, another project, another session or another answer is no card',
  async () => {
    const proposal = { projectId: PROJECT_ID, mergeCheckCommand: 'npm test' };
    const cases: Array<[string, Array<Record<string, unknown>>]> = [
      ['no card at all', []],
      // The owner has not answered it yet, or answered it with a no.
      ['still open', [card(proposal, { status: 'PENDING' })]],
      ['declined', [card(proposal, { status: 'DENIED' })]],
      // The turn ended before anybody answered and the card was collected.
      ['abandoned', [card(proposal, { status: 'ABANDONED' })]],
      // Answered by the server rather than by a person: a workspace's standing rule. The owner
      // never saw this question, so it is not a yes to it.
      ['auto-allowed', [card(proposal, { decidedById: null })]],
      // Filed from another conversation, about another project, or for a different command.
      ['another session', [card(proposal, { sessionId: '00000000-0000-7000-8000-0000000000c2' })]],
      ['another project', [card({
        projectId: '00000000-0000-7000-8000-0000000000a2', mergeCheckCommand: 'npm test',
      })]],
      ['a different change', [filedCard({ mergeCheckCommand: 'npm run e2e' })]],
    ];
    for (const [what, cards] of cases) {
      const { prisma } = approvalReader(cards);
      assert.equal(await findMergeCheckApproval(prisma, {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        settings: { mergeCheckCommand: 'npm test' },
      }), null, what);
    }
  });

// ── What the write records ───────────────────────────────────────────────────────────────────

test('the provenance names the card, who answered it, and whose session asked', () => {
  const approval: MergeCheckApproval = { approvalId: APPROVAL_ID, decidedById: OWNER_ID };
  assert.deepEqual(mergeCheckAuditPayload({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    approval,
    settings: { mergeCheckCommand: 'npm test', ignored: 'not part of the change' },
  }), {
    projectId: PROJECT_ID,
    approvalId: APPROVAL_ID,
    approvedByUserId: OWNER_ID,
    requestedBySessionId: SESSION_ID,
    mergeCheckCommand: 'npm test',
  });
});

// ── The write path, all the way down ────────────────────────────────────────────────────────

/**
 * A project with one binding, and a prisma good enough for `ProjectsService.update`.
 *
 * `$queryRaw` answers the two raw reads the write makes — the project row it locks, and the
 * binding it locks under it — by the table each names, because a single answer for both would be a
 * test of the fixture rather than of the code.
 */
function fakePrisma(input: { cards?: Array<Record<string, unknown>>; repository?: string | null } = {}) {
  const activity: any[] = [];
  const codebaseWrites: any[] = [];
  const projectWrites: any[] = [];
  let opened = false;
  const prisma: any = {
    project: {
      findFirst: async () => ({ id: PROJECT_ID, coordinatorSessionId: null }),
      findUniqueOrThrow: async () => ({ exceptionEscalationSeconds: 7200 }),
      update: async (args: any) => {
        projectWrites.push(args.data);
        return {
          id: PROJECT_ID, status: 'OPEN', configRevision: 0n, updatedAt: new Date(),
          acceptanceCriterionDefinitions: [], members: [], runtime: { coordinatorGeneration: 0n },
        };
      },
    },
    projectCodebase: {
      update: async (args: any) => {
        codebaseWrites.push(args.data);
        return {
          id: 'codebase-1', upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main',
          integrationRefSource: 'DEFAULT_RULE', integrationStartedAt: null,
          mergeCheckCommand: null, mergeCheckTimeoutSeconds: null, ...args.data,
        };
      },
      createMany: async () => {
        assert.fail('this project already has a binding; the fixture never binds one');
      },
    },
    approval: {
      findMany: async (args: any) => matchingApprovals(input.cards ?? [], args.where),
    },
    activity: { create: async (args: any) => { activity.push(args.data); } },
    // Rendered through the shared helper rather than picked apart here: `$queryRaw` takes two
    // calling conventions and a double that parses them itself drifts from one to the other
    // (`test-support/transaction-double-surface.spec.ts` fails the build when one does).
    $queryRaw: async (...args: unknown[]) => {
      const { text: sql } = renderRawQuery(args);
      if (sql.includes('"project_codebase"')) {
        return input.repository === null ? [] : [{
          id: 'codebase-1', upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main',
          integrationRefSource: 'DEFAULT_RULE', integrationStartedAt: null,
          mergeCheckCommand: null, mergeCheckTimeoutSeconds: null,
        }];
      }
      // Named, not guessed: an unexpected raw read answered with a project row would fail
      // somewhere else entirely.
      if (!sql.includes('FROM "project"')) throw new Error(`unexpected raw query: ${sql}`);
      return [{
        config_revision: 0n, status: 'OPEN', coordinator_session_id: null,
        coordinator_enabled: false, started_at: null, paused_at: null, paused_reason: null,
      }];
    },
  };
  prisma.$transaction = async (fn: any) => {
    opened = true;
    return fn(prisma);
  };
  return {
    prisma,
    activity,
    codebaseWrites,
    projectWrites,
    opened: () => opened,
  };
}

function isRefusedByTheOwnerRule(error: unknown): boolean {
  const response = (error as { getResponse?: () => { code?: string } }).getResponse?.();
  assert.equal((error as { getStatus?: () => number }).getStatus?.(), 403, String(error));
  assert.equal(response?.code, 'INTEGRATION_SETTINGS_OWNER_ONLY', String(error));
  return true;
}

/** The merge check a binding write carried, which is the part of it the card is about. */
const mergeCheckOf = (writes: any[]) =>
  writes.map((data) => ({
    mergeCheckCommand: data.mergeCheckCommand,
    mergeCheckTimeoutSeconds: data.mergeCheckTimeoutSeconds,
  }));

test('a session with the owner’s card on this exact change writes the merge check', async () => {
  const f = fakePrisma({ cards: [filedCard({ mergeCheckCommand: 'npm test' })] });

  await new ProjectsService(f.prisma, {} as never).update(
    OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'npm test' } } as never, SESSION_ID,
  );

  assert.deepEqual(mergeCheckOf(f.codebaseWrites),
    [{ mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: undefined }],
    'the merge check the card authorised is the merge check that was written');
  assert.equal(f.activity.length, 1, 'the write records which card let it through');
  assert.deepEqual(f.activity[0], {
    actorId: OWNER_ID,
    type: MERGE_CHECK_AUDIT_TYPE,
    payload: {
      projectId: PROJECT_ID,
      approvalId: APPROVAL_ID,
      approvedByUserId: OWNER_ID,
      requestedBySessionId: SESSION_ID,
      mergeCheckCommand: 'npm test',
    },
  });
});

test('no card, or a card for something else, is still INTEGRATION_SETTINGS_OWNER_ONLY', async () => {
  const cases: Array<[string, Array<Record<string, unknown>>]> = [
    ['no card at all', []],
    ['a card the owner declined', [card({ projectId: PROJECT_ID, mergeCheckCommand: 'npm test' },
      { status: 'DENIED' })]],
    ['a card nobody has answered', [card({ projectId: PROJECT_ID, mergeCheckCommand: 'npm test' },
      { status: 'PENDING' })]],
    ['a card for another change', [filedCard({ mergeCheckCommand: 'npm run e2e' })]],
    ['a card for another project', [card({
      projectId: '00000000-0000-7000-8000-0000000000a2', mergeCheckCommand: 'npm test',
    })]],
    ['a card nobody answered', [card(
      { projectId: PROJECT_ID, mergeCheckCommand: 'npm test' }, { decidedById: null },
    )]],
  ];
  for (const [what, cards] of cases) {
    const f = fakePrisma({ cards });
    await assert.rejects(
      () => new ProjectsService(f.prisma, {} as never).update(
        OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'npm test' } } as never, SESSION_ID,
      ),
      isRefusedByTheOwnerRule,
      what,
    );
    // Refused BEFORE the transaction, so the request writes nothing at all: no merge check, no
    // activity row, and not the rest of the fields the same request carried.
    assert.equal(f.opened(), false, what);
    assert.deepEqual(f.codebaseWrites, [], what);
    assert.deepEqual(f.activity, [], what);
  }
});

test('an old card is not a licence to write a different value later', async () => {
  // The card exists, is ALLOWED and was answered by the owner — and it is about `npm test`, so the
  // second change this session tries to slip through on it is refused. This is the case the whole
  // proposal comparison exists for.
  const f = fakePrisma({ cards: [filedCard({ mergeCheckCommand: 'npm test' })] });
  const service = new ProjectsService(f.prisma, {} as never);

  await service.update(
    OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'npm test' } } as never, SESSION_ID,
  );
  await assert.rejects(
    () => service.update(
      OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'rm -rf /' } } as never, SESSION_ID,
    ),
    isRefusedByTheOwnerRule,
  );
  assert.deepEqual(mergeCheckOf(f.codebaseWrites),
    [{ mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: undefined }],
    'the second write never reached the binding');
  assert.equal(f.activity.length, 1, 'and recorded no provenance for a write that did not happen');
});

test('the line is refused whether or not a card covers the request', async () => {
  const cards = [filedCard({ mergeCheckCommand: 'npm test' })];
  for (const integration of [
    { line: 'MAIN' },
    { projectBranchName: 'refs/heads/project/next' },
    { upstreamRef: 'refs/heads/trunk' },
    // A line field beside the merge check the card DOES cover: the line is refused, and with it
    // the whole request, so a card can never be a way of moving a project's line a field at a time.
    { line: 'MAIN', mergeCheckCommand: 'npm test' },
    // Anything else in the object, fail-closed: a field added later is owner-only until somebody
    // deliberately gives it a card.
    { exceptionEscalationSeconds: 3600 },
  ]) {
    const f = fakePrisma({ cards });
    await assert.rejects(
      () => new ProjectsService(f.prisma, {} as never).update(
        OWNER_ID, PROJECT_ID, { integration } as never, SESSION_ID,
      ),
      isRefusedByTheOwnerRule,
      JSON.stringify(integration),
    );
    assert.equal(f.opened(), false, JSON.stringify(integration));
  }
});

test('with no acting session the merge check is the owner’s own write, card or no card', async () => {
  const f = fakePrisma();
  await new ProjectsService(f.prisma, {} as never).update(
    OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'npm test', line: 'MAIN' } } as never,
  );

  assert.deepEqual(mergeCheckOf(f.codebaseWrites),
    [{ mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: undefined }]);
  assert.deepEqual(f.activity, [],
    'no card was answered, so there is no provenance to record — the owner wrote it themselves');
  assert.equal(f.projectWrites.length, 1);
});

test('another owner’s project is a 404 before any card is read', async () => {
  const f = fakePrisma({ cards: [filedCard({ mergeCheckCommand: 'npm test' })] });
  f.prisma.project.findFirst = async () => null;

  await assert.rejects(
    () => new ProjectsService(f.prisma, {} as never).update(
      OTHER_USER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'npm test' } } as never, SESSION_ID,
    ),
    /project not found/,
  );
});
