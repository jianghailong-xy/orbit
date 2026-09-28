// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiEntry } from '@orbit/shared';
import { WIKI_DEFAULT_SPACE_SETTINGS } from '@orbit/shared';
import type { WikiSpaceWithUsage, WikiTimelineItem } from '../lib/wiki';
import { WikiHome } from './WikiHome';
import { WikiRunDrawer } from './WikiRunPage';

/**
 * One run (mock 17 ⑦⑧⑨, 18 ④⑤): its drawer counts what it applied and groups its entries, Revert
 * run… asks first and then takes it back through `POST /api/wiki/changesets/:id/revert`, and Recently
 * changed folds the run into one row with View run and Revert run… under it.
 *
 * The run is the shared fixture's (`wiki-review-mode.fixture.json`), which OrbitKit is held to too.
 */

interface Run {
  changeset: WikiChangeset;
  entries: WikiEntry[];
}

function run(): Run {
  const path = [
    resolve(process.cwd(), '../shared/src/wiki-review-mode.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-review-mode.fixture.json'),
  ].find((candidate) => existsSync(candidate))!;
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as { runs: Run[] };
  return fixture.runs[0];
}

const RUN = run();
const SPACE_ID = RUN.changeset.spaceId;

const TIMELINE: WikiTimelineItem[] = [
  item('run1-op1', 'add', 'auto_applied', 'maintenance', 'e1', 'auto', 'automatic', 0),
  item('lone-op', 'add', 'auto_applied', 'agent', 'e9', 'unreviewed', 'tiered', 1),
  item('run1-op2', 'add', 'auto_applied', 'maintenance', 'e2', 'unreviewed', 'automatic', 2),
  item('owner-op', 'retire', 'auto_applied', 'owner', 'e8', 'confirmed', null, 3),
];

function item(
  opId: string,
  op: string,
  decision: string,
  origin: string,
  entryId: string,
  trust: string,
  appliedByMode: 'tiered' | 'automatic' | null,
  hoursAgo: number,
): WikiTimelineItem {
  return {
    opId,
    op,
    decision,
    origin,
    at: new Date(Date.now() - hoursAgo * 3_600_000 - 60_000).toISOString(),
    entryId,
    title: opId === 'lone-op' ? 'A lone Tiered add' : opId === 'owner-op' ? 'An entry you retired' : `Title of ${opId}`,
    kind: 'pitfall',
    status: op === 'retire' ? 'retired' : 'active',
    trust,
    supersededById: null,
    supersededByTitle: null,
    reason: null,
    appliedByMode,
    spotCheck: false,
  };
}

let reverts: string[] = [];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && /^\/api\/wiki\/changesets\/[^/]+\/revert$/.test(url)) {
    reverts.push(url);
    return reply(200, { revertedChangesetId: RUN.changeset.id, changesetId: 'revert', skipped: [] });
  }
  if (url.startsWith('/api/wiki/review')) return reply(200, [RUN.changeset]);
  if (url.startsWith(`/api/wiki/spaces/${SPACE_ID}/entries`)) return reply(200, RUN.entries);
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
    await render(<WikiRunDrawer spaceId={SPACE_ID} spaceSlug="orbit" changesetId={RUN.changeset.id} onClose={() => {}} />);
    await vi.waitFor(() => expect(container.textContent).toContain('Applied 5 changes'));
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
    expect(button('Revert run…', drawer)).toBeTruthy();
    expect(button('Open session', drawer)).toBeTruthy();
  });

  it('asks before it reverts, says what will happen, and then takes the run back', async () => {
    await render(<WikiRunDrawer spaceId={SPACE_ID} spaceSlug="orbit" changesetId={RUN.changeset.id} onClose={() => {}} />);
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
    expect(reverts).toEqual([`/api/wiki/changesets/${RUN.changeset.id}/revert`]);
  });

  it('says a run that settled cannot be opened, rather than drawing an empty page', async () => {
    await render(<WikiRunDrawer spaceId={SPACE_ID} spaceSlug="orbit" changesetId="settled-run" onClose={() => {}} />);
    await vi.waitFor(() => expect(container.textContent).toContain('This run is not waiting in Review any more'));
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

  it('folds a run into one row with View run and Revert run…, and marks what a mode applied', async () => {
    await render(<WikiHome space={space} />);
    await vi.waitFor(() => expect(container.querySelector('.wk-tl-run')).toBeTruthy());
    const rows = [...container.querySelectorAll<HTMLElement>('.wk-tl > li')];
    expect(rows).toHaveLength(3);
    const [first, lone, owner] = rows;
    expect(first.className).toContain('wk-tl-run');
    expect(first.querySelector('.wk-tl-h b')?.textContent).toBe('Wiki maintenance');
    expect(first.querySelector('.wk-tl-t')?.textContent).toBe('Applied 5 changes');
    expect(first.querySelector('.wk-tl-n')?.textContent).toBe('3 Auto · 1 Unreviewed · 1 rejected by the check · 2 to review');
    expect([...first.querySelectorAll('.wk-tl-acts > *')].map((node) => node.textContent)).toEqual(['View run', 'Revert run…']);
    // An op of no run the page can open stays its own row, marked with what the mode applied it as.
    expect(lone.querySelector('.wk-tl-h b')?.textContent).toBe('Added');
    expect(lone.querySelector('.tdp-badge')?.textContent).toBe('Unreviewed');
    expect(owner.querySelector('.wk-tl-h b')?.textContent).toBe('Retired');
    expect(owner.querySelector('.tdp-badge')).toBeNull();
  });
});
