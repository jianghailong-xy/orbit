// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialogDescription, openDialog } from '../components/RunnerEngines.test-helpers';
import type { Runner } from '../components/TasksSidePanel';
import { encodeId } from '../lib/idCodec';
import type { RunnerAttentionInput } from '../lib/runnerAttention';
import cases from '../lib/runnerAttention.cases.json';
import { InfrastructurePage } from './InfrastructurePage';

/**
 * The Machines section of /infrastructure, card by card: what the Runners list's card said and did is
 * on the machine's own card now. Its head says how many of its slots are taken, and under its name the
 * first two things that machine needs a person for, in the words runnerAttention writes — nothing new
 * on an offline card, whose header already says Offline. The card moves by its handle into the order
 * every runner list uses, its ⋯ renames the machine, rotates its token or deletes it, and Details opens
 * its page.
 *
 * The runners are runnerAttention.cases.json's, the same readings its own test and OrbitKit's run.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

interface AttentionCase {
  name: string;
  input: RunnerAttentionInput;
}
const CASES = cases as unknown as AttentionCase[];
const caseNamed = (prefix: string): AttentionCase => {
  const found = CASES.find((c) => c.name.startsWith(prefix));
  if (!found) throw new Error(`runnerAttention.cases.json has no case starting ${JSON.stringify(prefix)}`);
  return found;
};

/** A case's runner as GET /runners answers it, and its workspaces as GET /workspaces does. */
function machine(prefix: string, id: string) {
  const { runner, workspaces } = caseNamed(prefix).input;
  return {
    runner: { ...runner, id } as Runner,
    workspaces: workspaces.map((workspace) => ({ ...workspace, runnerId: id })),
  };
}

// Every real case is read at the same instant, so the page is too.
const NOW = caseNamed('real wikova').input.nowMs;
const WIKOVA = machine('real wikova', '33zx0JhRhJo8rd25d3qA1');
const WORKSTATION = machine('real workstation:', '33zx0JhRhJo8rd25d3qA2');
const MAC_MINI = machine('real longdeMac-mini.local', '33zx0JhRhJo8rd25d3qA3');
const LAB = machine('everything at once', '33zx0JhRhJo8rd25d3qA4');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let path = '';
/** What /dl/version.json publishes; null = the deployment has none (it answers the SPA's HTML). */
let published: string | null = null;
/** Every write the page sent, as sent. */
let sent: Array<{ method: string; path: string; body?: unknown }> = [];

function Probe() {
  path = useLocation().pathname;
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/dl/version.json' || published === null) throw new Error(`no ${url} here`);
      return { ok: true, json: async () => ({ version: published }) };
    }),
  );
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
  // A dropdown measures its trigger; jsdom has no ResizeObserver, nor any scrolling.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  published = null;
  sent = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle() {
  // The runners, their workspaces, the keys, the pools and the published release each arrive on
  // their own.
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount(machines: Array<ReturnType<typeof machine>>) {
  apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path: p, ...(init?.body === undefined ? {} : { body: init.body }) });
      if (p.endsWith('/rotate-token')) return { token: 'orb_rt_new' };
      if (p === '/runners/reorder') return machines.map((m) => m.runner);
      return {};
    }
    if (p === '/runners') return machines.map((m) => m.runner);
    if (p === '/workspaces') return machines.flatMap((m) => m.workspaces);
    return [];
  }) as typeof api);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/infrastructure']}>
          <Probe />
          <Routes>
            <Route path="/infrastructure" element={<InfrastructurePage />} />
            <Route path="/runners/:id" element={<div>machine page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const card = (name: string) => {
  const found = [...document.body.querySelectorAll<HTMLElement>('.re-runner-card')].find(
    (el) => el.querySelector('.re-runner')?.textContent === name,
  );
  if (!found) throw new Error(`no machine card named ${name}`);
  return found;
};
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const button = (words: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === words) ?? null;
/** The ⋯ of a machine's card, opened, and the item of its menu that says `words` (a portal, drawn a
 *  frame or two late on a slow host). */
const menuItem = async (name: string, words: string) => {
  await click(card(name).querySelector(`button[aria-label="More actions for ${name}"]`));
  let item: HTMLElement | undefined;
  await act(async () => {
    await vi.waitFor(() => {
      item = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
        (el) => el.textContent?.trim() === words,
      );
      if (!item) throw new Error(`${name}'s menu has no ${words}`);
    }, { timeout: 20_000, interval: 20 });
  });
  return item!;
};
const key = (target: Element, code: string, keyName = code) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key: keyName, bubbles: true, cancelable: true }));
  });

