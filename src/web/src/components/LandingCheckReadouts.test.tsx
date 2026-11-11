import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskIntegrationView, IntegrationTimelineEntry, SessionLandingView } from '@orbit/shared';
import { LandTaskStatus } from './LandTaskStatus';
import { landingTimelineText, scopedLandingEntries } from '../lib/landingSession';

describe('Landing check readouts', () => {
  it('adds the approved heading only for baseline waits and preserves the server summary', () => {
    const summary = 'Waiting to land: the project branch with the latest main fails its checks on its own; 3 landings wait until that is fixed';
    const view = (code: string): TaskIntegrationView => ({ state: 'QUEUED', since: null, handler: null, openItemId: null,
      jobId: null, checksRunningForMs: null, landTask: { state: 'QUEUED', jobId: 'j1', generation: '1', targetRef: 'refs/heads/project/payments',
        blockingReason: { code, summary } } } as TaskIntegrationView);
    const html = renderToStaticMarkup(<LandTaskStatus integration={view('WAITING_BASELINE')} />);
    expect(html).toContain('Waiting for baseline fix');
    expect(html).toContain(summary);
    expect(html).toContain('Landings resume automatically when this open item is resolved.');
    expect(renderToStaticMarkup(<LandTaskStatus integration={view('WAITING_SERIAL_SLOT')} />)).not.toContain('Waiting for baseline fix');
  });
  it.each([[0, 'passes'], [1, 'also fails']])('reads baseline attribution from structured scope, exit %s', (exitCode, verdict) => {
    const entry = { kind: 'CHECK_FINISHED', text: 'Landing check failed · exit 1 · 14m',
      data: { scope: 'BASELINE', exitCode, expectedExitCode: 0, timedOut: false } } as IntegrationTimelineEntry;
    expect(landingTimelineText(entry)).toBe(`Checked the project branch with main, without this task · ${verdict}`);
  });
  it('recovers scope only from the matching newest job, claim, round and check position', () => {
    const entry = { kind: 'CHECK_FINISHED', claim: 2, round: 3, check: { name: 'LANDING_CHECK', index: 1 },
      text: 'Landing check failed · exit 1 · 14m', data: { exitCode: 1, expectedExitCode: 0 } } as IntegrationTimelineEntry;
    const landing = { currentAttempt: { jobId: 'new', claim: 2, round: 3 }, checks: [{ scope: 'BASELINE' }] } as SessionLandingView;
    expect(landingTimelineText(scopedLandingEntries([entry], landing, 'new')[0]!))
      .toBe('Checked the project branch with main, without this task · also fails');
    expect(scopedLandingEntries([entry], landing, 'old')[0]).toBe(entry);
    const earlier = { ...entry, claim: 1 };
    expect(scopedLandingEntries([earlier], landing, 'new')[0]).toBe(earlier);
    const round = { ...entry, round: 2 };
    expect(scopedLandingEntries([round], landing, 'new')[0]).toBe(round);
  });

});
