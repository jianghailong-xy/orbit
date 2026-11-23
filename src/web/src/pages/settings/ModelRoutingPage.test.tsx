import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ModelQuality, ProviderModelTier, SubagentRoutingReport, SubagentTiersResponse } from '@orbit/shared';
import { workspacesQuery } from '../../lib/queries';
import { subagentRoutingReportQuery, type ReportPeriod } from '../../lib/routingReport';
import { BOARD_REPORT } from '../../lib/routingReport.fixtures';
import { subagentTiersQuery } from '../../lib/subagentTiers';
import { ModelRoutingPage } from './ModelRoutingPage';

/**
 * Settings → Providers → Model routing: Model tiers and the Routing report on one page. Over the report board's
 * figures (lib/routingReport.fixtures.ts) and a tier list for the same models, the SubAgents view draws one row per
 * model — its tier beside how its runs went — and flags the runs routed at a tier the model is not set to now.
 */
/** No SubAgent run and no done task: the Quality cell reads "No runs yet". */
const NO_QUALITY: ModelQuality = {
  subagent: { averageRating: null, ratedCount: 0, runCount: 0, raters: [] },
  tasks: { firstPassRate: null, firstPassTaskCount: 0, completedTaskCount: 0 },
};
const model = (id: string, levels: ProviderModelTier['levels'], fields: Partial<ProviderModelTier> = {}): ProviderModelTier => ({
  model: id, levels, source: 'catalogue', editable: true, outputPricePerMTok: null, quality: NO_QUALITY, ...fields,
});

const TIERS: SubagentTiersResponse = {
  providers: [
    {
      slug: 'claude', label: 'Claude Code', kind: 'builtin', providerId: null, billing: 'subscription',
      models: [
        model('claude-sonnet-5-5', ['S', 'M']),
        model('claude-opus-5-5', ['L', 'XL']),
        model('claude-fable-5-2', ['L', 'XL']),
        model('claude-haiku-5-5', []),
        model('claude-haiku-5', [], { supersededBy: 'claude-haiku-5-5' }),
      ],
    },
    {
      slug: 'codex', label: 'Codex', kind: 'builtin', providerId: null, billing: 'subscription',
      models: [model('gpt-6.2-sol', ['S', 'M', 'L', 'XL']), model('gpt-6.1-sol', ['S'])],
    },
    { slug: 'kimi', label: 'Kimi Code', kind: 'builtin', providerId: null, billing: 'subscription', models: [model('kimi-code/k3', ['S', 'M'])] },
    {
      slug: 'deepseek', label: 'DeepSeek', kind: 'key', providerId: 'k2', billing: 'key',
      models: [
        model('deepseek-v4-flash', ['S'], { editable: false, outputPricePerMTok: 0.42 }),
        model('deepseek-flash', [], { editable: false, outputPricePerMTok: 0.42 }),
      ],
    },
    {
      slug: 'moonshot', label: 'Kimi (Moonshot)', kind: 'key', providerId: 'k3', billing: 'key',
      models: [model('kimi-k3.1-pro', ['L'], { editable: false, outputPricePerMTok: 10 })],
    },
  ],
};

function render(
  address: string,
  report: SubagentRoutingReport | null = BOARD_REPORT,
  key: { period: ReportPeriod; agentId: string | null } = { period: '30d', agentId: null },
  tiers: SubagentTiersResponse = TIERS,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(workspacesQuery().queryKey, [{ id: 'ws1', name: 'orbit' }, { id: 'ws2', name: 'website' }]);
  qc.setQueryData(subagentTiersQuery().queryKey, tiers);
  if (report) qc.setQueryData(subagentRoutingReportQuery(key.period, key.agentId).queryKey, report);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[address]}>
        <ModelRoutingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The markup's text, tags as `|`, with the apostrophe the static render escapes. */