describe('a machine card’s head on /infrastructure', () => {
  it('says how busy the machine is, and under that what it needs, in amber with a warning triangle', async () => {
    await mount([WIKOVA, WORKSTATION, MAC_MINI, LAB]);
    const head = card('wikova').querySelector<HTMLElement>('.re-runner-copy')!;
    expect(head.querySelector('.re-runner-meta')?.textContent).toBe('4 / 12 running · vmi3129740 · v0.1.197');
    const util = head.querySelector<HTMLElement>('.runner-util');
    expect(util?.getAttribute('title')).toBe('4 of 12 slots in use');
    expect(util?.querySelector<HTMLElement>('.runner-util-fill')?.style.width).toBe(`${(4 / 12) * 100}%`);
    const line = head.querySelector<HTMLElement>('.runner-attention');
    expect(line?.textContent).toBe('Claude weekly limit 98% · Disk 95% full');
    expect(line?.className).toBe('runner-attention warn');
    expect(line?.querySelector('.anticon-warning')).not.toBeNull();
    // Its own line, after how busy it is; the toggle names it to a screen reader.
    expect(line?.previousElementSibling).toBe(util);
    expect(card('wikova').querySelector('.re-toggle')?.getAttribute('aria-describedby')).toBe(line?.id);
    // Folded, and saying so.
    expect(card('wikova').querySelector('.re-summary')).not.toBeNull();
  });

  it('is red when what it says already stops sessions, and names only the first two', async () => {
    await mount([LAB]);
    const line = card('lab').querySelector<HTMLElement>('.runner-attention');
    expect(line?.className).toBe('runner-attention bad');
    expect(line?.textContent).toBe('Claude signed out · app checkout stuck in a rebase');
  });

  it('keeps the disk warning when Default is spent but another Claude account has room', async () => {
    await mount([machine('Claude Default spent but another signed-in account has room', '33zx0JhRhJo8rd25d3qA6')]);
    expect(card('lab').querySelector('.runner-attention')?.textContent).toBe('Disk 92% full');
    // It reports no slots, so there is no count to give and no bar to fill.
    expect(card('lab').querySelector('.re-runner-meta')?.textContent).toBe('lab-host · v0.1.197');
    expect(card('lab').querySelector('.runner-util')).toBeNull();
  });

  it('stays away when nothing on the machine depends on what is wrong with it', async () => {
    // Claude is signed out on workstation, and none of its workspaces run on Claude.
    await mount([WORKSTATION]);
    expect(WORKSTATION.runner.engines?.find((e) => e.engine === 'claude')?.auth).toBe('no');
    expect(card('workstation').querySelector('.runner-attention')).toBeNull();
    expect(card('workstation').querySelector('.re-toggle')?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('leaves an offline card at its Offline tag: no count, no bar, no attention line', async () => {
    await mount([WIKOVA, MAC_MINI]);
    const mac = card('longdeMac-mini.local');
    expect(mac.classList.contains('offline')).toBe(true);
    expect(mac.querySelector('.re-runner-status .orbit-badge')?.textContent).toBe('Offline');
    // Its hostname is its name, so the line is the version alone.
    expect(mac.querySelector('.re-runner-meta')?.textContent).toBe('v0.1.155');
    // It can't update itself either, and says so on its page — not as a line here.
    expect(mac.querySelector('.runner-attention')).toBeNull();
    expect(mac.querySelector('.runner-util')).toBeNull();
  });

  it('knows the latest release from /dl/version.json, and does without it when it cannot be read', async () => {
    // Not root and on 0.1.190, with no other runner in the account to say a newer one exists.
    const alone = machine('not root and behind', '33zx0JhRhJo8rd25d3qA5');
    const version = alone.runner.version as string;
    published = caseNamed('not root and behind').input.latestVersion;
    expect(published).not.toBe(version);
    await mount([alone]);
    expect(card(alone.runner.name).querySelector('.runner-attention')?.textContent).toBe('Can’t update itself');

    act(() => root?.unmount());
    host?.remove();
    published = null;
    await mount([alone]);
    expect(card(alone.runner.name).querySelector('.runner-attention')).toBeNull();
  });

  it('folds open and shut from the chevron that leads it', async () => {
    await mount([WIKOVA]);
    const toggle = () => card('wikova').querySelector<HTMLButtonElement>('.re-toggle')!;
    const rows = () => card('wikova').querySelectorAll('.re-row[data-engine]');
    // The chevron is the toggle's first mark: the column the engine rows below put their icon in.
    expect(toggle().firstElementChild?.className).toBe('re-chev');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(rows()).toHaveLength(0);
    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-label')).toBe('Collapse wikova');
    expect(toggle().firstElementChild?.className).toBe('re-chev open');
    expect(rows().length).toBeGreaterThan(0);
    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(rows()).toHaveLength(0);
  });

  it('opens the machine’s page from Details', async () => {
    await mount([WIKOVA]);
    const details = card('wikova').querySelector<HTMLAnchorElement>('.re-manage');
    expect(details?.textContent).toBe('Details →');
    expect(details?.getAttribute('aria-label')).toBe('Details of wikova');
    expect(details?.getAttribute('href')).toBe(`/runners/${encodeId(WIKOVA.runner.id)}`);
    await click(details);
    expect(path).toBe(`/runners/${encodeId(WIKOVA.runner.id)}`);
  });
});

describe('a machine card’s handle and ⋯ on /infrastructure', () => {
  it('moves a machine down by its handle from the keyboard, and saves the new order', async () => {
    await mount([WIKOVA, WORKSTATION, MAC_MINI]);
    // Each card where a list of them stands, so the move has somewhere to go.
    [...document.body.querySelectorAll<HTMLElement>('.re-runner-card')].forEach((el, index) => {
      el.getBoundingClientRect = () => new DOMRect(0, index * 100, 600, 80);
    });
    const handle = card('wikova').querySelector<HTMLButtonElement>('button.re-drag')!;
    expect(handle.getAttribute('aria-label')).toBe('Reorder wikova');
    handle.focus();
    expect(document.activeElement).toBe(handle);
    await key(handle, 'Space', ' ');
    // The sensor takes the keys from the next tick on.
    await settle();
    await key(document, 'ArrowDown');
    await key(document, 'Space', ' ');
    await settle();
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/runners/reorder',
        body: { ids: [WORKSTATION.runner.id, WIKOVA.runner.id, MAC_MINI.runner.id] },
      },
    ]);
  });

  it('heads the card with its handle, first to the keyboard, and folds nothing by it', async () => {
    await mount([WIKOVA, WORKSTATION]);
    const head = card('wikova').querySelector<HTMLElement>('.re-head')!;
    const handle = head.querySelector<HTMLButtonElement>('button.re-drag')!;
    // Where Tab stops on the head, in order.
    const stops = [...head.querySelectorAll<HTMLElement>('button, a[href]')].filter(
      (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
    );
    expect(stops.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Reorder wikova',
      'Expand wikova',
      'Details of wikova',
      'More actions for wikova',
    ]);
    expect(handle.getAttribute('aria-roledescription')).toBe('sortable');
    expect(handle.title).toBe('Drag to reorder');
    handle.focus();
    expect(document.activeElement).toBe(handle);
    // A press on it is the handle's own: the head around it does not take it for a fold.
    await click(handle);
    expect(card('wikova').querySelector('.re-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(card('wikova').querySelector('.re-row[data-engine]')).toBeNull();
  });

  it('renames a machine from its ⋯, empty meaning the machine’s own name', async () => {
    await mount([WIKOVA]);
    await click(await menuItem('wikova', 'Rename'));
    const dialog = await openDialog('Rename machine');
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('wikova');
    expect(dialog.textContent).toContain('Leave empty to use the machine name (wikova).');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  Contabo  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Save', dialog));
    expect(sent).toEqual([
      { method: 'PATCH', path: `/runners/${WIKOVA.runner.id}`, body: { displayName: 'Contabo' } },
    ]);
  });

  it('rotates a machine’s token from its ⋯ once asked, and shows the new one', async () => {
    await mount([WIKOVA]);
    await click(await menuItem('wikova', 'Rotate token'));
    const confirm = await openDialog('Rotate token for “wikova”?');
    expect(sent).toEqual([]);
    await click(button('Rotate token', confirm));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${WIKOVA.runner.id}/rotate-token` }]);
    expect(document.body.querySelector('.runner-token-box')?.textContent).toBe('orb_rt_new');
  });

  it('deletes a machine from its ⋯ once asked', async () => {
    await mount([WIKOVA, WORKSTATION]);
    await click(await menuItem('workstation', 'Delete'));
    const confirm = await openDialog('Delete “workstation”?');
    expect(dialogDescription(confirm)).toContain('This removes the machine from your account.');
    expect(sent).toEqual([]);
    await click(button('Delete', confirm));
    expect(sent).toEqual([{ method: 'DELETE', path: `/runners/${WORKSTATION.runner.id}` }]);
  });
});

/**
 * index.css's rules for one selector, each with the at-rules it sits in, outermost first. jsdom lays
 * nothing out, so where the handle stands is read out of the stylesheet; comments come off first, so
 * that a sentence about a rule is never taken for the rule. Both path spellings, because the web
 * suite runs from `src/web` and a runner may start at the repository root.
 */
function rulesFor(selector: string): Array<{ within: string[]; body: string }> {
  const file = ['src/index.css', 'src/web/src/index.css'].map((each) => resolve(process.cwd(), each)).find(existsSync);
  if (file === undefined) throw new Error(`no index.css from ${process.cwd()}`);
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Array<{ within: string[]; body: string }> = [];
  const within: string[] = [];
  let from = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === ';') from = i + 1;
    else if (css[i] === '}') {
      within.pop();
      from = i + 1;
    } else if (css[i] === '{') {
      const prelude = css.slice(from, i).trim().replace(/\s+/g, ' ');
      from = i + 1;
      if (prelude.startsWith('@')) {
        within.push(prelude);
        continue;
      }
      const end = css.indexOf('}', i);
      if (prelude === selector) found.push({ within: [...within], body: css.slice(i + 1, end).trim() });
      i = end;
      from = end + 1;
    }
  }
  return found;
}

describe('where a machine card’s handle stands', () => {
  it('stays out of a wide head’s flow, so the chevron leads it in the engine icons’ column', () => {
    const handle = rulesFor('.re-runner-card .re-drag');
    // In the card's own left margin: nothing in the head's flow comes before the chevron.
    const wide = handle.find((rule) => rule.within.length === 0)?.body;
    expect(wide).toMatch(/position: absolute;/);
    expect(wide).toMatch(/left: 0;/);
    // A narrow card gives it a column of its own again, beside the name rather than over it.
    const narrow = handle.find((rule) => rule.within.join(' ') === '@container re-card (max-width: 600px)')?.body;
    expect(narrow).toMatch(/position: static;/);
    expect(narrow).toMatch(/grid-column: 1;/);
    // Out of sight only where a pointer can bring it back, and never from the keyboard: by its opacity,
    // which keeps it in the tab order, and not while it has focus.
    const hidden = rulesFor('.re-runner-card:not(:hover, .dragging) .re-drag:not(:focus-visible)');
    expect(hidden).toEqual([
      { within: ['@media (hover: hover)', '@container re-card (width > 600px)'], body: 'opacity: 0;' },
    ]);
  });
});
