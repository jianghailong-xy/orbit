// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A correction Claude refused, and a claim that substituted a mode, on the real session page, from what a real apiserver
 * answered (contracts/permission-mode-refused, captured with a real runner on PostgreSQL; README there):
 *  - the runner reported `permission_mode_correction_failed`: the capsule shows the lasting gap of the board
 *    (docs/mocks/permission-mode-actual, A1), "Default" with its dot and the CLI's words, never "Default → Auto";
 *    the transcript has a line saying the runner could not switch it, and why (B1);
 *  - the claim handed Auto for Bypass on a root runner: its line is worded from the server's requestedMode and reason;
 *  - a long session whose refusal paged out of the tail loaded: the detail's `permissionModeCorrectionRefusal` still gives
 *    the lasting gap and the CLI's words, not "switching" (task 355JM5aLiNscahuF5Xnes).
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), getSession: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({ loadTranscript: async () => null, saveTranscript: async () => {} }));

const { api, getSession, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');

/** The repository's `contracts/permission-mode-refused`, found above the test's working directory (jsdom's import.meta.url
 *  is a dev-server path). */
const FIXTURES = (() => {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'contracts/permission-mode-refused');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`contracts/permission-mode-refused was not found above ${process.cwd()}`);
  }
})();
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

type Detail = Record<string, unknown> & { id: string; workspaceId: string; assignedRunnerId: string };
type Page = { events: unknown[]; hasMore: boolean };
const REFUSED = read<Detail>('session-refused.web.json');
const REFUSED_EVENTS = read<Page>('session-refused.events.json');
const ROOT = read<Detail>('session-root-claim.web.json');
const ROOT_EVENTS = read<Page>('session-root-claim.events.json');
const PAGED = read<Detail>('session-refused-paged.web.json');
const PAGED_EVENTS = read<Page>('session-refused-paged.events.json');
const RUNNERS = [
  ...read<Array<Record<string, unknown> & { id: string }>>('runners.json'),
  ...read<Array<Record<string, unknown> & { id: string }>>('session-refused-paged.runners.json'),
];
const WORDS = 'Cannot set permission mode to auto: auto mode unavailable for this model';

const details: Record<string, Detail> = { [REFUSED.id]: REFUSED, [ROOT.id]: ROOT, [PAGED.id]: PAGED };
const pages: Record<string, Page> = { [REFUSED.id]: REFUSED_EVENTS, [ROOT.id]: ROOT_EVENTS, [PAGED.id]: PAGED_EVENTS };
/** When the server recorded Claude's report of Default in the paged-out session. */
const pagedReportAt = (): number => Date.parse((PAGED.permissionModeChanges as Array<{ at: string }>).at(-1)!.at);
const runnerOf = (s: Detail) => RUNNERS.find((r) => r.id === s.assignedRunnerId) as unknown as Runner;

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const capsule = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.composer-toolbar [data-mode-gap]');
const capsuleText = (): string => capsule()?.closest('.orbit-choice-value')?.textContent?.trim() ?? '';
const transcript = (): string[] =>
  [...mounted().querySelectorAll('.chat-user, .chat-assistant, .chat-mode-line')].map((el) =>
    el.classList.contains('chat-mode-line')
      ? `⛉ ${el.querySelector('.chat-mode-line-text')?.textContent}${el.classList.contains('is-gap') ? ' (amber)' : ''}`
      : (el.textContent ?? '').trim().split(/\s+/).slice(0, 3).join(' '),
  );
const menuHead = (): string | undefined => document.querySelector('.orbit-select-header')?.textContent?.trim();