const text = (html: string) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
/** The text of each body row of the page's table, cells joined by `|`. */
const rows = (html: string) =>
  [...html.slice(html.indexOf('<tbody>')).matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((row) => text(row[1]).replace(/^\||\|$/g, ''));

const PAGE = '/settings/providers/routing';

describe('Settings → Providers → Model routing', () => {
  it('is headed Model routing: the routing switches, then the models with the period and Agent filters and a tab per view', () => {
    const html = render(PAGE);
    expect(html).toMatch(/<h1[^>]*>Model routing<\/h1>/);
    expect(text(html)).toContain('Which tier each model takes SubAgent work at, and how that work went.');
    expect(text(html).indexOf('Route by tier')).toBeLessThan(text(html).indexOf('|Models|'));
    expect(html).toContain('aria-label="Period"');
    expect(html).toContain('aria-label="Agent"');
    expect(text(html)).toContain('|Last 30 days|');
    expect(text(html)).toContain('|All agents|');
    const tabs = [...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], text(m[2])]);
    expect(tabs).toEqual([['true', 'SubAgents|727|'], ['false', 'Workflows|9|']]);
  });

  it('SubAgents: a row per model with its tier, Quality, price, the tiers it ran at, runs and share done, in sections', () => {
    const html = render(PAGE);
    expect(text(html)).toContain(
      '|727 runs|, 71 of them workflow calls · |91%| done · 3 moved on · 16% without a size · |2 models ran outside their tiers|',
    );
    // Each model here is on one account: one row, its provider beside its name, nothing to open (its arrow's room kept,
    // unseen, so the names line up). By name, the numbers in it as numbers.
    expect(rows(html)).toEqual([
      'Routed by tier',
      '▸|Claude Fable 5.2|Claude Code|L · XL|No runs yet|Subscription|XL|2|100%',
      '▸|Claude Haiku 5.5|Claude Code|No tier set, but routed 12 times|Not set|No runs yet|Subscription|S|12|92%',
      '▸|Claude Opus 5.5|Claude Code|L · XL|No runs yet|Subscription|L|5|100%',
      '▸|Claude Sonnet 5.5|Claude Code|S · M|No runs yet|Subscription|M|22|68%',
      '▸|DeepSeek V4 Flash|DeepSeek|S|No runs yet|$0.42|S|64|98%',
      // Its M runs are outside the S it is set to.
      '▸|GPT-6.1 Sol|Codex|19 runs at M, outside S|S|No runs yet|Subscription|S|M|28|93%',
      '▸|GPT-6.2 Sol|Codex|S–XL by effort|No runs yet|Subscription|L|18|94%',
      '▸|Kimi K3|Kimi Code|S · M|No runs yet|Subscription|M|10|100%',
      '▸|kimi-k3.1-pro|Kimi (Moonshot)|L|No runs yet|$10.00|No runs|0|—',
      'Called by name|The SubAgent named its model, so no tier was picked.',
      '▸|DeepSeek Flash|DeepSeek|Not set|No runs yet|$0.42|Named|171|94%',
      'Not routed',
      '▸|DeepSeek Flash|DeepSeek|Not set|No runs yet|$0.42|Not routed|395|89%',
      '▸ No tier, no runs · 1 model',
    ]);
    expect(html.match(/model-routing-no-open/g)).toHaveLength(11);
  });

  it('draws a model on several accounts as one row, closed, with their runs summed and Varies where they differ', () => {
    const k3 = { key: 'kimi-k3', name: 'Kimi K3' };
    const quality: ModelQuality = {
      subagent: { averageRating: null, ratedCount: 0, runCount: 3, raters: [] },
      tasks: { firstPassRate: 0.8, firstPassTaskCount: 8, completedTaskCount: 10 },
    };
    const tiers: SubagentTiersResponse = {
      providers: TIERS.providers.map((provider) =>
        provider.slug === 'kimi' ? { ...provider, models: [model('kimi-code/k3', ['S', 'M'], { identity: k3, quality })] }
          : provider.slug === 'moonshot'
            ? { ...provider, models: [...provider.models, model('kimi-k3', ['S'], { editable: false, outputPricePerMTok: 15, identity: k3, quality })] }
            : provider),
    };
    const html = render(PAGE, BOARD_REPORT, undefined, tiers);
    const listed = rows(html);
    expect(listed).toContain('▸|Kimi K3|2 accounts|Varies|80% first pass · 10 tasks|Varies|M|10|100%');
    // Closed at first: no account row under it.
    expect(listed).not.toContain('Kimi Code|S · M ▾|$0.00|M|10|100%');
    expect(html).not.toContain('model-routing-account');
  });

  it('counts runs on an account the tier list does not have under their model, by the id with its wrapping taken off', () => {
    const report = {
      ...BOARD_REPORT,
      subagents: [...BOARD_REPORT.subagents, {
        tier: 'M' as const, provider: 'codex-pool', providerLabel: 'Codex Pool', model: 'gpt-6.2-sol', modelLabel: 'GPT-6.2-Sol',
        runs: 15, workflowCalls: 0, ended: 15, done: 13, costUsd: 0, movedOn: 0, noSize: 0,
      }],
    };
    const tiers: SubagentTiersResponse = {
      providers: TIERS.providers.map((provider) => provider.slug !== 'codex' ? provider : {
        ...provider,
        models: provider.models.map((m) => m.model === 'gpt-6.2-sol' ? { ...m, identity: { key: 'gpt-6-2-sol', name: 'GPT-6.2 Sol' } } : m),
      }),
    };
    const listed = rows(render(PAGE, report, undefined, tiers));
    // One model, named by the tier list's name, with both accounts' runs: 18 on Codex, 15 on the pool.
    expect(listed.filter((row) => row.includes('GPT-6.2'))).toEqual(['▸|GPT-6.2 Sol|2 accounts|Varies|No runs yet|Varies|M|L|33|91%']);
  });

  it("keeps Model tiers' Quality column beside the tier, its footnote under the table", () => {
    const html = render(PAGE);
    const heads = [...html.slice(html.indexOf('<thead>'), html.indexOf('</thead>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(['Model', 'Tier', 'Quality', 'Price / M out', 'Ran at', 'Runs', 'Done']);
    expect(text(html)).toContain('Quality is shown, not used for routing.');
  });

  it('opens nothing until asked, and folds away the models with no tier and no runs', () => {
    const html = render(PAGE);
    expect(html).not.toContain('model-routing-account');
    expect(text(html)).not.toContain('claude-haiku-5|');
    expect(html).toContain('aria-expanded="false"');
  });

  it('lists the tiers with no run in the period at all, and says nothing ran', () => {
    const html = render(PAGE, { subagents: [], workflows: [] });
    expect(text(html)).toContain('No SubAgents ran in the last 30 days.');
    expect(rows(html)[0]).toBe('Routed by tier');
    // With no run to name it, a model reads as its id.
    expect(rows(html)).toContain('▸|claude-sonnet-5-5|Claude Code|S · M|No runs yet|Subscription|No runs|0|—');
  });

  it('Workflows: a row per name with runs, calls, failed calls, cost and median duration, and its totals', () => {
    const html = render(`${PAGE}?view=workflows`);
    expect(text(html)).toContain('|9 runs| of 4 workflows · |71 calls|, 4 failed · |$7.02|');
    expect(rows(html)).toEqual([
      'review-changes|1 running|Review the diff by dimension, verify each finding|4|48|3|$5.48|6m 40s',
      'triage-flakes|Rerun each flaky spec and sort it by cause|3|15|1|$1.30|2m 10s',
      'workflow-smoke|Smoke test|1|3|0|$0.24|25s',
      'wf-p1-smoke|Phase 1 smoke test|1|5|0|$0.00|2m 7s',
    ]);
    expect(html).toContain('<td class="is-num is-bad">3</td>');
    expect(html).toContain('<td class="is-num is-zero">0</td>');
  });

  it('reads the period and Agent the address names', () => {
    const html = render(`${PAGE}?view=workflows&period=7d&agent=ws2`, BOARD_REPORT, { period: '7d', agentId: 'ws2' });
    expect(text(html)).toContain('|Last 7 days|');
    expect(text(html)).toContain('|website|');
    expect(rows(html)).toHaveLength(4);
  });

  it('says so when no workflow ran, and waits while the report is read', () => {
    expect(text(render(`${PAGE}?view=workflows`, { subagents: [], workflows: [] }))).toContain('No workflows ran in the last 30 days.');
    const reading = render(PAGE, null);
    expect(reading).toContain('aria-busy="true"');
    expect(reading).not.toContain('<table');
  });
});
