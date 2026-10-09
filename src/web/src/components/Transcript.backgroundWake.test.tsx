// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionTurn } from '../api';
import {
  ZH_JOB_AND_SCHEDULED,
  ZH_JOB_DONE,
  ZH_JOB_FAILED,
  ZH_SCHEDULED,
  ZH_TWO_JOBS,
  ZH_WAKE_WITH_COORDINATOR_CONTEXT,
} from '../lib/backgroundWake.fixtures';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * A turn the control plane opened — a background job had the news its agent was waiting for, or a
 * scheduled wakeup came due — is nobody's message: the block IS the turn. It used to draw as an
 * unnamed grey strip (`⊕ Orbit attached: context`) over an empty bubble, and then as a card on the
 * reader's side of the conversation, in the tint of their own messages — which a run of wakes turned
 * into somebody cutting in, splitting one answer into pieces and taking the sticky bar with it.
 *
 * It is one event line in the agent's stream instead: what happened, which job, how it came out and
 * when, with everything else one native disclosure away and a failure's tail left out of the fold.
 * Two things are held here that a line drawn only for what ships today would break: the 73 turns
 * already in the record carry the wording that shipped until 2026-09-15 and are not migrated
 * (fixtures copied verbatim out of this deployment's `run_event` rows), and a note that carries a
 * wake AND something else keeps that something else — as a folded entry under the line, not
 * swallowed by it, and not in a bubble of its own: nobody typed this turn, so a bubble here is an
 * empty one, signed with the reader's name.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listQueuedTurns: vi.fn(),
    cancelQueuedTurn: vi.fn(),
    interruptSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { ExportCtx, Transcript } = await import('./Transcript');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

// Built the way runner-api/background-job-wake.ts `buildBackgroundWakeBlock` builds it today
// (lib/backgroundWake.test.ts holds the parser to the same words).
const EN_DONE = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637',
  '      ended｜completed｜exit code 0',
  '      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570',
  '      output tail:',
  '        ==> recreating apiserver',
  '        ==> apiserver is healthy',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

/** A long tail whose complete contents must survive the independent output disclosure. */
const FAILED_TAIL = Array.from({ length: 12 }, (_, i) => `        error line ${i + 1}`);
const EN_FAILED = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_2955bec0e9fc｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169',
  '      ended｜failed｜exit code 1',
  '      output /root/.orbit/runs/4f50733a/bgj_2955bec0e9fc.output｜this covers bytes 0–350697',
  '      output tail:',
  ...FAILED_TAIL,
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

/** A `user` event as ingest stores a wake turn: the echo, and the same block recorded as the note. */
const wakeEvent = (block: string): RunEvent => ({
  seq: 7,
  type: 'user',
  turnId: 'turn-1',
  ts: '2026-09-15T18:10:00.000Z',
  payload: { text: block, controlPlaneNote: block },
});

describe('a wake turn in the transcript', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(events: RunEvent[]) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>,
      );
    });
  }

  const line = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.bgwake');
    if (!el) throw new Error(`no wake line was rendered:\n${container.innerHTML}`);
    return el;
  };
  const row = (): Element => line().querySelector('summary.bgwake-row')!;
  const fold = (): HTMLDetailsElement => line().querySelector<HTMLDetailsElement>('details.bgwake-fold')!;

  it('is one line in the agent’s stream, not a message the user typed', async () => {
    await mount([wakeEvent(EN_DONE)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(line().getAttribute('data-seq')).toBe('7');
    expect(line().className).toContain('is-ok');
    // No anchor for the sticky bar: it keeps naming the question the answer around this belongs to.
    expect(container.querySelector('[data-sticky-label]'), 'the line is no sticky anchor').toBeNull();

    // The line: what happened, which job, how it came out, and when.
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Background job finished');
    expect(row().querySelector('.bgwake-name')?.textContent).toBe('upgrade to 39551b637');
    expect(row().querySelector('.bgwake-name')?.classList.contains('is-command')).toBe(false);
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('exit 0');
    expect(row().querySelector('.bgwake-time')?.textContent).not.toBe('');

    // Everything else is folded under it, closed: the name in full, the command behind it, the ids,
    // who queued it, and what the agent read.
    expect(fold().hasAttribute('open')).toBe(false);
    const jobs = fold().querySelectorAll('.bgwake-job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].querySelector('.bgwake-job-name')?.textContent).toBe('upgrade to 39551b637');
    expect(jobs[0].querySelector('.bgwake-job-exit'), 'a lone job says how it came out on the line').toBeNull();
    expect(jobs[0].querySelector('.bgwake-job-cmd')?.textContent).toBe(
      '/root/orbit/.claude/skills/upgrade/upgrade.sh --pull',
    );
    expect(jobs[0].querySelector('.bgwake-job-meta')?.textContent).toBe(
      'bgj_13c53745a88a · 16.2 KB of output',
    );
    expect(fold().querySelector('.bgwake-meta')?.textContent).toBe('Queued by a background job, not typed by you');
    const raw = fold().querySelector('details.bgwake-raw')!;
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('summary')?.textContent).toBe('What the agent received');
    expect(raw.querySelector('pre')?.textContent).toBe(EN_DONE);

    // Outside the fold there is the line and nothing else.
    const shown = line().cloneNode(true) as HTMLElement;
    shown.querySelector('.bgwake-body')!.remove();
    expect(shown.textContent).not.toContain('The control plane recorded this for you');
    expect(shown.textContent).not.toContain('upgrade.sh');
    expect(shown.textContent).not.toContain('bgj_');
  });

  it('names a job started without a description by one line of its command', async () => {
    const bare = EN_DONE.replace('｜upgrade to 39551b637', '');
    await mount([wakeEvent(bare)]);

    const name = row().querySelector('.bgwake-name')!;
    expect(name.textContent).toBe('/root/orbit/.claude/skills/upgrade/upgrade.sh --pull');
    expect(name.classList.contains('is-command')).toBe(true);
    // All of it is in the fold, where no description row stands over it.
    expect(fold().querySelector('.bgwake-job-head')).toBeNull();
    expect(fold().querySelector('.bgwake-job-cmd')?.textContent).toBe(
      '/root/orbit/.claude/skills/upgrade/upgrade.sh --pull',
    );
  });

  it('keeps the failed output preview and its disclosure independent of job details', async () => {
    await mount([wakeEvent(EN_FAILED)]);

    expect(line().className).toContain('is-failed');
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Background job failed');
    expect(row().querySelector('.bgwake-name')?.textContent).toBe('watch main CI 34997433169');
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('exit 1');
    expect(fold().querySelector('.bgwake-job-meta')?.textContent).toBe(
      'bgj_2955bec0e9fc · 342.5 KB of output',
    );

    const tail = line().querySelector('.bgwake-tail')!;
    expect(tail, 'the failure’s tail is drawn').not.toBeNull();
    expect(fold().contains(tail), 'why it failed is what woke anybody: not behind the fold').toBe(false);
    expect(row().querySelector('.bgwake-details-label')?.textContent).toBe('Job details');
    expect(tail.querySelector('.bgwake-output-label')?.textContent).toBe('Output tail');
    const output = tail.querySelector<HTMLDetailsElement>('details.bgwake-output')!;
    const toggle = output.querySelector('summary')!;
    expect(output.open).toBe(false);
    // Layout is clamped by CSS; the stored excerpt is never shortened or reformatted.
    const text = FAILED_TAIL.map((line) => line.trim()).join('\n');
    expect(output.querySelector('.bgwake-output-preview')?.textContent).toBe(text);
    await act(async () => { toggle.click(); });
    expect(output.open).toBe(true);
    expect(output.querySelector('.bgwake-output-full')?.textContent).toBe(text);
    expect(fold().open, 'opening output must not open job metadata').toBe(false);
    await act(async () => { toggle.click(); });
    expect(output.open).toBe(false);
  });

  it('provides an output disclosure for long single-line JSON and strips terminal color codes', async () => {
    const json = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({
      Action: 'fail', Package: 'orbit', Test: `TestCodexReset${i}`,
    })));
    await mount([wakeEvent(EN_FAILED.replace(FAILED_TAIL.join('\n'), `        \x1b[31m${json}\x1b[0m`))]);

    const output = line().querySelector<HTMLDetailsElement>('details.bgwake-output')!;
    expect(output.open).toBe(false);
    expect(output.querySelector('.bgwake-output-preview')?.textContent).toBe(json);
    expect(output.querySelector('.bgwake-output-expand')?.textContent).toBe('Show full output');
    await act(async () => { output.querySelector('summary')!.click(); });
    expect(output.open).toBe(true);
    expect(output.querySelector('.bgwake-output-full')?.textContent).toBe(json);
    expect(fold().open).toBe(false);
  });

  it('draws the same line for the wording that shipped until 2026-09-15', async () => {
    await mount([wakeEvent(ZH_JOB_DONE)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Background job finished');
    expect(row().querySelector('.bgwake-name')?.textContent).toBe('watch main CI rerun 34970575848');
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('exit 0');
    expect(fold().querySelector('.bgwake-job-meta')?.textContent).toBe('bgj_cc4b4ef84b39 · 54 B of output');
    expect(fold().querySelector('details.bgwake-raw pre')?.textContent).toBe(ZH_JOB_DONE);
  });

  it('draws an older failure as a failure', async () => {
    await mount([wakeEvent(ZH_JOB_FAILED)]);

    expect(line().className).toContain('is-failed');
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Background job failed');
    expect(row().querySelector('.bgwake-name')?.textContent).toBe('Smoke: wakeOnExit on a job that exits 3');
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('exit 3');
    expect(fold().querySelector('.bgwake-job-meta')?.textContent).toBe('bgj_209fc7f9f47a · no output');
  });

  it('draws an older scheduled wakeup as the wakeup it was', async () => {
    await mount([wakeEvent(ZH_SCHEDULED)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Scheduled wakeup');
    expect(row().querySelector('.bgwake-name')?.textContent).toContain('复跑负载闸门');
    expect(row().querySelector('.bgwake-status'), 'nothing has come out of a wakeup').toBeNull();
    expect(row().querySelector('.bgwake-mark')?.classList.contains('is-pending')).toBe(true);
    // The fold says why in full, when it was asked for, and what it left for this turn to read.
    expect(fold().querySelector('.bgwake-wakeup-reason')?.textContent).toContain('复跑负载闸门');
    expect(fold().querySelector('.bgwake-wakeup-meta')?.textContent).toContain('Asked for 1h out');
    expect(fold().querySelector('.bgwake-wakeup .chat-pre')?.textContent).toContain('兜底检查');
    expect(fold().querySelector('.bgwake-meta')?.textContent).toBe(
      'Queued by a scheduled wakeup, not typed by you',
    );
  });

  it('draws the one older turn both blocks came on as a single line', async () => {
    await mount([wakeEvent(ZH_JOB_AND_SCHEDULED)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(container.querySelectorAll('.bgwake')).toHaveLength(1);
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Background job finished');
    expect(row().querySelector('.bgwake-name')?.textContent).toBe(
      'upgrade to 39551b637 (catalog-window fix + session-import)',
    );
    expect(fold().querySelector('.bgwake-job-meta')?.textContent).toBe('bgj_13c53745a88a · 16.2 KB of output');
    // The wakeup that came due while the job ran keeps its own row in the same fold.
    expect(fold().querySelector('.bgwake-wakeup-reason')?.textContent).toContain('升级作业的备份验证');
    expect(fold().querySelector('.bgwake-wakeup-meta')?.textContent).toContain('Asked for 12m out');
    expect(fold().querySelector('details.bgwake-raw pre')?.textContent).toBe(ZH_JOB_AND_SCHEDULED);
  });

  it('counts the jobs of an older turn that answered for two, and names each in the fold', async () => {
    await mount([wakeEvent(ZH_TWO_JOBS)]);

    expect(line().className).toContain('is-failed');
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('2 background jobs finished');
    expect(row().querySelector('.bgwake-name'), 'several jobs are counted, not named, on the line').toBeNull();
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('2 of 2 failed');
    expect([...fold().querySelectorAll('.bgwake-job-exit')].map((el) => el.textContent)).toEqual([
      'exit 1',
      'exit 1',
    ]);
    expect([...fold().querySelectorAll('.bgwake-job-meta')].map((el) => el.textContent)).toEqual([
      'bgj_52843eb345d1 · no output',
      'bgj_974ceb2c3d52 · no output',
    ]);
  });

  it('takes only the wake out of a note that carried more, and keeps the rest its own entry in the fold', async () => {
    await mount([wakeEvent(ZH_WAKE_WITH_COORDINATOR_CONTEXT)]);

    // The line is the wake alone — the coordinator's standing role is not part of what woke anybody.
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Background job finished');
    const raw = fold().querySelector('details.bgwake-raw pre')!;
    expect(raw.textContent?.startsWith('<background-job-wake>')).toBe(true);
    expect(raw.textContent).not.toContain('orbit_project_coordinator_context');

    // The rest is still an entry of its own, named for what it is — in the line's fold, since it is
    // the control plane's too and this turn has no words of anybody's to sit under.
    const toggle = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('⊕ Orbit attached:'),
    );
    expect(toggle, `no entry for the rest of the note:\n${container.innerHTML}`).toBeTruthy();
    expect(toggle!.textContent).toBe('⊕ Orbit attached: project coordinator context');
    expect(fold().contains(toggle!), 'the entry was left outside the fold').toBe(true);
    // And no bubble: an empty one here reads as a message the person sent without words.
    expect(container.querySelector('.chat-user')).toBeNull();

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const opened = toggle!.parentElement!.querySelector('pre')!;
    expect(opened.textContent?.startsWith('<orbit_project_coordinator_context>')).toBe(true);
    expect(opened.textContent).not.toContain('bgj_');
  });

  // The shape that raised this: 16 of this deployment's `<background-jobs>` notes ride a turn whose
  // content is empty, and every one of them is a wake — 15 a job's, 1 a scheduled wakeup's. Delivery
  // appends the inventory to the wake's own turn, so both blocks arrive on a turn nobody typed.
  it('draws no empty bubble when the same wake turn also carries the inventory block', async () => {
    const inventory = [
      '<background-jobs>',
      '  Ended while you were away:',
      '    bgj_41314cd48e66｜job｜swift test｜completed｜exit code 0｜output /root/.orbit/runs/x/bgj_41314cd48e66.output',
      '  The control plane recorded this for you; the user did not say it. The output files belong to the runner, so they are still there after an engine change.',
      '  Read output with mcp__orbit__bg_output by id; mcp__orbit__bg_list gives the whole list.',
      '</background-jobs>',
    ].join('\n');

    await mount([wakeEvent(`${ZH_JOB_DONE}\n\n${inventory}`)]);

    expect(container.querySelector('.chat-user')).toBeNull();
    const toggle = [...fold().querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('⊕ Orbit attached:'),
    );
    expect(toggle?.textContent).toBe('⊕ Orbit attached: background jobs · 1 ended, exit 0');
    // The wake itself is still the line's own subject, not one of the entry's rows.
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('Background job finished');
  });

  it('keeps the line, and the words behind a native disclosure, in an exported transcript', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <div className="workspace-sessions">
          <Transcript events={[wakeEvent(EN_DONE)]} live={false} />
        </div>
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html');

    expect(exported.querySelector('.bgwake-title')?.textContent).toBe('Background job finished');
    // A static file has no JS: both folds have to be ones the browser itself can open.
    expect(exported.querySelector('details.bgwake-fold > summary.bgwake-row')).not.toBeNull();
    expect(exported.querySelector('details.bgwake-fold details.bgwake-raw pre')?.textContent).toBe(EN_DONE);
  });

  it('keeps failed output expandable without JavaScript in an exported transcript', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <Transcript events={[wakeEvent(EN_FAILED)]} live={false} />
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html');
    const output = exported.querySelector<HTMLDetailsElement>('details.bgwake-output')!;
    expect(output.open).toBe(false);
    expect(output.querySelector('summary')).not.toBeNull();
    expect(output.querySelector('.bgwake-output-full')?.textContent).toBe(
      FAILED_TAIL.map((line) => line.trim()).join('\n'),
    );
  });
});

// ── the same wake, still waiting behind the running turn ──────────────────────────────────────

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');
const TYPED = 'and check the dark theme too';

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Coordinator: wake rendering',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-09-15T18:00:00Z',
  updatedAt: '2026-09-15T18:10:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('a wake still waiting in the queued tail', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    const queue: ActiveSessionTurn[] = [
      { turnId: 'turn-wake', kind: 'message', placement: 'queued', content: EN_DONE, createdAt: '2026-09-15T18:10:01.000Z' },
      { turnId: 'turn-typed', kind: 'message', placement: 'queued', content: TYPED, createdAt: '2026-09-15T18:10:05.000Z' },
    ];
    apiMock.mockReset();
    vi.mocked(listQueuedTurns).mockImplementation(async () => queue);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    apiMock.mockImplementation((path: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
        if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(SESSION);
      }
      if (path.startsWith('/sessions')) return reply([SESSION]);
      if (path.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      return reply([]);
    });
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

  it('is the same line, drawn as still queued, with the queue’s line under it', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const nextContainer = document.createElement('div');
    const nextRoot = createRoot(nextContainer);
    client = nextClient;
    container = nextContainer;
    root = nextRoot;
    document.body.appendChild(nextContainer);
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
            <AntApp>
              <WorkspaceView runner={RUNNER} />
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(mounted().querySelector('.bgwake')).not.toBeNull();
          expect(mounted().querySelector('.chat-queued')).not.toBeNull();
        },
        { timeout: 20_000, interval: 20 },
      );
    });

    const line = mounted().querySelector<HTMLElement>('.bgwake')!;
    expect(line.classList.contains('is-queued'), 'drawn as still queued').toBe(true);
    expect(line.querySelector('.bgwake-title')?.textContent).toBe('Background job finished');
    expect(line.querySelector('.bgwake-name')?.textContent).toBe('upgrade to 39551b637');
    expect(line.hasAttribute('data-seq'), 'a queued wake is no event for ⌘F to land on').toBe(false);
    // The block stays folded here too, and none of it is drawn as something the user typed.
    const fold = line.querySelector('details.bgwake-fold')!;
    expect(fold.hasAttribute('open')).toBe(false);
    expect(fold.querySelector('details.bgwake-raw pre')?.textContent).toBe(EN_DONE);
    expect(
      [...mounted().querySelectorAll('.chat-user')].some((b) => b.textContent?.includes('bgj_')),
      'no part of the wake is drawn as something the user typed',
    ).toBe(false);

    // The queue's own line, under the wake's.
    const queueLine = line.querySelector('.bgwake-queued .chat-queued-meta')!;
    expect(queueLine.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect([...queueLine.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);

    // The message typed behind it is drawn as it always was.
    const bubbles = mounted().querySelectorAll<HTMLElement>('.chat-queued');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].querySelector('.md')?.textContent?.trim()).toBe(TYPED);
  });
});
