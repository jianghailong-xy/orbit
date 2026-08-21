import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import {
  ABSENT_REASON_TEXT,
  absentReasonText,
  automationPolicyCopy,
  blockerKindCopy,
  isForbidden,
  isStaleConfigRevision,
  policyDraftChanged,
  policyDraftOf,
  policyEscalation,
  policyPatchBody,
  policyRefusal,
  runStateCopy,
  triggerBody,
  triggerRefusal,
  type CoordinatorStatus,
  type PolicyDraft,
} from './coordinatorStatus';

/** A project mid-flight, with every section populated the way a healthy one is. Individual tests
 *  narrow one field at a time so what each assertion is about stays visible. */
function status(patch: Partial<CoordinatorStatus> = {}): CoordinatorStatus {
  return {
    projectId: 'p1',
    readAt: '2026-08-20T10:00:00.000Z',
    project: {
      title: 'P',
      status: 'OPEN',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-20T09:00:00.000Z',
      taskCount: 3,
      tasksByStatus: { OPEN: 2, DONE: 1 },
    },
    coordination: {
      agentId: 'a1', agentIdAbsentReason: null, agentName: 'orbit', identitySource: 'EXPLICIT',
      workspaceId: 'w1', workspaceIdAbsentReason: null, generation: '2',
      sessionId: 's1', sessionIdAbsentReason: null, session: null, sessionAbsentReason: null,
    },
    policy: {
      coordinatorEnabled: true,
      automationPolicy: 'GUARDED_AUTO',
      configRevision: '7',
      maxConcurrentTasks: 4,
      sessionBudgetPerDay: 20,
      sessionBudgetPerDayAbsentReason: null,
    },
    consumption: {
      tasksInFlight: 1, concurrencyRemaining: 3, coordinatorSessionsLast24h: 5,
      budgetRemaining: 15, budgetRemainingAbsentReason: null,
      budgetWindowStartedAt: '2026-08-19T10:00:00.000Z',
    },
    runtime: {
      runState: 'EXECUTING', lease: null, leaseAbsentReason: 'NOT_LEASED',
      fencingToken: '11', acceptanceAttempt: '0',
    },
    nextWake: {
      at: '2026-08-20T10:05:00.000Z', reason: 'BACKOFF', absentReason: null,
      candidates: [], candidatesAbsentReason: 'DECISION_PREDATES_WAKE_AUDIT',
      flooredBy: null, decisionId: 'd1',
    },
    decisions: [], decisionsEmptyReason: 'NO_DECISION_YET',
    pendingActions: [], pendingActionsEmptyReason: 'NO_PENDING_ACTION',
    blockers: { open: [], openEmptyReason: 'NO_OPEN_BLOCKER', resolved: [] },
    events: { pending: [], pendingEmptyReason: 'NO_PENDING_EVENT', recent: [] },
    acceptance: {
      criteria: null, criteriaAbsentReason: 'NO_ACCEPTANCE_CRITERIA', attempt: '0',
      lastRun: null, lastRunAbsentReason: 'ACCEPTANCE_NOT_ATTEMPTED',
      evidence: {
        verifications: { total: 0, pending: 0, pass: 0, fail: 0, inconclusive: 0, unresolvedFailures: 0 },
        merges: [], mergesEmptyReason: 'NO_MERGE_EVIDENCE',
      },
    },
    ...patch,
  };
}

const draftOf = (patch: Partial<PolicyDraft> = {}): PolicyDraft => ({
  ...policyDraftOf(status()),
  ...patch,
});

