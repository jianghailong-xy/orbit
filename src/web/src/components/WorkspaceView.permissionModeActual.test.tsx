// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import { modeChange as change, modeFacts } from '../test/permissionModeFixtures';

/**
 * The mode a session is actually running in, on the real session page, state by state as the approved board
 * draws them (docs/mocks/permission-mode-actual; the owner's A1, B1 and C1 of 2026-11-19):
 *  ① the composer's Mode capsule says the mode the server recorded the engine running in;
 *  ② a gap from the intent: "Default → Auto" with a spinner while the runner switches it, an amber dot while it
 *     lasts, the reason at the head of the menu, and the menu's check still on the intent;
 *  ③ the transcript records each change where it happened, with who or what made it;
 *  ④ before a session starts, the mode it will start in: Auto stays selectable on a model with no Auto (C1).
 *  ⑤ a session with more changes than its detail carries: the older ones are read as the transcript pages back,
 *     and each is drawn once where it happened, even where several share one moment.
 * The Agent tools drawer says the same mode and gap.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), getSession: vi.fn(), getSessionPermissionModeChanges: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({ loadTranscript: async () => null, saveTranscript: async () => {} }));

const { api, getSession, getSessionEventPage, getSessionPermissionModeChanges } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000e1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000e2');
const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-0000000000f${n}`);
const RUNNING = id(1);
const CORRECTING = id(2);
const NO_AUTO = id(3);
const HISTORY = id(4);
const ROOT_BYPASS = id(5);
const LONG = id(6);

const ALL_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const runnerWith = (runsAsRoot = false): Runner =>
  ({
    id: RUNNER_ID,
    name: 'workstation-gpu',
    online: true,
    maxConcurrent: 2,
    activeSessions: 1,
    runsAsRoot,
    engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
    modelCatalog: {
      claude: [
        { value: 'claude-opus-5-5', label: 'Opus 5.5', permissionModes: ALL_MODES },
        { value: 'claude-haiku-4-5', label: 'Haiku 4.5', permissionModes: ALL_MODES.filter((m) => m !== 'auto') },
      ],
    },
  }) as unknown as Runner;
const WORKSPACE = { id: WORKSPACE_PUBLIC, name: 'orbit', model: null, effort: null };

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const T0 = Date.parse('2026-11-27T05:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

type Change = ReturnType<typeof change>;

/** A live Claude session and its stored intent, with the mode the server recorded it running in: its newest change's. */
const row = (sid: string, title: string, model: string, permissionMode: string, changes: Change[]) => ({
  id: sid,
  workspaceId: WORKSPACE_PUBLIC,
  workspace: WORKSPACE,
  runnerId: RUNNER_ID,
  title,
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  engine: 'claude',
  model,
  permissionMode,
  ...modeFacts(changes),
  numTurns: 2,
  createdAt: at(0),
  lastTurnAt: at(300),
});

let rows: Record<string, unknown>[] = [];
let details: Record<string, Record<string, unknown>> = {};
let events: Record<string, unknown[]> = {};
let lastModel: string | null = null;
/** LONG's every change, as the server holds them, and the `before` of each page of them asked for. */
let longChanges: Change[] = [];
let modePagesAsked: number[] = [];
/** LONG's older transcript page answers when this is resolved: the transcript has paged back to the start. */
let releaseOlderEvents: () => void = () => {};

