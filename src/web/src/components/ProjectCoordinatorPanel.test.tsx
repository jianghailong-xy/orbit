import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import {
  policyDraftOf,
  type CoordinatorBlocker,
  type CoordinatorStatus,
  type PolicyDraft,
} from '../lib/coordinatorStatus';
import {
  CoordinatorAcceptance,
  CoordinatorBlockers,
  CoordinatorDecisions,
  CoordinatorIdentity,
  CoordinatorPolicyForm,
  CoordinatorTrigger,
  ProjectCoordinatorPanel,
} from './ProjectCoordinatorPanel';

// Nothing here fetches — every component in this file takes the server's answer as a prop — but
// the stub is the backstop that would make an accidental request visible as a failure rather than
// as a hang.
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: vi.fn(() => new Promise(() => {})) };
});

// Real UUIDs: the id codec throws on anything that is neither spelling, so a placeholder string
// would fail the render rather than the assertion — and these are also what the "no raw UUID
// reaches the page" test needs to look for.
const AGENT = '0195c0de-0000-7000-8000-0000000000a1';
const WORKSPACE = '0195c0de-0000-7000-8000-0000000000a2';
const SESSION = '0195c0de-0000-7000-8000-0000000000a3';
const TASK = '0195c0de-0000-7000-8000-0000000000a4';
const RESULT_SESSION = '0195c0de-0000-7000-8000-0000000000a5';

const paint = (node: React.ReactElement) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

