import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCriteriaEdit } from './criteria-edit-classification';
import { criterionLandingReason } from './criterion-landing-reason';
import { criterionLanding, type LandingBranches } from './project-criterion-landing';
import {
  criterionConfirmationStanding,
  type CriterionConfirmationFacts,
} from './project-criterion-confirmation';
import {
  CRITERION_CHECK_NOT_FOUND,
  CRITERION_CONFIRMATION_COORDINATOR_ONLY,
  CRITERION_NOT_CONFIRMATION_MODE,
  CRITERION_NOTHING_TO_WITHDRAW,
  CRITERION_REVISION_MOVED,
  ProjectCriterionConfirmationService,
} from './project-criterion-confirmation.service';
import {
  criterionSatisfaction,
  type CriterionWithSettlementFacts,
  type ServingTaskFacts,
} from './project-criterion-satisfaction';
import { derivedDoneFromLanes } from './project-done-derived';
import { doneReadiness, type DoneState } from './project-done-request';

/**
 * Criteria met by confirmation (migration 0545). A CONFIRMATION criterion is met exactly while a
 * confirmation of its CURRENT revision stands — from the owner, the coordinator, or an Agent check
 * that reported PASS — and a TASKS criterion is decided exactly as before, NO_WORK_SERVES_IT and all.
 */

const T0 = new Date('2026-11-11T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function row(over: Partial<CriterionConfirmationFacts> = {}): CriterionConfirmationFacts {
  return {
    id: over.id ?? 'conf-1',
    revision: 1,
    confirmerKind: 'OWNER',
    outcome: 'CONFIRMED',
    sessionId: null,
    checkTaskId: null,
    note: null,
    attachmentIds: [],
    createdAt: at(0),
    settledAt: at(0),
    withdrawnAt: null,
    ...over,
  };
}

function criterion(over: Partial<CriterionWithSettlementFacts> = {}): CriterionWithSettlementFacts {
  return { id: 'crit', ordinal: 1, revision: 1, servingTasks: [], ...over };
}

function doneTask(id: string): ServingTaskFacts {
  return {
    id,
    title: id,
    status: 'DONE',
    criterionDefinitionId: 'crit',
    criterionRevision: 1,
    completionCriterion: 'EXECUTABLE',
    verifiesTaskId: null,
    verdict: null,
    verifiedBy: [],
    verifies: null,
    completionEvidence: [],
  };
}

const [satisfy] = [(c: CriterionWithSettlementFacts) => criterionSatisfaction([c])[0]];

// ── TASKS criteria: unchanged ──────────────────────────────────────────────────────────────────

test('a TASKS criterion nobody serves is still NO_WORK_SERVES_IT, with or without the field', () => {
  for (const definition of [criterion(), criterion({ satisfiedBy: 'TASKS' })]) {
    const answer = satisfy(definition);
    assert.equal(answer.satisfied, false);
    assert.deepEqual(answer.unmet, [{ clause: 'NO_WORK_SERVES_IT', heldUpBy: [] }]);
    assert.equal(answer.satisfiedBy, 'TASKS');
    assert.equal(answer.confirmation, null);
  }
});

test('a confirmation row does not satisfy a TASKS criterion: only its work does', () => {
  const answer = satisfy(criterion({ satisfiedBy: 'TASKS', confirmations: [row()] }));
  assert.equal(answer.satisfied, false);
  assert.deepEqual(answer.unmet.map((u) => u.clause), ['NO_WORK_SERVES_IT']);
  assert.equal(satisfy(criterion({ servingTasks: [doneTask('t1')] })).satisfied, true);
});

// ── CONFIRMATION criteria: each confirmer path ─────────────────────────────────────────────────

test('a CONFIRMATION criterion is unmet until confirmed, and never NO_WORK_SERVES_IT', () => {
  const answer = satisfy(criterion({ satisfiedBy: 'CONFIRMATION' }));
  assert.equal(answer.satisfied, false);
  assert.deepEqual(answer.unmet, [{ clause: 'NOT_CONFIRMED', heldUpBy: [] }]);
  assert.equal(answer.confirmation?.state, 'UNCONFIRMED');
  // Finished serving work does not meet it either: it is met by confirmation alone.
  assert.equal(
    satisfy(criterion({ satisfiedBy: 'CONFIRMATION', servingTasks: [doneTask('t1')] })).satisfied,
    false,
  );
});

