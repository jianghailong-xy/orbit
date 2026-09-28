// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChangesetView } from '@orbit/shared';
import { WIKI_DEFAULT_SPACE_SETTINGS } from '@orbit/shared';
import type { WikiSpaceWithUsage, WikiTimelineItem } from '../lib/wiki';
import { WikiHome } from './WikiHome';
import { WikiRunDrawer } from './WikiRunPage';

/**
 * One run (mock 17 ⑦⑧⑨, 18 ④⑤): its drawer reads the run by its own id (`GET /api/wiki/changesets/:id`),
 * says what the server counted and groups its entries, offers Revert run… exactly when the server says
 * it can and then takes it back through `POST /api/wiki/changesets/:id/revert`, and Recently changed
 * folds every run into one row with View run and Revert run… under it — whether or not anything of it
 * still waits in Review, which this door answers empty throughout.
 *
 * The runs are the shared fixture's (`wiki-review-mode.fixture.json`), which OrbitKit is held to too.
 */

interface Run {
  name: string;
  view: WikiChangesetView;
}

function runs(): Run[] {
  const path = [
    resolve(process.cwd(), '../shared/src/wiki-review-mode.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-review-mode.fixture.json'),
  ].find((candidate) => existsSync(candidate))!;
  return (JSON.parse(readFileSync(path, 'utf8')) as { runs: Run[] }).runs;
}

const RUNS = runs();
/** A maintenance run with a spot check and a floor still waiting. */
const RUN = RUNS[0].view;
/** An Automatic run every op of which its verdicts applied: nothing of it is in Review. */
const SETTLED = RUNS.find((run) => run.name === 'an Automatic run nothing of which waits in Review')!.view;
/** A run the owner took back already. */
const REVERTED = RUNS.find((run) => run.name === 'a run reverted already')!.view;
const SPACE_ID = RUN.spaceId;

const TIMELINE: WikiTimelineItem[] = [
  item('run1-op1', 'add', 'auto_applied', 'maintenance', 'e1', 'auto', 'automatic', RUN.id, 'automatic', 0),
  item('run4-op1', 'add', 'auto_applied', 'maintenance', 'h1', 'auto', 'automatic', SETTLED.id, 'automatic', 1),
  item('run1-op2', 'add', 'auto_applied', 'maintenance', 'e2', 'unreviewed', 'automatic', RUN.id, 'automatic', 2),
  item('owner-op', 'retire', 'auto_applied', 'owner', 'e8', 'confirmed', null, 'owner-changeset', null, 3),
];

function item(
  opId: string,
  op: string,
  decision: string,
  origin: string,
  entryId: string,
  trust: string,
  appliedByMode: 'tiered' | 'automatic' | null,
  changesetId: string,
  changesetAppliedByMode: 'tiered' | 'automatic' | null,
  hoursAgo: number,
): WikiTimelineItem {
  return {
    opId,
    op,
    decision,
    origin,
    at: new Date(Date.now() - hoursAgo * 3_600_000 - 60_000).toISOString(),
    entryId,
    title: opId === 'owner-op' ? 'An entry you retired' : `Title of ${opId}`,
    kind: 'pitfall',
    status: op === 'retire' ? 'retired' : 'active',
    trust,
    supersededById: null,
    supersededByTitle: null,
    reason: null,
    appliedByMode,
    spotCheck: false,
    changesetId,
    changesetAppliedByMode,
  };
}

