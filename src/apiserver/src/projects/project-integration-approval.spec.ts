import assert from 'node:assert/strict';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';

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
const OTHER_PROJECT_ID = '00000000-0000-7000-8000-0000000000a2';
const SESSION_ID = '00000000-0000-7000-8000-0000000000c1';
const APPROVAL_ID = '00000000-0000-7000-8000-0000000000d1';

/**
 * The same projects, spelled the way the CALLER spells them.
 *
 * This is not a decoration: it is the spelling that reaches the card in production. `project_update`
 * tells the agent its `projectId` is "the project as shown in its web UI URL (/projects/<id>)", the
 * runner puts that string on the card unchanged, and the route that performs the write has already
 * decoded it to the uuid (`PublicIdPipe`) — so a comparison over the two as-written strings can
 * never match, which is a card the owner answered that authorises nothing.
 */
const PUBLIC_PROJECT_ID = uuidToBase62(PROJECT_ID);
const OTHER_PUBLIC_PROJECT_ID = uuidToBase62(OTHER_PROJECT_ID);

/** One ALLOWED card a person answered, as `findMany` returns it. */
function card(input: unknown, over: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID, input, decidedById: OWNER_ID,
    status: 'ALLOWED', toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME, sessionId: SESSION_ID,
    ...over,
  };
}

/** The card the runner files for "make this project's merge check `npm test`". `projectId` is what
 *  the caller wrote — the uuid by default, and the public id a real `project_update` carries in
 *  every case that is about that spelling. */