/** A project the loop is actively running, with every section populated. */
function busy(patch: Partial<CoordinatorStatus> = {}): CoordinatorStatus {
  return {
    projectId: 'p1',
    readAt: '2026-08-20T10:00:00.000Z',
    project: {
      title: 'Ship it', status: 'OPEN',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z',
      taskCount: 3, tasksByStatus: { OPEN: 2, DONE: 1 },
    },
    coordination: {
      agentId: AGENT, agentIdAbsentReason: null, agentName: 'orbit', identitySource: 'EXPLICIT',
      workspaceId: WORKSPACE, workspaceIdAbsentReason: null, generation: '2',
      sessionId: SESSION, sessionIdAbsentReason: null,
      session: {
        id: SESSION, runStatus: 'RUNNING', runState: 'RUNNING', lifecycleState: 'OPEN',
        endReason: null, startedAt: '2026-08-20T09:00:00.000Z', finishedAt: null,
        completedAt: null, deletedAt: null,
      },
      sessionAbsentReason: null,
    },
    policy: {
      coordinatorEnabled: true, automationPolicy: 'GUARDED_AUTO', configRevision: '7',
      maxConcurrentTasks: 4, sessionBudgetPerDay: 20, sessionBudgetPerDayAbsentReason: null,
    },
    consumption: {
      tasksInFlight: 1, concurrencyRemaining: 3, coordinatorSessionsLast24h: 5,
      budgetRemaining: 15, budgetRemainingAbsentReason: null,
      budgetWindowStartedAt: '2026-08-19T10:00:00.000Z',
    },
    runtime: {
      runState: 'EXECUTING',
      lease: { expiresAt: '2026-08-20T10:01:00.000Z', heartbeatAt: '2026-08-20T10:00:30.000Z', fencingToken: '11' },
      leaseAbsentReason: null, fencingToken: '11', acceptanceAttempt: '0',
    },
    nextWake: {
      at: '2026-08-20T10:05:00.000Z', reason: 'RETRY_BACKOFF', absentReason: null,
      candidates: [
        { at: '2026-08-20T10:05:00.000Z', reason: 'RETRY_BACKOFF' },
        { at: '2026-08-20T10:30:00.000Z', reason: 'BLOCKER_POLL' },
      ],
      candidatesAbsentReason: null, flooredBy: 'MIN_WAKE_INTERVAL', decisionId: 'd1',
    },
    decisions: [], decisionsEmptyReason: 'NO_DECISION_YET',
    pendingActions: [], pendingActionsEmptyReason: 'NO_PENDING_ACTION',
    blockers: { open: [], openEmptyReason: 'NO_OPEN_BLOCKER', resolved: [] },
    events: { pending: [], pendingEmptyReason: 'NO_PENDING_EVENT', recent: [] },
    acceptance: {
      criteria: 'It builds and the tests pass.', criteriaAbsentReason: null, attempt: '0',
      run: null, runAbsentReason: 'ACCEPTANCE_NOT_ATTEMPTED',
      doneGate: {
        allowed: false, runId: null, refusalCode: 'ACCEPTANCE_MISSING', reason: null,
        acceptanceDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      lastRun: null, lastRunAbsentReason: 'ACCEPTANCE_NOT_ATTEMPTED',
      evidence: {
        verifications: { total: 0, pending: 0, pass: 0, fail: 0, inconclusive: 0, unresolvedFailures: 0 },
        merges: [], mergesEmptyReason: 'NO_MERGE_EVIDENCE',
      },
    },
    ...patch,
  };
}

/**
 * A project made before the coordinator existed: no runtime row, no coordinator, nothing ever
 * decided. Every optional fact is absent with its reason, which is precisely the shape this screen
 * must not paint as healthy.
 */
function legacy(): CoordinatorStatus {
  const s = busy();
  return {
    ...s,
    coordination: {
      agentId: null, agentIdAbsentReason: 'NO_COORDINATOR_AGENT', agentName: null,
      identitySource: 'DERIVED',
      workspaceId: null, workspaceIdAbsentReason: 'NO_COORDINATION_WORKSPACE', generation: '0',
      sessionId: null, sessionIdAbsentReason: 'COORDINATOR_NEVER_OPENED',
      session: null, sessionAbsentReason: 'COORDINATOR_NEVER_OPENED',
    },
    policy: {
      coordinatorEnabled: false, automationPolicy: 'MANUAL', configRevision: '0',
      maxConcurrentTasks: 1, sessionBudgetPerDay: null, sessionBudgetPerDayAbsentReason: 'UNLIMITED',
    },
    consumption: {
      tasksInFlight: 0, concurrencyRemaining: 1, coordinatorSessionsLast24h: 0,
      budgetRemaining: null, budgetRemainingAbsentReason: 'UNLIMITED',
      budgetWindowStartedAt: '2026-08-19T10:00:00.000Z',
    },
    runtime: { runState: 'PLANNING', lease: null, leaseAbsentReason: 'NOT_LEASED', fencingToken: '0', acceptanceAttempt: '0' },
    nextWake: {
      at: null, reason: null, absentReason: 'NO_WAKE_SCHEDULED',
      candidates: [], candidatesAbsentReason: 'NO_DECISION_YET', flooredBy: null, decisionId: null,
    },
    acceptance: {
      criteria: null, criteriaAbsentReason: 'NO_ACCEPTANCE_CRITERIA', attempt: '0',
      run: null, runAbsentReason: 'ACCEPTANCE_NOT_ATTEMPTED',
      doneGate: {
        allowed: false, runId: null, refusalCode: 'ACCEPTANCE_MISSING', reason: null,
        acceptanceDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      lastRun: null, lastRunAbsentReason: 'ACCEPTANCE_NOT_ATTEMPTED',
      evidence: {
        verifications: { total: 0, pending: 0, pass: 0, fail: 0, inconclusive: 0, unresolvedFailures: 0 },
        merges: [], mergesEmptyReason: 'NO_MERGE_EVIDENCE',
      },
    },
  };
}

function blocker(patch: Partial<CoordinatorBlocker> = {}): CoordinatorBlocker {
  return {
    id: 'b1', kind: 'NO_MATCHING_RUNNER', owner: 'SYSTEM', recovery: 'EVENT', severity: 'WARNING',
    requiredAction: 'Bring a runner that satisfies this task back online.',
    nextCheckAt: '2026-08-20T10:02:00.000Z', subjectType: 'TASK', subjectId: TASK,
    lifecycleGeneration: '1', firstSeenAt: '2026-08-20T09:00:00.000Z',
    lastSeenAt: '2026-08-20T09:59:00.000Z', occurrences: 4, escalatedAt: null,
    resolvedAt: null, resolvedBy: null, raisedByActionId: null, raisedByActionStatus: null,
    ...patch,
  };
}

const noopPolicy = (draft: PolicyDraft) => ({
  draft,
  onDraft: () => {},
  pending: false,
  conflict: null,
  confirmed: false,
  onConfirm: () => {},
  error: null,
  onSubmit: () => {},
  onReview: () => {},
});

const noopTrigger = {
  pending: false, conflict: false, error: null, result: null, onRun: () => {},
};

describe('the panel’s own read states', () => {
  it('shows a spinner and no sections before the first status lands', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        status={undefined} loading error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
      />,
    );
    expect(html).toContain('ant-spin');
    expect(html).not.toContain('Blockers');
    expect(html).not.toContain('Acceptance evidence');
  });

  it('says an unread state is not a healthy one, and offers a retry', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        status={undefined} loading={false} error={new Error('gateway timeout')}
        onRetry={() => {}} readOnly={false} trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
      />,
    );
    expect(html).toContain('gateway timeout');
    expect(html).toContain('an unread state is not a healthy one');
    expect(html).toContain('Retry');
    // Above all: no section pretending there is nothing blocking this project.
    expect(html).not.toContain('Nothing is blocking this project right now.');
  });

  it('keeps the last state on screen when a refresh fails, and says it is stale', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        status={busy()} loading={false} error={new Error('offline')}
        onRetry={() => {}} readOnly={false} trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
      />,
    );
    expect(html).toContain('Showing the last state that loaded');
    expect(html).toContain('offline');
    expect(html).toContain('Blockers');
  });

  it('says so when nothing has been read at all rather than drawing an empty project', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        status={undefined} loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
      />,
    );
    expect(html).toContain('No coordinator state has been read yet.');
  });
});

