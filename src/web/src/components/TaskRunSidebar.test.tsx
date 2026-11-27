// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The task run sidebar (docs/task-run-sidebar-design.md, board docs/mocks/task-run-sidebar): the task
 * panel docked beside a conversation in its compact arrangement, and today's overlay everywhere else.
 */

// Every read the panel makes is seeded below; one that is not stays pending rather than failing.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

const { TaskDetailPanel, compactTaskState, doneMeansChecklist } = await import('./TaskDetailPanel');
const { TaskOverPagePanel } = await import('./TaskOverPagePanel');
const { encodeId } = await import('../lib/idCodec');
const { TASK_COLUMN_QUERY } = await import('../lib/useMediaQuery');

const TASK = encodeId('0195c0de-0000-7000-8000-0000000000a1');
const RUN = encodeId('0195c0de-0000-7000-8000-0000000000a2');
const EARLIER_RUN = encodeId('0195c0de-0000-7000-8000-0000000000a3');
const OTHER_SESSION = encodeId('0195c0de-0000-7000-8000-0000000000a4');
const PROJECT = encodeId('0195c0de-0000-7000-8000-0000000000a5');

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const run = (over: Record<string, unknown> = {}) => ({
  id: RUN,
  status: 'FAILED',
  runStatus: 'FAILED',
  createdAt: '2026-11-25T12:41:00.000Z',
  costUsd: 1.32,
  workspace: { name: 'orbit-ws01' },
  acceptanceRounds: [],
  ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  title: 'Fix the date-dependent failures in the web test suite and the duplicate heading in the config guide',
  status: 'FAILED',
  createdAt: '2026-11-25T06:40:00.000Z',
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'npm run docs:check && cd src/web && npx vitest run',
  acceptanceExpectedExitCode: 0,
  acceptanceCriteria: '- Full web suite, 0 failed\n- Fix the clock dependence, do not weaken tests',
  description: 'main is red in two places.',
  assignee: { id: 'w1', name: 'orbit-ws01' },
  sessions: [run()],
  comments: [],
  dependsOn: [],
  dependedOnBy: [],
  ...over,
});

const ROUND = {
  id: 'round-1',
  turnId: 'turn-acceptance-1',
  exitCode: 1,
  expectedExitCode: 0,
  branchSha: '432e94a1b2c3d4e5f60718293a4b5c6d7e8f9012',
  finishedAt: '2026-11-25T06:53:00.000Z',
  outputTail: 'FAIL src/date.test.ts',
};

function client(data: Record<string, unknown>, extra: Array<[unknown[], unknown]> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } } });
  qc.setQueryData(['task', TASK], data);
  qc.setQueryData(['task', TASK, 'evidence'], []);
  qc.setQueryData(['session', RUN], {
    id: RUN,
    branch: 'orbit/task-fix-date-dependent-failures',
    branchMerged: false,
    branchCommits: [{ sha: '16f4a7c0ffee', subject: 'docs: rename the second "Drive" heading', committedAt: '2026-11-25T06:50:00.000Z', files: [] }],
  });
  for (const [key, value] of extra) qc.setQueryData(key, value);
  return qc;
}

function compact(data: Record<string, unknown>, extra: Array<[unknown[], unknown]> = []): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client(data, extra)}>
      <MemoryRouter>
        <TaskDetailPanel taskId={TASK} onOpenTask={() => {}} onClose={() => {}} onDelete={() => {}} deleting={false}
          docked compact hereSessionId={RUN} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The column's blocks, top to bottom, as the markup orders them: the head first, then each `data-block`. */
function blocks(html: string): string[] {
  const head = html.indexOf('tdp-compact-head');
  const found = [...html.matchAll(/data-block="([a-z-]+)"/g)].map((m) => ({ name: m[1], at: m.index! }));
  return [{ name: 'head', at: head }, ...found].filter((b) => b.at >= 0).sort((a, b) => a.at - b.at).map((b) => b.name);
}

const text = (html: string): string => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent ?? '';
};
const pill = (html: string): string | null => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.querySelector('[data-status-pill]')?.textContent ?? null;
};

const BOARD_ORDER = ['head', 'state', 'branch', 'done-means', 'runs', 'runs-with', 'activity'];