test('the owner, the coordinator and a PASSing Agent check each meet it, and are named', () => {
  for (const confirmation of [
    row({ confirmerKind: 'OWNER', note: 'ICP filing number on the footer' }),
    row({ confirmerKind: 'COORDINATOR', sessionId: 'coord-session' }),
    row({ confirmerKind: 'AGENT_CHECK', sessionId: 'check-run', checkTaskId: 'check-task' }),
  ]) {
    const answer = satisfy(criterion({ satisfiedBy: 'CONFIRMATION', confirmations: [confirmation] }));
    assert.equal(answer.satisfied, true, confirmation.confirmerKind);
    assert.deepEqual(answer.unmet, []);
    assert.equal(answer.confirmation?.state, 'CONFIRMED');
    assert.equal(answer.confirmation?.current?.confirmerKind, confirmation.confirmerKind);
    assert.equal(answer.confirmation?.current?.sessionId, confirmation.sessionId);
    assert.equal(answer.confirmation?.current?.note, confirmation.note);
    assert.deepEqual(answer.confirmation?.current?.at, at(0));
  }
});

test('a FAILed Agent check leaves it unmet; a running one is reported and settles nothing', () => {
  const failed = row({ id: 'chk', confirmerKind: 'AGENT_CHECK', outcome: 'FAILED', checkTaskId: 'ct' });
  const answer = satisfy(criterion({ satisfiedBy: 'CONFIRMATION', confirmations: [failed] }));
  assert.equal(answer.satisfied, false);
  assert.equal(answer.confirmation?.state, 'CHECK_FAILED');
  assert.equal(answer.confirmation?.current?.id, 'chk');

  const running = row({
    id: 'run', confirmerKind: 'AGENT_CHECK', outcome: 'PENDING', checkTaskId: 'ct', settledAt: null,
  });
  const pending = satisfy(criterion({ satisfiedBy: 'CONFIRMATION', confirmations: [running] }));
  assert.equal(pending.satisfied, false);
  assert.equal(pending.confirmation?.state, 'UNCONFIRMED');
  assert.equal(pending.confirmation?.checkRunning?.id, 'run');
});

test('the newest settled row decides: a later FAIL re-opens it, a later confirmation closes it', () => {
  const owner = row({ id: 'own', settledAt: at(1) });
  const fail = row({
    id: 'fail', confirmerKind: 'AGENT_CHECK', outcome: 'FAILED', checkTaskId: 'ct', settledAt: at(2),
  });
  assert.equal(
    criterionConfirmationStanding(1, [owner, fail]).state, 'CHECK_FAILED');
  assert.equal(
    criterionConfirmationStanding(1, [fail, row({ id: 'again', settledAt: at(3) })]).state, 'CONFIRMED');
});

// ── Staleness and withdrawal ───────────────────────────────────────────────────────────────────

test('a revision bump makes the confirmation stale: unmet again, and the old one named', () => {
  const answer = satisfy(criterion({
    satisfiedBy: 'CONFIRMATION', revision: 2, confirmations: [row({ revision: 1 })],
  }));
  assert.equal(answer.satisfied, false);
  assert.deepEqual(answer.unmet.map((u) => u.clause), ['NOT_CONFIRMED']);
  assert.equal(answer.confirmation?.state, 'STALE');
  assert.equal(answer.confirmation?.stale, true);
  assert.equal(answer.confirmation?.current?.revision, 1);
  // Confirming the new revision meets it again.
  assert.equal(satisfy(criterion({
    satisfiedBy: 'CONFIRMATION', revision: 2,
    confirmations: [row({ revision: 1 }), row({ id: 'r2', revision: 2, settledAt: at(5) })],
  })).satisfied, true);
});