/** How many real buttons are disabled. Written as a regex over the OPENING tag so it cannot count
 *  the antd Switch (a `<button role="switch">` whose class is `ant-switch`) as one of them. */
const disabledButtons = (html: string) =>
  (html.match(/<button[^>]*class="ant-btn[^"]*"[^>]*disabled=""/g) ?? []).length;

describe('a viewer who may read but not drive', () => {
  it('says so once at the top, closes every control, and still shows the read face', () => {
    const readOnly = paint(
      <ProjectCoordinatorPanel
        status={busy()} loading={false} error={null} onRetry={() => {}} readOnly
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
      />,
    );
    expect(readOnly).toContain('Read-only');
    expect(readOnly).toContain('owner keeps the final control');
    // The read face is intact...
    expect(readOnly).toContain('Blockers');
    expect(readOnly).toContain('EXECUTING');
    // ...and every write path is closed — both buttons and all four settings fields.
    expect(disabledButtons(readOnly)).toBe(2);
    expect(readOnly).toContain('ant-switch-disabled');
    expect(readOnly).toContain('ant-select-disabled');
    expect(readOnly).toContain('ant-input-number-disabled');
    // ...each with the reason beside it rather than a silently dead control.
    expect(readOnly).toContain('refused the last control write');
  });

  it('leaves the same controls open for a viewer who may drive', () => {
    const status = busy();
    const open = paint(
      <ProjectCoordinatorPanel
        status={status} loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger}
        policy={noopPolicy({ ...policyDraftOf(status), maxConcurrentTasks: 9 })}
      />,
    );
    // Nothing disabled: an OPEN project with its coordinator on, and an edit that changed
    // something and escalates nothing. If this ever went to 1 the assertion above would be
    // measuring antd's defaults rather than this screen's gating.
    expect(disabledButtons(open)).toBe(0);
    expect(open).not.toContain('ant-select-disabled');
  });
});

