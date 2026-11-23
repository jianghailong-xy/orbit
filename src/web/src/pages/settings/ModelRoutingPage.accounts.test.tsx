// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelQuality, ProviderModelTier, SubagentReportGroup, SubagentTiersResponse } from '@orbit/shared';
import { meQuery, workspacesQuery, type Me } from '../../lib/queries';
import { subagentRoutingReportQuery } from '../../lib/routingReport';
import { subagentTiersQuery } from '../../lib/subagentTiers';

/**
 * Settings → Model routing: a model on several accounts is one row, closed at first; a click on its name opens a row per
 * account (its provider, tier, price and runs) and a second click closes them.
 */

vi.mock('../../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
vi.mock('../../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api')>()), api: vi.fn(async () => ({})) }));
const { ModelRoutingPage } = await import('./ModelRoutingPage');

const quality: ModelQuality = {
  subagent: { averageRating: null, ratedCount: 0, runCount: 37, raters: [] },
  tasks: { firstPassRate: 0.47, firstPassTaskCount: 43, completedTaskCount: 91 },
};
const SONNET = { key: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' };
const model = (fields: Partial<ProviderModelTier> = {}): ProviderModelTier => ({
  model: 'claude-sonnet-5-5', levels: ['S', 'M'], source: 'catalogue', editable: false, outputPricePerMTok: null, quality,
  identity: SONNET, ...fields,
});
const TIERS: SubagentTiersResponse = {
  providers: [
    { slug: 'claude', label: 'Claude Code', kind: 'builtin', providerId: null, billing: 'subscription', models: [model()] },
    { slug: 'antigravity', label: 'Antigravity CLI', kind: 'builtin', providerId: null, billing: 'subscription', models: [model()] },
    { slug: 'anthropic', label: 'Team key', kind: 'key', providerId: 'k1', billing: 'key', models: [model({ outputPricePerMTok: 10 })] },
  ],
};
const group = (tier: 'S' | 'M', runs: number, done: number): SubagentReportGroup => ({
  tier, provider: 'claude', providerLabel: 'Claude Code', model: 'claude-sonnet-5-5', modelLabel: 'Sonnet 5.5',
  runs, workflowCalls: 0, ended: runs, done, costUsd: 1, movedOn: 0, noSize: 0,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', createdAt: '2026-01-01T00:00:00Z', preferences: {} } as Me);
  qc.setQueryData(workspacesQuery().queryKey, []);
  qc.setQueryData(subagentTiersQuery().queryKey, TIERS);
  qc.setQueryData(subagentRoutingReportQuery('30d', null).queryKey, { subagents: [group('S', 13, 13), group('M', 24, 17)], workflows: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={['/settings/providers/routing']}><ModelRoutingPage /></MemoryRouter></QueryClientProvider>,
  ));
}

/** Each body row's cells, as text joined by `|`. */
const rows = () => [...container!.querySelectorAll('.model-routing-table tbody tr')]
  .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent).join('|'));

describe('a model on several accounts', () => {
  it('opens to a row per account on a click of its name, and closes on another', async () => {
    await mount();
    expect(rows()).toEqual([
      'Routed by tier',
      '▸Claude Sonnet 5.53 accounts|S · M|47% first pass · 91 tasks|Varies|SM|37|81%',
    ]);
    const open = container!.querySelector<HTMLButtonElement>('.model-routing-open')!;
    expect(open.getAttribute('aria-expanded')).toBe('false');

    await act(async () => open.click());
    expect(open.getAttribute('aria-expanded')).toBe('true');
    // Most runs first; each its own tier, price and runs, no Quality of its own.
    expect(rows().slice(2)).toEqual([
      'Claude Code|S · M||Subscription|SM|37|81%',
      'Antigravity CLI|S · M||Subscription|No runs|0|—',
      'Team key|S · M||$10.00|No runs|0|—',
    ]);

    await act(async () => open.click());
    expect(rows()).toHaveLength(2);
  });
});
