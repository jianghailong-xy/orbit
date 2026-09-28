// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiEntryDetail } from '../lib/wiki';
import { WikiEntryDrawer } from './WikiEntryDrawer';

/**
 * An entry a review mode applied, in its drawer (mocks 17–18 ①–⑥): Unreviewed offers Confirm and
 * Reject ▾, Auto offers Reject alone, Web-derived says why it waits, and what the owner wrote or
 * confirmed offers neither. The bar under the head says what the mark means for agents, and Where
 * it's used says an Unreviewed entry is not sent.
 *
 * The two answers are read off the wire: `POST /api/wiki/entries/:id/confirm` and
 * `POST /api/wiki/entries/:id/reject` with the reason picked from the menu. The bar's second line is the
 * entry read's own `verification` — the verdict its current revision was applied on — and Review, which
 * answers empty here, is not where it comes from.
 */

const ENTRY_ID = '0196b400-0000-7000-8000-000000000001';
const SPACE_ID = '0196b400-0000-7000-8000-0000000000aa';

function detail(over: Partial<WikiEntryDetail> = {}): WikiEntryDetail {
  return {
    id: ENTRY_ID,
    spaceId: SPACE_ID,
    kind: 'pitfall',
    status: 'active',
    trust: 'unreviewed',
    currentRevision: 1,
    title: 'captureBeyondViewport shifts the screenshot',
    summary: 'Set it false and clip by the element rect.',
    fields: { symptom: 'side-by-side shots are offset', cause: 'a reflow', fix: 'set it false' },
    topics: ['ui-design'],
    aliases: [],
    anchors: [],
    anchorState: 'unchecked',
    anchorCheckedRef: null,
    anchorCheckedAt: null,
    tainted: false,
    challenged: false,
    unsupported: false,
    pinned: false,
    supersedesId: null,
    supersededById: null,
    validFrom: '2026-09-28T05:00:00.000Z',
    validTo: null,
    recordedAt: '2026-09-28T05:00:00.000Z',
    retiredAt: null,
    sources: [],
    history: [
      {
        id: 'rev-1',
        entryId: ENTRY_ID,
        revision: 1,
        title: 'x',
        summary: 'y',
        fields: {},
        topics: [],
        aliases: [],
        anchors: [],
        contentSha256: 'f'.repeat(64),
        authorKind: 'maintenance',
        authorUserId: null,
        authorSessionId: null,
        authorToolCallId: null,
        changesetOpId: 'op-1',
        createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
    ],
    exposure: [],
    ...over,
  } as WikiEntryDetail;
}

let entry: WikiEntryDetail = detail();
let posts: Array<{ url: string; body: unknown }> = [];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && url.startsWith(`/api/wiki/entries/${ENTRY_ID}/`)) {
    posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
    return reply(200, {});
  }
  if (url.startsWith(`/api/wiki/entries/${ENTRY_ID}`)) return reply(200, entry);
  if (url.startsWith('/api/wiki/review')) return reply(200, []);
  if (url.startsWith('/api/link-previews')) return reply(200, { previews: [] });
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
  vi.stubGlobal('fetch', vi.fn(serve));
  posts = [];
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
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount(over: Partial<WikiEntryDetail> = {}): Promise<void> {
  entry = detail(over);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AntApp>
            <WikiEntryDrawer entryId={ENTRY_ID} spaceSlug="orbit" onClose={() => {}} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(container.querySelector('.tdp-title')?.textContent).toContain('captureBeyondViewport'));
  await settle();
}