describe('a legacy project defaults safe and admits what it does not know', () => {
  it('renders every absent fact as its reason rather than as zero or healthy', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        status={legacy()} loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(legacy()))}
      />,
    );
    expect(html).toContain('No agent holds this project’s coordinator seat');
    expect(html).toContain('The coordination conversation has never been opened.');
    expect(html).toContain('No wake is scheduled');
    expect(html).toContain('never been reconciled');
    expect(html).toContain('Deliberately uncapped');
    expect(html).toContain('Project acceptance has never run here.');
  });

  it('leaves the coordinator off and does not talk the reader into turning it on', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        status={legacy()} loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(legacy()))}
      />,
    );
    expect(html).toContain('It stays off until you turn it on.');
    // The trigger is closed, and the reason is the server's own.
    expect(html).toContain('would be discarded rather than acted on');
    // MANUAL is described as a level, never as "off" or as a fault.
    expect(html).toContain('This is not “off”');
  });
});

describe('every id on the page is a short public one', () => {
  it('links agent, workspace, session, task and result session, and prints no raw UUID', () => {
    const status = busy({
      blockers: { open: [blocker()], openEmptyReason: null, resolved: [] },
      decisions: [{
        id: 'd1', createdAt: '2026-08-20T09:59:00.000Z', decidedBy: 'COORDINATOR',
        reason: 'dispatched one task', decisionInputHash: 'abc', fencingToken: '11',
        coordinatorAgentId: AGENT, coordinatorSessionId: SESSION,
        runStateBefore: 'PLANNING', runStateAfter: 'EXECUTING', configRevision: '7',
        nextWakeAt: null, nextWakeReason: null,
        actions: [{
          id: 'ac1', decisionId: 'd1', type: 'DISPATCH_TASK', status: 'APPLIED',
          subjectType: 'TASK', subjectId: TASK, idempotencyKey: 'pc:v1:xyz:dispatch',
          refusalCode: null, reasonCode: 'POLICY_ALLOWED', resultSessionId: RESULT_SESSION,
          fencingToken: '11', createdAt: '2026-08-20T09:59:00.000Z', updatedAt: '2026-08-20T09:59:01.000Z',
        }],
      }],
      decisionsEmptyReason: null,
    });
    const html = paint(
      <ProjectCoordinatorPanel
        status={status} loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(status))}
      />,
    );
    for (const [kind, id] of [
      ['workspaces', AGENT], ['workspaces', WORKSPACE], ['sessions', SESSION],
      ['tasks', TASK], ['sessions', RESULT_SESSION],
    ] as const) {
      expect(html, `${kind}/${id}`).toContain(`href="/${kind}/${encodeId(id)}"`);
    }
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('states that an id it cannot encode is unreadable rather than printing it', () => {
    const html = paint(<CoordinatorIdentity status={busy({
      coordination: { ...busy().coordination, agentId: 'not-an-id' },
    })} />);
    expect(html).toContain('unreadable id');
    expect(html).not.toContain('not-an-id');
  });
});