test('a withdrawn confirmation counts for nothing', () => {
  const answer = satisfy(criterion({
    satisfiedBy: 'CONFIRMATION', confirmations: [row({ withdrawnAt: at(1) })],
  }));
  assert.equal(answer.satisfied, false);
  assert.equal(answer.confirmation?.state, 'UNCONFIRMED');
  assert.equal(answer.confirmation?.current, null);
});

// ── Landing and the done card ──────────────────────────────────────────────────────────────────

const BRANCHES: LandingBranches = { upstream: ['main'], integration: ['project/p'] };

test('a CONFIRMATION criterion takes no part in landing: LANDED, nothing to land, no UNLANDED', () => {
  const [{ landing }] = criterionLanding(
    [{ id: 'crit', satisfiedBy: 'CONFIRMATION', servingTasks: [] }], BRANCHES);
  assert.equal(landing, 'LANDED');
  assert.equal(
    criterionLandingReason({ landing, servingTasks: [], satisfiedBy: 'CONFIRMATION' }, BRANCHES, []),
    'NOTHING_TO_LAND');
  // The same criterion in TASKS mode is still UNKNOWN: the fold for task work is untouched.
  assert.equal(criterionLanding([{ id: 'crit', servingTasks: [] }], BRANCHES)[0].landing, 'UNKNOWN');

  const satisfaction = criterionSatisfaction([
    criterion({ satisfiedBy: 'CONFIRMATION', confirmations: [row()] }),
  ]);
  const derived = derivedDoneFromLanes(
    satisfaction,
    [{ definitionId: 'crit', landing, landingReason: 'NOTHING_TO_LAND' }],
    [],
    'CONFIRMED',
  );
  assert.equal(derived.done, true);
  assert.deepEqual(derived.withheld, []);
  assert.equal(derived.criteria[0].satisfiedBy, 'CONFIRMATION');
  assert.equal(derived.criteria[0].confirmation?.current?.confirmerKind, 'OWNER');
});

test('doneReadiness: a confirmed CONFIRMATION criterion has no finding, an unconfirmed one only UNSATISFIED', () => {
  // The landing fold's answer for a CONFIRMATION criterion, whatever work is filed under it.
  const [{ landing }] = criterionLanding(
    [{ id: 'crit', satisfiedBy: 'CONFIRMATION', servingTasks: [] }], BRANCHES);
  const state = (satisfied: boolean, nonCode = false): DoneState => ({
    criteria: [{
      stated: {
        ordinal: 1, key: 'k', text: 'ICP filing approved', definitionId: 'crit',
        definitionRevision: 1, verificationMethod: 'Owner reads the filing',
        completionCriterionOverrideReason: null, contentHash: 'h',
      },
      satisfied,
      heldUpBy: [],
      landing,
      reason: null,
      heldOffLanded: [],
    }],
    tasks: [],
    ownerItems: [],
    jobs: [],
    criteriaDigest: 'd',
    stateDigest: 's',
    nonCode,
  });
  assert.deepEqual(doneReadiness(state(true), []).map((f) => f.code), []);
  assert.deepEqual(doneReadiness(state(false), []).map((f) => f.code), ['DONE_CRITERION_UNSATISFIED']);
  // In a project marked non-code the two rules compose: still no landing finding either way.
  assert.deepEqual(doneReadiness(state(true, true), []).map((f) => f.code), []);
  assert.deepEqual(doneReadiness(state(false, true), []).map((f) => f.code), ['DONE_CRITERION_UNSATISFIED']);
});

