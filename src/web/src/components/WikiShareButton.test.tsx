// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLink, WikiShareCounts } from '../api';

/**
 * The Wiki head's Share and the dialog it opens on a space (docs/share-links-design.md §10; mock
 * share-links 08 ① – ④): `Share` while the space has no public link and `Shared · Live` while it has
 * one, both opening the one Share dialog — here with a wiki's two rows, Documents always and Footnotes
 * off until it is turned on, each with what it holds. What is asserted is what the owner reads and the
 * request each press sends; the server's side is share-links/public-wiki.pg.spec.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getShareLink: vi.fn(),
  putShareLink: vi.fn(),
  turnOffShareLink: vi.fn(),
}));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { getShareLink, putShareLink, turnOffShareLink } = await import('../api');
const { copyText } = await import('../lib/clipboard');
const { WikiShareButton } = await import('./WikiShareButton');

const SPACE = '34ZsQa8m1Wk4gGq0Vd7bNe';
const TOKEN = 'Wk7pQ2xR9mT4vLs8nYb1cZe6hFj0uDa3';
const COUNTS: WikiShareCounts = { documents: 12, footnotes: 486 };

const wikiLink = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: 'L1',
  kind: 'WIKI',
  token: TOKEN,
  include: { footnotes: false },
  expiresAt: null,
  revokedAt: null,
  viewCount: 3,
  lastViewedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  state: 'ACTIVE',
  stateReason: null,
  root: { id: SPACE, title: 'orbit', slug: 'orbit' },
  ...over,
});

/** The space's link as the server keeps it: GET reads it, PUT opens or changes it, DELETE ends it. */
let stored: { link: ShareLink | null; counts: WikiShareCounts };
function serve(link: ShareLink | null): void {
  stored = { link, counts: COUNTS };
  vi.mocked(getShareLink).mockImplementation(async () => structuredClone(stored));
  vi.mocked(putShareLink).mockImplementation(async (_kind, _id, body) => {
    const base = stored.link ?? wikiLink({ viewCount: 0, lastViewedAt: null });
    stored.link = { ...base, include: { ...base.include, ...body.include } };
    return structuredClone(stored.link);
  });
  vi.mocked(turnOffShareLink).mockImplementation(async () => {
    stored.link = null;
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <WikiShareButton spaceId={SPACE} spaceSlug="orbit" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** What the head shows: the Share button, or the Shared · Live pill. */
const head = () => container!.querySelector<HTMLElement>('button');
const dialog = (): HTMLElement => {
  const found = document.body.querySelector<HTMLElement>('[role="dialog"].share-dialog');
  if (!found) throw new Error('the Share dialog is not open');
  return found;
};
/** A dialog's name, as assistive technology reads it. */
const nameOf = (el: Element): string | undefined =>
  document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? undefined;
const layers = () =>
  [...dialog().querySelectorAll<HTMLElement>('.share-layer')].map((row) => ({
    name: row.querySelector('.share-layer-name')?.textContent,
    detail: row.querySelector('.share-layer-detail')?.textContent,
    warn: row.querySelector('.share-layer-detail')?.classList.contains('is-warn') ?? false,
    on: row.querySelector('[role="checkbox"]')!.getAttribute('aria-checked') === 'true',
    locked: row.querySelector('[role="checkbox"]')!.getAttribute('aria-disabled') === 'true',
    count: row.querySelector('.share-layer-count')?.textContent,
  }));

const FOOTNOTES_DETAIL =
  'The quotes and code each sentence cites, with file paths and lines. Can include command output and file contents.';

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  for (const fn of [getShareLink, putShareLink, turnOffShareLink, copyText]) vi.mocked(fn).mockClear();
  for (const fn of Object.values(toast)) fn.mockReset();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the Wiki head’s Share and its dialog', { timeout: 60_000 }, () => {
  it('not shared: Share opens the wiki’s dialog, whose Copy link is the space’s own signed-in address', async () => {
    serve(null);
    await mount();

    expect(getShareLink).toHaveBeenCalledWith('WIKI', SPACE);
    expect(head()?.textContent).toBe('Share');
    await click(head(), 'Share');
    expect(nameOf(dialog())).toBe('Share wiki');
    expect(dialog().querySelector('.share-access-select')?.textContent?.trim()).toBe('Only you');
    await click(
      [...dialog().querySelectorAll('.share-dialog-foot :is(button, a)')].find((b) => b.textContent?.trim() === 'Copy link'),
      'Copy link',
    );
    expect(copyText).toHaveBeenCalledWith(`${window.location.origin}/wiki/orbit`);
  });

  it('turning it on opens the space’s link with Documents always and Footnotes off, each with what it holds', async () => {
    serve(null);
    await mount();
    await click(head(), 'Share');

    await click(dialog().querySelector('.share-access-select'), 'the Access control');
    const anyone = [...document.body.querySelectorAll('.share-access-menu [role="menuitem"]')].find(
      (item) => item.querySelector('.share-access-option-title')?.textContent === 'Anyone with the link',
    );
    await click(anyone, 'Anyone with the link');

    expect(putShareLink).toHaveBeenCalledWith('WIKI', SPACE, {});
    await vi.waitFor(() => expect(dialog().querySelector('input[aria-label="Public link"]')).not.toBeNull());
    expect(dialog().textContent).toContain('Anyone with the link can view — no sign-in. They can’t change anything.');
    expect(layers()).toEqual([
      {
        name: 'Documents',
        detail: 'The wiki’s home and every document written so far',
        warn: false,
        on: true,
        locked: true,
        count: '12 documents',
      },
      { name: 'Footnotes', detail: FOOTNOTES_DETAIL, warn: false, on: false, locked: false, count: '486 footnotes' },
    ]);
    // The head says so at once: the dialog's write is the head's read.
    expect(head()?.textContent).toContain('Shared · Live');
  });

  it('Footnotes sends only its own layer, and its risk is said in amber once it is on', async () => {
    serve(wikiLink());
    await mount();

    expect(head()?.textContent).toContain('Shared · Live');
    await click(head(), 'Shared · Live');
    await click(dialog().querySelector('.share-layer[data-layer="footnotes"] [role="checkbox"]'), 'the Footnotes switch');

    expect(putShareLink).toHaveBeenCalledWith('WIKI', SPACE, { include: { footnotes: true } });
    await vi.waitFor(() => expect(layers()[1]).toMatchObject({ name: 'Footnotes', on: true, warn: true }));
    expect(layers()[1].count).toBe('486 footnotes');
  });
});