describe('blockers are structured, and none of them promises a fallback', () => {
  it('shows kind, owner, recovery, required action and the next check', () => {
    const html = paint(<CoordinatorBlockers status={busy({
      blockers: { open: [blocker()], openEmptyReason: null, resolved: [] },
    })} />);
    expect(html).toContain('No matching runner online');
    expect(html).toContain('owner SYSTEM');
    expect(html).toContain('clears on EVENT');
    expect(html).toContain('Bring a runner that satisfies this task back online.');
    expect(html).toContain('next check');
    expect(html).toContain('seen 4×');
  });

  it('tells an offline runner apart from an unavailable provider', () => {
    const runner = paint(<CoordinatorBlockers status={busy({
      blockers: { open: [blocker()], openEmptyReason: null, resolved: [] },
    })} />);
    const provider = paint(<CoordinatorBlockers status={busy({
      blockers: {
        open: [blocker({
          kind: 'PROVIDER_UNAVAILABLE', subjectType: 'PROVIDER',
          requiredAction: 'Wait for the provider to come back, or pin the task to an available one.',
        })],
        openEmptyReason: null, resolved: [],
      },
    })} />);
    expect(runner).toContain('No matching runner online');
    expect(runner).toContain('not rerouted to a runner that does not match');
    expect(provider).toContain('Provider unavailable');
    expect(provider).toContain('it is not moved to a different provider');
    expect(provider).not.toContain('No matching runner online');
  });

  it('shows an approval wait as an expected wait, and points at where it is answered', () => {
    const html = paint(<CoordinatorBlockers status={busy({
      blockers: {
        open: [blocker({
          kind: 'AWAITING_USER_APPROVAL', owner: 'USER', recovery: 'HUMAN', severity: 'INFO',
          subjectType: 'SESSION', subjectId: SESSION,
          requiredAction: 'Approve or reject the pending action.',
        })],
        openEmptyReason: null, resolved: [],
      },
    })} />);
    expect(html).toContain('Waiting for your approval');
    expect(html).toContain('Approve or reject the pending action.');
    // Answered in the session that asked — this page offers no approve button, because the API
    // behind this screen has none.
    expect(html).toContain('answered in the session that asked');
    expect(html).toContain(`href="/sessions/${encodeId(SESSION)}"`);
    expect(html).not.toContain('>Approve<');
  });

  it('renders a coordinator that made no progress as the blocker it is', () => {
    const html = paint(<CoordinatorBlockers status={busy({
      blockers: {
        open: [blocker({
          kind: 'COORDINATOR_NO_PROGRESS', owner: 'USER', recovery: 'HUMAN', severity: 'CRITICAL',
          subjectType: 'PROJECT', subjectId: 'p1', escalatedAt: '2026-08-20T09:30:00.000Z',
          requiredAction: 'The coordinator ran on these facts and did not change them; take it from here.',
        })],
        openEmptyReason: null, resolved: [],
      },
    })} />);
    expect(html).toContain('Coordinator made no progress');
    expect(html).toContain('escalated');
    expect(html).toContain('not run again on them');
  });

  it('says nothing is blocking rather than showing an empty list', () => {
    const html = paint(<CoordinatorBlockers status={busy()} />);
    expect(html).toContain('Nothing is blocking this project right now.');
  });

  it('keeps resolved episodes, marked as resolved and by whom', () => {
    const html = paint(<CoordinatorBlockers status={busy({
      blockers: {
        open: [], openEmptyReason: 'NO_OPEN_BLOCKER',
        resolved: [blocker({ id: 'b0', resolvedAt: '2026-08-20T08:00:00.000Z', resolvedBy: 'AUTO' })],
      },
    })} />);
    expect(html).toContain('1 resolved earlier');
    expect(html).toContain('resolved');
    expect(html).toContain('AUTO');
  });
});

describe('the manual trigger', () => {
  it('says what it does and does not do', () => {
    const html = paint(<CoordinatorTrigger {...noopTrigger} status={busy()} readOnly={false} />);
    expect(html).toContain('It grants nothing and skips nothing');
    expect(html).toContain('policy, authorization,');
  });

  it('tells a queued press apart from one that matched a signal already waiting', () => {
    const queued = paint(<CoordinatorTrigger
      {...noopTrigger} status={busy()} readOnly={false}
      result={{
        triggerId: 't1', accepted: true, configRevision: '7', automationPolicy: 'GUARDED_AUTO',
        eventId: 'e1', occurrences: 1, deduplicated: false,
        occurredAt: '2026-08-20T10:00:00.000Z', consumedAt: null, nextAttemptAt: null,
      }}
    />);
    const twice = paint(<CoordinatorTrigger
      {...noopTrigger} status={busy()} readOnly={false}
      result={{
        triggerId: 't1', accepted: true, configRevision: '7', automationPolicy: 'GUARDED_AUTO',
        eventId: 'e1', occurrences: 2, deduplicated: true,
        occurredAt: '2026-08-20T10:00:00.000Z', consumedAt: null, nextAttemptAt: null,
      }}
    />);
    expect(queued).toContain('Queued against configRevision 7');
    expect(queued).toContain('it is not running yet');
    expect(twice).toContain('Already queued');
    expect(twice).toContain('one run and not two');
  });

  it('shows the server’s refusal verbatim when a press fails', () => {
    const html = paint(<CoordinatorTrigger
      {...noopTrigger} status={busy()} readOnly={false}
      error={new Error('this project is DONE, and a settled project’s coordinator does not run')}
    />);
    expect(html).toContain('The coordinator was not triggered');
    expect(html).toContain('a settled project’s coordinator does not run');
  });
});

