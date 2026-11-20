import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SubagentRoutingReport } from '@orbit/shared';
import { workspacesQuery } from '../../lib/queries';
import { subagentRoutingReportQuery, type ReportPeriod } from '../../lib/routingReport';
import { BOARD_REPORT } from '../../lib/routingReport.fixtures';
import { RoutingReportPage } from './RoutingReportPage';

/**
 * Settings → Routing report as board docs/mocks/subagent-workflow/08-report.html draws it, over the board's own
 * figures (lib/routingReport.fixtures.ts): the Workflows view's rows and totals, the SubAgents view's, and that the
 * SubAgents totals say how many of their runs were workflow calls — the Workflows view's calls, counted once.
 */
function render(
  address: string,
  report: SubagentRoutingReport | null = BOARD_REPORT,
  key: { period: ReportPeriod; agentId: string | null } = { period: '30d', agentId: null },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(workspacesQuery().queryKey, [{ id: 'ws1', name: 'orbit' }, { id: 'ws2', name: 'website' }]);
  if (report) qc.setQueryData(subagentRoutingReportQuery(key.period, key.agentId).queryKey, report);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[address]}>
        <RoutingReportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The markup's text, tags as `|`, with the apostrophe the static render escapes. */
const text = (html: string) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/&#x27;/g, "'");
/** The text of each body row of the page's table, cells joined by `|`. */
const rows = (html: string) =>
  [...html.slice(html.indexOf('<tbody>')).matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((row) => text(row[1]).replace(/^\||\|$/g, ''));

describe('Settings → Routing report', () => {
  it('is headed Routing report, with the period and Agent filters and a tab per view, each with its runs', () => {
    const html = render('/settings/routing-report');
    expect(html).toMatch(/<h1[^>]*>Routing report<\/h1>/);
    expect(text(html)).toContain('How the work Orbit routed went: which tier and model ran it, how often it finished, and what it cost.');
    expect(html).toContain('aria-label="Period"');
    expect(html).toContain('aria-label="Agent"');
    expect(text(html)).toContain('|Last 30 days|');
    expect(text(html)).toContain('|All agents|');
    const tabs = [...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], text(m[2])]);
    expect(tabs).toEqual([['true', 'SubAgents|727|'], ['false', 'Workflows|9|']]);
  });

  it('Workflows: a row per name with runs, calls, failed calls, cost and median duration, and its totals', () => {
    const html = render('/settings/routing-report?view=workflows');
    expect(text(html)).toContain('|9 runs| of 4 workflows · |71 calls|, 4 failed · |$7.02|');
    expect(rows(html)).toEqual([
      'review-changes|1 running|Review the diff by dimension, verify each finding|4|48|3|$5.48|6m 40s',
      'triage-flakes|Rerun each flaky spec and sort it by cause|3|15|1|$1.30|2m 10s',
      'workflow-smoke|Smoke test|1|3|0|$0.24|25s',
      'wf-p1-smoke|Phase 1 smoke test|1|5|0|$0.00|2m 7s',
    ]);
    // Failed calls stand out; none is quiet.
    expect(html).toContain('<td class="is-num is-bad">3</td>');
    expect(html).toContain('<td class="is-num is-zero">0</td>');
    expect(text(html)).toContain(
      "A workflow's calls are SubAgent runs, so they count in SubAgents too. Failed: calls that ended without finishing. Duration: the median of its ended runs.",
    );
  });

  it('SubAgents: a row per tier and model picked, workflow calls counted among the runs and named in the totals', () => {
    const html = render('/settings/routing-report');
    expect(text(html)).toContain('|727 runs|, 71 of them workflow calls · |91%| done · |$287.21| · 3 moved on · 16% without a size');
    expect(rows(html)).toEqual([
      'S|DeepSeek V4 Flash|DeepSeek|64|98%|$11.40|0|14%',
      'S|Claude Haiku 5.5|Claude Code|12|92%|$1.20|1|17%',
      'S|GPT-6.1 Sol|Codex|9|100%|$0.00|0|0%',
      'M|Claude Sonnet 5.5|Claude Code|22|68%|$9.86|0|36%',
      'M|GPT-6.1 Sol|Codex|19|89%|$0.00|2|37%',
      'M|Kimi K3|Kimi Code|10|100%|$0.00|0|0%',
      'L|GPT-6.2 Sol|Codex|18|94%|$0.00|0|0%',
      'L|Claude Opus 5.5|Claude Code|5|100%|$4.31|0|0%',
      'XL|Claude Fable 5.2|Claude Code|2|100%|$6.80|0|0%',
      'Named|DeepSeek Flash|DeepSeek|171|94%|$81.30|—|—',
      'Not routed|DeepSeek Flash|DeepSeek|395|89%|$172.34|—|—',
    ]);
    // The Workflows view's calls are exactly the SubAgents view's workflow calls.
    const calls = BOARD_REPORT.workflows.reduce((sum, row) => sum + row.calls, 0);
    expect(BOARD_REPORT.subagents.reduce((sum, row) => sum + row.workflowCalls, 0)).toBe(calls);
    expect(text(html)).toContain(`${calls} of them workflow calls`);
  });

  it('reads the period and Agent the address names', () => {
    const html = render('/settings/routing-report?view=workflows&period=7d&agent=ws2', BOARD_REPORT, { period: '7d', agentId: 'ws2' });
    expect(text(html)).toContain('|Last 7 days|');
    expect(text(html)).toContain('|website|');
    expect(rows(html)).toHaveLength(4);
  });

  it('says so when nothing ran in the period, and waits while the report is read', () => {
    const empty = render('/settings/routing-report?view=workflows', { subagents: [], workflows: [] });
    expect(text(empty)).toContain('No workflows ran in the last 30 days.');
    expect(text(render('/settings/routing-report', { subagents: [], workflows: [] }))).toContain('No SubAgents ran in the last 30 days.');
    const allTime = render('/settings/routing-report?period=all', { subagents: [], workflows: [] }, { period: 'all', agentId: null });
    expect(text(allTime)).toContain('No SubAgents ran yet.');
    const reading = render('/settings/routing-report', null);
    expect(reading).toContain('aria-busy="true"');
    expect(reading).not.toContain('<table');
  });
});