const actions = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('.tdp-head-actions > .ant-btn, .tdp-head-actions > .ant-dropdown-trigger')].map(
    (node) => (node.textContent ?? '').trim() || (node.getAttribute('aria-label') ?? ''),
  );

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('an entry a review mode applied', () => {
  it('Unreviewed: Confirm, then Reject ▾, then Edit — and the bar says it is not sent', async () => {
    await mount();
    expect(actions().slice(0, 3)).toEqual(['Confirm', 'Reject', 'Edit']);
    const bar = container.querySelector('.wk-markbar')!;
    expect(bar.className).toContain('tone-muted');
    expect(bar.textContent).toContain('Unreviewed · applied without review, and not sent to agents until you confirm it.');
    expect(bar.textContent).toContain('Wiki maintenance, 2h ago');
    // The bar sits between the head and Details.
    const html = container.innerHTML;
    expect(html.indexOf('wk-markbar')).toBeGreaterThan(html.indexOf('tdp-head'));
    expect(html.indexOf('wk-markbar')).toBeLessThan(html.indexOf('>Details<'));
    expect(container.textContent).toContain('Not sent to agents while it is Unreviewed.');
    expect(container.textContent).not.toContain('No session has been shown this entry yet.');
  });

  it('confirms through the owner’s door', async () => {
    await mount();
    await act(async () => button('Confirm').click());
    await settle();
    expect(posts).toEqual([{ url: `/api/wiki/entries/${ENTRY_ID}/confirm`, body: {} }]);
  });

  it('rejects with the reason picked from Review’s four, and says where it goes', async () => {
    await mount();
    await act(async () => button('Reject').click());
    await settle();
    const menu = document.querySelector<HTMLElement>('.ant-dropdown-menu')!;
    const items = [...menu.querySelectorAll('.ant-dropdown-menu-item')].map((node) => node.textContent);
    expect(items).toEqual(['Not true', 'Not useful', 'Duplicate', 'Too specific', 'The reason goes on the record.']);
    const notUseful = [...menu.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')].find((node) => node.textContent === 'Not useful')!;
    await act(async () => notUseful.click());
    await settle();
    expect(posts).toEqual([{ url: `/api/wiki/entries/${ENTRY_ID}/reject`, body: { reason: 'not_useful' } }]);
  });

  it('Auto: Reject alone — it is already sent — and a green bar that says Reject takes it back', async () => {
    await mount({ trust: 'auto' });
    expect(actions().slice(0, 2)).toEqual(['Reject', 'Edit']);
    expect(actions()).not.toContain('Confirm');
    const bar = container.querySelector('.wk-markbar')!;
    expect(bar.className).toContain('tone-green');
    expect(bar.textContent).toContain('Auto · applied without asking you, and sent to agents. Reject takes it back.');
    expect(container.textContent).not.toContain('Not sent to agents while it is Unreviewed.');
  });

  it('Web-derived: Confirm is what shows it to agents, said in amber', async () => {
    await mount({ tainted: true });
    expect(actions().slice(0, 2)).toEqual(['Confirm', 'Reject']);
    expect(container.querySelector('.tdp-meta')?.textContent).toContain('Web-derived');
    const bar = container.querySelector('.wk-markbar')!;
    expect(bar.className).toContain('tone-amber');
    expect(bar.textContent).toContain('Web-derived · this session read web pages before proposing. Confirming shows it to agents.');
  });

  const VERDICT = {
    verdict: 'partial' as const,
    reason: 'The cited record says part of it.',
    model: 'qwen3.8-27b-fp8',
    at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    duplicateOf: null,
    evidence: 'readable' as const,
  };

  it('says who checked it and what they said, from the entry read, with nothing of it waiting in Review', async () => {
    await mount({ changesetId: 'run-1', appliedByMode: 'automatic', verification: VERDICT });
    expect(container.querySelector('.wk-markbar .wk-markbar-line')?.textContent).toBe(
      'Checked by qwen3.8-27b-fp8: partly supported · Wiki maintenance, 2h ago',
    );
  });

  it('Web-derived: says the verdict, and that it went no further than Unreviewed', async () => {
    await mount({ tainted: true, changesetId: 'run-1', appliedByMode: 'automatic', verification: { ...VERDICT, verdict: 'supported' } });
    expect(container.querySelector('.wk-markbar .wk-markbar-line')?.textContent).toBe(
      'Checked by qwen3.8-27b-fp8: supported · capped at Unreviewed · Wiki maintenance, 2h ago',
    );
  });

  it('no verdict — a Tiered entry — and the line says who applied it and when, and nothing more', async () => {
    await mount({ changesetId: 'run-2', appliedByMode: 'tiered', verification: null });
    expect(container.querySelector('.wk-markbar .wk-markbar-line')?.textContent).toBe('Wiki maintenance, 2h ago');
  });

  it('what the owner wrote or confirmed offers neither answer and no bar', async () => {
    await mount({ trust: 'confirmed' });
    expect(actions()).not.toContain('Confirm');
    expect(actions()).not.toContain('Reject');
    expect(container.querySelector('.wk-markbar')).toBeNull();
  });
});