let reverts: string[] = [];
let reads: string[] = [];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && /^\/api\/wiki\/changesets\/[^/]+\/revert$/.test(url)) {
    reverts.push(url);
    return reply(200, { revertedChangesetId: RUN.id, changesetId: 'revert', skipped: [] });
  }
  const run = /^\/api\/wiki\/changesets\/([^/?]+)$/.exec(url);
  if (run) {
    reads.push(decodeURIComponent(run[1]));
    const view = RUNS.map((one) => one.view).find((one) => one.id === decodeURIComponent(run[1]));
    return view ? reply(200, view) : reply(404, { message: 'no such changeset' });
  }
  // Nothing waits in Review: no run below is opened from it.
  if (url.startsWith('/api/wiki/review')) return reply(200, []);
  if (url.startsWith(`/api/wiki/spaces/${SPACE_ID}/entries`)) return reply(200, []);
  if (url.startsWith(`/api/wiki/spaces/${SPACE_ID}/timeline`)) return reply(200, { items: TIMELINE });
  if (url.startsWith('/api/wiki/spaces')) return reply(200, []);
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(serve));
  reverts = [];
  reads = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function render(node: React.ReactNode): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AntApp>{node}</AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function button(label: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('one run’s drawer', () => {
  it('says who it was and what it applied, counts it, and lists Added / Amended / Reinforced', async () => {
    await render(<WikiRunDrawer spaceSlug="orbit" changesetId={RUN.id} onClose={() => {}} />);
    await vi.waitFor(() => expect(container.textContent).toContain('Applied 5 changes'));
    expect(reads).toContain(RUN.id);
    const drawer = container.querySelector('.wk-run')!;
    expect(drawer.querySelector('.wk-dkind')?.textContent).toBe('Wiki maintenance · run');
    expect([...drawer.querySelectorAll('.wk-run-counts > span')].map((node) => node.textContent)).toEqual([
      '3 Auto',
      '1 Unreviewed',
      '1 rejected by the check',
      '2 to review',
    ]);
    const groups = [...drawer.querySelectorAll('.tdp-section-title')].map((node) => node.textContent);
    expect(groups).toEqual(['Added3', 'Amended1', 'Reinforced1']);
    expect(drawer.textContent).toContain('Chromium renders the mock HTML to PNG');
    expect(button('Revert run…', drawer).disabled).toBe(false);
    expect(button('Open session', drawer)).toBeTruthy();
  });

  it('asks before it reverts, says what the server counted, and then takes the run back', async () => {
    await render(<WikiRunDrawer spaceSlug="orbit" changesetId={RUN.id} onClose={() => {}} />);
    await vi.waitFor(() => expect(container.textContent).toContain('Applied 5 changes'));
    await act(async () => button('Revert run…', container).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('.ant-modal-confirm')!;
    expect(dialog.textContent).toContain('Revert this run?');
    expect(dialog.textContent).toContain(
      'The 4 changes it applied are undone: 3 added entries are withdrawn and 1 amended one goes back to its previous revision. Agents stop getting them.',
    );
    expect(dialog.textContent).toContain('Changes you have confirmed, edited or rejected since are left as they are.');
    expect(reverts).toEqual([]);
    await act(async () => button('Revert run', dialog).click());
    await settle();
    expect(reverts).toEqual([`/api/wiki/changesets/${RUN.id}/revert`]);
  });

  it('opens a run nothing of which waits in Review, and offers Revert run… because the server says it can', async () => {
    await render(<WikiRunDrawer spaceSlug="orbit" changesetId={SETTLED.id} onClose={() => {}} />);
    await vi.waitFor(() => expect(container.textContent).toContain('Applied 3 changes'));
    const drawer = container.querySelector('.wk-run')!;
    expect([...drawer.querySelectorAll('.wk-run-counts > span')].map((node) => node.textContent)).toEqual(['2 Auto', '1 Unreviewed']);
    expect([...drawer.querySelectorAll('.tdp-section-title')].map((node) => node.textContent)).toEqual(['Added2', 'Amended1']);
    await act(async () => button('Revert run…', drawer).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('.ant-modal-confirm')!;
    expect(dialog.textContent).toContain(
      'The 3 changes it applied are undone: 2 added entries are withdrawn and 1 amended one goes back to its previous revision. Agents stop getting them.',
    );
    await act(async () => button('Revert run', dialog).click());
    await settle();
    expect(reverts).toEqual([`/api/wiki/changesets/${SETTLED.id}/revert`]);
  });

  it('holds Revert run… back once the server says nothing is left to take back', async () => {
    await render(<WikiRunDrawer spaceSlug="orbit" changesetId={REVERTED.id} onClose={() => {}} />);
    await vi.waitFor(() => expect(container.textContent).toContain('Applied 2 changes'));
    const drawer = container.querySelector('.wk-run')!;
    expect(button('Revert run…', drawer).disabled).toBe(true);
    // Its entry retired with the revert wears no mark; the one put back is Unreviewed.
    expect([...drawer.querySelectorAll('.tdp-badge')].map((node) => node.textContent)).toEqual(['Unreviewed']);
  });

  it('says nothing it cannot back about a run the server does not know', async () => {
    await render(<WikiRunDrawer spaceSlug="orbit" changesetId="unknown-run" onClose={() => {}} />);
    await vi.waitFor(() => expect(reads).toContain('unknown-run'));
    await settle();
    const drawer = container.querySelector('.wk-drawer')!;
    expect(drawer.textContent).toBe('');
    expect(drawer.querySelector('button[aria-label="Close"]')).toBeTruthy();
    expect(container.textContent).not.toContain('Review');
  });
});

describe('Recently changed', () => {
  const space: WikiSpaceWithUsage = {
    id: SPACE_ID,
    slug: 'orbit',
    title: 'orbit',
    repoUrlNorm: null,
    rootCommitSha: null,
    settings: WIKI_DEFAULT_SPACE_SETTINGS as never,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };

  it('folds every run into one row by the changeset its items name, with View run and Revert run…', async () => {
    await render(<WikiHome space={space} />);
    await vi.waitFor(() => expect(container.querySelectorAll('.wk-tl-run .wk-tl-n')).toHaveLength(2));
    const rows = [...container.querySelectorAll<HTMLElement>('.wk-tl > li')];
    expect(rows).toHaveLength(3);
    const [first, settled, owner] = rows;
    expect(first.className).toContain('wk-tl-run');
    expect(first.querySelector('.wk-tl-h b')?.textContent).toBe('Wiki maintenance');
    expect(first.querySelector('.wk-tl-t')?.textContent).toBe('Applied 5 changes');
    expect(first.querySelector('.wk-tl-n')?.textContent).toBe('3 Auto · 1 Unreviewed · 1 rejected by the check · 2 to review');
    expect([...first.querySelectorAll('.wk-tl-acts > *')].map((node) => node.textContent)).toEqual(['View run', 'Revert run…']);
    // The run nothing of which waits in Review is a row of its own all the same, and can be taken back.
    expect(settled.className).toContain('wk-tl-run');
    expect(settled.querySelector('.wk-tl-t')?.textContent).toBe('Applied 3 changes');
    expect(settled.querySelector('.wk-tl-n')?.textContent).toBe('2 Auto · 1 Unreviewed');
    expect([...settled.querySelectorAll('.wk-tl-acts > *')].map((node) => node.textContent)).toEqual(['View run', 'Revert run…']);
    expect(settled.querySelector('.wk-tl-t a')?.getAttribute('href')).toContain('/wiki/orbit/run/');
    // What the owner did stays a row of its own, with no mark.
    expect(owner.className).not.toContain('wk-tl-run');
    expect(owner.querySelector('.wk-tl-h b')?.textContent).toBe('Retired');
    expect(owner.querySelector('.tdp-badge')).toBeNull();
    expect(reads.sort()).toEqual([RUN.id, SETTLED.id].sort());
  });
});
