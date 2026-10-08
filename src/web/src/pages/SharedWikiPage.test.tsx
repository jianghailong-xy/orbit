// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedWiki, SharedWikiDoc, SharedWikiFootnote } from '../api';
import { wikiMonthDayTime } from '../lib/wikiDocs';
import { wikiMonthDay } from '../lib/wikiReviewMode';
import { SharedLinkPage } from './SharedLinkPage';
import { SharedWikiDocRoute } from './SharedWikiPage';

/**
 * A wiki link's pages (docs/share-links-design.md §10; mock share-links 09), mounted whole on the
 * routes that serve them: `/s/<token>`, the space's home, and `/s/<token>/d/<slug>`, one written
 * document. What is held here:
 *
 *  - the home lists the written documents by category in the app home's rows, each opening its page
 *    under the same link;
 *  - without Footnotes a document is its text alone — no number after a sentence, no footnote list;
 *  - with Footnotes the numbers open the app's footnote card, which names the original's place and
 *    leads nowhere, and a person's comment is the Owner's;
 *  - a document left to another links only when the link opens that one;
 *  - no link on any of them goes into the app, and a document the link does not open is the dead
 *    link's page.
 */

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const TOKEN = 'Wk7pQ2xR9mT4vLs8nYb1cZe6hFj0uDa3';
const SHARE = `/api/shared/${TOKEN}`;

const WIKI: SharedWiki = {
  name: 'orbit',
  documents: 3,
  categories: [
    {
      key: 'runtime',
      number: 1,
      title: 'Runtime',
      docs: [
        { slug: 'session-runtime', number: '1.1', title: 'Session runtime', lead: 'A session claims a turn. It retries a failed one.' },
        { slug: 'deploy', number: '1.3', title: 'Deploy', lead: null },
      ],
    },
    { key: 'ops', number: 3, title: 'Operations', docs: [{ slug: 'backups', number: '3.1', title: 'Backups', lead: 'Back up nightly.' }] },
  ],
};

const FOOTNOTES: SharedWikiFootnote[] = [
  {
    n: 1,
    kind: 'code',
    verdict: 'verified',
    quote: 'claimTurn(',
    path: 'src/runner/loop.ts',
    lineStart: 10,
    lineEnd: 12,
    section: null,
    symbol: 'RunLoop.claim',
    excerpt: 'function claim() {\n  claimTurn(next);\n}',
    seq: null,
    at: null,
    label: null,
    notePath: null,
  },
  {
    n: 2,
    kind: 'turn',
    verdict: 'verified',
    quote: 'claim the next turn',
    path: null,
    lineStart: null,
    lineEnd: null,
    section: null,
    symbol: null,
    excerpt: null,
    seq: 4,
    at: '2026-09-30T08:00:00.000Z',
    label: 'user',
    notePath: null,
  },
  {
    n: 3,
    kind: 'task_comment',
    verdict: 'not_found',
    quote: 'it retries',
    path: null,
    lineStart: null,
    lineEnd: null,
    section: null,
    symbol: null,
    excerpt: null,
    seq: null,
    at: '2026-09-30T09:00:00.000Z',
    label: 'USER',
    notePath: null,
  },
];

/** The document as the server answers it: its numbers and footnotes only with Footnotes. */
function doc(footnotes: boolean): SharedWikiDoc {
  return {
    slug: 'session-runtime',
    number: '1.1',
    title: 'Session runtime',
    question: 'How does a session run?',
    audience: ['Someone new to the runner'],
    scopeIn: ['The run loop'],
    scopeOut: [
      { text: 'Where it is stored', docs: [{ slug: null, number: '1.2', title: 'Storage' }] },
      { text: 'Deploying it', docs: [{ slug: 'deploy', number: '1.3', title: 'Deploy' }] },
    ],
    category: { key: 'runtime', number: 1, title: 'Runtime' },
    updatedAt: '2026-10-02T09:00:00.000Z',
    sections: [
      {
        key: 'loop',
        number: 1,
        title: 'The loop',
        blocks: [
          { kind: 'heading', text: 'How it starts', sentences: [] },
          {
            kind: 'paragraph',
            text: null,
            sentences: [
              { text: 'A session claims a turn.', notes: footnotes ? [1, 2] : [] },
              { text: 'It retries a `failed` one.', notes: footnotes ? [3] : [] },
            ],
          },
          { kind: 'code', text: 'orbit run --once', sentences: [] },
        ],
      },
      { key: 'end', number: 3, title: 'The end', blocks: [{ kind: 'item', text: null, sentences: [{ text: 'It finishes.', notes: [] }] }] },
    ],
    ...(footnotes ? { footnotes: FOOTNOTES } : {}),
  };
}

