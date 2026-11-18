// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * The managed runner is Orbit Cloud from the moment the runner list arrives: GET /runners says
 * `managed` on its row, so the sidebar's Set up row and the Machines menu never show its stored
 * name `orbit-managed` while GET /managed-runner is still on its way, or when it fails.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api } = await import('../api');

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8'),
) as { capabilities: { name: string; body: unknown }[] };

const MANAGED_ID = '0197e7a0-0000-7000-8000-00000000c10d';
let runners: unknown[] = [];
let managedStatus: 'pending' | 'failing' = 'pending';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let observer: MutationObserver | null = null;
/** Every piece of markup the page ever held, text and attributes alike, sampled at each DOM change. */
let seen: string[] = [];

function serve() {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/projects/sidebar') return [];
    if (path === '/runners') return runners;
    if (path === '/auth/capabilities') return fixture.capabilities.find((c) => c.name === 'switched on')!.body;
    if (path === '/managed-runner') {
      if (managedStatus === 'pending') return new Promise(() => {});
      throw new Error('managed runner status unavailable');
    }
    if (path === '/workspaces') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'MEMBER', avatarUpdatedAt: null };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function visit(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  seen = [];
  observer = new MutationObserver(() => seen.push(document.body.innerHTML));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={['/projects']}>
        <QueryClientProvider client={client}>
          <TasksSidePanel />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  seen.push(document.body.innerHTML);
  await settle();
}

const setupRows = () => [...document.querySelectorAll<HTMLElement>('.tp-workspace-name')].map((el) => el.textContent);

async function openMachinesMenu(): Promise<void> {
  await act(async () => container!.querySelector<HTMLButtonElement>('.tp-user-trigger')!.click());
  await settle();
  const machines = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((row) =>
    row.textContent?.startsWith('Machines'),
  )!;
  await act(async () => {
    machines.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
});

afterEach(async () => {
  observer?.disconnect();
  observer = null;
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  runners = [];
  managedStatus = 'pending';
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

describe("the managed runner's row flag names it Orbit Cloud before GET /managed-runner answers", () => {
  it.each(['pending', 'failing'] as const)(
    'with /managed-runner %s, the Set up row and the Machines menu say Orbit Cloud and never orbit-managed',
    async (state) => {
      managedStatus = state;
      runners = [
        { id: MANAGED_ID, name: 'orbit-managed', displayName: null, online: true, managed: true },
        { id: 'r2', name: 'build-box', displayName: null, online: true, managed: false },
      ];
      serve();
      await visit();
      await act(async () => {
        await vi.waitFor(() => expect(setupRows()).toContain('Set up Orbit Cloud'), { timeout: 5_000, interval: 20 });
      });
      expect(setupRows()).toContain('Set up build-box');
      await openMachinesMenu();
      const menu = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].map((row) => row.textContent);
      expect(menu.some((text) => text?.startsWith('Orbit Cloud'))).toBe(true);
      expect(menu.some((text) => text?.startsWith('build-box'))).toBe(true);

      expect(vi.mocked(api).mock.calls.some(([path]) => path === '/managed-runner')).toBe(true);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.filter((html) => html.includes('orbit-managed'))).toEqual([]);
      expect(document.body.innerHTML).not.toContain('orbit-managed');
    },
  );

  it("an owner-given name still wins over Orbit Cloud", async () => {
    runners = [{ id: MANAGED_ID, name: 'orbit-managed', displayName: 'Team cloud', online: true, managed: true }];
    serve();
    await visit();
    await act(async () => {
      await vi.waitFor(() => expect(setupRows()).toContain('Set up Team cloud'), { timeout: 5_000, interval: 20 });
    });
    expect(document.body.textContent).not.toContain('Orbit Cloud');
    expect(seen.filter((html) => html.includes('orbit-managed'))).toEqual([]);
  });
});