describe('an absent fact is a value, not a blank', () => {
  it('has a sentence for every reason the server can send', () => {
    // The closed set as `project-coordinator-status.ts` declares it. Spelled out rather than
    // imported: the apiserver is not on this app's module graph, and a reason added there without
    // a sentence here is exactly what this asserts against.
    for (const reason of [
      'NO_COORDINATOR_AGENT', 'COORDINATOR_NEVER_OPENED', 'COORDINATOR_SESSION_TRASHED',
      'NO_COORDINATION_WORKSPACE', 'UNLIMITED', 'NOT_LEASED', 'NO_WAKE_SCHEDULED',
      'NO_DECISION_YET', 'DECISION_PREDATES_WAKE_AUDIT', 'NO_PENDING_ACTION', 'NO_OPEN_BLOCKER',
      'NO_PENDING_EVENT', 'NO_ACCEPTANCE_CRITERIA', 'ACCEPTANCE_NOT_ATTEMPTED', 'NO_MERGE_EVIDENCE',
    ]) {
      expect(ABSENT_REASON_TEXT[reason], reason).toBeTruthy();
    }
  });

  it('names a reason it does not recognise instead of rendering nothing', () => {
    const text = absentReasonText('SOMETHING_THIS_BUILD_PREDATES');
    expect(text).toContain('SOMETHING_THIS_BUILD_PREDATES');
    expect(text).toContain('does not recognise');
  });

  it('is null only when the value is actually present', () => {
    expect(absentReasonText(null)).toBeNull();
    expect(absentReasonText(undefined)).toBeNull();
    expect(absentReasonText('')).toBeNull();
  });

  it('keeps "uncapped" from reading as a limit of zero', () => {
    expect(ABSENT_REASON_TEXT.UNLIMITED).toContain('not a limit of zero');
  });

  it('keeps "never attempted" from reading as passed or failed', () => {
    expect(ABSENT_REASON_TEXT.ACCEPTANCE_NOT_ATTEMPTED).toContain('Not attempted');
    expect(ABSENT_REASON_TEXT.ACCEPTANCE_NOT_ATTEMPTED).toContain('not the same as failed');
  });

  it('tells "never opened" apart from "opened and trashed"', () => {
    expect(ABSENT_REASON_TEXT.COORDINATOR_NEVER_OPENED).not.toEqual(
      ABSENT_REASON_TEXT.COORDINATOR_SESSION_TRASHED,
    );
    expect(ABSENT_REASON_TEXT.COORDINATOR_SESSION_TRASHED).toContain('coordinated before');
  });

  it('says an un-audited candidate set is unknown rather than empty', () => {
    expect(ABSENT_REASON_TEXT.DECISION_PREDATES_WAKE_AUDIT).toContain('unknown, not none');
  });
});

describe('blocker copy names what is waited on and never a fallback', () => {
  it('tells provider, runner and runtime apart', () => {
    const provider = blockerKindCopy('PROVIDER_UNAVAILABLE');
    const runner = blockerKindCopy('NO_MATCHING_RUNNER');
    const runtime = blockerKindCopy('RUNTIME_REQUIREMENT_UNMET');
    expect(new Set([provider.label, runner.label, runtime.label]).size).toBe(3);
    expect(provider.note).toContain('not moved to a different provider');
    expect(runner.note).toContain('not rerouted');
  });

  it('never suggests the loop switches provider, runner or agent by itself', () => {
    for (const kind of [
      'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
      'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER', 'MERGE_CONFLICT',
      'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED', 'AWAITING_USER_APPROVAL',
      'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD', 'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE',
      'COORDINATOR_NO_PROGRESS', 'UNKNOWN_FAILURE',
    ]) {
      const copy = blockerKindCopy(kind);
      expect(copy.label, kind).toBeTruthy();
      // "falls back to", "switches to another", "automatically retried" — the readings that would
      // promise a second dispatch path §12.3 forbids.
      expect(copy.note.toLowerCase(), kind).not.toMatch(/falls? back|instead uses|switch(es)? to another/);
    }
  });

  it('renders a kind it has never heard of as a blocker rather than as nothing', () => {
    const copy = blockerKindCopy('SOME_NEW_KIND');
    expect(copy.label).toBe('SOME_NEW_KIND');
    expect(copy.note).toContain('does not recognise');
  });

  it('does not call an expected wait a fault', () => {
    expect(blockerKindCopy('POLICY_MANUAL_HOLD').note).toContain('a choice, not a fault');
  });
});

