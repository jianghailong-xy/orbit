// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionShareCounts, ShareLink } from '../api';

/**
 * The Share dialog on a session (docs/share-links-design.md §2, §3, §8; mock 03-share-dialog), in a
 * real document: its three states — nobody but you, anyone with the link, and the question asked
 * before a link is turned off — and the count each layer carries. What is asserted is what the
 * owner reads and the request each press sends; the server's side is share-links.pg.spec.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getShareLink: vi.fn(),
  putShareLink: vi.fn(),
  turnOffShareLink: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { getShareLink, putShareLink, turnOffShareLink } = await import('../api');
const { ShareModal } = await import('./ShareModal');

const SESSION = '34ToZJmiOG8Ym1MR6ingQ';
const TOKEN = 'k3Qx9vR2mT7wLp4sYb8nZc1eHf6uJd0a';
const HOUR = 3_600_000;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();

/** The counts GET /sessions/:id/share answers with — the session's own, not the link's. */
const COUNTS: SessionShareCounts = { messages: 77, toolCalls: 196 };

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: 'L1',
  kind: 'SESSION',
  token: TOKEN,
  include: { toolOutput: true },
  expiresAt: null,
  revokedAt: null,
  viewCount: 14,
  lastViewedAt: at(-2 * HOUR),
  createdAt: at(-24 * HOUR),
  updatedAt: at(-24 * HOUR),
  state: 'ACTIVE',
  stateReason: null,
  root: { id: SESSION, title: '子代理模型由伺服器端設定', status: 'AWAITING_INPUT', lifecycleState: 'OPEN', completedAt: null },
  ...over,
});

/**
 * The owner's side of the server, as far as this dialog reaches it: one root, its open link (or
 * none), and its counts. PUT opens or changes the link, DELETE ends it, GET reads what is there now
 * — so a read that comes round after a write sees the write, as it would against the real one.
 */