function serve(): void {
  const correctingAt = ago(4_000);
  // As the real apiserver recorded them on PostgreSQL (scripts/permission-mode-actual-stack/seed.mjs).
  const changes: Record<string, Change[]> = {
    [RUNNING]: [change('CLAIM', 'auto', null, at(1))],
    [CORRECTING]: [change('CLAIM', 'auto', null, ago(6_000)), change('ENGINE_REPORT', 'default', 'auto', correctingAt)],
    [NO_AUTO]: [change('CLAIM', 'auto', null, at(1)), change('OWNER_PICK', 'default', 'auto', at(1800), 'web')],
    [HISTORY]: [
      change('CLAIM', 'auto', null, at(1)),
      change('ENGINE_REPORT', 'default', 'auto', at(2)),
      change('RUNNER_CORRECTION', 'auto', 'default', at(4)),
      change('OWNER_PICK', 'plan', 'auto', at(70), 'web'),
      change('OWNER_PICK', 'acceptEdits', 'plan', at(80), 'ios'),
      change('OWNER_PICK', 'auto', 'acceptEdits', at(90), 'android'),
      change('ORBIT_CHANGE', 'default', 'auto', at(210)),
      change('OWNER_PICK', 'auto', 'default', at(220), 'web'),
      change('RESPAWN', 'default', 'auto', at(230)),
      change('RUNNER_CORRECTION', 'auto', 'default', at(232)),
    ],
    [ROOT_BYPASS]: [change('CLAIM', 'auto', null, at(1))],
  };
  // 61 changes: the claim, then thirty rounds of the owner moving to Plan on the web and back to Auto on Android in the
  // same millisecond, twenty before the first reply and ten after the second question. The detail carries the newest 50,
  // the oldest of them at 0:15.
  longChanges = [change('CLAIM', 'auto', null, at(1), null, 1)];
  for (let round = 0; round < 30; round += 1) {
    const when = round < 20 ? at(10 + round) : at(110 + round);
    longChanges.push(
      change('OWNER_PICK', 'plan', 'auto', when, 'web', longChanges.length + 1),
      change('OWNER_PICK', 'auto', 'plan', when, 'android', longChanges.length + 2),
    );
  }
  changes[LONG] = longChanges.slice(-50);
  rows = [
    row(RUNNING, 'Staging migration check', 'claude-opus-5-5', 'auto', changes[RUNNING]),
    row(CORRECTING, 'Rotate the staging key', 'claude-opus-5-5', 'auto', changes[CORRECTING]),
    row(NO_AUTO, 'Tidy the changelog', 'claude-haiku-4-5', 'auto', changes[NO_AUTO]),
    row(HISTORY, 'Drop the probe table', 'claude-opus-5-5', 'auto', changes[HISTORY]),
    row(ROOT_BYPASS, 'Rebuild the index', 'claude-opus-5-5', 'bypassPermissions', changes[ROOT_BYPASS]),
    row(LONG, 'Flip the flag', 'claude-opus-5-5', 'auto', changes[LONG]),
  ];
  details = Object.fromEntries(rows.map((r) => [r.id as string, { ...r, permissionModeChanges: changes[r.id as string] }]));
  details[LONG].permissionModeChangesHasMore = true;
  const conversation = [
    { seq: 1, type: 'user', turnId: 't1', ts: at(0), payload: { text: 'Run the staging migration check and tell me what fails.' } },
    { seq: 2, type: 'assistant', turnId: 't1', ts: at(60), payload: { text: 'Ran it against staging: 14 of 14 checks passed.' } },
    { seq: 3, type: 'user', turnId: 't2', ts: at(120), payload: { text: 'Good. Now drop the old runner_probe table on staging.' } },
    { seq: 4, type: 'assistant', turnId: 't2', ts: at(200), payload: { text: 'Dropped it. Nothing else referenced it.' } },
  ];
  events = Object.fromEntries(rows.map((r) => [r.id as string, conversation]));
}

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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The Mode capsule's words, which say whether there is a gap (`data-mode-gap`), inside the pill's trigger. */
const capsule = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.composer-toolbar [data-mode-gap]');
const capsuleText = (): string => capsule()?.closest('.orbit-choice-value')?.textContent?.trim() ?? '';

/** Mounts the page at `route` and waits for the Mode capsule to say `expected`. */
async function mount(route: string, expected: string, runner = runnerWith()): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  root = createRoot(container);
  document.body.appendChild(container);
  const nextClient = client;
  const nextRoot = root;
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[route]}>
          <WorkspaceView runner={runner} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(capsuleText()).toBe(expected), { timeout: 20_000, interval: 20 });
  });
  await settle();
}

/** Opens the Mode menu, as the session page's tests open a house Select, and waits for its options. */
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
const options = (): string[] =>
  [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent?.trim() ?? '');
const checked = (): string | undefined =>
  document.querySelector('[role="listbox"] [role="option"][aria-selected="true"]')?.textContent?.trim();
const menuHead = (): string | undefined => document.querySelector('.orbit-select-header')?.textContent?.trim();

