import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { CoordinatorDeliveryCard } from '@orbit/shared';

import { withCoordinatorDelivery } from '../runner-api/control-plane-note';
import { completionEvidenceRevisedFact } from './completion-input';
import { coordinatorDeliveryCardOf, readCoordinatorDeliveryCards } from './coordinator-delivery-card';
import { acceptanceLandedReadingOf, buildCoordinatorDeliveryMessage } from './coordinator-judgment-opening';
import {
  type WakeFact,
  attemptEndedUnsettledFact,
  criterionUnlandedFact,
  dependentReadyFact,
  projectAcceptanceLandedFact,
  projectBlockerRaisedFact,
  projectSettledUnmergedFact,
  projectTasksSettledFact,
  taskDispatchRefusedFact,
  taskRunStoppedFact,
} from './coordinator-wake';
import {
  criteriaDecisionReplyIntentOf,
  criteriaDecisionReplyMessage,
  criteriaDecisionReplyTurnId,
} from './criteria-decision-reply';
import { criterionKeyOf, standardSetConfirmationStanding } from './project-acceptance';
import { derivedUuid } from './project-dispatch-identity';
import { deriveProjectDone, type DerivedProjectDoneReading } from './project-done-derived';

/**
 * A delivery's card is read off its wake (`coordinatorDeliveryCardOf`): the event and the `detail` the
 * fact was claimed with, and the moment the wake was bound — and, for a project whose criteria have
 * all landed, which reading the words were written in. The rows behind the card, and both carriers,
 * are coordinator-delivery-turn-card.pg.spec.ts's. Each fact here is built by the function that builds
 * it in production, with what its producer adds to `detail` before the claim.
 */

const PROJECT = randomUUID();
const TASK = randomUUID();
const BOUND = new Date('2026-10-31T11:30:00.000Z');

/** The wake a delivered fact leaves: its event, its subject and its `detail`, bound at `BOUND`. */
const wakeOf = (fact: WakeFact) => ({
  event: fact.event, subjectId: fact.subjectId, detail: fact.detail ?? {}, updatedAt: BOUND,
});

const card = (over: Partial<CoordinatorDeliveryCard> & Pick<CoordinatorDeliveryCard, 'kind'>): CoordinatorDeliveryCard => ({
  task: null, revision: null, count: null, deliveredAt: BOUND.toISOString(), toCoordinator: true, ...over,
});

const evidence = (movedFromProjectId?: string): WakeFact => {
  const fact = completionEvidenceRevisedFact({
    projectId: PROJECT, taskId: TASK, revision: '2', criterionRevision: '1', evidenceDigest: 'e'.repeat(64),
    ...(movedFromProjectId ? { movedFromProjectId } : {}),
  });
  // What `CompletionEvidenceProducer.decidedByCoordinator` adds before the fact is claimed and queued.
  return { ...fact, detail: { ...fact.detail, title: 'Wiki model queue', criterion: null, escalationSeconds: 1800 } };
};