describe('automation levels are described accurately', () => {
  it('says MANUAL is not off', () => {
    expect(automationPolicyCopy('MANUAL').description).toContain('not “off”');
  });

  it('describes the two automatic levels differently', () => {
    expect(automationPolicyCopy('GUARDED_AUTO').description).not.toEqual(
      automationPolicyCopy('AUTO').description,
    );
    expect(automationPolicyCopy('GUARDED_AUTO').description).toContain('stops at the boundaries');
  });

  it('admits it cannot describe a level it does not know', () => {
    expect(automationPolicyCopy('FUTURE').description).toContain('does not recognise');
  });
});

describe('run states', () => {
  it('describes each one the schema declares', () => {
    for (const state of [
      'PLANNING', 'EXECUTING', 'AWAITING_VERIFICATION', 'BLOCKED', 'AWAITING_HUMAN',
      'ACCEPTANCE', 'SETTLED',
    ]) {
      expect(runStateCopy(state).unknown, state).toBe(false);
    }
  });

  it('does not paint an unrecognised state as a healthy one', () => {
    const copy = runStateCopy('SOMETHING_NEW');
    expect(copy.unknown).toBe(true);
    expect(copy.color).toBe('default');
    expect(copy.description).toContain('does not recognise');
  });
});

describe('a control is closed with the reason the server would have given', () => {
  it('lets a healthy open project be triggered', () => {
    expect(triggerRefusal({ status: status() })).toBeNull();
  });

  it('refuses a settled project, naming its lifecycle', () => {
    const refusal = triggerRefusal({ status: status({ project: { ...status().project, status: 'DONE' } }) });
    expect(refusal?.code).toBe('PROJECT_SETTLED');
    expect(refusal?.message).toContain('DONE');
  });

  it('refuses a switched-off coordinator and says where to turn it on', () => {
    const off = status();
    off.policy.coordinatorEnabled = false;
    const refusal = triggerRefusal({ status: off });
    expect(refusal?.code).toBe('COORDINATOR_DISABLED');
    expect(refusal?.message).toContain('discarded');
  });

  it('refuses before the state is known rather than assuming it is fine', () => {
    expect(triggerRefusal({ status: undefined })?.code).toBe('STATUS_UNKNOWN');
  });

  it('puts a permission refusal ahead of everything else, and says the owner keeps control', () => {
    const refusal = triggerRefusal({ status: undefined, readOnly: true });
    expect(refusal?.code).toBe('READ_ONLY');
    expect(refusal?.message).toContain('owner');
  });

  it('holds a second press while one is on the wire', () => {
    expect(triggerRefusal({ status: status(), pending: true })?.code).toBe('IN_FLIGHT');
  });

  it('closes the settings form on an unacknowledged stale refusal, not merely reports it', () => {
    const refusal = policyRefusal({ status: status(), conflict: true });
    expect(refusal?.code).toBe('STALE_CONFLICT');
    expect(refusal?.message).toContain('nothing was written');
  });

  it('does not invent refusals PATCH /projects/:id never makes', () => {
    // A settled project and a switched-off coordinator are both editable: the second especially,
    // since turning the coordinator back ON is done from this very form.
    const settledAndOff = status({ project: { ...status().project, status: 'CANCELLED' } });
    settledAndOff.policy.coordinatorEnabled = false;
    expect(policyRefusal({ status: settledAndOff })).toBeNull();
  });
});

describe('the settings write states the revision it was composed against', () => {
  it('always carries expectedConfigRevision', () => {
    const body = policyPatchBody(draftOf({ maxConcurrentTasks: 9 }), status());
    expect(body.expectedConfigRevision).toBe('7');
  });

  it('sends only what changed, so an edit does not re-assert somebody else’s field', () => {
    const body = policyPatchBody(draftOf({ maxConcurrentTasks: 9 }), status());
    expect(Object.keys(body).sort()).toEqual(['expectedConfigRevision', 'maxConcurrentTasks']);
  });

  it('names an automation level whenever it is switching the coordinator on', () => {
    const off = status();
    off.policy.coordinatorEnabled = false;
    // The level is unchanged — and it still has to be sent, because the server refuses a request
    // that turns automation on without saying how far it may go.
    const body = policyPatchBody({ ...policyDraftOf(off), coordinatorEnabled: true }, off);
    expect(body.coordinatorEnabled).toBe(true);
    expect(body.automationPolicy).toBe('GUARDED_AUTO');
  });

  it('does not send a level when it is only switching the coordinator off', () => {
    const body = policyPatchBody(draftOf({ coordinatorEnabled: false }), status());
    expect(body.coordinatorEnabled).toBe(false);
    expect(body).not.toHaveProperty('automationPolicy');
  });

  it('sends null for the budget rather than omitting it, so "no limit" is a written choice', () => {
    const body = policyPatchBody(draftOf({ sessionBudgetPerDay: null }), status());
    expect(body.sessionBudgetPerDay).toBeNull();
  });

  it('knows an untouched form has nothing to write', () => {
    expect(policyDraftChanged(draftOf(), status())).toBe(false);
    expect(policyDraftChanged(draftOf({ sessionBudgetPerDay: null }), status())).toBe(true);
  });
});