let footnotesOn = false;
let requests: string[] = [];
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Not Found', json: async () => body }) as Response;

/** GET /shared/:token…, as share-links/public-wiki.ts answers it. */
function share(url: string): Response {
  const include = { footnotes: footnotesOn };
  if (url.startsWith(`${SHARE}?`)) return json({ kind: 'WIKI', include, sharedAt: '2026-10-07T00:00:00.000Z', root: WIKI });
  if (url === `${SHARE}/docs/session-runtime`) return json({ include, wiki: { name: 'orbit' }, doc: doc(footnotesOn) });
  return json({ statusCode: 404, message: 'shared link not found', error: 'Not Found' }, 404);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  footnotesOn = false;
  requests = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      return share(url);
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/s/:token" element={<SharedLinkPage />} />
            <Route path="/s/:token/d/:slug" element={<SharedWikiDocRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string) {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const hrefs = () => [...document.body.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
const crumbs = () =>
  [...container.querySelectorAll('.share-crumbs .share-crumb')].map((el) => ({ label: el.textContent, to: el.getAttribute('href') }));
const footnoteNumbers = () => [...container.querySelectorAll('.wk-dc-body .wk-fn-n')].map((b) => b.textContent);

describe('a wiki link’s pages', { timeout: 60_000 }, () => {
  it('the home lists the written documents by category, each opening its page under the same link', async () => {
    await mount(`/s/${TOKEN}`);

    expect(crumbs()).toEqual([{ label: 'orbit · Wiki', to: null }]);
    expect(container.querySelector('.page-title')?.textContent).toBe('Wiki');
    expect(container.querySelector('.wk-space-tag')?.textContent).toBe('orbit');
    expect(container.querySelector('.wk-home-state')?.textContent).toBe('3 documents');
    expect([...container.querySelectorAll('.wk-pl-cat-h')].map((h) => h.textContent)).toEqual(['1Runtime', '3Operations']);
    const rows = [...container.querySelectorAll<HTMLAnchorElement>('.wk-pl-doc')].map((row) => ({
      number: row.querySelector('.no')?.textContent,
      title: row.querySelector('.tt')?.textContent,
      lead: row.querySelector('.q')?.textContent ?? null,
      to: row.getAttribute('href'),
    }));
    expect(rows).toEqual([
      { number: '1.1', title: 'Session runtime', lead: 'A session claims a turn. It retries a failed one.', to: `/s/${TOKEN}/d/session-runtime` },
      { number: '1.3', title: 'Deploy', lead: null, to: `/s/${TOKEN}/d/deploy` },
      { number: '3.1', title: 'Backups', lead: 'Back up nightly.', to: `/s/${TOKEN}/d/backups` },
    ]);
    expect(hrefs().every((href) => href.startsWith(`/s/${TOKEN}`))).toBe(true);
    expect(document.title).toBe('orbit · Wiki — Orbit');
  });

  it('without Footnotes a document is its text alone, its scope linking only to documents the link opens', async () => {
    await mount(`/s/${TOKEN}/d/session-runtime`);

    expect(requests).toContain(`${SHARE}/docs/session-runtime`);
    expect(crumbs()).toEqual([
      { label: 'orbit · Wiki', to: `/s/${TOKEN}` },
      { label: 'Session runtime', to: null },
    ]);
    expect(container.querySelector('.wk-art-title')?.textContent).toBe('Session runtime');
    expect([...container.querySelectorAll('.wk-tag')].map((t) => t.textContent)).toEqual(['Runtime', '2 sections']);
    // Local time, as the app's own pages say it.
    expect(container.querySelector('.wk-art-updated')?.textContent).toBe(
      `Updated ${wikiMonthDay('2026-10-02T09:00:00.000Z')} · written by Wiki maintenance`,
    );
    const scope = container.querySelector('.wk-dc-scope')!;
    expect(scope.textContent).toContain('How does a session run?');
    // Storage is not written: its number, not a link. Deploy is: its page, under this link.
    expect(scope.querySelector('.see.off')?.textContent?.trim()).toBe('→ 1.2');
    expect([...scope.querySelectorAll('a.see')].map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['→ 1.3', `/s/${TOKEN}/d/deploy`],
    ]);
    expect([...container.querySelectorAll('.wk-dc-sec h2')].map((h) => h.textContent)).toEqual(['1The loop', '3The end']);
    const body = container.querySelector('.wk-dc-body')!;
    expect(body.querySelector('h3')?.textContent).toBe('How it starts');
    expect(body.querySelector('.wk-dc-code')?.textContent).toBe('orbit run --once');
    expect(body.querySelector('p code')?.textContent).toBe('failed');
    expect(body.querySelector('li')?.textContent).toContain('It finishes.');
    expect(footnoteNumbers()).toEqual([]);
    expect(container.querySelector('.wk-fn2-list')).toBeNull();
    expect(hrefs().every((href) => href.startsWith(`/s/${TOKEN}`))).toBe(true);
  });

  it('with Footnotes the numbers open the app’s card, which names the original’s place and leads nowhere', async () => {
    footnotesOn = true;
    await mount(`/s/${TOKEN}/d/session-runtime`);

    expect(footnoteNumbers()).toEqual(['[1]', '[2]', '[3]']);
    expect([...container.querySelectorAll('.wk-tag')].map((t) => t.textContent)).toContain('3 footnotes');
    const list = container.querySelector('.wk-fn2-list')!;
    expect([...list.querySelectorAll('.wk-fn2-row .loc')].map((l) => l.textContent)).toEqual([
      'src/runner/loop.ts · RunLoop.claim',
      `turn #4 · ${wikiMonthDayTime('2026-09-30T08:00:00.000Z')}`,
      `comment · ${wikiMonthDayTime('2026-09-30T09:00:00.000Z')}`,
    ]);

    await click(container.querySelector('#wk-fnref-1'), 'footnote 1');
    const card = document.body.querySelector('.ant-popover .wk-fn2')!;
    expect(card.querySelector('.k')?.textContent).toContain('Code');
    expect(card.querySelector('.code .ln.q')?.textContent).toContain('claimTurn(next);');
    expect(card.querySelector('.loc')?.textContent).toBe('src/runner/loop.ts · RunLoop.claim · L10–12');
    expect(card.querySelectorAll('a')).toHaveLength(0);
    expect(card.querySelector('.via')).toBeNull();

    await click(container.querySelector('#wk-fnref-3'), 'footnote 3');
    const comment = [...document.body.querySelectorAll('.ant-popover .wk-fn2')].find((c) => c.textContent?.includes('it retries'))!;
    expect(comment.querySelector('.k')?.textContent).toContain('Owner’s comment');
    expect(comment.querySelector('.k')?.textContent).toContain('quote not found');
    // A visitor cannot open the original, so they are not told to.
    expect(comment.querySelector('.xnote')).toBeNull();
    expect(hrefs().every((href) => href.startsWith(`/s/${TOKEN}`))).toBe(true);
  });

  it('a document the link does not open is the dead link’s page', async () => {
    await mount(`/s/${TOKEN}/d/storage`);
    expect(container.textContent).toContain('This shared link isn’t available');
  });
});