test('a CONFIRMATION criterion in a non-code project reads no landing reason at all', () => {
  const [{ landing }] = criterionLanding(
    [{ id: 'crit', satisfiedBy: 'CONFIRMATION', servingTasks: [] }], BRANCHES);
  for (const confirmations of [[row()], []]) {
    const derived = derivedDoneFromLanes(
      criterionSatisfaction([criterion({ satisfiedBy: 'CONFIRMATION', confirmations })]),
      [{ definitionId: 'crit', landing, landingReason: 'NOTHING_TO_LAND' }],
      [],
      'CONFIRMED',
      true,
    );
    assert.equal(derived.nonCode, true);
    assert.equal(derived.criteria[0].landingReason, null);
    assert.ok(!derived.criteria[0].withheld.includes('CRITERION_UNLANDED'));
    assert.ok(!derived.withheld.includes('CRITERION_UNLANDED'));
    assert.equal(derived.done, confirmations.length > 0);
    assert.equal(derived.criteria[0].confirmation?.state, confirmations.length > 0 ? 'CONFIRMED' : 'UNCONFIRMED');
  }
});

// ── Mode is a semantic change ──────────────────────────────────────────────────────────────────

test('changing a criterion\'s mode, either way, is held like a rewording', () => {
  const tasks = [{ id: 'a', text: 'x', verificationMethod: 'm', satisfiedBy: 'TASKS' as const }];
  const confirm = [{ ...tasks[0], satisfiedBy: 'CONFIRMATION' as const }];
  assert.equal(classifyCriteriaEdit(tasks, confirm), 'WEAKENING');
  assert.equal(classifyCriteriaEdit(confirm, tasks), 'WEAKENING');
  assert.equal(classifyCriteriaEdit(confirm, confirm), 'ADDITIVE');
  // Absent is TASKS, so a caller that predates the field changes nothing by omitting it.
  assert.equal(classifyCriteriaEdit(tasks, [{ id: 'a', text: 'x', verificationMethod: 'm' }]), 'ADDITIVE');
});

// ── The doors ──────────────────────────────────────────────────────────────────────────────────

const OWNER = 'owner-1';
const PROJECT = 'project-1';
const COORDINATOR_SESSION = 'coord-session';

/** The few delegates the service touches, in memory. */
function fakeStack(definitionOver: { satisfiedBy?: 'TASKS' | 'CONFIRMATION'; revision?: number } = {}) {
  const definition = {
    id: 'crit', projectId: PROJECT, ordinal: 5, text: 'ICP filing approved',
    verificationMethod: 'Read the filing record', revision: definitionOver.revision ?? 1,
    satisfiedBy: definitionOver.satisfiedBy ?? 'CONFIRMATION',
  };
  const confirmations: Array<CriterionConfirmationFacts & {
    ownerId: string; projectId: string; definitionId: string; withdrawnByKind: string | null;
  }> = [];
  const sessions = new Map<string, { taskId: string | null }>([
    ['check-run', { taskId: 'check-task' }],
    ['other-run', { taskId: 'other-task' }],
  ]);
  let clock = 0;
  const matches = (r: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => r[key] === value);
  const prisma = {
    projectAcceptanceCriterionDefinition: {
      findFirst: async ({ where }: any) => (where.id === definition.id && where.projectId === PROJECT
        && where.project.ownerId === OWNER
        ? { ...definition, project: { title: 'CBAI', coordinatorSessionId: COORDINATOR_SESSION } }
        : null),
      findFirstOrThrow: async () => ({
        revision: definition.revision,
        confirmations: confirmations.filter((r) => r.withdrawnAt === null),
      }),
    },
    projectCriterionConfirmation: {
      create: async ({ data }: any) => {
        clock += 1;
        const created = {
          id: `conf-${confirmations.length + 1}`, sessionId: null, checkTaskId: null, note: null,
          attachmentIds: [], createdAt: at(clock), settledAt: null, withdrawnAt: null,
          withdrawnByKind: null, ...data,
        };
        confirmations.push(created);
        return created;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of confirmations) {
          if (!matches(r as never, where)) continue;
          clock += 1;
          Object.assign(r, data, data.settledAt ? { settledAt: at(clock) } : {});
          count += 1;
        }
        return { count };
      },
      findFirst: async ({ where }: any) => [...confirmations].reverse()
        .find((r) => matches(r as never, where)) ?? null,
    },
    session: {
      findFirst: async ({ where }: any) => sessions.get(where.id) ?? null,
    },
    projectMember: { findFirst: async () => ({ agentId: 'coord-workspace' }) },
    attachment: { count: async ({ where }: any) => where.id.in.filter((id: string) => id.startsWith('own-')).length },
  };
  const created: any[] = [];
  const executed: string[] = [];
  const tasks = {
    create: async (_owner: string, dto: any) => { created.push(dto); return { id: 'check-task' }; },
    execute: async (_owner: string, id: string) => { executed.push(id); return { sessionId: 'check-run' }; },
  };
  const reprojected: string[] = [];
  // The re-projection is `storeDerivedProjectStatus`'s, covered by its own specs; here it is only
  // asked whether every write ends on it.
  const service = new (class extends ProjectCriterionConfirmationService {
    protected override async reproject(_owner: string, projectId: string) { reprojected.push(projectId); }
  })(prisma as never, tasks as never);
  return { service, definition, confirmations, created, executed, reprojected };
}

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: any) => {
    assert.equal(error.getResponse?.().code, code);
    return true;
  });
}

