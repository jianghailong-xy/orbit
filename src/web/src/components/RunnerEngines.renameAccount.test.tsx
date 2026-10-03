// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerEngineAccount, RunnerEngineHealth } from '@orbit/shared';
import { RunnerEngines } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * Renaming an account on a runner, from the Providers page — Default included.
 *
 * Default is the login the machine's own environment selects (~/.claude), and the machine never names
 * it: the page could only ever call it "Default", whichever subscription is signed into it. Every
 * account's name is a label kept in Orbit (PATCH /runners/:id/accounts/:engine/:account), changed in
 * place on its row the way a session's title is, and Default renamed keeps a mark saying what it is.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a'): the Manage link encodes it.
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const DEFAULT: RunnerEngineAccount = { id: 'default', home: '/root/.claude', auth: 'yes' };
const RD: RunnerEngineAccount = { id: 'fad98727', name: 'jianghailong.rd', home: '/root/.orbit/claude-accounts/fad98727', auth: 'yes' };
const ORBIT: RunnerEngineAccount = { id: '29e631a9', name: 'jianghailong.orbit', home: '/root/.orbit/claude-accounts/29e631a9', auth: 'yes' };

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

const runner = (accounts: RunnerEngineAccount[], over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  engines: [
    health({ engine: 'claude', version: '2.1.288', accounts }),
    health({ engine: 'codex', version: '0.156.0' }),
    health({ engine: 'kimi', version: '0.41.0' }),
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** What the server holds: a rename changes it, and the list read after it returns it. */
let served: Runner[] = [];
let client: QueryClient | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Remove asks in an antd popup, which measures itself with a ResizeObserver jsdom does not have.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  localStorage.clear();
});

/** The server's side of a rename: the name it keeps, the way RunnersService.renameAccount keeps it. */
function renamed(path: string, name: string): RunnerEngineAccount {
  const [, , , , engine, id] = path.split('/');
  let account: RunnerEngineAccount | undefined;
  served = served.map((r) => ({
    ...r,
    engines: r.engines?.map((e) =>
      e.engine !== engine
        ? e
        : {
            ...e,
            accounts: e.accounts?.map((a) => {
              if (a.id !== id) return a;
              const { name: _was, ...rest } = a;
              account = id === 'default' && name === 'Default' ? rest : { ...rest, name };
              return account;
            }),
          },
    ),
  }));
  return account!;
}

function mount(runners: Runner[], { strict = false } = {}) {
  served = runners;
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path === '/runners') return served;
    if (options?.method === 'PATCH') return renamed(path, (options.body as { name: string }).name);
    if (path.endsWith('/login') && (options?.method ?? 'GET') === 'GET') {
      return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    }
    if (options?.method === 'DELETE') return { account: RD.id, status: 'pending', message: null };
    return { status: 'pending', engine: 'claude', url: null, userCode: null, message: null };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], runners);
  client = qc;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const page = (
    <MemoryRouter initialEntries={['/providers']}>
      <QueryClientProvider client={qc}>
        {/* The app mounts AntD's `App`, which is what gives `App.useApp()` its message API. */}
        <AntApp>
          <RunnerEngines />
        </AntApp>
      </QueryClientProvider>
    </MemoryRouter>
  );
  act(() => root!.render(strict ? <StrictMode>{page}</StrictMode> : page));
  return host;
}

/** The runner's next heartbeat: these are what it reports now, and the page reads the list again. */
async function report(runners: Runner[]) {
  served = runners;
  await act(async () => {
    await client!.invalidateQueries({ queryKey: ['runners'] });
  });
}

const rows = (el: ParentNode, selector: string) => [...el.querySelectorAll<HTMLElement>(selector)];
const labelOf = (b: Element) => b.textContent?.trim() || b.getAttribute('aria-label');
const button = (el: ParentNode, label: string) => {
  const found = rows(el, 'button').find((b) => labelOf(b) === label);
  if (!found) throw new Error(`no "${label}" button in ${el.textContent}`);
  return found as HTMLButtonElement;
};
/** The account rows, in the order the page drew them. */
const accountsOf = (page: ParentNode) => rows(page, '.re-acct');
const nameOf = (row: HTMLElement) => row.querySelector('.re-name-text')?.textContent;
const chipsOf = (row: HTMLElement) => rows(row, '.re-name .re-chip').map((chip) => chip.textContent);
const editorOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input.re-name-input');
/** Every rename the page asked for: where, and the body it sent. */
const renames = () =>
  apiMock.mock.calls
    .filter(([, options]) => options?.method === 'PATCH')
    .map(([path, options]) => [path, (options as { body?: unknown }).body]);