describe('the settings form writes with a fence and never over somebody else', () => {
  it('states the revision it is writing against', () => {
    const html = paint(<CoordinatorPolicyForm
      {...noopPolicy(policyDraftOf(busy()))} status={busy()} readOnly={false}
    />);
    expect(html).toContain('At configRevision 7');
    expect(html).toContain('refused rather than merged');
  });

  it('describes each automation level as what it is', () => {
    for (const [policy, phrase] of [
      ['MANUAL', 'This is not “off”'],
      ['GUARDED_AUTO', 'stops at the boundaries that need a person'],
      ['AUTO', 'willing to leave running'],
    ] as const) {
      const status = busy();
      status.policy.automationPolicy = policy;
      const html = paint(<CoordinatorPolicyForm
        {...noopPolicy(policyDraftOf(status))} status={status} readOnly={false}
      />);
      expect(html, policy).toContain(phrase);
    }
  });

  it('will not save an untouched form, and says why that is deliberate', () => {
    const html = paint(<CoordinatorPolicyForm
      {...noopPolicy(policyDraftOf(busy()))} status={busy()} readOnly={false}
    />);
    expect(html).toContain('Nothing is changed');
    expect(html).toContain('refuse somebody else’s in-flight edit');
  });

  it('asks for a confirmation before it hands the coordinator more room', () => {
    const status = busy();
    const html = paint(<CoordinatorPolicyForm
      {...noopPolicy({ ...policyDraftOf(status), automationPolicy: 'AUTO' })}
      status={status} readOnly={false}
    />);
    expect(html).toContain('This edit gives the coordinator more room');
    expect(html).toContain('Guarded auto to Auto');
    expect(html).toContain('Confirm the box above before this can be saved.');
  });

  it('does not ask for one when the edit hands it no more room', () => {
    const status = busy();
    const html = paint(<CoordinatorPolicyForm
      {...noopPolicy({ ...policyDraftOf(status), maxConcurrentTasks: 8 })}
      status={status} readOnly={false}
    />);
    expect(html).not.toContain('This edit gives the coordinator more room');
  });

  it('shows a refused compare-and-swap as a conflict, keeps the edit, and closes Save', () => {
    const status = busy();
    const html = paint(<CoordinatorPolicyForm
      {...noopPolicy({ ...policyDraftOf(status), maxConcurrentTasks: 8 })}
      status={status} readOnly={false}
      conflict={{ message: 'this project is at configRevision 9, not 7 — its coordination settings changed after you read them, so nothing was written' }}
    />);
    expect(html).toContain('Refused — these settings changed under you');
    expect(html).toContain('configRevision 9, not 7');
    expect(html).toContain('Nothing was written.');
    expect(html).toContain('Review current settings');
    // The write path is shut until the reader has looked — otherwise the next press would carry
    // the revision that just superseded theirs, and succeed.
    expect(html).toContain('Review the current settings before writing again.');
  });

  it('shows an ordinary failure as itself, not as a conflict', () => {
    const status = busy();
    const html = paint(<CoordinatorPolicyForm
      {...noopPolicy({ ...policyDraftOf(status), maxConcurrentTasks: 8 })}
      status={status} readOnly={false} error={new Error('network unreachable')}
    />);
    expect(html).toContain('Settings were not saved');
    expect(html).toContain('network unreachable');
    expect(html).not.toContain('changed under you');
  });
});