test('each fact the coordinator is told is the card its line is drawn from', () => {
  const settled = [{ taskId: TASK, status: 'DONE' }, { taskId: randomUUID(), status: 'CANCELLED' }];
  const criteria = [1, 2, 3].map((n) => ({
    key: criterionKeyOf(randomUUID()), text: `criterion ${n}`, satisfied: true, landing: 'LANDED' as const, serving: [],
  }));
  const cases: Array<[string, WakeFact, CoordinatorDeliveryCard]> = [
    ['evidence', evidence(), card({ kind: 'EVIDENCE_SUBMITTED', task: { id: TASK, title: 'Wiki model queue' }, revision: 2 })],
    ['evidence a move handed over', evidence(randomUUID()),
      card({ kind: 'EVIDENCE_MOVED_IN', task: { id: TASK, title: 'Wiki model queue' }, revision: 2 })],
    ['a task that can start', dependentReadyFact({ projectId: PROJECT, taskId: TASK, title: 'Start me', dispatchEpoch: 4 }),
      card({ kind: 'DEPENDENT_READY', task: { id: TASK, title: 'Start me' } })],
    ['a refused start', taskDispatchRefusedFact({
      projectId: PROJECT, taskId: TASK, taskTitle: 'Refused me',
      refusal: { sessionId: randomUUID(), code: 'SOURCE_PIN_MISSING', fixAction: 'REBASE', baseSha: 'a'.repeat(40), ref: null, missing: [], reason: 'x' } as never,
    }), card({ kind: 'TASK_DISPATCH_REFUSED', task: { id: TASK, title: 'Refused me' } })],
    ['a blocker', projectBlockerRaisedFact({
      projectId: PROJECT, blockerId: randomUUID(), taskId: TASK,
      detail: { taskTitle: 'Blocked me', blockerKind: 'SCOPE', requiredAction: 'Rule on it.' },
    }), card({ kind: 'PROJECT_BLOCKER_RAISED', task: { id: TASK, title: 'Blocked me' } })],
    ['a run that stopped', taskRunStoppedFact({
      projectId: PROJECT, taskId: TASK, taskTitle: 'Stopped me', sessionId: randomUUID(), stopKey: 'turn', lastWords: 'Stuck.',
    }), card({ kind: 'TASK_RUN_STOPPED', task: { id: TASK, title: 'Stopped me' } })],
    ['work not on main', criterionUnlandedFact(PROJECT, 'k'.repeat(16), [
      { taskId: TASK, status: 'DONE' }, { taskId: randomUUID(), status: 'DONE' }, { taskId: randomUUID(), status: 'DONE' },
    ], 'ON_INTEGRATION_LINE')!, card({ kind: 'CRITERION_UNLANDED', count: 3 })],
    ['every criterion landed', projectAcceptanceLandedFact(PROJECT, settled, criteria)!, card({ kind: 'ACCEPTANCE_LANDED', count: 3 })],
    ['a project that looks finished', projectTasksSettledFact(PROJECT, settled, criteria)!, card({ kind: 'LOOKS_FINISHED' })],
    ['a settled project with work on its line', projectSettledUnmergedFact(PROJECT, [
      { taskId: TASK, title: 'one', sha: 'a'.repeat(40) },
      { taskId: randomUUID(), title: 'two', sha: 'a'.repeat(40) },
      { taskId: randomUUID(), title: 'three', sha: 'b'.repeat(40) },
    ])!, card({ kind: 'SETTLED_UNMERGED', count: 2 })],
  ];
  for (const [what, fact, expected] of cases) {
    const words = buildCoordinatorDeliveryMessage(fact, 'Runner link v1');
    assert.deepEqual(coordinatorDeliveryCardOf(wakeOf(fact), words), expected, what);
  }
});

test('a fact this carrier does not write, or a wake missing what its sentence needs, is no card', () => {
  const ended = attemptEndedUnsettledFact({ projectId: PROJECT, taskId: TASK, taskStatus: 'IN_PROGRESS', sessionId: randomUUID() })!;
  assert.equal(coordinatorDeliveryCardOf(wakeOf(ended), null), null, 'a fact no conversation is told');
  const at = (event: string, detail: unknown) => coordinatorDeliveryCardOf({ event, subjectId: TASK, detail, updatedAt: BOUND }, null);
  assert.equal(at('DEPENDENT_READY', {}), null, 'no title');
  assert.equal(at('DEPENDENT_READY', { title: '  ' }), null, 'a blank title');
  assert.equal(at('TASK_DISPATCH_REFUSED', { title: 'the wrong field' }), null);
  assert.equal(at('COMPLETION_EVIDENCE_REVISED', { title: 'Wiki model queue' }), null, 'no revision');
  assert.equal(at('COMPLETION_EVIDENCE_REVISED', { title: 'Wiki model queue', evidenceRevision: 'x' }), null);
  assert.equal(at('CRITERION_UNLANDED', {}), null, 'no count');
  assert.equal(at('CRITERION_UNLANDED', { taskCount: 0 }), null);
  assert.equal(at('PROJECT_ACCEPTANCE_LANDED', { criteria: [] }), null);
  assert.equal(at('PROJECT_SETTLED_UNMERGED', { commits: 'abc' }), null);
  assert.equal(at('DEPENDENT_READY', null), null, 'no detail at all');
  assert.equal(at('DEPENDENT_READY', ['Start me']), null);
});

