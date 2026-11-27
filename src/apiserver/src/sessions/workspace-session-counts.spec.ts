import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import { SESSION_EXECUTING_EXCEPT_BG_JOB_WHERE } from '../common/session-working';
import { BG_JOB_ACTIVITY_STALE_AFTER_MS } from './background-job-activity';
import { SessionsService } from './sessions.service';
import { turnStateFilter } from './session-turn-state';

test('workspace counts separate queued activity from Session-list spinner work', async () => {
  const groupByCalls: any[] = [];
  const findManyCalls: any[] = [];
  const now = Date.now();
  // Every session with a job in flight, and the one thing that separates them: whether the job is
  // still MOVING. `w-jobs` reported output seconds ago; `w-stalled` has produced nothing since well
  // before the threshold: still executing, so it is counted, as `stalledJobs` rather than `jobs` —
  // the rail's breathing mark stops where nothing is moving without the work disappearing.
  // `w-unknown` is the third shape: a job nobody has reported progress on (an older runner), which
  // is unknown rather than stalled and counts exactly as it did before the rule existed.
  const sessionsWithJobs = [
    {
      id: 's-jobs',
      workspaceId: 'w-jobs',
      runningBgJobs: ['bgj_live'],
      runningBgJobActivity: { bgj_live: now - 5_000 },
    },
    {
      id: 's-stalled',
      workspaceId: 'w-stalled',
      runningBgJobs: ['bgj_stalled'],
      runningBgJobActivity: { bgj_stalled: now - BG_JOB_ACTIVITY_STALE_AFTER_MS - 60_000 },
    },
    { id: 's-unknown', workspaceId: 'w-unknown', runningBgJobs: ['bgj_unreported'], runningBgJobActivity: {} },
    // A job as live as `w-jobs`' — but it is the job still reading the card below that needs you,
    // and a session that needs you is counted there only.
    {
      id: 's-job-live',
      workspaceId: 'w-job-live',
      runningBgJobs: ['bgj_up'],
      runningBgJobActivity: { bgj_up: now - 5_000 },
    },
  ];
  const rawCalls: any[] = [];
  const prisma = {
    // The fold read: which failures the list folds into a project row. `s-failed-member` is a task run
    // in a project whose coordinator shares its workspace.
    $queryRaw: async (sql: any) => {
      rawCalls.push(sql);
      return [{ id: 's-failed-member' }];
    },
    session: {
      groupBy: async (args: any) => {
        groupByCalls.push(args);
        // Admitted work: w-queued is intentionally present here only. (The spinner and jobs-only
        // tallies used to reach this method too; they are findMany now — the jobs one because
        // whether a job still counts is a fact about `now`, the spinner one because a session
        // that needs you is taken back out of it by id.)
        return [
          { workspaceId: 'w-queued', _count: { _all: 1 } },
          { workspaceId: 'w-running', _count: { _all: 2 } },
        ];
      },
      findMany: async (args: any) => {
        findManyCalls.push(args);
        // Five different questions reach this method, told apart by what they ask for rather than
        // by call order. The first is the jobs-only set — work in flight with nobody generating,
        // which is neither of the others: a workspace whose only live session is parked with a
        // `bg_run` job and no turn in it. The second is the blocked-on-a-tool-call population; the
        // third is the cards a runner-hosted JOB is still reading — the one population a turn rule
        // cannot see, since there need not be a live turn at all — the fourth is the spinner
        // population, and the fifth resolves the conversations an owner DECISION is waiting on
        // (`projects/owner-decision-signal.ts`) to the workspaces they run in.
        if (args?.where?.lastTurnOutcome) {
          // Failures nobody is retrying: one alone in its workspace, and one beside a blocked turn
          // in `w-needs-you` — still one place to go, so it adds nothing there.
          return [
            { id: 's-failed', workspaceId: 'w-failed' },
            { id: 's-needs-you', workspaceId: 'w-needs-you' },
            { id: 's-failed-member', workspaceId: 'w-failed-member' },
          ];
        }
        if (args?.where?.runningBgJobs && !args?.where?.OR) {
          return sessionsWithJobs;
        }
        if (args?.where?.approvals) {
          return [
            { id: 's-blocked', workspaceId: 'w-running' },
            { id: 's-needs-you', workspaceId: 'w-needs-you' },
          ];
        }
        if (args?.where?.runningBgShells) {
          // Two conversations spelled the same way, told apart only by whether the card names the
          // job that is up: `bgj_up` is in the shell set and `bgj_gone` is not, which is the whole
          // rule. The third row holds a card with no job at all on a conversation with a shell up —
          // an in-turn card left on a parked session, which is nobody's question and must not be
          // lit by this path.
          return [
            {
              id: 's-job-live',
              workspaceId: 'w-job-live',
              runningBgShells: ['bgj_up'],
              approvals: [{ backgroundJobId: 'bgj_up' }],
            },
            {
              id: 's-job-gone',
              workspaceId: 'w-job-gone',
              runningBgShells: ['bgj_up'],
              approvals: [{ backgroundJobId: 'bgj_gone' }],
            },
            {
              id: 's-turn-card',
              workspaceId: 'w-turn-card',
              runningBgShells: ['bgj_up'],
              approvals: [{ backgroundJobId: null }],
            },
          ];
        }
        if (args?.where?.OR) {
          // The exact spinner population before anything is taken out: a normal RUNNING row, a
          // self-driven engine turn, a parked parent whose sub-agent is still working — and the two
          // turns blocked on a tool call above, which are generating too.
          return [
            { id: 's-running', workspaceId: 'w-running' },
            { id: 's-blocked', workspaceId: 'w-running' },
            { id: 's-engine-turn', workspaceId: 'w-engine-turn' },
            { id: 's-subagent', workspaceId: 'w-subagent' },
            { id: 's-needs-you', workspaceId: 'w-needs-you' },
          ];
        }
        return [{ id: 's-coordinator', workspaceId: 'w-decision' }];
      },
    },
    // One project, coordinated from `s-coordinator`, with one filed weakening proposal that
    // nothing has answered or displaced. No Approval row exists for it anywhere — that is the
    // whole point of the second source.
    project: {
      findMany: async () => [{ id: 'p-1', coordinatorSessionId: 's-coordinator' }],
    },
    projectRatifiedActionIntent: {
      findMany: async () => [{ id: 'intent-1', projectId: 'p-1', action: {} }],
    },
    // "Answered" has two landings and `settledIntentIds` reads both: a commit row, a decision row.
    // This proposal has neither, so it is still a question — which is why `w-decision` needs you.
    projectRatifiedActionCommit: { findMany: async () => [] },
    projectCriteriaDecision: { findMany: async () => [] },
    // The fourth source the signal counts, read inside the same `readProjectDecisionSignals` as the
    // proposal above because it lands the same way — a project decision waiting on the coordinator's
    // conversation (`standard-set-awaiting-confirmation.ts`, the confirmation card's own four facts).
    // Its three reads answer with nothing here, which is what the card not being drawn looks like:
    // `p-1` states no criteria and holds no task, and either fact alone closes the question. So
    // every `needsYou` below is still a statement about the held proposal.
    projectAcceptanceCriterionDefinition: { findMany: async () => [] },
    projectStandardSetConfirmation: { findMany: async () => [] },
    projectTaskStatusCount: { findMany: async () => [] },
    // The other kind of owner decision, evidence waiting on the coordinator's card: none here.
    task: { findMany: async () => [] },
    // And the third, an OWNER_CONFIRMED task's run waiting on its owner in the task's own session:
    // none here either, so every `needsYou` below is still a statement about the first two.
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    // …and the four owner items a project can be waiting on its owner for (§7.6 V13),
    // which these fixtures have none of either.
    // The open owner requests and waiting task moves the same row counts (none here).
    ownerRequest: { findMany: async () => [] },
    projectHandoffApproval: { findMany: async () => [] },
    projectOpenItem: { findMany: async () => [] },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const result = await service.workspaceSessionCounts('owner-1');
  const byWorkspace = new Map(result.map((row) => [row.workspaceId, row]));

  assert.deepEqual(byWorkspace.get('w-queued'), {
    workspaceId: 'w-queued',
    active: 1,
    running: 0,
    jobs: 0,
    stalledJobs: 0,
    needsYou: 0,
  });
  // Two turns in flight, one of them blocked on you: the count says the blocked one and the spinner
  // tally says the other — the sidebar draws them side by side, so neither may say both.
  assert.deepEqual(byWorkspace.get('w-running'), {
    workspaceId: 'w-running',
    active: 2,
    running: 1,
    jobs: 0,
    stalledJobs: 0,
    needsYou: 1,
  });
  // The third tally, and the only row here that is neither generating nor waiting on anyone: the
  // rail draws its own quieter mark for it rather than borrowing either of theirs.
  assert.deepEqual(byWorkspace.get('w-jobs'), {
    workspaceId: 'w-jobs',
    active: 0,
    running: 0,
    jobs: 1,
    stalledJobs: 0,
    needsYou: 0,
  });
  // The same session shape with one thing changed — the job stopped producing long enough ago. It is
  // still executing (common/session-working.ts), so the workspace is still counted; the flag beside
  // it moves it from `jobs` to `stalledJobs`, the same verdict the task carrier's `runStalled` gives.
  assert.deepEqual(byWorkspace.get('w-stalled'), {
    workspaceId: 'w-stalled',
    active: 0,
    running: 0,
    jobs: 0,
    stalledJobs: 1,
    needsYou: 0,
  });
  // And the third: nobody has said when this job last produced output, which is not the same claim
  // as "it has produced nothing for ten minutes". Counting it either way is a choice; counting it
  // as work in flight is the one that leaves an older runner behaving exactly as it does today.
  assert.deepEqual(byWorkspace.get('w-unknown'), {
    workspaceId: 'w-unknown',
    active: 0,
    running: 0,
    jobs: 1,
    stalledJobs: 0,
    needsYou: 0,
  });
  assert.equal(byWorkspace.get('w-engine-turn')?.running, 1);
  assert.equal(byWorkspace.get('w-subagent')?.running, 1);
  // Its only turn is blocked on you: generating, and still not the spinner — the Session list draws
  // this row with the waiting glyph — so the dot stays dark beside the count.
  assert.deepEqual(byWorkspace.get('w-needs-you'), {
    workspaceId: 'w-needs-you',
    active: 0,
    running: 0,
    jobs: 0,
    stalledJobs: 0,
    needsYou: 1,
  });
  // The third source, and the one the other two cannot see: a card a runner-hosted job is still
  // reading on a conversation that is parked — no turn in flight, a live process polling for the
  // answer. The rail lights for it, and lights for exactly it: the same conversation shape with the
  // job gone is not a question (its card is what the reap collects), and a card naming no job at all
  // is the turn's, which is over. Its job is still producing output, and `jobs` leaves it out all
  // the same: the one thing this workspace is doing is waiting on you.
  assert.deepEqual(byWorkspace.get('w-job-live'), {
    workspaceId: 'w-job-live',
    active: 0,
    running: 0,
    jobs: 0,
    stalledJobs: 0,
    needsYou: 1,
  });
  assert.equal(byWorkspace.get('w-job-gone'), undefined);
  assert.equal(byWorkspace.get('w-turn-card'), undefined);
  // The second source: a conversation with an unanswered owner decision on it and no approval row
  // anywhere. It is neither running nor queued, so `needsYou` is the only thing this workspace has
  // — which is exactly the state the tally used to report as nothing at all.
  assert.deepEqual(byWorkspace.get('w-decision'), {
    workspaceId: 'w-decision',
    active: 0,
    running: 0,
    jobs: 0,
    stalledJobs: 0,
    needsYou: 1,
  });
  // A failed session with no retry armed sits in the Session list's Needs you section, so the rail
  // counts it there too, by the failure facts (common/session-release.ts) over the same Open scope.
  assert.deepEqual(byWorkspace.get('w-failed'), {
    workspaceId: 'w-failed',
    active: 0,
    running: 0,
    jobs: 0,
    stalledJobs: 0,
    needsYou: 1,
  });
  // A failed member of a project is folded into its project's row, which a failure does not light,
  // so the list has no Needs you row for it and the rail counts nothing.
  assert.equal(byWorkspace.get('w-failed-member'), undefined);
  assert.equal(rawCalls.length, 1);
  assert.deepEqual(rawCalls[0].values.find(Array.isArray), ['s-failed', 's-needs-you', 's-failed-member']);
  const failedQuery = findManyCalls.find((call) => call?.where?.lastTurnOutcome);
  assert.deepEqual(failedQuery.where.finishedAt, { not: null });
  assert.equal(failedQuery.where.endReason, null);
  assert.equal(failedQuery.where.retryAt, null);
  assert.equal(failedQuery.where.completedAt, null);
  assert.equal(failedQuery.where.deletedAt, null);
  // And it is scoped to the Open list the same way the blocked query is, so a decision waiting on
  // a conversation the owner filed away does not light a workspace they are not looking at.
  const decisionQuery = findManyCalls.find(
    (call) =>
      !call?.where?.approvals &&
      !call?.where?.runningBgJobs &&
      !call?.where?.runningBgShells &&
      !call?.where?.lastTurnOutcome &&
      !call?.where?.OR,
  );
  assert.equal(decisionQuery.where.completedAt, null);
  assert.equal(decisionQuery.where.deletedAt, null);

  // The job-card tally is the same kind of lookup: candidates are the conversations with any shell
  // up, the same Open scope, and it reads only what the rule needs — the shell set, and the pending
  // cards' job ids. The card rows are fetched narrowed to the ones that name a job, because a card
  // that names none is the turn's and this question is not about the turn.
  const jobCardsQuery = findManyCalls.find((call) => call?.where?.runningBgShells);
  assert.deepEqual(jobCardsQuery.where.runningBgShells, { isEmpty: false });
  assert.equal(jobCardsQuery.where.completedAt, null);
  assert.equal(jobCardsQuery.where.deletedAt, null);
  assert.deepEqual(jobCardsQuery.select, {
    id: true,
    workspaceId: true,
    runningBgShells: true,
    approvals: {
      where: { status: 'PENDING', backgroundJobId: { not: null } },
      select: { id: true, toolName: true, backgroundJobId: true },
    },
  });

  // The jobs tally is still a lookup on the denormalized set — candidates that hold no job in
  // flight are never read — and still over the same Open scope as the other two.
  const jobsQuery = findManyCalls.find((call) => call?.where?.runningBgJobs);
  assert.deepEqual(jobsQuery.where.runningBgJobs, { isEmpty: false });
  // Held: the release column (common/session-release.ts heldFilter), not the held statuses.
  assert.equal(jobsQuery.where.finishedAt, null);
  assert.equal(jobsQuery.where.status, undefined);
  assert.equal(jobsQuery.where.completedAt, null);
  assert.equal(jobsQuery.where.deletedAt, null);
  // It reads the two columns the verdict needs and nothing else — the verdict itself is not stored
  // anywhere, so it cannot be selected — plus the id a session that needs you is taken out by.
  assert.deepEqual(jobsQuery.select, {
    id: true,
    workspaceId: true,
    runningBgJobs: true,
    runningBgJobActivity: true,
  });

  assert.equal(groupByCalls.length, 1);
  // Admitted work: held with a turn queued or in flight (session-turn-state.ts).
  assert.deepEqual(groupByCalls[0].where.OR, turnStateFilter(['QUEUED', 'IN_FLIGHT']).OR);
  assert.equal(groupByCalls[0].where.finishedAt, null);
  // The blocked query carries an `OR` too (GENERATING_SESSION_FILTER), which is why it is ruled out
  // by its `approvals`.
  const runningQuery = findManyCalls.find((call) => call?.where?.OR && !call?.where?.approvals);
  // The shared definition, background jobs aside: a dispatched turn, or on a session that has not
  // ended the engine's own turn or a subagent (common/session-working.ts).
  assert.deepEqual(runningQuery.where.OR, SESSION_EXECUTING_EXCEPT_BG_JOB_WHERE.OR);
  // A dispatched turn is the turn state IN_FLIGHT; "not ended" is held (finished_at IS NULL).
  assert.deepEqual(runningQuery.where.OR, [
    turnStateFilter(['IN_FLIGHT']),
    {
      finishedAt: null,
      OR: [{ engineTurnActive: true }, { runningSubagents: { isEmpty: false } }],
    },
  ]);
  assert.equal(runningQuery.where.completedAt, null);
  assert.equal(runningQuery.where.deletedAt, null);
  assert.deepEqual(runningQuery.select, { id: true, workspaceId: true });
});