test('the owner confirms over REST, with an optional note and their own uploads', async () => {
  const { service, confirmations, reprojected } = fakeStack();
  const result = await service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, {
    note: '  Checked the MIIT record  ', attachmentIds: ['own-shot'],
  });
  assert.equal(result.confirmation.state, 'CONFIRMED');
  assert.equal(result.confirmation.current?.confirmerKind, 'OWNER');
  assert.equal(result.confirmation.current?.note, 'Checked the MIIT record');
  assert.deepEqual(confirmations[0].attachmentIds, ['own-shot']);
  assert.deepEqual(reprojected, [PROJECT], 'the write re-projects the project\'s DONE');
  assert.equal(confirmations[0].sessionId, null);
  // Not this account's upload: refused, and nothing written.
  await assert.rejects(service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, { attachmentIds: ['theirs'] }));
  assert.equal(confirmations.length, 1);
});

test('only the project\'s coordinator conversation may confirm from a session', async () => {
  const { service, confirmations } = fakeStack();
  await refused(service.confirm(OWNER, PROJECT, 'crit', { kind: 'COORDINATOR', sessionId: 'a-task-run' }, {}),
    CRITERION_CONFIRMATION_COORDINATOR_ONLY);
  await refused(service.confirm(OWNER, PROJECT, 'crit', { kind: 'COORDINATOR', sessionId: undefined }, {}),
    CRITERION_CONFIRMATION_COORDINATOR_ONLY);
  assert.equal(confirmations.length, 0);
  const result = await service.confirm(
    OWNER, PROJECT, 'crit', { kind: 'COORDINATOR', sessionId: COORDINATOR_SESSION }, { note: 'read it' });
  assert.equal(result.confirmation.state, 'CONFIRMED');
  assert.equal(result.confirmation.current?.confirmerKind, 'COORDINATOR');
  assert.equal(result.confirmation.current?.sessionId, COORDINATOR_SESSION);
});

test('a TASKS criterion and a revision that moved under the reader are refused', async () => {
  await refused(fakeStack({ satisfiedBy: 'TASKS' }).service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, {}),
    CRITERION_NOT_CONFIRMATION_MODE);
  const { service, confirmations } = fakeStack({ revision: 3 });
  await refused(service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, { revision: 2 }),
    CRITERION_REVISION_MOVED);
  assert.equal(confirmations.length, 0);
  assert.equal((await service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, { revision: 3 }))
    .confirmation.current?.revision, 3);
});

test('withdrawal by the owner or the coordinator makes it unmet, and keeps the row', async () => {
  for (const actor of [{ kind: 'OWNER' as const }, { kind: 'COORDINATOR' as const, sessionId: COORDINATOR_SESSION }]) {
    const { service, confirmations } = fakeStack();
    await service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, {});
    const result = await service.withdraw(OWNER, PROJECT, 'crit', actor);
    assert.equal(result.confirmation.state, 'UNCONFIRMED');
    assert.equal(confirmations.length, 1, 'a withdrawal is a stamp, not a delete');
    assert.equal(confirmations[0].withdrawnByKind, actor.kind);
    assert.ok(confirmations[0].withdrawnAt);
    await refused(service.withdraw(OWNER, PROJECT, 'crit', actor), CRITERION_NOTHING_TO_WITHDRAW);
  }
});