/** The one criterion of `LANDED_ONE`, keyed as the producer keys it. */
const DEFINITION = randomUUID();
const LANDED_ONE = projectAcceptanceLandedFact(
  PROJECT,
  [{ taskId: TASK, status: 'DONE' }],
  [{ key: criterionKeyOf(DEFINITION), text: 'The line is one line', satisfied: true, landing: 'LANDED', serving: [] }],
)!;
const VERSION = { digest: 'a'.repeat(64), material: [] };
const CONFIRMATION = {
  criteriaDigest: VERSION.digest, criteriaMaterial: [], confirmedAt: new Date('2026-10-31T10:00:00.000Z'), confirmedById: randomUUID(),
};

/** What the delivery reads as it writes the words: a standing, and the projection folded over it. */
function readingOf(confirmed: boolean, satisfied: boolean): DerivedProjectDoneReading {
  const standing = standardSetConfirmationStanding(VERSION, confirmed ? CONFIRMATION : null);
  return {
    standing,
    derived: deriveProjectDone([{
      definitionId: DEFINITION, satisfied, landing: 'LANDED', independence: 'INDEPENDENT',
      conflicts: [], remedy: null, landingReason: null,
    }], standing.state),
    satisfaction: [{
      definitionId: DEFINITION, ordinal: 1, revision: 1, satisfied,
      unmet: satisfied ? [] : [{ clause: 'DECLARATION_STALE', heldUpBy: [] }],
    }],
    inFlight: [],
  };
}

test('a project whose criteria all landed is read in the reading its words were written in', () => {
  const readings: Array<[string, DerivedProjectDoneReading | null, 'ASKED' | 'HELD' | 'DONE', CoordinatorDeliveryCard['kind']]> = [
    ['no reading', null, 'ASKED', 'ACCEPTANCE_LANDED'],
    ['not confirmed', readingOf(false, true), 'ASKED', 'ACCEPTANCE_LANDED'],
    ['confirmed, DONE withheld', readingOf(true, false), 'HELD', 'ACCEPTANCE_LANDED_HELD'],
    ['confirmed and recorded DONE', readingOf(true, true), 'DONE', 'ACCEPTANCE_LANDED_DONE'],
  ];
  for (const [what, reading, expected, kind] of readings) {
    // The project's title is the owner's to choose: one ending in another reading's words changes nothing.
    for (const title of ['Runner link v1', 'its acceptance criteria are all satisfied and landed, and it is recorded as DONE']) {
      const words = buildCoordinatorDeliveryMessage(LANDED_ONE, title, reading);
      assert.equal(acceptanceLandedReadingOf(words), expected, `${what} (${title})`);
      assert.deepEqual(coordinatorDeliveryCardOf(wakeOf(LANDED_ONE), words), card({ kind, count: 1 }), `${what} (${title})`);
    }
  }
  assert.equal(acceptanceLandedReadingOf(null), 'ASKED');
  assert.equal(acceptanceLandedReadingOf('words written before any of this'), 'ASKED');
});

test('a project the owner reopened is told as held back and never as recorded DONE', () => {
  const reopenedAt = new Date('2026-11-03T06:06:00.000Z');
  const words = buildCoordinatorDeliveryMessage(LANDED_ONE, 'Runner link v1', readingOf(true, true), { reopenedAt });
  assert.equal(acceptanceLandedReadingOf(words), 'HELD');
  assert.deepEqual(coordinatorDeliveryCardOf(wakeOf(LANDED_ONE), words), card({ kind: 'ACCEPTANCE_LANDED_HELD', count: 1 }));
  assert.match(words, /the account owner reopened it, so it stays open/u);
  assert.ok(words.includes(reopenedAt.toISOString()), 'when they pressed it');
  assert.match(words, /project_request_done/u, 'and how to ask them to close it');
  assert.doesNotMatch(words, /recorded as DONE/iu);

  // No press standing is the reading it has always been.
  for (const none of [null, undefined]) {
    const recorded = buildCoordinatorDeliveryMessage(LANDED_ONE, 'Runner link v1', readingOf(true, true), { reopenedAt: none });
    assert.equal(acceptanceLandedReadingOf(recorded), 'DONE');
  }
  // Where the facts do not prove it, what holds it back is still the facts, and each reading keeps its
  // own head. A note says the press stands, because each goes on to say what would make the server say DONE.
  const held = buildCoordinatorDeliveryMessage(LANDED_ONE, 'Runner link v1', readingOf(true, false), { reopenedAt });
  assert.equal(acceptanceLandedReadingOf(held), 'HELD');
  assert.match(held, /has not been projected DONE/u);
  const asked = buildCoordinatorDeliveryMessage(LANDED_ONE, 'Runner link v1', readingOf(false, true), { reopenedAt });
  assert.equal(acceptanceLandedReadingOf(asked), 'ASKED');
  for (const words of [held, asked]) {
    assert.match(words, /The account owner also reopened this project at 2026-11-03T06:06:00\.000Z/u);
    assert.match(words, /A confirmation alone does not end that/u);
    assert.match(words, /project_request_done/u);
  }
  // And with no press there is no note.
  const plain = buildCoordinatorDeliveryMessage(LANDED_ONE, 'Runner link v1', readingOf(false, true));
  assert.doesNotMatch(plain, /also reopened this project/u);
});