function filedCard(proposal: Record<string, unknown>, projectId: string = PROJECT_ID) {
  return card({
    projectId,
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
  assert.notEqual(mergeCheckRequestKey(OTHER_PROJECT_ID, command), key);
});

test('the project is compared as a project, not as a spelling of its id', () => {
  const command = { mergeCheckCommand: 'npm test' };

  // THE REAL PATH, and the one that was broken. The card carries the id the CALLER wrote — the
  // runner files it with the string the agent passed to `project_update`, which the tool tells the
  // agent is the id in the project's web UI URL — while the request carries the uuid the route
  // decoded that id to. Same project, same change, one spelling on each side, and it has to match:
  // otherwise every card the runner files is a question the owner answers that authorises nothing.
  assert.equal(
    mergeCheckProposalKey({ projectId: PUBLIC_PROJECT_ID, ...command }),
    mergeCheckRequestKey(PROJECT_ID, command),
  );
  // Either side may be handed either spelling — no caller has to know which one the other used.
  assert.equal(
    mergeCheckRequestKey(PUBLIC_PROJECT_ID, command),
    mergeCheckRequestKey(PROJECT_ID, command),
  );
  assert.equal(
    mergeCheckProposalKey({ projectId: PROJECT_ID, ...command }),
    mergeCheckProposalKey({ projectId: PUBLIC_PROJECT_ID, ...command }),
  );
  // Resolving the id does not make the key blind to WHICH project it names: another project, in
  // either spelling, is still another project.
  assert.notEqual(
    mergeCheckProposalKey({ projectId: OTHER_PUBLIC_PROJECT_ID, ...command }),
    mergeCheckRequestKey(PROJECT_ID, command),
  );
  assert.notEqual(
    mergeCheckProposalKey({ projectId: OTHER_PROJECT_ID, ...command }),
    mergeCheckRequestKey(PUBLIC_PROJECT_ID, command),
  );
  // And an id that resolves to neither spelling is kept as written rather than quietly dropped,
  // so a card naming something undecodable covers nothing — fail-closed, not lenient.
  assert.notEqual(
    mergeCheckProposalKey({ projectId: 'not-an-id', ...command }),
    mergeCheckRequestKey(PROJECT_ID, command),
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
      ['another project', [card({ projectId: OTHER_PROJECT_ID, mergeCheckCommand: 'npm test' })]],
      // Another project again, spelled the way a caller spells it. Resolving the id must not turn
      // "this card is about a different project" into a match.
      ['another project, as a public id', [card({
        projectId: OTHER_PUBLIC_PROJECT_ID, mergeCheckCommand: 'npm test',
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

test('the card the RUNNER files — projectId as the public id the caller wrote — is found', async () => {
  // A real card is filed by `runner-go/mcp.go`'s `projectMergeCheckCard`, which writes the string
  // the agent passed straight through — and the agent was told, by the tool's own description, to
  // pass the id in the project's web UI URL. So this is the spelling the owner's card actually
  // carries, and the one the gate was blind to while every case spelled the project the internal
  // way on both sides.
  const { prisma } = approvalReader([filedCard({ mergeCheckCommand: 'npm test' }, PUBLIC_PROJECT_ID)]);

  assert.deepEqual(
    await findMergeCheckApproval(prisma, {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      settings: { mergeCheckCommand: 'npm test' },
    }),
    { approvalId: APPROVAL_ID, decidedById: OWNER_ID },
  );
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

test('the card the runner files — the caller’s public id on it — writes the merge check', async () => {
  // The same write as above, through the card a REAL call files. `project_update` tells the agent
  // its `projectId` is the id in the project's web UI URL; `runner-go/mcp.go` puts that string on
  // the card unchanged; the route performing the write has already decoded it to the uuid. Before
  // the key resolved the id, this — the only card any real call ever files — covered nothing, so
  // the owner could answer the question and the change was still refused.
  const f = fakePrisma({ cards: [filedCard({ mergeCheckCommand: 'npm test' }, PUBLIC_PROJECT_ID)] });

  await new ProjectsService(f.prisma, {} as never).update(
    OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'npm test' } } as never, SESSION_ID,
  );

  assert.deepEqual(mergeCheckOf(f.codebaseWrites),
    [{ mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: undefined }],
    'the merge check the card authorised is the merge check that was written');
  assert.equal(f.activity.length, 1, 'the write records which card let it through');
  // The provenance records the project the write is about, in the spelling the rest of the ledger
  // uses — the resolved uuid — not the spelling the card happened to carry.
  assert.deepEqual((f.activity[0] as { payload: Record<string, unknown> }).payload, {
    projectId: PROJECT_ID,
    approvalId: APPROVAL_ID,
    approvedByUserId: OWNER_ID,
    requestedBySessionId: SESSION_ID,
    mergeCheckCommand: 'npm test',
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
    ['a card for another project', [card({ projectId: OTHER_PROJECT_ID, mergeCheckCommand: 'npm test' })]],
    ['a card nobody answered', [card(
      { projectId: PROJECT_ID, mergeCheckCommand: 'npm test' }, { decidedById: null },
    )]],
    // The same refusals again through the spelling a real card carries, so the fix that lets the
    // runner's card through cannot also let these through: resolving the id makes the comparison
    // land on WHICH project a card is about, and these are about a different one, a different
    // change, or nobody's answer.
    ['another change, card filed as a public id', [
      filedCard({ mergeCheckCommand: 'npm run e2e' }, PUBLIC_PROJECT_ID)]],
    ['another project, card filed as a public id', [card({
      projectId: OTHER_PUBLIC_PROJECT_ID, mergeCheckCommand: 'npm test',
    })]],
    ['declined, card filed as a public id', [card(
      { projectId: PUBLIC_PROJECT_ID, mergeCheckCommand: 'npm test' }, { status: 'DENIED' })]],
    ['unanswered, card filed as a public id', [card(
      { projectId: PUBLIC_PROJECT_ID, mergeCheckCommand: 'npm test' }, { status: 'PENDING' })]],
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
  //
  // Asserted for both spellings of the project, and the public-id one is the load-bearing half:
  // letting the runner's card through is only correct while it stays a yes to THAT change and not
  // a standing permission, and the runner's card is the one written with a public id.
  for (const projectId of [PROJECT_ID, PUBLIC_PROJECT_ID]) {
    const f = fakePrisma({ cards: [filedCard({ mergeCheckCommand: 'npm test' }, projectId)] });
    const service = new ProjectsService(f.prisma, {} as never);

    await service.update(
      OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'npm test' } } as never, SESSION_ID,
    );
    await assert.rejects(
      () => service.update(
        OWNER_ID, PROJECT_ID, { integration: { mergeCheckCommand: 'rm -rf /' } } as never, SESSION_ID,
      ),
      isRefusedByTheOwnerRule,
      projectId,
    );
    assert.deepEqual(mergeCheckOf(f.codebaseWrites),
      [{ mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: undefined }],
      `the second write never reached the binding (card filed as ${projectId})`);
    assert.equal(f.activity.length, 1, 'and recorded no provenance for a write that did not happen');
  }
});

test('the line is refused whether or not a card covers the request', async () => {
  // The card a real call files, spelled as the runner writes it: so what this proves is that the
  // card a session actually holds is not a way in for the line either.
  const cards = [filedCard({ mergeCheckCommand: 'npm test' }, PUBLIC_PROJECT_ID)];
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
