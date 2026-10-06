// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AccessToken, type IssuedAccessToken } from '../api';
import { ALL_SCOPES, NEVER_EXPIRES, NEVER_EXPIRES_WARNING, READ_SCOPES, fullDate, untilLine } from '../lib/accessTokens';
import { ago } from '../lib/watches';

/**
 * Settings → Access tokens (docs/personal-access-token-design.md §9), in a real document over what
 * GET /access-tokens answers: the list and what each row says, issuing a token from the dialog — and
 * the token itself shown once, beside Copy, and nowhere after — and revoking one.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  listAccessTokens: vi.fn(),
  issueAccessToken: vi.fn(),
  revokeAccessToken: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const { api, issueAccessToken, listAccessTokens, revokeAccessToken } = await import('../api');
const { copyText } = await import('../lib/clipboard');
const { AccessTokensPage } = await import('./AccessTokensPage');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();
const WORKSPACE = { id: 'W1', name: 'orbit-develop' };

let serial = 0;
const token = (name: string, over: Partial<AccessToken> = {}): AccessToken => {
  serial += 1;
  return {
    id: `T${serial}`,
    name,
    tokenHint: `h${String(serial).padStart(3, '0')}`,
    scopes: [...READ_SCOPES],
    workspaceIds: [],
    workspaces: [],
    expiresAt: at(30 * DAY),
    createdVia: 'WEB',
    lastUsedAt: null,
    lastUsedIp: null,
    lastUsedUserAgent: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: at(-10 * DAY),
    state: 'ACTIVE',
    ...over,
  };
};

const CI = token('CI pipeline', {
  scopes: [...ALL_SCOPES],
  expiresAt: null,
  lastUsedAt: at(-3 * HOUR),
  lastUsedIp: '203.0.113.7',
  lastUsedUserAgent: 'orbit-cli/0.1.220',
});
const LAPTOP = token('Laptop script', {
  scopes: ['tasks:read', 'tasks:write', 'wiki:read'],
  workspaceIds: [WORKSPACE.id],
  workspaces: [WORKSPACE],
  expiresAt: at(90 * DAY),
  createdVia: 'CLI_DEVICE',
});
const OLD = token('Old cron', { state: 'REVOKED', revokedAt: at(-2 * DAY), revokedReason: 'ADMIN' });
const LAPSED = token('Demo', { state: 'EXPIRED', expiresAt: at(-5 * DAY) });

/** The one string this page must show once: what POST /access-tokens answers and nothing else does. */
const PLAINTEXT = 'orbit_pat_mYq3Lx0vR8tN2wPz5KcJ7hB4dF6gS1aE9uIoT3yVbXk';

let stored: AccessToken[] = [];
function serve(tokens: AccessToken[]): void {
  stored = tokens.map((t) => structuredClone(t));
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/workspaces') return [WORKSPACE];
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(listAccessTokens).mockImplementation(async () => ({ tokens: structuredClone(stored) }));
  vi.mocked(revokeAccessToken).mockImplementation(async (id) => {
    stored = stored.map((t) =>
      t.id === id ? { ...t, state: 'REVOKED', revokedAt: new Date().toISOString(), revokedReason: 'USER' } : t);
    return { id, revokedAt: new Date().toISOString(), revokedReason: 'USER' };
  });
  vi.mocked(issueAccessToken).mockImplementation(async (body) => {
    serial += 1;
    const issued: IssuedAccessToken = {
      id: `T${serial}`,
      token: PLAINTEXT,
      name: body.name,
      tokenHint: PLAINTEXT.slice(-4),
      scopes: body.scopes,
      workspaceIds: body.workspaceIds ?? [],
      expiresAt: body.expiresInDays === null ? null : at(body.expiresInDays * DAY),
      createdVia: 'WEB',
      createdAt: new Date().toISOString(),
    };
    // What the list answers from now on: the token's row, never the token.
    const { token: _secret, ...row } = issued;
    stored = [{ ...row, workspaces: [], lastUsedAt: null, lastUsedIp: null, lastUsedUserAgent: null, revokedAt: null, revokedReason: null, state: 'ACTIVE' }, ...stored];
    return issued;
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(path = '/settings/access-tokens'): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <AccessTokensPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(page().querySelector('.ant-table-row, .ant-table-placeholder')).not.toBeNull(), {
    timeout: 10_000,
  });
  await settle();
}

/** Leave the page: what it held goes with it. */
async function leave(): Promise<void> {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  await settle();
}

const page = (): HTMLElement => {
  if (!container) throw new Error('the page is not mounted');
  return container;
};
const dialog = () => document.body.querySelector<HTMLElement>('.ant-modal.access-token-dialog');

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const button = (within: ParentNode, label: string) =>
  [...within.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label);

async function type(input: HTMLInputElement | null, value: string): Promise<void> {
  expect(input, 'the input is on screen').toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** Every row of the list as it reads, cell by cell. */
const rows = () =>
  [...page().querySelectorAll<HTMLElement>('.ant-table-row')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim() ?? ''));

const tabs = () =>
  [...page().querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
    label: tab.firstChild?.textContent,
    count: tab.querySelector('.following-count')?.textContent,
    selected: tab.getAttribute('aria-selected') === 'true',
  }));