describe('acceptance evidence is evidence, never a verdict', () => {
  it('says an acceptance that never ran never ran', () => {
    const html = paint(<CoordinatorAcceptance status={busy()} />);
    expect(html).toContain('Project acceptance has never run here.');
    expect(html).toContain('not the same as passed');
    expect(html).toContain('No verification task has been filed in this project.');
    expect(html).toContain('no merge evidence to show');
  });

  it('shows verdict tallies and per-branch merge state without concluding from them', () => {
    const html = paint(<CoordinatorAcceptance status={busy({
      acceptance: {
        criteria: 'All checks pass.', criteriaAbsentReason: null, attempt: '2',
        // A run that DID pass, against facts that have since moved. Both halves matter on screen:
        // the conclusion is shown as the conclusion it was, and the gate is shown refusing — a
        // screen that hid either would be answering "can this be closed" by itself.
        run: {
          id: 'ar1', attempt: '1', verdict: 'PASS', decidedBy: 'COORDINATOR_AGENT',
          criteriaRevision: 'c'.repeat(64), inputDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
          supersededAt: null, supersededReason: null,
          startedAt: '2026-08-20T09:00:00.000Z', completedAt: '2026-08-20T09:04:00.000Z',
          criteria: [
            {
              id: 'ac1', ordinal: 1, criterionKey: 'k1', criterionText: 'All checks pass.',
              verdict: 'PASS', summary: '28/28 on a disposable database', evidence: {},
              evidenceTaskId: null, evidenceSessionId: null, decidedAt: '2026-08-20T09:04:00.000Z',
            },
          ],
        },
        runAbsentReason: null,
        doneGate: {
          allowed: false, runId: null, refusalCode: 'ACCEPTANCE_EVIDENCE_STALE',
          reason: 'a task changed after that run', acceptanceDigest: 'd'.repeat(64),
        },
        lastRun: {
          id: 'ac9', decisionId: 'd9', type: 'RUN_PROJECT_ACCEPTANCE', status: 'APPLIED',
          subjectType: 'PROJECT', subjectId: 'p1', idempotencyKey: 'pc:v1:p:acceptance:2',
          refusalCode: null, reasonCode: null, resultSessionId: RESULT_SESSION, fencingToken: '11',
          createdAt: '2026-08-20T09:00:00.000Z', updatedAt: '2026-08-20T09:05:00.000Z',
        },
        lastRunAbsentReason: null,
        evidence: {
          verifications: { total: 4, pending: 1, pass: 2, fail: 1, inconclusive: 0, unresolvedFailures: 1 },
          merges: [
            {
              sessionId: SESSION, taskId: TASK, taskTitle: 'do the thing', taskStatus: 'DONE',
              branch: 'orbit/thing', baseSha: 'abc', mergeStatus: 'merged', mergeTarget: 'main',
              mergedSourceSha: 'def', branchMerged: true, mergedAt: '2026-08-20T08:00:00.000Z',
              commitStatus: 'clean', worktreeDirty: false,
            },
            {
              sessionId: RESULT_SESSION, taskId: null, taskTitle: null, taskStatus: null,
              branch: 'orbit/other', baseSha: null, mergeStatus: null, mergeTarget: null,
              mergedSourceSha: null, branchMerged: null, mergedAt: null,
              commitStatus: null, worktreeDirty: true,
            },
          ],
          mergesEmptyReason: null,
        },
      },
    })} />);
    expect(html).toContain('2 pass');
    expect(html).toContain('1 unresolved');
    expect(html).toContain('merged into main');
    // An unreported merge state is stated as unreported — never as "not merged", and never as done.
    expect(html).toContain('merge state not reported');
    expect(html).toContain('worktree dirty');
    expect(html).toContain('RUN_PROJECT_ACCEPTANCE');
    // The native record: what it concluded, criterion by criterion, and who concluded it.
    expect(html).toContain('attempt 1');
    expect(html).toContain('by COORDINATOR_AGENT');
    expect(html).toContain('1. All checks pass.');
    expect(html).toContain('28/28 on a disposable database');
    // ...and the gate, reported rather than re-decided: the code the write path would refuse with,
    // and the sentence that says what to do about it.
    expect(html).toContain('ACCEPTANCE_EVIDENCE_STALE');
    expect(html).toContain('Run acceptance again');
  });
});