/** The transcript's text, top to bottom, with each mode-change line marked. */
const transcript = (): string[] =>
  [...mounted().querySelectorAll('.chat-user, .chat-assistant, .chat-mode-line')].map((el) =>
    el.classList.contains('chat-mode-line')
      ? `⛉ ${el.querySelector('.chat-mode-line-text')?.textContent}${el.classList.contains('is-gap') ? ' (amber)' : ''}`
      : (el.textContent ?? '').trim().split(/\s+/).slice(0, 3).join(' '),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  serve();
  lastModel = null;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSessionEventPage).mockReset();
  modePagesAsked = [];
  const olderEvents = new Promise<void>((resolve) => {
    releaseOlderEvents = resolve;
  });
  vi.mocked(getSessionEventPage).mockImplementation((async (sid: string, opts: { before?: number }) => {
    if (sid !== LONG) return { events: events[sid] ?? [], hasMore: false };
    // LONG opens on its second question; the page before it waits until the test lets the transcript reach the start.
    if (opts.before === undefined) return { events: (events[sid] ?? []).slice(2), hasMore: true };
    await olderEvents;
    return { events: (events[sid] ?? []).filter((e) => (e as { seq: number }).seq < opts.before!), hasMore: false };
  }) as never);
  vi.mocked(getSessionPermissionModeChanges).mockReset();
  vi.mocked(getSessionPermissionModeChanges).mockImplementation(async (_sid: string, opts: { before?: number } = {}) => {
    // As GET /sessions/:id/permission-mode-changes pages them: the 50 just before `before`, oldest first.
    modePagesAsked.push(opts.before!);
    const older = longChanges.filter((c) => c.seq! < opts.before!);
    return { changes: older.slice(-50), hasMore: older.length > 50 };
  });
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(async (sid: string) => details[sid] as never);
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (init?.method && init.method !== 'GET') return reply(undefined);
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([
        {
          id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z',
          lastEngine: 'claude', lastProvider: 'claude', lastModel,
        },
      ]);
    }
    for (const sid of Object.keys(details)) {
      if (path.startsWith(`/sessions/${sid}`)) {
        if (path.includes('/events/page')) return reply({ events: events[sid] ?? [], hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(details[sid]);
      }
    }
    if (path.startsWith('/sessions')) return reply(rows);
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
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('the mode a session is actually running in (docs/mocks/permission-mode-actual)', { timeout: 60_000 }, () => {
  it('① the capsule says the mode the engine runs in, unmarked, and the menu’s check is on it', async () => {
    await mount(`/sessions/${RUNNING}`, 'Auto');
    expect(capsule()?.dataset.modeGap).toBe('none');
    expect(capsule()?.querySelector('.composer-mode-dot, .composer-mode-spin')).toBeNull();
    await openMode();
    expect(checked()).toBe('Auto');
    expect(menuHead()).toBeUndefined();
    // The plain first claim says nothing in the transcript.
    expect(mounted().querySelectorAll('.chat-mode-line')).toHaveLength(0);
  });

  it('② while the runner switches Claude back to Auto: "Default → Auto" with a spinner, and why', async () => {
    await mount(`/sessions/${CORRECTING}`, 'Default → Auto');
    expect(capsule()?.dataset.modeGap).toBe('switching');
    expect(capsule()?.className).toContain('is-gap');
    expect(capsule()?.querySelector('.composer-mode-spin')).not.toBeNull();
    await openMode();
    expect(menuHead()).toBe('Running in Default. Claude started below the Auto you asked for; the runner is switching it to Auto now.');
    expect(checked()).toBe('Auto');
    // The transcript's line for it is the gap's, in amber.
    expect(transcript()).toContain('⛉ Claude started in Default, not Auto (amber)');
  });

  it('② a lasting gap on a model with no Auto: "Default" with a dot, the reason and the way back, the check on Auto', async () => {
    await mount(`/sessions/${NO_AUTO}`, 'Default');
    expect(capsule()?.dataset.modeGap).toBe('lasting');
    expect(capsule()?.querySelector('.composer-mode-dot')).not.toBeNull();
    await openMode();
    expect(menuHead()).toBe('Running in Default. You asked for Auto, but Haiku 4.5 has no Auto. Pick a model with Auto to get it back.');
    expect(checked()).toBe('Auto — not on Haiku 4.5, runs as Default');
    expect(options()).toEqual([
      'Default',
      'Plan',
      'Accept Edits',
      'Auto — not on Haiku 4.5, runs as Default',
      "Don't Ask",
      'Bypass',
    ]);
    expect(transcript()).toContain('⛉ Mode now Default — you picked Haiku 4.5, which has no Auto (amber)');
  });

  it('② Bypass on a root runner runs as Auto: a lasting gap, and the claim’s line says why', async () => {
    await mount(`/sessions/${ROOT_BYPASS}`, 'Auto', runnerWith(true));
    expect(capsule()?.dataset.modeGap).toBe('lasting');
    await openMode();
    expect(menuHead()).toBe('Running in Auto. You asked for Bypass, but Bypass can’t run on a root runner.');
    expect(checked()).toBe('Bypass — unavailable on a root runner, runs as Auto');
    expect(transcript()).toContain('⛉ Started in Auto, not Bypass — Bypass can’t run on a root runner (amber)');
  });

  it('③ the transcript records every change where it happened, with who or what made it', async () => {
    await mount(`/sessions/${HISTORY}`, 'Auto');
    await act(async () => {
      await vi.waitFor(() => expect(mounted().querySelectorAll('.chat-mode-line').length).toBeGreaterThan(0), { timeout: 10_000, interval: 20 });
    });
    expect(transcript()).toEqual([
      'Run the staging',
      '⛉ Mode set back to Auto by the runner — Claude had started in Default',
      'Ran it against',
      '⛉ Mode set to Plan by you, on the web',
      '⛉ Mode set to Accept Edits by you, on iOS',
      '⛉ Mode set to Auto by you, on Android',
      'Good. Now drop',
      'Dropped it. Nothing',
      '⛉ Mode set to Default by Orbit',
      '⛉ Mode set to Auto by you, on the web',
      '⛉ Claude restarted in Default',
      '⛉ Mode set back to Auto by the runner — Claude had restarted in Default',
    ]);
    const line = mounted().querySelector('.chat-mode-line')!;
    expect(line.querySelector('svg.chat-mode-line-icon')).not.toBeNull();
    expect(line.querySelector('b')?.textContent).toBe('Auto');
    expect(line.querySelector('time')?.getAttribute('dateTime')).toBe(at(4));
    // The engine runs the mode asked for, so no line is amber.
    expect(mounted().querySelectorAll('.chat-mode-line.is-gap')).toHaveLength(0);
  });

  it('④ before a session starts, a model with Auto shows Auto with no hint', async () => {
    lastModel = 'claude-opus-5-5';
    await mount(`/workspaces/${WORKSPACE_PUBLIC}/new`, 'Auto');
    expect(capsule()?.dataset.modeGap).toBe('none');
    await openMode();
    expect(menuHead()).toBeUndefined();
    expect(checked()).toBe('Auto');
  });

  it('④ before a session starts on a model with no Auto (C1): the Default it starts in, and Auto kept as the pick', async () => {
    lastModel = 'claude-haiku-4-5';
    await mount(`/workspaces/${WORKSPACE_PUBLIC}/new`, 'Default');
    expect(capsule()?.dataset.modeGap).toBe('lasting');
    expect(capsule()?.querySelector('.composer-mode-dot')).not.toBeNull();
    await openMode();
    expect(menuHead()).toBe('Starts in Default. Haiku 4.5 has no Auto; your pick stays Auto and applies on a model that has it.');
    expect(checked()).toBe('Auto — not on Haiku 4.5, starts in Default');
  });

  it('the Agent tools drawer says the same mode and gap', async () => {
    await mount(`/sessions/${NO_AUTO}`, 'Default');
    await act(async () => {
      mounted().querySelector('.workspace-header button[aria-label="More actions"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const door = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="menu"]:not([data-closed]) [role="menuitem"]')].find((el) =>
        el.textContent?.startsWith('Agent tools'),
      );
      expect(found).toBeTruthy();
      return found!;
    });
    await act(async () => {
      door.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const drawer = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('.agent-tools'));
      expect(found).toBeTruthy();
      return found!;
    });
    const section = [...drawer.querySelectorAll('.agent-tools-sec')].find((s) => s.textContent?.startsWith('Permission mode'))!;
    expect(section.querySelector('.agent-tools-sec-title small')?.textContent).toBe('Default');
    expect(section.querySelector('.agent-tools-mode-gap')?.textContent).toBe(
      'Running in Default. You asked for Auto, but Haiku 4.5 has no Auto. Pick a model with Auto to get it back.',
    );
  });

  it('⑤ more changes than the detail carries: the older ones are read as the transcript pages back, each drawn once', async () => {
    await mount(`/sessions/${LONG}`, 'Auto');
    const lines = () => mounted().querySelectorAll('.chat-mode-line');
    await act(async () => {
      await vi.waitFor(() => expect(lines().length).toBe(50), { timeout: 10_000, interval: 20 });
    });
    // The detail's oldest change (at 0:15) is older than the oldest event loaded (the question at 2:00): nothing more
    // is needed for the window shown, so nothing more is read.
    await settle();
    expect(modePagesAsked).toEqual([]);

    // The transcript pages back to the start: the changes before the detail's are read with it, from its oldest.
    await act(async () => releaseOlderEvents());
    await act(async () => {
      await vi.waitFor(() => expect(lines().length).toBe(60), { timeout: 10_000, interval: 20 });
    });
    expect(modePagesAsked).toEqual([longChanges[11].seq]);
    const round = ['⛉ Mode set to Plan by you, on the web', '⛉ Mode set to Auto by you, on Android'];
    expect(transcript()).toEqual([
      'Run the staging',
      // The claim's plain first mode says nothing; the twenty rounds before the first reply, each pair in its order.
      ...Array.from({ length: 20 }, () => round).flat(),
      'Ran it against',
      'Good. Now drop',
      ...Array.from({ length: 10 }, () => round).flat(),
      'Dropped it. Nothing',
    ]);
    // Each line once, by the change it draws, and each at its own moment.
    const times = [...lines()].map((l) => l.querySelector('time')?.getAttribute('dateTime'));
    expect(times).toEqual(longChanges.slice(1).map((c) => c.at));
    await settle();
    expect(modePagesAsked).toHaveLength(1);
  });
});