/** React only hears a value typed through the native setter, followed by the input event. */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}
async function startRename(row: HTMLElement): Promise<HTMLInputElement> {
  await act(async () => {
    button(row, 'Rename').click();
  });
  const input = editorOf(row);
  expect(input, 'the name turns into its editor').toBeTruthy();
  return input!;
}

describe('renaming an account on a runner', () => {
  it('offers Rename on every account row, Default included', () => {
    const page = mount([runner([DEFAULT, RD, ORBIT])]);

    for (const row of accountsOf(page)) expect(button(row, 'Rename')).toBeTruthy();
  });

  it('renames Default: the new name goes to the control plane, and the row carries it with its DEFAULT mark', async () => {
    const page = mount([runner([DEFAULT, RD, ORBIT])]);
    const [defaultRow] = accountsOf(page);

    const input = await startRename(defaultRow);
    // The editor opens on the name as it is, all of it selected, so typing replaces it.
    expect(input.value).toBe('Default');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Default'.length]);

    await type(input, '  jianghailong.main ');
    await press(input, 'Enter');

    // The rename can be emitted one step after the press — a mutation whose scope is busy waits for
    // the one in flight before it runs (the rename account panel's sign-in) — so what was SENT is
    // waited for, not read synchronously.
    await vi.waitFor(() =>
      expect(renames()).toEqual([[`/runners/${RUNNER_ID}/accounts/claude/default`, { name: 'jianghailong.main' }]]),
    );
    await vi.waitFor(() => expect(apiMock.mock.calls.filter(([path]) => path === '/runners').length).toBeGreaterThan(0));
    // The row the press redraws, not the request it fires. The press closes the editor, and the
    // redraw after it is the settled mutation standing on the list's OLD name — `shown` falls back
    // to the account once `isPending` goes false, which it does when the refetch `onSuccess` awaits
    // has resolved, one render before the list's own answer reaches this row. A loaded host reads
    // the row in that render: "expected 'Default' to be 'jianghailong.main'", with the editor
    // already gone (the request was issued long before — the mount read alone satisfies the wait
    // above). What the press must have done is the row carrying the name the response carries.
    await vi.waitFor(() => expect(nameOf(accountsOf(page)[0])).toBe('jianghailong.main'));
    const [named] = accountsOf(page);
    expect(editorOf(named)).toBeNull();
    expect(chipsOf(named)).toContain('DEFAULT');
    expect(named.querySelector('.re-chip')?.getAttribute('title')).toBeNull();
  });

  it('renames an added account, and a double-click on its name opens the same editor', async () => {
    const page = mount([runner([DEFAULT, RD, ORBIT])]);
    const [, rdRow] = accountsOf(page);

    await act(async () => {
      rdRow.querySelector('.re-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = editorOf(rdRow)!;
    expect(input.value).toBe('jianghailong.rd');
    await type(input, 'jianghailong.research');
    await act(async () => input.blur());

    await vi.waitFor(() =>
      expect(renames()).toEqual([[`/runners/${RUNNER_ID}/accounts/claude/fad98727`, { name: 'jianghailong.research' }]]),
    );
    await vi.waitFor(() => expect(nameOf(accountsOf(page)[1])).toBe('jianghailong.research'));
    // An added account is not Default, renamed or not.
    expect(chipsOf(accountsOf(page)[1])).toEqual([]);
  });

  it('sends nothing for Escape, an empty name, or the name it already has', async () => {
    const page = mount([runner([DEFAULT, RD, ORBIT])]);
    const [, rdRow] = accountsOf(page);

    let input = await startRename(rdRow);
    await type(input, 'Something else');
    await press(input, 'Escape');
    expect(editorOf(rdRow)).toBeNull();
    expect(nameOf(rdRow)).toBe('jianghailong.rd');

    input = await startRename(rdRow);
    await type(input, '   ');
    await press(input, 'Enter');

    input = await startRename(rdRow);
    await type(input, ' jianghailong.rd ');
    await press(input, 'Enter');

    expect(renames()).toEqual([]);
    expect(nameOf(rdRow)).toBe('jianghailong.rd');
  });

  it('names Default back to "Default", which drops its mark', async () => {
    const page = mount([runner([{ ...DEFAULT, name: 'jianghailong.main' }, RD, ORBIT])]);
    const [defaultRow] = accountsOf(page);
    expect(chipsOf(defaultRow)).toContain('DEFAULT');

    const input = await startRename(defaultRow);
    await type(input, 'Default');
    await press(input, 'Enter');

    await vi.waitFor(() =>
      expect(renames()).toEqual([[`/runners/${RUNNER_ID}/accounts/claude/default`, { name: 'Default' }]]),
    );
    await vi.waitFor(() => expect(nameOf(accountsOf(page)[0])).toBe('Default'));
    expect(chipsOf(accountsOf(page)[0])).not.toContain('DEFAULT');
  });

  it('keeps Rename on a runner that is offline: a name is kept in Orbit, not on the machine', async () => {
    const page = mount([runner([DEFAULT, RD, ORBIT], { online: false })]);
    const [, rdRow, orbitRow] = accountsOf(page);

    expect(button(rdRow, 'Remove').disabled).toBe(true);
    expect(button(orbitRow, 'Rename').disabled).toBe(false);
    const input = await startRename(orbitRow);
    await type(input, 'Orbit');
    await press(input, 'Enter');

    await vi.waitFor(() =>
      expect(renames()).toEqual([[`/runners/${RUNNER_ID}/accounts/claude/29e631a9`, { name: 'Orbit' }]]),
    );
  });

  it('says where a removed account’s workspaces go by the name Default goes by', async () => {
    const page = mount([runner([{ ...DEFAULT, name: 'jianghailong.main' }, RD, ORBIT])]);
    const [, rdRow] = accountsOf(page);

    await act(async () => {
      button(rdRow, 'Remove').click();
    });
    await act(async () => {
      await vi.waitFor(
        () =>
          expect(document.querySelector('.ant-popconfirm-description')?.textContent).toContain(
            'Workspaces set to this account run on jianghailong.main.',
          ),
        { timeout: 20_000, interval: 20 },
      );
    });
  });
});

describe('naming an account while + Account adds it', () => {
  // The slot the runner makes for the new account: an id of its own, under the name it was added with.
  const ADDED: RunnerEngineAccount = {
    id: '7c41d2aa',
    name: 'Account 2',
    home: '/root/.orbit/claude-accounts/7c41d2aa',
    auth: 'yes',
  };
  const claudeRow = (page: ParentNode) =>
    rows(page, '.re-row').find((row) => row.querySelector('.re-name')?.textContent === 'Claude Code')!;
  const loginPosts = () =>
    apiMock.mock.calls
      .filter(([path, options]) => path === `/runners/${RUNNER_ID}/login` && options?.method === 'POST')
      .map(([, options]) => (options as { body?: unknown }).body);
  /** The + Account panel, while it is open. */
  const panelOf = (page: ParentNode) => page.querySelector('.re-add');
  /** The runner's list has reached the page once the new account has a row of its own. */
  const shown = (page: ParentNode) =>
    vi.waitFor(() => expect(accountsOf(page).map(nameOf)).toEqual(['Default', 'Account 2']));
  /** Let what that set off land — the effects of the render, a request's outcome — before asking
   *  whether the panel is still open: a list read or a failure reaches the component a tick later. */
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  /** Press + Account on the Claude row, and put the caret in the name it opens with. */
  async function add(page: HTMLElement): Promise<HTMLInputElement> {
    await act(async () => {
      button(claudeRow(page), '+ Account').click();
    });
    const input = page.querySelector<HTMLInputElement>('.re-add input')!;
    await act(async () => input.focus());
    return input;
  }

  it('saves a name typed while the sign-in runs once the runner reports the account, then folds away', async () => {
    const page = mount([runner([DEFAULT])]);
    const input = await add(page);
    expect(input.value).toBe('Account 2');
    expect(loginPosts()).toEqual([{ engine: 'claude', accountName: 'Account 2' }]);

    await type(input, 'Work');
    await press(input, 'Enter');
    // Nothing to name yet: the runner has not reported the account.
    expect(renames()).toEqual([]);

    await report([runner([DEFAULT, ADDED])]);
    await vi.waitFor(() =>
      expect(renames()).toEqual([[`/runners/${RUNNER_ID}/accounts/claude/7c41d2aa`, { name: 'Work' }]]),
    );
    await vi.waitFor(() => expect(accountsOf(page).map(nameOf)).toEqual(['Default', 'Work']));
    // What the panel added is that row now, and the panel itself is gone.
    await vi.waitFor(() => expect(panelOf(page)).toBeNull());
    // Named, not added again: the one sign-in is still the only one.
    expect(loginPosts()).toHaveLength(1);
  });

  it('waits for a name still being typed when the account arrives, then saves it and folds away', async () => {
    const page = mount([runner([DEFAULT])]);
    const input = await add(page);
    // Signed in and reported while the caret is still in the field: the panel stays for the name.
    await report([runner([DEFAULT, ADDED])]);
    await shown(page);
    await settle();
    expect(panelOf(page)).not.toBeNull();
    expect(renames()).toEqual([]);

    await type(input, ' Personal ');
    await press(input, 'Enter');
    await vi.waitFor(() =>
      expect(renames()).toEqual([[`/runners/${RUNNER_ID}/accounts/claude/7c41d2aa`, { name: 'Personal' }]]),
    );
    await vi.waitFor(() => expect(nameOf(accountsOf(page)[1])).toBe('Personal'));
    await vi.waitFor(() => expect(panelOf(page)).toBeNull());
  });

  it('sends nothing for the name the account already has, or for none, and folds away', async () => {
    const page = mount([runner([DEFAULT])]);
    const input = await add(page);
    await type(input, '   ');
    await press(input, 'Enter');
    // An emptied name goes back to the one the account is being added under.
    expect(input.value).toBe('Account 2');
    await act(async () => input.focus());
    await type(input, ' Account 2 ');
    await press(input, 'Enter');

    await report([runner([DEFAULT, ADDED])]);
    await vi.waitFor(() => expect(panelOf(page)).toBeNull());
    expect(renames()).toEqual([]);
    expect(accountsOf(page).map(nameOf)).toEqual(['Default', 'Account 2']);
  });

  it('stays open until the runner reports the account signed in', async () => {
    const page = mount([runner([DEFAULT])]);
    const input = await add(page);
    await act(async () => input.blur());
    // A probe that caught the account mid-sign-in reports it signed out: not done yet.
    await report([runner([DEFAULT, { ...ADDED, auth: 'no' }])]);
    await shown(page);
    await settle();
    expect(panelOf(page)).not.toBeNull();

    await report([runner([DEFAULT, ADDED])]);
    await vi.waitFor(() => expect(panelOf(page)).toBeNull());
  });

  it('stays open, the name kept, when saving the name fails', async () => {
    const page = mount([runner([DEFAULT])]);
    const answer = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'PATCH') throw new Error('Could not reach the server');
      return answer(path, options);
    });
    const input = await add(page);
    await report([runner([DEFAULT, ADDED])]);
    await shown(page);

    await type(input, 'Work');
    await press(input, 'Enter');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Could not reach the server'));
    expect(document.body.textContent).toContain("Couldn't rename the account");
    await settle();
    // The account is signed in and reported, but not under the name in the field: still open.
    expect(panelOf(page)).not.toBeNull();
    expect(input.value).toBe('Work');
  });

  it('starts one sign-in, even mounted twice by StrictMode', async () => {
    const page = mount([runner([DEFAULT])], { strict: true });
    await add(page);
    expect(loginPosts()).toEqual([{ engine: 'claude', accountName: 'Account 2' }]);
  });
});