/** How many times `text` appears anywhere in the document. */
const occurrences = (text: string) => document.body.textContent!.split(text).length - 1;

async function newToken(name: string, choose: (form: HTMLElement) => Promise<void> = async () => {}): Promise<void> {
  await click(button(page(), 'New token'), 'New token');
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  await type(dialog()!.querySelector<HTMLInputElement>('input[placeholder^="What it"]'), name);
  await choose(dialog()!);
  await click(button(dialog()!, 'Create token'), 'Create token');
  await vi.waitFor(() => expect(issueAccessToken).toHaveBeenCalled());
  await settle();
}

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
  for (const fn of [api, listAccessTokens, issueAccessToken, revokeAccessToken, copyText]) vi.mocked(fn).mockClear();
  for (const fn of Object.values(toast)) fn.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
});

afterEach(async () => {
  await leave();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Settings → Access tokens', { timeout: 60_000 }, () => {
  it('lists each active token: what it can do and where, its expiry — Never expires marked — its last use and how it was made', async () => {
    serve([CI, LAPTOP, OLD, LAPSED]);
    await open();

    expect(page().querySelector('.page-title')?.textContent).toBe('Access tokens');
    expect(tabs()).toEqual([
      { label: 'Active', count: '2', selected: true },
      { label: 'Revoked & expired', count: '2', selected: false },
    ]);
    const now = Date.now();
    expect(rows()).toEqual([
      [
        `CI pipelineorbit_pat_…${CI.tokenHint}`,
        'Read & write · everything',
        'All workspaces',
        NEVER_EXPIRES,
        `${ago(CI.lastUsedAt, now)}203.0.113.7`,
        `${fullDate(CI.createdAt)}in Settings`,
        'Revoke',
      ],
      [
        `Laptop scriptorbit_pat_…${LAPTOP.tokenHint}`,
        'Tasks: read & write · Wiki: read',
        'orbit-develop',
        `${fullDate(LAPTOP.expiresAt!)}${untilLine(LAPTOP.expiresAt!, now)}`,
        'Never used',
        `${fullDate(LAPTOP.createdAt)}by orbit login`,
        'Revoke',
      ],
    ]);
    // The mark is a tag of its own, on the token that never expires and on no other.
    expect([...page().querySelectorAll('.access-token-never')].map((tag) => tag.textContent)).toEqual([NEVER_EXPIRES]);
    // Where the last use came from carries what made it.
    expect(page().querySelector('[title="orbit-cli/0.1.220"]')?.textContent).toBe('203.0.113.7');

    await click(page().querySelectorAll('[role="tab"]')[1], 'Revoked & expired');
    expect(rows().map((row) => [row[0], row[3], row.length])).toEqual([
      [`Old cronorbit_pat_…${OLD.tokenHint}`, `Revoked by an administrator ${fullDate(OLD.revokedAt!)}`, 7],
      [`Demoorbit_pat_…${LAPSED.tokenHint}`, `Expired ${fullDate(LAPSED.expiresAt!)}`, 7],
    ]);
    // A token that no longer works has nothing to revoke.
    expect(page().querySelectorAll('.ant-table-row button')).toHaveLength(0);
  });

  it('issues a token and shows it once — in full, beside Copy and why to copy it now — never in the list, and gone once dismissed', async () => {
    serve([CI]);
    await open();

    await newToken('Nightly report', async (form) => {
      // 90 days unless another is chosen, saying when that is.
      const checked = form.querySelector<HTMLInputElement>('input[type="radio"][value="90"]');
      expect(checked?.checked).toBe(true);
      expect(form.textContent).toContain(`Stops working on ${fullDate(at(90 * DAY))}.`);
      expect(form.textContent).not.toContain(NEVER_EXPIRES_WARNING);
      // Never says what it risks, where it is chosen.
      await click(form.querySelector('input[type="radio"][value="never"]'), 'Never');
      expect(form.querySelector('.access-token-never-warning')?.textContent).toBe(NEVER_EXPIRES_WARNING);
    });

    expect(issueAccessToken).toHaveBeenCalledWith({
      name: 'Nightly report',
      scopes: [...READ_SCOPES],
      workspaceIds: [],
      expiresInDays: null,
    });
    await vi.waitFor(() => expect(page().querySelector('.access-token-issued')).not.toBeNull());
    const shown = page().querySelector<HTMLElement>('.access-token-issued')!;
    expect(shown.querySelector('.access-token-secret')?.textContent).toBe(PLAINTEXT);
    expect(shown.textContent).toContain('Nightly report is ready');
    expect(shown.textContent).toContain('Copy it now — this is the only time it is shown. Once you leave this page, it can’t be seen again.');
    // Once on the page: in the panel, and in the list only as its last four characters.
    await vi.waitFor(() => expect(rows().map((row) => row[0])).toContain(`Nightly reportorbit_pat_…${PLAINTEXT.slice(-4)}`));
    expect(occurrences(PLAINTEXT)).toBe(1);
    expect(page().querySelector('.ant-table')!.textContent).not.toContain(PLAINTEXT);
    expect(dialog()?.textContent ?? '').not.toContain(PLAINTEXT);

    await click(button(shown, 'Copy'), 'Copy');
    expect(copyText).toHaveBeenCalledWith(PLAINTEXT);
    expect(toast.success).toHaveBeenCalledWith('Token copied');

    await click(button(shown, 'Done'), 'Done');
    expect(page().querySelector('.access-token-issued')).toBeNull();
    expect(occurrences(PLAINTEXT)).toBe(0);
  });

  it('keeps the token nowhere once the page is left: not when it is opened again, and in no cache', async () => {
    serve([]);
    await open();
    await newToken('CI deploy');
    await vi.waitFor(() => expect(page().querySelector('.access-token-secret')?.textContent).toBe(PLAINTEXT));

    await leave();
    await open();
    expect(page().querySelector('.access-token-issued')).toBeNull();
    expect(occurrences(PLAINTEXT)).toBe(0);
    expect(rows().map((row) => row[0])).toEqual([`CI deployorbit_pat_…${PLAINTEXT.slice(-4)}`]);
    const cached = JSON.stringify([
      client.getQueryCache().getAll().map((query) => query.state.data),
      client.getMutationCache().getAll().map((mutation) => mutation.state.data),
    ]);
    expect(cached).not.toContain(PLAINTEXT.slice('orbit_pat_'.length));
    expect(listAccessTokens).toHaveBeenCalled();
  });

  it('a custom token is the scopes picked, write bringing read along; a name and a scope are needed to create one', async () => {
    serve([]);
    await open();
    await click(button(page(), 'New token'), 'New token');
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const form = dialog()!;
    expect(button(form, 'Create token')?.hasAttribute('disabled')).toBe(true);

    await type(form.querySelector<HTMLInputElement>('input[placeholder^="What it"]'), 'Wiki bot');
    await click(form.querySelector('input[type="radio"][value="custom"]'), 'Custom');
    const row = (resource: string) =>
      [...form.querySelectorAll<HTMLElement>('.access-token-scope-row')].find((r) => r.firstChild?.textContent === resource)!;
    const box = (resource: string, which: 'Read' | 'Write') =>
      [...row(resource).querySelectorAll<HTMLElement>('.ant-checkbox-wrapper')]
        .find((label) => label.textContent === which)!
        .querySelector<HTMLInputElement>('input')!;
    // Custom starts from the preset it leaves: every read scope, and no write.
    for (const resource of ['Tasks', 'Projects', 'Sessions', 'Workspaces', 'Runners', 'Wiki', 'Events']) {
      expect(box(resource, 'Read').checked, resource).toBe(true);
    }
    expect(form.querySelectorAll('.access-token-scope-row')).toHaveLength(7);
    expect(box('Tasks', 'Write').checked).toBe(false);

    // Untick every read but the wiki's, then write the wiki, then untick the projects' read again.
    for (const resource of ['Tasks', 'Projects', 'Sessions', 'Workspaces', 'Runners', 'Events']) await click(box(resource, 'Read'), resource);
    await click(box('Wiki', 'Write'), 'Wiki write');
    // Writing sessions brings reading them along.
    await click(box('Sessions', 'Write'), 'Sessions write');
    expect(box('Sessions', 'Read').checked).toBe(true);
    // Giving up reading them gives up writing them.
    await click(box('Sessions', 'Read'), 'Sessions read');
    expect(box('Sessions', 'Write').checked).toBe(false);

    await click(button(form, 'Create token'), 'Create token');
    await vi.waitFor(() => expect(issueAccessToken).toHaveBeenCalledTimes(1));
    expect(issueAccessToken).toHaveBeenCalledWith({
      name: 'Wiki bot',
      scopes: ['wiki:read', 'wiki:write'],
      workspaceIds: [],
      expiresInDays: 90,
    });

    // With nothing picked, there is nothing to create.
    await click(button(page(), 'Done'), 'Done');
    await click(button(page(), 'New token'), 'New token');
    await vi.waitFor(() => expect(dialog()?.querySelector('input[placeholder^="What it"]')).toBeTruthy());
    const again = dialog()!;
    await type(again.querySelector<HTMLInputElement>('input[placeholder^="What it"]'), 'Nothing');
    await click(again.querySelector('input[type="radio"][value="custom"]'), 'Custom');
    for (const resource of ['Tasks', 'Projects', 'Sessions', 'Workspaces', 'Runners', 'Wiki', 'Events']) {
      const read = [...again.querySelectorAll<HTMLElement>('.access-token-scope-row')]
        .find((r) => r.firstChild?.textContent === resource)!
        .querySelector<HTMLInputElement>('input')!;
      await click(read, resource);
    }
    expect(button(again, 'Create token')?.hasAttribute('disabled')).toBe(true);
  });

  it('a refused token says why and keeps the dialog open; nothing is shown as issued', async () => {
    serve([CI]);
    vi.mocked(issueAccessToken).mockRejectedValueOnce(
      new ApiError('You already have an access token named "CI pipeline" — revoke it or pick another name', 409, 'PAT_NAME_IN_USE'),
    );
    await open();
    await newToken('CI pipeline');

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't create the token",
      'You already have an access token named "CI pipeline" — revoke it or pick another name',
    );
    expect(dialog()).not.toBeNull();
    expect(page().querySelector('.access-token-issued')).toBeNull();
  });

  it('revokes a token after asking, and files it under Revoked & expired', async () => {
    serve([CI, LAPTOP]);
    await open();

    const ci = [...page().querySelectorAll<HTMLElement>('.ant-table-row')].find((row) => row.textContent?.startsWith('CI pipeline'))!;
    await click(button(ci, 'Revoke'), 'Revoke');
    expect(revokeAccessToken).not.toHaveBeenCalled();
    const asked = document.body.querySelector('.ant-popconfirm');
    expect(asked?.querySelector('.ant-popconfirm-title')?.textContent).toBe('Revoke “CI pipeline”?');
    expect(asked?.querySelector('.ant-popconfirm-description')?.textContent).toBe(
      'Anything using it stops working at once. This can’t be undone.',
    );
    await click(button(asked!, 'Revoke'), 'Revoke (confirm)');

    expect(revokeAccessToken).toHaveBeenCalledTimes(1);
    expect(vi.mocked(revokeAccessToken).mock.calls[0][0]).toBe(CI.id);
    expect(toast.success).toHaveBeenCalledWith('Token revoked', '“CI pipeline” stopped working.');
    await vi.waitFor(() =>
      expect(tabs()).toEqual([
        { label: 'Active', count: '1', selected: true },
        { label: 'Revoked & expired', count: '1', selected: false },
      ]),
    );
    expect(rows().map((row) => row[0])).toEqual([`Laptop scriptorbit_pat_…${LAPTOP.tokenHint}`]);
    await click(page().querySelectorAll('[role="tab"]')[1], 'Revoked & expired');
    expect(rows().map((row) => row[3].replace(/ \w{3} \d+, \d{4}$/, ''))).toEqual(['Revoked']);
  });
});