describe('the decision ledger', () => {
  it('shows the transition, the snapshot it decided on, and what came of it', () => {
    const html = paint(<CoordinatorDecisions status={busy({
      decisions: [{
        id: 'd1', createdAt: '2026-08-20T09:59:00.000Z', decidedBy: 'COORDINATOR',
        reason: 'rotated the coordination session', decisionInputHash: 'h-abc', fencingToken: '11',
        coordinatorAgentId: AGENT, coordinatorSessionId: SESSION,
        runStateBefore: 'PLANNING', runStateAfter: 'EXECUTING', configRevision: '7',
        nextWakeAt: null, nextWakeReason: null,
        actions: [{
          id: 'ac1', decisionId: 'd1', type: 'ROTATE_COORDINATOR_SESSION', status: 'APPLIED',
          subjectType: 'PROJECT', subjectId: 'p1', idempotencyKey: 'pc:v1:p:rotate:3',
          refusalCode: null, reasonCode: null, resultSessionId: RESULT_SESSION, fencingToken: '11',
          createdAt: '2026-08-20T09:59:00.000Z', updatedAt: '2026-08-20T09:59:01.000Z',
        }],
      }],
      decisionsEmptyReason: null,
    })} />);
    expect(html).toContain('PLANNING → EXECUTING');
    expect(html).toContain('h-abc');
    expect(html).toContain('ROTATE_COORDINATOR_SESSION');
    expect(html).toContain('pc:v1:p:rotate:3');
    expect(html).toContain(`href="/sessions/${encodeId(RESULT_SESSION)}"`);
  });

  it('says a decision produced nothing rather than showing an empty row', () => {
    const html = paint(<CoordinatorDecisions status={busy({
      decisions: [{
        id: 'd2', createdAt: '2026-08-20T09:59:00.000Z', decidedBy: 'SYSTEM', reason: null,
        decisionInputHash: null, fencingToken: '11', coordinatorAgentId: null,
        coordinatorSessionId: null, runStateBefore: null, runStateAfter: null,
        configRevision: null, nextWakeAt: null, nextWakeReason: null, actions: [],
      }],
      decisionsEmptyReason: null,
    })} />);
    expect(html).toContain('No action came of it.');
    expect(html).toContain('no run-state transition recorded');
    expect(html).toContain('not recorded');
  });

  it('says a project has never been reconciled rather than showing nothing', () => {
    expect(paint(<CoordinatorDecisions status={busy()} />)).toContain('never been reconciled');
  });
});

describe('§13.8: what happened to this project’s @-mentions', () => {
  it('says nothing arrived stuck when the server tracked and found none', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
        status={busy({
          acceptance: {
            ...busy().acceptance,
            evidence: {
              ...busy().acceptance.evidence,
              undeliveredMentions: [],
              undeliveredMentionsEmptyReason: 'NO_UNDELIVERED_MENTION',
            },
          },
        })}
      />,
    );
    expect(html).toContain('reached the agent it named');
  });

  it('does NOT claim that when the server never tracked it', () => {
    // Mixed version: a new client against an old server. `undefined` is "no opinion", and
    // collapsing it into an empty list would report every mention delivered on the strength of a
    // field that was never sent.
    const status = busy();
    delete (status.acceptance.evidence as any).undeliveredMentions;
    delete (status.acceptance.evidence as any).undeliveredMentionsEmptyReason;
    const html = paint(
      <ProjectCoordinatorPanel
        loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
        status={status}
      />,
    );
    expect(html).toContain('does not track');
    expect(html).not.toContain('reached the agent it named');
  });

  it('names the task, the agent and what would clear a stuck one', () => {
    const html = paint(
      <ProjectCoordinatorPanel
        loading={false} error={null} onRetry={() => {}} readOnly={false}
        trigger={noopTrigger} policy={noopPolicy(policyDraftOf(busy()))}
        status={busy({
          acceptance: {
            ...busy().acceptance,
            evidence: {
              ...busy().acceptance.evidence,
              undeliveredMentions: [{
                id: 'd1', taskId: TASK, workspaceId: WORKSPACE, status: 'BLOCKED' as const,
                attempts: 0, errorCode: 'NO_RUNNER',
                requiredAction: 'bind this agent to a runner',
                lastError: null,
                nextAttemptAt: '2026-08-20T10:05:00.000Z',
                createdAt: '2026-08-20T10:00:00.000Z',
              }],
              undeliveredMentionsEmptyReason: null,
            },
          },
        })}
      />,
    );
    expect(html).toContain('NO_RUNNER');
    expect(html).toContain('bind this agent to a runner');
    expect(html).toContain('not delivered yet');
  });
});