async function mount(session: Detail, expected: string, opts: { lines?: boolean } = {}): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  root = createRoot(container);
  document.body.appendChild(container);
  const nextClient = client;
  const nextRoot = root;
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${session.id}`]}>
          <WorkspaceView runner={runnerOf(session)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(capsuleText()).toBe(expected), { timeout: 20_000, interval: 20 });
  });
  if (opts.lines === false) return;
  await act(async () => {
    await vi.waitFor(() => expect(mounted().querySelectorAll('.chat-mode-line').length).toBeGreaterThan(0), { timeout: 10_000, interval: 20 });
  });
}

async function openMode(): Promise<void> {
  const trigger = capsule()?.closest('[role="combobox"]');
  expect(trigger, 'the Mode capsule').toBeTruthy();
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    trigger!.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    trigger!.dispatchEvent(new MouseEvent('mousedown', init));
    trigger!.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    trigger!.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    trigger!.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  for (let frame = 0; frame < 100; frame += 1) {
    if (document.querySelectorAll('[role="listbox"] [role="option"]').length > 0) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  throw new Error('the Mode menu did not open');
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async (sid: string) => (pages[sid] ?? { events: [], hasMore: false }) as never);
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(async (sid: string) => details[sid] as never);
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (init?.method && init.method !== 'GET') return reply(undefined);
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') return reply(Object.values(details).map((s) => s.workspace));
    if (path === '/runners') return reply(RUNNERS);
    for (const sid of Object.keys(details)) {
      if (path.startsWith(`/sessions/${sid}`)) {
        if (path.includes('/events/page')) return reply(pages[sid]);
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(details[sid]);
      }
    }
    if (path.startsWith('/sessions')) return reply(Object.values(details));
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const node = container;
  root = null;
  client = null;
  container = null;
  try {
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    if (mountedClient) {
      await mountedClient.cancelQueries();
      mountedClient.clear();
    }
    node?.remove();
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('a refused correction and a claim’s substitution, from a real apiserver', { timeout: 60_000 }, () => {
  it('the payloads are the server’s: the refusal is an event, not a mode change', () => {
    expect(REFUSED.actualPermissionMode).toBe('default');
    expect((REFUSED.permissionModeChanges as Array<{ cause: string }>).map((c) => c.cause)).toEqual(['CLAIM', 'ENGINE_REPORT']);
    expect(REFUSED_EVENTS.events).toContainEqual(
      expect.objectContaining({ type: 'system', payload: expect.objectContaining({ subtype: 'permission_mode_correction_failed', reason: WORDS }) }),
    );
  });

  it('a refused correction is a lasting gap with the CLI’s words, not "switching", and the transcript names it', async () => {
    await mount(REFUSED, 'Default');
    expect(capsule()?.dataset.modeGap).toBe('lasting');
    expect(capsule()?.querySelector('.composer-mode-dot')).not.toBeNull();
    expect(capsule()?.querySelector('.composer-mode-spin')).toBeNull();
    expect(transcript()).toEqual([
      'Reply with the',
      'The index on',
      // The report goes with the refusal that answers it, where the runner said so: the server stamped the report when it
      // took the batch, after every event in it.
      '⛉ Claude started in Default',
      `⛉ Claude stays in Default — the runner couldn’t switch it to Auto: ${WORDS} (amber)`,
    ]);
    await openMode();
    expect(menuHead()).toBe(`Running in Default. You asked for Auto, but the runner couldn’t switch Claude to it: ${WORDS}.`);
  });

  it('a refusal paged out of the events loaded still reads as the lasting gap, from the detail', async () => {
    // The real payloads: the tail page the transcript loads first has no refusal, and the detail carries it.
    expect(PAGED_EVENTS.hasMore).toBe(true);
    expect(PAGED_EVENTS.events.length).toBe(200);
    expect(
      PAGED_EVENTS.events.some((e) => (e as { payload?: { subtype?: string } }).payload?.subtype === 'permission_mode_correction_failed'),
    ).toBe(false);
    expect((PAGED.permissionModeChanges as Array<{ cause: string }>).map((c) => c.cause)).toEqual(['CLAIM', 'ENGINE_REPORT']);
    expect(PAGED.permissionModeCorrectionRefusal).toEqual(
      expect.objectContaining({ mode: 'default', requestedMode: 'auto', reason: WORDS }),
    );

    // The reports it answers are older than every event loaded: no mode line is drawn, and the capsule still knows. Read
    // seconds after Claude's report, while a report not yet answered would still read as being switched.
    vi.useFakeTimers({ toFake: ['Date'], now: pagedReportAt() + 5_000 });
    await mount(PAGED, 'Default', { lines: false });
    expect(capsule()?.dataset.modeGap).toBe('lasting');
    expect(capsule()?.querySelector('.composer-mode-dot')).not.toBeNull();
    expect(capsule()?.querySelector('.composer-mode-spin')).toBeNull();
    expect(capsuleText()).not.toContain('→');
    await openMode();
    expect(menuHead()).toBe(`Running in Default. You asked for Auto, but the runner couldn’t switch Claude to it: ${WORDS}.`);
  });

  it('without the detail’s word, the same paged-out session would not say why', async () => {
    // The control: the detail as a server before migration 1821 answered it.
    const { permissionModeCorrectionRefusal: _dropped, ...older } = PAGED;
    details[PAGED.id] = older as Detail;
    try {
      vi.useFakeTimers({ toFake: ['Date'], now: pagedReportAt() + 5_000 });
      await mount(older as Detail, 'Default', { lines: false });
      await openMode();
      // A gap, but not the refusal's: the events loaded say nothing of what Claude said.
      expect(menuHead()).not.toContain(WORDS);
      expect(menuHead()).not.toContain('couldn’t switch Claude');
    } finally {
      details[PAGED.id] = PAGED;
    }
  });

  it('the claim’s line is worded from the server’s requestedMode and reason', async () => {
    await mount(ROOT, 'Auto');
    expect(transcript()).toContain('⛉ Started in Auto, not Bypass — Bypass can’t run on a root runner (amber)');
  });
});