let stored: { link: ShareLink | null; counts: SessionShareCounts };
function serve(initial: { link: ShareLink | null; counts?: SessionShareCounts }): void {
  stored = { link: initial.link, counts: initial.counts ?? COUNTS };
  vi.mocked(getShareLink).mockImplementation(async () => structuredClone(stored));
  vi.mocked(putShareLink).mockImplementation(async (_kind, _id, body) => {
    const base = stored.link ?? link({ viewCount: 0, lastViewedAt: null });
    stored.link = {
      ...base,
      include: { ...base.include, ...body.include },
      expiresAt: body.expiresAt === undefined ? base.expiresAt : body.expiresAt,
    };
    return structuredClone(stored.link);
  });
  vi.mocked(turnOffShareLink).mockImplementation(async () => {
    stored.link = null;
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const onClose = vi.fn();

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ShareModal open onClose={onClose} kind="SESSION" rootId={SESSION} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(dialog().querySelector('.share-access')).not.toBeNull(), { timeout: 10_000 });
  await settle();
}

const dialog = (): HTMLElement => {
  const found = document.body.querySelector<HTMLElement>('.ant-modal.share-dialog');
  if (!found) throw new Error('the Share dialog is not open');
  return found;
};
const text = (): string => dialog().textContent ?? '';

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Access, opened as a press opens it, and the one choice asked for. */
async function chooseAccess(choice: 'Only you' | 'Anyone with the link'): Promise<void> {
  await click(dialog().querySelector('.share-access-select'), 'the Access control');
  const option = [...document.body.querySelectorAll('.share-access-menu .ant-dropdown-menu-item')].find(
    (item) => item.querySelector('.share-access-option-title')?.textContent === choice,
  );
  await click(option, `the "${choice}" choice`);
}

/** The Includes rows as the owner reads them: name, whether it is on, whether it can change, count. */
const layers = () =>
  [...dialog().querySelectorAll<HTMLElement>('.share-layer')].map((row) => ({
    name: row.querySelector('.share-layer-name')?.textContent,
    on: row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
    locked: row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
    count: row.querySelector('.share-layer-count')?.textContent,
  }));

const footButtons = () =>
  [...dialog().querySelectorAll<HTMLElement>('.share-dialog-foot .ant-btn')].map((b) => b.textContent?.trim());

const popconfirm = () => document.body.querySelector<HTMLElement>('.ant-popconfirm');

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
  vi.mocked(getShareLink).mockReset();
  vi.mocked(putShareLink).mockReset();
  vi.mocked(turnOffShareLink).mockReset();
  onClose.mockReset();
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

describe('the Share dialog on a session', { timeout: 60_000 }, () => {
  it('not shared: only you, no public address, and the signed-in Copy link', async () => {
    serve({ link: null });
    await open();

    expect(getShareLink).toHaveBeenCalledWith('SESSION', SESSION);
    expect(dialog().querySelector('.ant-modal-title')?.textContent).toBe('Share session');
    expect(dialog().querySelector('.share-access-select')?.textContent?.trim()).toBe('Only you');
    expect(text()).toContain('Only you can open it, signed in. Choose “Anyone with the link” to make a public link.');
    // Nothing public exists, so nothing public is shown or offered.
    expect(dialog().querySelector('input[aria-label="Public link"]')).toBeNull();
    expect(dialog().querySelectorAll('.share-layer')).toHaveLength(0);
    expect(text()).not.toContain('Preview');
    expect(text()).toContain('Copy link — the signed-in link, for yourself');
    expect(footButtons()).toEqual(['Copy link']);
  });

  it('turning it on opens a link with the defaults, then shows the link, the layers with counts, Live, Expires and views', async () => {
    serve({ link: null });
    await open();

    await chooseAccess('Anyone with the link');

    expect(putShareLink).toHaveBeenCalledTimes(1);
    expect(putShareLink).toHaveBeenCalledWith('SESSION', SESSION, {});
    await vi.waitFor(() => expect(dialog().querySelector('input[aria-label="Public link"]')).not.toBeNull());
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Public link"]')!.value).toBe(
      `${window.location.origin}/s/${TOKEN}`,
    );
    expect(dialog().querySelector('.share-access-select')?.textContent?.trim()).toBe('Anyone with the link');
    expect(layers()).toEqual([
      { name: 'Messages', on: true, locked: true, count: '77 messages' },
      { name: 'Tool calls and output', on: true, locked: false, count: '196 calls' },
    ]);
    expect(text()).toContain('Live — viewers see changes as they happen');
    expect(text()).toContain('Not opened yet');
  });

  it('shared: Access, the link and Copy, Includes with counts, the Live line, Expires, views and Preview', async () => {
    serve({ link: link() });
    await open();

    expect(dialog().querySelector('.share-access-select')?.textContent?.trim()).toBe('Anyone with the link');
    expect(text()).toContain('Anyone with the link can view — no sign-in. They can’t reply or change anything.');
    const url = dialog().querySelector<HTMLInputElement>('input[aria-label="Public link"]');
    expect(url?.value).toBe(`${window.location.origin}/s/${TOKEN}`);
    expect(dialog().querySelector('.share-dialog-url .ant-btn')?.textContent?.trim()).toBe('Copy');
    expect(dialog().querySelector('.share-dialog-label')?.textContent).toBe('Includes');
    expect(layers()).toEqual([
      { name: 'Messages', on: true, locked: true, count: '77 messages' },
      { name: 'Tool calls and output', on: true, locked: false, count: '196 calls' },
    ]);
    const rows = [...dialog().querySelectorAll('.share-dialog-row')].map((row) => row.textContent);
    expect(rows[0]).toBe('UpdatesLive — viewers see changes as they happen');
    expect(rows[1]).toContain('Expires');
    expect(rows[1]).toContain('Never');
    expect(dialog().querySelector('.share-dialog-stat')?.textContent).toBe('Viewed 14 times · last 2h ago');
    expect(footButtons()).toEqual(['Preview ↗', 'Done']);
    const preview = [...dialog().querySelectorAll<HTMLAnchorElement>('.share-dialog-foot a')].find(
      (a) => a.textContent?.includes('Preview'),
    );
    // The owner's own look is flagged, so the link does not count it as a visit.
    expect(preview?.getAttribute('href')).toBe(`${window.location.origin}/s/${TOKEN}?preview=1`);
    expect(preview?.getAttribute('target')).toBe('_blank');
  });

  it('the counts are the session’s own, one of each read in the singular', async () => {
    serve({ link: link(), counts: { messages: 1, toolCalls: 1 } });
    await open();
    expect(layers().map((row) => row.count)).toEqual(['1 message', '1 call']);
  });

  it('turning Tool calls and output off sends only that layer', async () => {
    serve({ link: link() });
    await open();

    const tools = dialog().querySelector<HTMLInputElement>('.share-layer[data-layer="toolOutput"] input[type="checkbox"]');
    await click(tools, 'the Tool calls and output switch');

    expect(putShareLink).toHaveBeenCalledWith('SESSION', SESSION, { include: { toolOutput: false } });
    await vi.waitFor(() => expect(layers()[1]).toMatchObject({ name: 'Tool calls and output', on: false }));
    // What the layer holds does not change with whether it is shown.
    expect(layers()[1].count).toBe('196 calls');
  });

  it('choosing Only you asks first, and turns the link off only when that is confirmed', async () => {
    serve({ link: link() });
    await open();

    await chooseAccess('Only you');

    const asked = popconfirm();
    expect(asked, 'no question before turning the link off').not.toBeNull();
    expect(asked!.querySelector('.ant-popconfirm-title')?.textContent).toBe('Turn off this link?');
    expect(asked!.querySelector('.ant-popconfirm-description')?.textContent).toBe(
      'Anyone who has it loses access right away.',
    );
    expect(turnOffShareLink, 'the link was turned off before anyone confirmed').not.toHaveBeenCalled();
    // Still public while the question is open.
    expect(dialog().querySelector('input[aria-label="Public link"]')).not.toBeNull();

    const confirm = [...asked!.querySelectorAll('.ant-btn')].find((b) => b.textContent?.trim() === 'Turn off');
    await click(confirm, 'Turn off');

    expect(turnOffShareLink).toHaveBeenCalledWith('SESSION', SESSION);
    await vi.waitFor(() => expect(dialog().querySelector('.share-access-select')?.textContent?.trim()).toBe('Only you'));
    expect(dialog().querySelector('input[aria-label="Public link"]')).toBeNull();
  });

  it('cancelling the question leaves the link as it was', async () => {
    serve({ link: link() });
    await open();

    await chooseAccess('Only you');
    const cancel = [...popconfirm()!.querySelectorAll('.ant-btn')].find((b) => b.textContent?.trim() === 'Cancel');
    await click(cancel, 'Cancel');

    expect(turnOffShareLink).not.toHaveBeenCalled();
    expect(dialog().querySelector('.share-access-select')?.textContent?.trim()).toBe('Anyone with the link');
    expect(dialog().querySelector('input[aria-label="Public link"]')).not.toBeNull();
  });

  it('Expires sends a day seven days out and says when it stops working', async () => {
    serve({ link: link() });
    await open();

    await act(async () => {
      dialog().querySelector('.share-dialog-expiry .ant-select-content')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    const options = [...document.body.querySelectorAll('.ant-select-item-option')];
    expect(options.map((o) => o.textContent)).toEqual(['Never', '1 day', '7 days', '30 days']);
    await click(options.find((o) => o.textContent === '7 days'), 'the 7 days choice');

    expect(putShareLink).toHaveBeenCalledTimes(1);
    const [, , body] = vi.mocked(putShareLink).mock.calls[0];
    const sent = Date.parse(body.expiresAt!);
    expect(Math.abs(sent - (Date.now() + 7 * 24 * HOUR))).toBeLessThan(60_000);
    const day = new Date(sent).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    await vi.waitFor(() => expect(text()).toContain(`Stops working ${day}`));
  });

  it('a link reopened with an expiry names the day it stops', async () => {
    const until = at(3 * 24 * HOUR);
    serve({ link: link({ expiresAt: until }) });
    await open();
    const day = new Date(until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    expect(dialog().querySelector('.share-dialog-expiry')?.textContent).toBe(`Until ${day}`);
  });

  it('a link past its expiry is not a public link any more', async () => {
    serve({ link: link({ expiresAt: at(-HOUR), state: 'ENDED', stateReason: 'EXPIRED' }) });
    await open();
    expect(dialog().querySelector('.share-access-select')?.textContent?.trim()).toBe('Only you');
    expect(dialog().querySelector('input[aria-label="Public link"]')).toBeNull();
  });
});