describe('the compact column, in the board order for each state', () => {
  it('Failed: the pill names the check, Why it failed lists this run\'s rounds with Output, the note and three actions', () => {
    const html = compact(task({
      sessions: [run({ acceptanceRounds: [ROUND] }), run({ id: EARLIER_RUN, createdAt: '2026-11-24T12:41:00.000Z', acceptanceRounds: [] })],
      comments: [{ id: 'c1', authorName: 'orbit-ws01', createdAt: '2026-11-26T12:11:00.000Z', body: 'Machine load, not the code.\nThe run\'s own check exited 0.' }],
    }));
    expect(blocks(html)).toEqual(BOARD_ORDER);
    expect(pill(html)).toBe('Failed · check exited 1');
    const all = text(html);
    expect(all).toContain('Why it failed');
    expect(all).toMatch(/Acceptance check · exit 1, expected 0 · .+ on 432e94a · Output/);
    expect(all).toContain('Latest note (orbit-ws01, Nov 26): Machine load, not the code.');
    expect(all).not.toContain("The run's own check exited 0.");
    expect(all).toContain('Re-run the check');
    expect(all).toContain('Retry the task');
    expect(all).toContain('Close as not needed');
    // Branch: what is left on it, and where it stands against main.
    expect(all).toContain('orbit/task-fix-date-dependent-failures');
    expect(all).toContain('1 ahead');
    expect(all).toContain('16f4a7c docs: rename the second "Drive" heading');
    // Done means: the command judged by the round, each criterion not settled yet, the rest behind Show.
    expect(html).toMatch(/<li class="is-failed"><span class="tdp-check-mark">✕<\/span><code>npm run docs:check/);
    expect(all).toContain('Criteria text · BriefShow');
    expect(all).not.toContain('main is red in two places.');
    // Runs: numbered from the oldest, this one named, the other a link.
    expect(all).toContain('Run 2 · Nov 25 · $1.32 · this conversation');
    expect(html).toContain(`href="/sessions/${EARLIER_RUN}"`);
    expect(html).not.toContain(`href="/sessions/${RUN}"`);
    // Runs with and Activity, one line each; the composer is the conversation's.
    expect(all).toContain('orbit-ws01 · Claude Code');
    expect(all).toMatch(/Activity · \d+/);
    expect(html).not.toContain('tdp-compose');
  });

  it('Running: the pill says how long, the state block is Now', () => {
    const html = compact(task({
      status: 'IN_PROGRESS',
      sessions: [run({ status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', phase: 'RUNNING', activity: 'TURN', costUsd: 0.84,
        createdAt: new Date(Date.now() - 7 * 60_000).toISOString() })],
      progress: { revision: 3, phase: 'Retry with backoff', current: 3, total: 5, message: null },
    }));
    expect(blocks(html)).toEqual(BOARD_ORDER);
    expect(pill(html)).toBe('Running · 7m');
    const all = text(html);
    expect(all).toContain('$0.84 so far');
    expect(all).toContain('Step 3 of 5');
    expect(html).toContain('class="tdp-state is-running"');
  });

  it('Needs you: the pill names the evidence, the block reviews it with Accept and Send back', () => {
    const html = compact(
      task({ status: 'IN_PROGRESS', completionCriterion: 'OWNER_CONFIRMED', acceptanceCommand: null,
        sessions: [run({ status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', costUsd: 3.12 })] }),
      [
        [['task', TASK, 'owner-confirmation'], { taskId: TASK, waiting: { requestId: 'req-1', sessionId: RUN, requestedAt: '2026-11-25T07:20:00.000Z', report: null, review: null }, decisions: [] }],
        [['task', TASK, 'evidence'], [{ revision: '1', submittedAt: '2026-11-25T07:20:00.000Z',
          evidence: { claim: 'Retries on 5xx.', checks: [{ kind: 'TOOL_CALL', ref: 'bgj_1', command: 'npm test', succeeded: true }] }, decision: null }]],
      ],
    );
    expect(blocks(html)).toEqual(BOARD_ORDER);
    expect(pill(html)).toBe('Needs you · evidence r1');
    const all = text(html);
    expect(all).toContain('Review the evidence');
    expect(all).toContain('✓npm test');
    expect(all).toContain('Accept');
    expect(all).toContain('Send back');
    expect(all).toContain('After you accept');
  });

  it('Done: the pill and the landing badge, Delivered in two lines', () => {
    const html = compact(
      task({ status: 'DONE', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCommand: null,
        integration: { state: 'ON_UPSTREAM', mainBranch: 'main', landTask: null },
        sessions: [run({ status: 'SUCCEEDED', runStatus: 'SUCCEEDED', costUsd: 3.12 })] }),
      [[['task', TASK, 'evidence'], [{ revision: '1', submittedAt: '2026-11-25T07:20:00.000Z', evidence: { claim: 'Done.' },
        decision: { decision: 'CONFIRM', decidedAt: '2026-11-25T07:31:00.000Z', decidedByType: 'USER' } }]]],
    );
    expect(blocks(html)).toEqual(BOARD_ORDER);
    expect(pill(html)).toBe('Done');
    expect(html).toContain('data-landing-badge="">On main</span>');
    const state = /<section class="tdp-state is-done"[\s\S]*?<\/section>/.exec(html)![0];
    expect(state.match(/<li /g)).toHaveLength(2);
    expect(text(state)).toMatch(/^Delivered✓Evidence r1 accepted · .+○?✓?On main/);
    // Every criterion ticks once the task is accepted.
    expect(html).toMatch(/<li class="is-passed"><span class="tdp-check-mark">✓<\/span><span>Full web suite, 0 failed<\/span>/);
  });

  it('reads the state block from the task, and Done means from the newest round and the decision', () => {
    expect(compactTaskState({ status: 'FAILED', needsYou: false, running: false })).toBe('FAILED');
    expect(compactTaskState({ status: 'DONE', needsYou: false, running: false })).toBe('DONE');
    expect(compactTaskState({ status: 'IN_PROGRESS', needsYou: true, running: true })).toBe('NEEDS_YOU');
    expect(compactTaskState({ status: 'IN_PROGRESS', needsYou: false, running: true })).toBe('RUNNING');
    expect(compactTaskState({ status: 'OPEN', needsYou: false, running: false })).toBeNull();
    const rows = doneMeansChecklist({ criteria: 'One paragraph\nof text.', command: 'npm test', round: { exitCode: 0, expectedExitCode: 0 }, status: 'OPEN', evidenceDecision: null });
    expect(rows.map((r) => [r.text, r.mark])).toEqual([['npm test', 'passed'], ['One paragraph of text.', 'pending']]);
  });
});

/** A window `width` px wide: min-width and max-width queries answer for it, nothing else matches. */
function windowWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const bounds = [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    const matches = bounds.length > 0 && !/hover|pointer|prefers/.test(query)
      && bounds.every(([, side, px]) => (side === 'min' ? width >= Number(px) : width <= Number(px)));
    return { matches, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false };
  });
}
const DOCK_WIDTH = Number(/min-width:\s*(\d+)px/.exec(TASK_COLUMN_QUERY)![1]);

describe('docked beside a conversation from 1640 px, the overlay below that and on other pages', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let search = '';
  function Where() {
    ({ search } = useLocation());
    return null;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // The overlay's composer sizes itself with one.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(async () => {
    const mounted = root;
    root = null;
    if (mounted) await act(async () => mounted.unmount());
    container?.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
  const open = async (path: string) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const qc = client(task());
    await act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[`${path}?task=${TASK}`]}>
            <Where />
            <Routes>
              <Route path="*" element={<TaskOverPagePanel taskId={TASK} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    return container;
  };
  const panel = () => container!.querySelector('.project-task-panel')!;

  it('docks as the compact column in the task\'s own run conversation on a wide window', async () => {
    windowWidth(DOCK_WIDTH);
    await open(`/sessions/${RUN}`);
    expect(panel().className).toBe('project-task-panel is-docked');
    expect(panel().querySelector('.task-detail-panel')!.className).toBe('task-detail-panel is-docked is-compact');
  });

  it('docks beside any conversation, not only one of its runs (owner, session-task-column)', async () => {
    windowWidth(DOCK_WIDTH);
    await open(`/sessions/${OTHER_SESSION}`);
    expect(panel().className).toBe('project-task-panel is-docked');
    expect(panel().querySelector('.task-detail-panel')!.className).toBe('task-detail-panel is-docked is-compact');
    // No run of the task is this conversation, so none is named so and every run is a link.
    expect(panel().textContent).not.toContain('this conversation');
    expect(panel().querySelector(`a[href="/sessions/${RUN}"]`)).not.toBeNull();
  });

  it('lies over the page below the docking width, in the full arrangement', async () => {
    windowWidth(DOCK_WIDTH - 1);
    await open(`/sessions/${RUN}`);
    expect(panel().className).toBe('project-task-panel');
    expect(panel().querySelector('.task-detail-panel')!.className).toBe('task-detail-panel');
    expect(panel().querySelector('.tdp-compose')).not.toBeNull();
  });

  it('lies over every other page, as today', async () => {
    windowWidth(DOCK_WIDTH + 400);
    for (const path of [`/projects/${PROJECT}`, '/scheduled', '/wiki']) {
      await open(path);
      expect(panel().className, path).toBe('project-task-panel');
      expect(panel().querySelector('.is-compact'), path).toBeNull();
      const mounted = root;
      root = null;
      await act(async () => mounted!.unmount());
      container!.remove();
    }
  });

  it('✕ in its own run conversation closes it and remembers the close for that conversation alone', async () => {
    windowWidth(DOCK_WIDTH);
    await open(`/sessions/${RUN}`);
    const close = panel().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    await act(async () => close.click());
    expect(new URLSearchParams(search).get('task')).toBeNull();
    expect(JSON.parse(store.get('orbit.taskRunSidebarClosed') ?? '[]')).toEqual([RUN]);
  });

  it('✕ beside a conversation that is not one of its runs remembers nothing', async () => {
    windowWidth(DOCK_WIDTH);
    await open(`/sessions/${OTHER_SESSION}`);
    await act(async () => panel().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(store.get('orbit.taskRunSidebarClosed')).toBeUndefined();
  });

  it('the stylesheet docks it at the column width the query makes room for', () => {
    const css = ['src/index.css', 'src/web/src/index.css']
      .map((p) => resolve(process.cwd(), p))
      .map((p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } })
      .find((c) => c != null)!;
    const rule = /\.app-shell \.project-task-panel\.is-docked > \.task-detail-panel \{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/width: 420px;/);
    expect(TASK_COLUMN_QUERY).toBe('(min-width: 1640px)');
  });
});
