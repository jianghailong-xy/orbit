import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskIntegrationView } from '@orbit/shared';
import { LandTaskStatus, landingBadge } from './LandTaskStatus';

/**
 * The two silences of a landing, which read the same only if a page lets them: a runner that has
 * stopped REPORTING, and a job that judged itself over. The first is the runner's silence and the
 * row words it as such; the second is the job's own verdict, and the only thing that ever says
 * "timed out" is the sentence the server put on it (`blockingReason`).
 *
 * The owner's report of 2026-10-08 is why both are here: a landing of 4m 41s whose step read
 * `fetching` was called a timeout in the same breath as it was called busy.
 */
describe('a landing attempt, on the task that owns it', () => {
  const NOW = Date.parse('2026-10-08T06:00:00Z');
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

  function integration(landTask: NonNullable<TaskIntegrationView['landTask']>): TaskIntegrationView {
    return {
      state: landTask.state === 'RUNNING' ? 'RUNNING' : landTask.state as TaskIntegrationView['state'],
      since: landTask.queuedAt,
      handler: null,
      openItemId: null,
      jobId: landTask.jobId,
      checksRunningForMs: null,
      landTask,
    };
  }

  function job(over: Partial<NonNullable<TaskIntegrationView['landTask']>> = {}) {
    return {
      jobId: 'j1', state: 'RUNNING' as const, phase: 'FETCH' as const, generation: '2',
      queuedAt: at(9), startedAt: at(7), heartbeatAt: at(0), finishedAt: null,
      targetRef: 'refs/heads/project/p', waitMs: 120_000, blockingReason: null,
      ...over,
    } as NonNullable<TaskIntegrationView['landTask']>;
  }

  it('says how long a silent runner has been silent, and never calls that a timeout', () => {
    const html = renderToStaticMarkup(
      <LandTaskStatus integration={integration(job({ heartbeatAt: at(11) }))} now={NOW} />,
    );
    expect(html).toContain('No report for 11m');
    expect(html).toContain('<span class="land-task-step">fetching</span>');
    expect(html).not.toMatch(/timed? ?out/i);
    // "Update unavailable" is the app failing to READ the server, which is a different fact.
    expect(html).not.toContain('Update unavailable');
  });

  it('says a job claimed whose runner has never reported has no report YET', () => {
    const html = renderToStaticMarkup(
      <LandTaskStatus integration={integration(job({ heartbeatAt: null, startedAt: at(7) }))} now={NOW} />,
    );
    expect(html).toContain('No report yet');
    expect(html).not.toMatch(/timed? ?out/i);
  });

  it('leaves a job its runner is reporting from alone, and repeats the job’s own verdict when it stopped', () => {
    const reporting = renderToStaticMarkup(<LandTaskStatus integration={integration(job())} now={NOW} />);
    expect(reporting).toContain('<span class="land-task-step">fetching</span>');
    expect(reporting).not.toContain('No report');

    // The job's own conclusion, in the server's words: this — and only this — is a timeout.
    const stopped = renderToStaticMarkup(<LandTaskStatus integration={integration(job({
      state: 'CHECK_FAILED', phase: 'CHECK', finishedAt: at(2),
      blockingReason: { code: 'CHECK_FAILED', summary: 'Checks failed on the combined tree: merge check timed out' },
    }))} now={NOW} />);
    expect(stopped).toContain('Checks failed on the combined tree: merge check timed out');
    expect(stopped).not.toContain('No report');
  });

  it('writes the queue wait the landing paid, which is not the time it has been working', () => {
    const html = renderToStaticMarkup(
      <LandTaskStatus integration={integration(job({ waitMs: 143_600 }))} now={NOW} />,
    );
    expect(html).toContain('<dt>Queue wait</dt><dd>2m</dd>');
  });
});

describe('where a landing’s work is, by the project’s main branch', () => {
  const receipted = (state: TaskIntegrationView['state']): TaskIntegrationView => ({
    state, since: '2026-10-08T05:00:00Z', handler: null, openItemId: null, jobId: null, checksRunningForMs: null,
  });
  const syncing: TaskIntegrationView = {
    ...receipted('RUNNING'),
    landTask: {
      jobId: 'j1', state: 'CONFLICT', phase: 'MAIN_SYNC', generation: '2', queuedAt: '2026-10-08T05:50:00Z',
      startedAt: '2026-10-08T05:51:00Z', heartbeatAt: '2026-10-08T05:52:00Z', finishedAt: '2026-10-08T05:53:00Z',
      targetRef: 'refs/heads/project/p', waitMs: 0, blockingReason: null,
    },
  };

  it('says On main and stopped while syncing main word for word as before for a project on main', () => {
    expect(landingBadge(receipted('ON_UPSTREAM'))).toEqual({ label: 'On main', tone: 'green' });
    expect(landingBadge(receipted('ON_UPSTREAM'), 'main')).toEqual({ label: 'On main', tone: 'green' });
    expect(renderToStaticMarkup(<LandTaskStatus integration={syncing} />))
      .toContain('<span class="land-task-step">stopped while syncing main</span>');
  });

  it('names master for a project on master', () => {
    expect(landingBadge(receipted('ON_UPSTREAM'), 'master')).toEqual({ label: 'On master', tone: 'green' });
    expect(renderToStaticMarkup(<LandTaskStatus integration={receipted('ON_UPSTREAM')} main="master" />))
      .toContain('On master');
    expect(renderToStaticMarkup(<LandTaskStatus integration={syncing} main="master" />))
      .toContain('<span class="land-task-step">stopped while syncing master</span>');
    // A newer attempt over a receipt says where the receipt put the work.
    const reattempt: TaskIntegrationView = { ...syncing, state: 'ON_UPSTREAM' };
    const words = (html: string) => html.replace(/<!-- -->/gu, '');
    expect(words(renderToStaticMarkup(<LandTaskStatus integration={reattempt} />)))
      .toContain('Its work is on main by an existing receipt.');
    expect(words(renderToStaticMarkup(<LandTaskStatus integration={reattempt} main="master" />)))
      .toContain('Its work is on master by an existing receipt.');
  });
});