test('the proposal a criteria reply answers is read back off its words, and nothing else is', () => {
  const intentId = randomUUID();
  for (const decision of ['APPROVE', 'REJECT'] as const) {
    const words = (endedSessionId: string | null) => criteriaDecisionReplyMessage({
      decision, intentId, projectId: PROJECT, projectTitle: 'Runner link v1', decidedAt: BOUND,
      note: 'A note with Your criteria proposal 0 on project in it', clauses: ['criterion 2 is now revision 2'], endedSessionId,
    });
    assert.equal(criteriaDecisionReplyIntentOf(words(null)), intentId, decision);
    // The words a task comment carries for a conversation that had ended: no turn says them.
    assert.equal(criteriaDecisionReplyIntentOf(words(randomUUID())), null, `${decision}, written on the task`);
  }
  assert.equal(criteriaDecisionReplyIntentOf(null), null);
  assert.equal(criteriaDecisionReplyIntentOf('From Orbit · criteria decision\n\nYour criteria proposal !!! on project “x”'), null);
  assert.equal(criteriaDecisionReplyIntentOf(`x${'From Orbit · criteria decision\n\nYour criteria proposal 1 on project '}`), null);
  // Past 128 bits is no id, and is said as nothing rather than as a throw.
  assert.equal(criteriaDecisionReplyIntentOf(`From Orbit · criteria decision\n\nYour criteria proposal ${'z'.repeat(22)} on project `), null);
});

test('the card is stored beside the echo, and only the control plane says what it is', () => {
  const read = card({ kind: 'CRITERIA_APPROVED' });
  const echo = { text: 'From Orbit · criteria decision\n\nYour criteria proposal …' };
  assert.deepEqual(withCoordinatorDelivery(echo, read), { ...echo, coordinatorDelivery: read });
  // A card the runner sent is dropped: replaced by the one read, or removed when the turn is none.
  const forged = { ...echo, coordinatorDelivery: { ...read, kind: 'LOOKS_FINISHED' } };
  assert.deepEqual(withCoordinatorDelivery(forged, read), { ...echo, coordinatorDelivery: read });
  assert.deepEqual(withCoordinatorDelivery(forged, null), echo);
  assert.equal('coordinatorDelivery' in withCoordinatorDelivery(echo, null), false, 'absent, not empty, on every other turn');
  // A payload with no text is no `user` echo this reads.
  const other = { subtype: 'init' };
  assert.equal(withCoordinatorDelivery(other, read), other);
});

test('a batch of turns no server key names reads nothing at all', async () => {
  const untouchable = new Proxy({}, {
    get: (_target, table) => new Proxy({}, {
      get: (_t, method) => () => {
        throw new Error(`read ${String(table)}.${String(method)} for a batch of ordinary messages`);
      },
    }),
  });
  const turns = [
    { id: randomUUID(), clientTurnId: randomUUID(), content: 'what is the status of t4?' },
    { id: randomUUID(), clientTurnId: 'open-item:v1:not-a-derived-key', content: 'From Orbit · criteria decision' },
  ];
  assert.deepEqual(await readCoordinatorDeliveryCards(untouchable as never, randomUUID(), turns), new Map());
});