describe('an edit that hands the coordinator more room has to be confirmed', () => {
  it('says nothing about an edit that hands it none', () => {
    expect(policyEscalation(draftOf({ maxConcurrentTasks: 8 }), status())).toBeNull();
    expect(policyEscalation(draftOf({ sessionBudgetPerDay: 5 }), status())).toBeNull();
  });

  it('catches switching the coordinator on', () => {
    const off = status();
    off.policy.coordinatorEnabled = false;
    const text = policyEscalation({ ...policyDraftOf(off), coordinatorEnabled: true }, off);
    expect(text).toContain('switches this project’s coordinator on');
  });

  it('catches raising the automation level, and ignores lowering it', () => {
    expect(policyEscalation(draftOf({ automationPolicy: 'AUTO' }), status())).toContain('Guarded auto to Auto');
    expect(policyEscalation(draftOf({ automationPolicy: 'MANUAL' }), status())).toBeNull();
  });

  it('catches removing the daily budget', () => {
    expect(policyEscalation(draftOf({ sessionBudgetPerDay: null }), status()))
      .toContain('removes the daily session budget');
  });

  it('asks about a level it cannot rank rather than assuming it is a step down', () => {
    expect(policyEscalation(draftOf({ automationPolicy: 'SOME_FUTURE_LEVEL' }), status())).toBeTruthy();
  });

  it('states every reason at once when an edit does several', () => {
    const off = status();
    off.policy.coordinatorEnabled = false;
    const text = policyEscalation(
      { ...policyDraftOf(off), coordinatorEnabled: true, automationPolicy: 'AUTO', sessionBudgetPerDay: null },
      off,
    );
    expect(text).toContain('switches');
    expect(text).toContain('Auto');
    expect(text).toContain('budget');
  });
});

describe('the manual trigger', () => {
  it('fences on the revision it was composed against', () => {
    expect(triggerBody(status(), null)).toEqual({ expectedConfigRevision: '7' });
  });

  it('carries the press’s own id so a retry is one run and not two', () => {
    expect(triggerBody(status(), 't-1')).toEqual({ expectedConfigRevision: '7', triggerId: 't-1' });
  });
});

describe('a 409 is not one thing', () => {
  it('recognises the compare-and-swap refusal by its code, not its prose', () => {
    expect(isStaleConfigRevision(new ApiError('changed', 409, 'STALE_CONFIG_REVISION'))).toBe(true);
  });

  it('does not treat the trigger’s other two 409s as a stale write', () => {
    expect(isStaleConfigRevision(new ApiError('settled', 409, 'PROJECT_SETTLED'))).toBe(false);
    expect(isStaleConfigRevision(new ApiError('off', 409, 'COORDINATOR_DISABLED'))).toBe(false);
    // The open-coordinator endpoint's own 409 carries no code at all.
    expect(isStaleConfigRevision(new ApiError('already coordinating', 409))).toBe(false);
  });

  it('does not mistake an ordinary error for either refusal', () => {
    expect(isStaleConfigRevision(new Error('offline'))).toBe(false);
    expect(isForbidden(new Error('offline'))).toBe(false);
    expect(isForbidden(new ApiError('nope', 403))).toBe(true);
    expect(isForbidden(new ApiError('nope', 404))).toBe(false);
  });
});
