import type { LandTaskIntegrationView, ProjectIntegrationView, TaskIntegrationView } from '@orbit/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ProjectIntegrationLine } from './ProjectIntegrationLine';

const PROJECT = 'project19';
const QUEUED = '2026-10-04T01:00:00.000Z';
const STARTED = '2026-10-04T01:02:00.000Z';
const HEARTBEAT = '2026-10-04T01:03:00.000Z';
const FINISHED = '2026-10-04T01:04:00.000Z';
const TARGET = 'refs/heads/project/landing-visibility';

/** A task's integration as the server's read model gives it, newest attempt in `state`. */
function current(
  state: LandTaskIntegrationView['state'],
  reason: LandTaskIntegrationView['blockingReason'] = null,
): TaskIntegrationView {
  return {
    state: state === 'LANDED' ? 'ON_INTEGRATION_LINE' : state as TaskIntegrationView['state'],
    since: QUEUED,
    handler: state === 'CHECK_FAILED' || state === 'CONFLICT' ? 'OWNER' : null,
    openItemId: state === 'CHECK_FAILED' || state === 'CONFLICT' ? 'item19' : null,
    jobId: 'landing19',
    checksRunningForMs: null,
    landTask: {
      jobId: 'landing19',
      state,
      phase: state === 'RUNNING' || state === 'CHECK_FAILED' ? 'CHECK' : state === 'CONFLICT' ? 'REBASE' : null,
      // Wider than a double, as every 64-bit counter crosses the API: printed as sent.
      generation: '9007199254740993',
      queuedAt: QUEUED,
      startedAt: state === 'QUEUED' ? null : STARTED,
      heartbeatAt: state === 'QUEUED' ? null : HEARTBEAT,
      finishedAt: state === 'QUEUED' || state === 'RUNNING' ? null : FINISHED,
      targetRef: TARGET,
      waitMs: 120_000,
      blockingReason: reason,
    },
  };
}

function view(over: Partial<ProjectIntegrationView> = {}): ProjectIntegrationView {
  return {
    line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: 'project/landing-visibility',
    upstreamRef: 'main', source: 'EXPLICIT', locked: true, startedAt: QUEUED,
    mergeCheckCommand: 'npm test', mergeCheckCommandAbsentReason: null,
    mergeCheckTimeoutSeconds: 900, escalationSeconds: 3600,
    commitsAheadOfUpstream: 1, commitsAheadOfUpstreamAbsentReason: null,
    lastUpstreamSyncAt: null, lastUpstreamSyncAbsentReason: 'NEVER_SYNCED',
    integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'PASSING', inFlight: null,
    ...over,
  };
}

function render(data: ProjectIntegrationView): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  qc.setQueryData(['project', PROJECT, 'integration'], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ProjectIntegrationLine projectId={PROJECT} started /></MemoryRouter>
    </QueryClientProvider>,
  );
}

const landings = (html: string) =>
  /<div class="project-land-tasks" aria-label="Current landings">([\s\S]*)<\/div><\/div>$/.exec(html)?.[1];