test('a revision bump after a confirmation leaves the criterion stale through the door too', async () => {
  const { service, definition } = fakeStack();
  await service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, {});
  definition.revision = 2; // what the normalize trigger does on a text, method or mode edit
  await refused(service.confirm(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, { revision: 1 }),
    CRITERION_REVISION_MOVED);
  // Nothing of revision 2 stands, so there is nothing to withdraw, and the standing reads STALE.
  await refused(service.withdraw(OWNER, PROJECT, 'crit', { kind: 'OWNER' }), CRITERION_NOTHING_TO_WITHDRAW);
  const { confirmation } = await service.startCheck(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, {});
  assert.equal(confirmation.state, 'STALE');
  assert.equal(confirmation.stale, true);
  assert.equal(confirmation.current?.revision, 1);
});

test('an Agent check is started as a codeless check task, and its PASS confirms', async () => {
  const { service, confirmations, created, executed } = fakeStack();
  const started = await service.startCheck(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, { instructions: 'use the record' });
  assert.equal(started.checkTaskId, 'check-task');
  assert.deepEqual(executed, ['check-task']);
  assert.equal(created[0].projectId, PROJECT);
  assert.equal(created[0].assigneeId, 'coord-workspace');
  assert.equal(created[0].codeless, true);
  assert.equal(created[0].criterionKey, undefined, 'the check serves no criterion as TASKS work');
  assert.match(created[0].description, /ICP filing approved/);
  assert.match(created[0].description, /Read the filing record/);
  assert.match(created[0].description, /criterion_check_report/);
  assert.equal(started.confirmation.checkRunning?.checkTaskId, 'check-task');
  assert.equal(started.confirmation.state, 'UNCONFIRMED');

  const reported = await service.reportCheck(OWNER, 'check-run', { verdict: 'PASS', note: 'record matches' });
  assert.equal(reported.outcome, 'CONFIRMED');
  assert.equal(reported.confirmation.state, 'CONFIRMED');
  assert.equal(reported.confirmation.current?.confirmerKind, 'AGENT_CHECK');
  assert.equal(reported.confirmation.current?.sessionId, 'check-run');
  assert.equal(reported.confirmation.current?.note, 'record matches');
  assert.equal(confirmations.length, 1);
  // Reported once: a second report finds nothing waiting.
  await refused(service.reportCheck(OWNER, 'check-run', { verdict: 'FAIL' }), CRITERION_CHECK_NOT_FOUND);
});

test('an Agent check\'s FAIL is a failed attempt that leaves the criterion unmet', async () => {
  const { service } = fakeStack();
  await service.startCheck(OWNER, PROJECT, 'crit', { kind: 'COORDINATOR', sessionId: COORDINATOR_SESSION }, {});
  const reported = await service.reportCheck(OWNER, 'check-run', { verdict: 'FAIL', note: 'no filing number' });
  assert.equal(reported.outcome, 'FAILED');
  assert.equal(reported.confirmation.state, 'CHECK_FAILED');
  assert.equal(reported.confirmation.current?.note, 'no filing number');
});

test('only the check\'s own session can report, and only a coordinator or the owner can start one', async () => {
  const { service } = fakeStack();
  await refused(service.startCheck(OWNER, PROJECT, 'crit', { kind: 'COORDINATOR', sessionId: 'x' }, {}),
    CRITERION_CONFIRMATION_COORDINATOR_ONLY);
  await service.startCheck(OWNER, PROJECT, 'crit', { kind: 'OWNER' }, {});
  await refused(service.reportCheck(OWNER, 'other-run', { verdict: 'PASS' }), CRITERION_CHECK_NOT_FOUND);
  await refused(service.reportCheck(OWNER, undefined, { verdict: 'PASS' }), CRITERION_CHECK_NOT_FOUND);
});