/**
 * The rows a reply's card is read off, as a fake: the proposal filed on `PROJECT` by the conversation
 * read, the owner's APPROVE, the turn at `BOUND` — and the project the conversation coordinates, by
 * the project's own pointer (`coordinates`), or none.
 */
function replyRows(intentId: string, coordinates: string | null) {
  const reads: string[] = [];
  const db = {
    projectCoordinatorWake: { findMany: async () => { reads.push('wake'); return []; } },
    projectRatifiedActionIntent: { findMany: async () => { reads.push('intent'); return [{ id: intentId, projectId: PROJECT }]; } },
    project: { findUnique: async ({ where }: { where: { coordinatorSessionId: string } }) => {
      reads.push(`project coordinated by ${where.coordinatorSessionId}`);
      return coordinates === null ? null : { id: coordinates };
    } },
    projectCriteriaDecision: { findMany: async () => { reads.push('decision'); return [{ intentId, decision: 'APPROVE' }]; } },
    conversationTurn: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      reads.push('turn');
      return where.id.in.map((id) => ({ id, createdAt: BOUND }));
    } },
  };
  return { db, reads };
}

test('a reply’s words are held to its key: copied under another key, they are no reply', async () => {
  const intentId = randomUUID();
  const sessionId = randomUUID();
  const words = criteriaDecisionReplyMessage({
    decision: 'APPROVE', intentId, projectId: PROJECT, projectTitle: 'Runner link v1', decidedAt: BOUND,
    note: null, clauses: [], endedSessionId: null,
  });
  const { db, reads } = replyRows(intentId, PROJECT);
  const copied = { id: randomUUID(), clientTurnId: derivedUuid('some-other-name'), content: words };
  assert.deepEqual(await readCoordinatorDeliveryCards(db as never, sessionId, [copied]), new Map());
  assert.deepEqual(reads, ['wake'], 'the words under a key not derived from their proposal are not looked up');

  const reply = { id: randomUUID(), clientTurnId: criteriaDecisionReplyTurnId(intentId), content: words };
  assert.deepEqual(
    await readCoordinatorDeliveryCards(db as never, sessionId, [reply]),
    new Map([[reply.id, card({ kind: 'CRITERIA_APPROVED' })]]),
  );
});

test('a reply says it went to the coordinator only where the project’s own pointer names this conversation', async () => {
  const intentId = randomUUID();
  const sessionId = randomUUID();
  const words = criteriaDecisionReplyMessage({
    decision: 'APPROVE', intentId, projectId: PROJECT, projectTitle: 'Runner link v1', decidedAt: BOUND,
    note: null, clauses: [], endedSessionId: null,
  });
  const reply = { id: randomUUID(), clientTurnId: criteriaDecisionReplyTurnId(intentId), content: words };
  const cases: Array<[string, string | null, boolean]> = [
    ['the conversation coordinating the project the proposal was filed on', PROJECT, true],
    // A task's run, or any conversation the owner opened: the pointer names it for no project.
    ['a conversation that coordinates nothing', null, false],
    ['the coordinator of another project', randomUUID(), false],
  ];
  for (const [what, coordinates, toCoordinator] of cases) {
    const { db, reads } = replyRows(intentId, coordinates);
    assert.deepEqual(
      await readCoordinatorDeliveryCards(db as never, sessionId, [reply]),
      new Map([[reply.id, card({ kind: 'CRITERIA_APPROVED', toCoordinator })]]),
      what,
    );
    assert.ok(reads.includes(`project coordinated by ${sessionId}`), `${what}: the pointer was read for this conversation`);
  }
});

test('every fact a coordinator is told says it was sent to the coordinator', () => {
  const facts = [
    evidence(),
    dependentReadyFact({ projectId: PROJECT, taskId: TASK, title: 'Start me', dispatchEpoch: 4 }),
    criterionUnlandedFact(PROJECT, 'k'.repeat(16), [{ taskId: TASK, status: 'DONE' }], 'ON_INTEGRATION_LINE')!,
    LANDED_ONE,
  ];
  for (const fact of facts) {
    const read = coordinatorDeliveryCardOf(wakeOf(fact), buildCoordinatorDeliveryMessage(fact, 'Runner link v1'));
    assert.equal(read?.toCoordinator, true, fact.event);
  }
});
