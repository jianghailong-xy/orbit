import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOARD_SUBAGENTS, BOARD_WORKFLOWS } from './routingReport.fixtures';

const getSubagentRoutingReport = vi.fn(async () => ({ subagents: [], workflows: [] }));
vi.mock('../api', () => ({ getSubagentRoutingReport }));

const { reportPeriod, reportSince, subagentRoutingReportQuery, subagentTotals, workflowTotals } = await import('./routingReport');

afterEach(() => {
  vi.useRealTimers();
  getSubagentRoutingReport.mockClear();
});

describe('the routing report read', () => {
  it('asks for the period that ends now, and the Agent, or neither', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 20, 12) });
    const run = (query: ReturnType<typeof subagentRoutingReportQuery>) =>
      (query.queryFn as unknown as () => Promise<unknown>)();
    await run(subagentRoutingReportQuery('7d', 'ws1'));
    await run(subagentRoutingReportQuery('all', null));
    expect(getSubagentRoutingReport.mock.calls).toEqual([
      [{ since: '2026-11-13T12:00:00.000Z', agentId: 'ws1' }],
      [{ since: undefined, agentId: undefined }],
    ]);
    // The key holds the period, not the time, so the report is not re-read every millisecond.
    expect(subagentRoutingReportQuery('30d', null).queryKey).toEqual(['routing-report', 'subagents', '30d', null]);
  });

  it('opens on the last 30 days, and reads only a period it offers from the address', () => {
    expect(reportPeriod(null)).toBe('30d');
    expect(reportPeriod('7d')).toBe('7d');
    expect(reportPeriod('all')).toBe('all');
    expect(reportPeriod('90d')).toBe('30d');
    expect(reportSince('30d', Date.UTC(2026, 10, 30))).toBe('2026-10-31T00:00:00.000Z');
  });
});

describe('the totals lines', () => {
  it('add up the SubAgents rows, the share without a size taken of routed runs only', () => {
    expect(subagentTotals(BOARD_SUBAGENTS)).toEqual({
      runs: 727, workflowCalls: 71, ended: 726, done: 661, costUsd: expect.closeTo(287.21, 6), movedOn: 3, noSize: 26, routed: 161,
    });
  });

  it('add up the Workflows rows', () => {
    expect(workflowTotals(BOARD_WORKFLOWS)).toEqual({ runs: 9, workflows: 4, calls: 71, failedCalls: 4, costUsd: expect.closeTo(7.02, 6) });
  });
});
