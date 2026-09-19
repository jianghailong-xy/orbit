import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { BG_JOB_ACTIVITY_STALE_AFTER_MS } from './background-job-activity';
import { SessionsService } from './sessions.service';

test('workspace counts separate queued activity from Session-list spinner work', async () => {
  const groupByCalls: any[] = [];
  const findManyCalls: any[] = [];
  const now = Date.now();
  // Every session with a job in flight, and the one thing that separates them: whether the job is
  // still MOVING. `w-jobs` reported output seconds ago; `w-stalled` has produced nothing since well
  // before the threshold, which makes it a process rather than work in progress — it stays in
  // `running_bg_shells` and in the clients' tray, and it is deliberately absent from this tally.
  // `w-unknown` is the third shape: a job nobody has reported progress on (an older runner), which
  // is unknown rather than stalled and counts exactly as it did before the rule existed.
  const sessionsWithJobs = [
    {
      workspaceId: 'w-jobs',
      runningBgJobs: ['bgj_live'],
      runningBgJobActivity: { bgj_live: now - 5_000 },
    },
    {
      workspaceId: 'w-stalled',
      runningBgJobs: ['bgj_stalled'],
      runningBgJobActivity: { bgj_stalled: now - BG_JOB_ACTIVITY_STALE_AFTER_MS - 60_000 },
    },
    { workspaceId: 'w-unknown', runningBgJobs: ['bgj_unreported'], runningBgJobActivity: {} },
  ];
  const prisma = {
    session: {
      groupBy: async (args: any) => {
        groupByCalls.push(args);
        // Two different populations reach this one method, told apart by what they ask for rather
        // than by call order, so adding a tally elsewhere cannot silently rewire this fixture.
        //
        // The first is admitted work: w-queued is intentionally present here only. The second is
        // the exact spinner population: a normal RUNNING row, a self-driven engine turn, or a
        // parked parent whose sub-agent is still working. (The jobs-only tally used to be a third;
        // it is a findMany now, because whether a job still counts is a fact about `now`.)
        if (args?.where?.status) {
          return [
            { workspaceId: 'w-queued', _count: { _all: 1 } },
            { workspaceId: 'w-running', _count: { _all: 2 } },
          ];
        }
        return [
          { workspaceId: 'w-running', _count: { _all: 1 } },
          { workspaceId: 'w-engine-turn', _count: { _all: 1 } },
          { workspaceId: 'w-subagent', _count: { _all: 1 } },
        ];
      },
      findMany: async (args: any) => {
        findManyCalls.push(args);
        // Four different questions reach this method, told apart by what they ask for rather than
        // by call order. The first is the jobs-only set — work in flight with nobody generating,
        // which is neither of the others: a workspace whose only live session is parked with a
        // `bg_run` job and no turn in it. The second is the blocked-on-a-tool-call population; the
        // third is the cards a runner-hosted JOB is still reading — the one population a turn rule
        // cannot see, since there need not be a live turn at all — and the fourth resolves the
        // conversations an owner DECISION is waiting on (`projects/owner-decision-signal.ts`) to
        // the workspaces they run in.
        if (args?.where?.runningBgJobs) {
          return sessionsWithJobs;
        }
        if (args?.where?.approvals) {
          return [
            { id: 's-running', workspaceId: 'w-running' },
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
    // The other kind of owner decision, evidence waiting on the coordinator's card: none here.
    task: { findMany: async () => [] },
    // And the third, an OWNER_CONFIRMED task's run waiting on its owner in the task's own session:
    // none here either, so every `needsYou` below is still a statement about the first two.
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    // …and the four owner items a project can be waiting on its owner for (§7.6 V13),
    // which these fixtures have none of either.
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
    needsYou: 0,
  });
  assert.deepEqual(byWorkspace.get('w-running'), {
    workspaceId: 'w-running',
    active: 2,
    running: 1,
    jobs: 0,
    needsYou: 1,
  });
  // The third tally, and the only row here that is neither generating nor waiting on anyone: the
  // rail draws its own quieter mark for it rather than borrowing either of theirs.
  assert.deepEqual(byWorkspace.get('w-jobs'), {
    workspaceId: 'w-jobs',
    active: 0,
    running: 0,
    jobs: 1,
    needsYou: 0,
  });
  // The same session shape with one thing changed — the job stopped producing long enough ago — and
  // the tally drops it. The job is still a process, which is a different set on the same row
  // (`runningBgShells`), and the clients still list it in the tray.
  //
  // The workspace is then absent from the answer rather than present with a zero, which is what a
  // workspace with nothing to count has always been: the rail builds its map from the rows it gets
  // and reads a missing workspace as 0 (TasksSidePanel), so an entry of zeros would say nothing the
  // absence does not.
  assert.equal(byWorkspace.get('w-stalled'), undefined);
  // And the third: nobody has said when this job last produced output, which is not the same claim
  // as "it has produced nothing for ten minutes". Counting it either way is a choice; counting it
  // as work in flight is the one that leaves an older runner behaving exactly as it does today.
  assert.deepEqual(byWorkspace.get('w-unknown'), {
    workspaceId: 'w-unknown',
    active: 0,
    running: 0,
    jobs: 1,
    needsYou: 0,
  });
  assert.equal(byWorkspace.get('w-engine-turn')?.running, 1);
  assert.equal(byWorkspace.get('w-subagent')?.running, 1);
  assert.deepEqual(byWorkspace.get('w-needs-you'), {
    workspaceId: 'w-needs-you',
    active: 0,
    running: 0,
    jobs: 0,
    needsYou: 1,
  });
  // The third source, and the one the other two cannot see: a card a runner-hosted job is still
  // reading on a conversation that is parked — no turn in flight, a live process polling for the
  // answer. The rail lights for it, and lights for exactly it: the same conversation shape with the
  // job gone is not a question (its card is what the reap collects), and a card naming no job at all
  // is the turn's, which is over.
  assert.deepEqual(byWorkspace.get('w-job-live'), {
    workspaceId: 'w-job-live',
    active: 0,
    running: 0,
    jobs: 0,
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
    needsYou: 1,
  });
  // And it is scoped to the Open list the same way the blocked query is, so a decision waiting on
  // a conversation the owner filed away does not light a workspace they are not looking at.
  const decisionQuery = findManyCalls.find(
    (call) => !call?.where?.approvals && !call?.where?.runningBgJobs && !call?.where?.runningBgShells,
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
      select: { backgroundJobId: true },
    },
  });

  // The jobs tally is still a lookup on the denormalized set — candidates that hold no job in
  // flight are never read — and still over the same Open scope as the other two.
  const jobsQuery = findManyCalls.find((call) => call?.where?.runningBgJobs);
  assert.deepEqual(jobsQuery.where.runningBgJobs, { isEmpty: false });
  assert.equal(jobsQuery.where.completedAt, null);
  assert.equal(jobsQuery.where.deletedAt, null);
  // It reads the two columns the verdict needs and nothing else: the verdict itself is not stored
  // anywhere, so it cannot be selected.
  assert.deepEqual(jobsQuery.select, {
    workspaceId: true,
    runningBgJobs: true,
    runningBgJobActivity: true,
  });

  assert.deepEqual(groupByCalls[0].where.status.in, [RunStatus.RUNNING, RunStatus.PENDING]);
  assert.deepEqual(groupByCalls[1].where.OR, [
    { status: RunStatus.RUNNING },
    {
      status: RunStatus.AWAITING_INPUT,
      OR: [{ engineTurnActive: true }, { runningSubagents: { isEmpty: false } }],
    },
  ]);
});