describe('the project integration view’s current LAND_TASKs (§2.7a)', () => {
  it.each([
    ['QUEUED', 'Waiting to land', { code: 'WAITING_DISPATCH', summary: 'Waiting to land: next for runner hpc, which claims it on its next heartbeat' }],
    ['RUNNING', 'Landing', null],
    ['LANDED', 'Landed', null],
    ['CHECK_FAILED', 'Landing checks failed', { code: 'CHECK_FAILED', summary: 'Checks failed on the combined tree: the merge check exited 1 (expected 0)' }],
    ['CONFLICT', 'Landing conflict', { code: 'CONFLICT', summary: 'Stopped at a conflict: the task’s branch could not be combined with the target branch (3 conflicting files)' }],
  ] as const)('draws a %s landing with the server’s generation, target, times and reason, and nothing to press', (state, label, reason) => {
    const html = render(view({
      landTasks: [{ taskId: 'task19', taskTitle: 'Landing visibility', integration: current(state, reason) }],
    }));
    const list = landings(html);
    expect(list).toBeDefined();
    expect(list).toContain('href="/projects/project19/tasks/task19"');
    expect(list).toContain('Landing visibility');
    expect(list).toContain(`data-land-task-state="${state}"`);
    expect(list).toContain(`>${label}</span>`);
    expect(list).toContain('generation 9007199254740993');
    expect(list).toContain(`<code title="${TARGET}">project/landing-visibility</code>`);
    expect(list).toContain('<dt>Queue wait</dt><dd>2m</dd>');
    expect(list).toContain(`dateTime="${QUEUED}"`);
    expect(list).not.toContain('<button');
    expect(list).not.toContain('Task DONE');
    if (reason) {
      expect(list).toContain(`data-blocking-reason="${reason.code}"`);
      expect(list).toContain(reason.summary);
    } else {
      expect(list).not.toContain('data-blocking-reason');
    }
    if (state !== 'QUEUED') {
      expect(list).toContain(`dateTime="${STARTED}"`);
      expect(list).toContain(`dateTime="${HEARTBEAT}"`);
    }
    if (state === 'RUNNING') expect(list).toContain('<span class="land-task-step">checking</span>');
    if (state === 'CONFLICT') expect(list).toContain('stopped while rebasing');
    if (state === 'LANDED' || state === 'CHECK_FAILED' || state === 'CONFLICT') {
      expect(list).toContain(`dateTime="${FINISHED}"`);
    }
  });

  it.each([
    ['WAITING_TASK_WORK', 'Waiting to land: the task’s work session is still running, and its branch can still move'],
    ['WAITING_SERIAL_SLOT', 'Waiting to land: the landing of “Earlier task” is running on this branch first'],
    ['WAITING_MAIN_SYNC', 'Waiting for the project line to sync: the landing of “Earlier task” could not merge upstream into this branch, and its conflict is still open'],
    ['WAITING_RUNNER', 'Waiting for runner hpc: it is offline'],
  ] as const)('prints the server’s %s reason as given, never one inferred from the task being DONE', (code, summary) => {
    const html = render(view({
      landTasks: [{ taskId: 'task19', taskTitle: 'Landing visibility', integration: current('QUEUED', { code, summary }) }],
    }));
    expect(html).toContain(`data-blocking-reason="${code}"`);
    expect(html).toContain(summary);
  });

  it('keeps the server’s order: running, the queue, the stops, the last landing', () => {
    const html = render(view({
      landTasks: [
        { taskId: 'a', taskTitle: 'Alpha running', integration: current('RUNNING') },
        { taskId: 'b', taskTitle: 'Bravo queued', integration: current('QUEUED') },
        { taskId: 'c', taskTitle: 'Charlie stopped', integration: current('CHECK_FAILED') },
        { taskId: 'd', taskTitle: 'Delta landed', integration: current('LANDED') },
      ],
    }));
    const order = ['Alpha running', 'Bravo queued', 'Charlie stopped', 'Delta landed'].map((title) => html.indexOf(title));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it('a new queued generation is drawn even when an earlier one has a receipt', () => {
    const integration = current('QUEUED');
    integration.state = 'ON_UPSTREAM';
    const html = render(view({
      landTasks: [{ taskId: 'task19', taskTitle: 'Landing visibility', integration }],
    }));
    expect(html).toContain('Waiting to land');
    expect(html).toContain('data-land-task-state="QUEUED"');
    expect(html).toContain('Its work is on main by an existing receipt.');
  });

  it('draws the line’s own facts and no list when nothing is current, or the server predates it', () => {
    for (const data of [view(), view({ landTasks: [] })]) {
      const html = render(data);
      expect(html).toContain('Running jobs');
      expect(html).toContain('Queued');
      expect(html).toContain('Last landing check');
      expect(html).not.toContain('Current landings');
      expect(html).not.toContain('class="project-land-task"');
    }
  });
});
