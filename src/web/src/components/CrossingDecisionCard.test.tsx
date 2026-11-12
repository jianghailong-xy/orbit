// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCrossingRow } from '../lib/attribution';
import { CROSSING_PROVENANCE, MOVE_TASKS_APPROVE_CONSEQUENCE } from '../lib/crossingBatches';

/**
 * The crossing decision card as a conversation mounts it (`useCrossingDecisionCards`): one card per
 * batch — task moves from the session's task-moves read, filings and dependencies from the
 * project's crossings read. A batch of task moves is answered by ONE call to the session's batch
 * door with every move and its key, and its fence refusal is shown on the card; the other kinds go
 * through the existing door one crossing at a time. The same card is drawn in the session that
 * asked for the moves. Then the receipt it leaves, and the one a batch answered at another end
 * leaves.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { useCrossingDecisionCards } = await import('./CrossingDecisionCard');

const TARGET = 'TgtPub';
const COORDINATOR = 'CoordSession';
const ASKER = 'AskerSession';
const SOURCE = '0195c0de-0000-7000-8000-000000000020';

function row(i: number, over: Partial<ProjectCrossingRow> = {}): ProjectCrossingRow {
  return {
    id: `0195c0de-0000-7000-8000-00000000010${i}`,
    publicId: `Crossing${i}`,
    fromProjectId: SOURCE,
    toProjectId: '0195c0de-0000-7000-8000-000000000010',
    toProjectPublicId: TARGET,
    fromProject: { title: 'Runner link v1', status: 'DONE' },
    toProject: { title: 'Runner hardening', status: 'OPEN' },
    kind: 'MOVE_TASK',
    subjectTaskId: `t${i}`,
    subjectTask: { id: `t${i}`, title: `Moved task ${i}` },
    requestedCriterion: { key: String(3 + i), text: `criterion ${3 + i}` },
    withdrawnCriterion: null,
    crossingKey: `key-${i}`,
    state: 'PENDING',
    title: `Moved task ${i}`,
    reason: 'These tasks serve criteria here; their old project is done.',
    requestedAt: `2026-11-09T08:31:0${i}.000Z`,
    decidedAt: null,
    expiresAt: null,
    ...over,
  };
}

let rows: ProjectCrossingRow[] = [];
let posts: Array<{ path: string; body: unknown }> = [];
let refuse: Set<string> = new Set();
/** Moves whose key the batch door finds no longer matches: it then writes nothing. */
let fence: Set<string> = new Set();

/** `GET /sessions/:id/task-moves`, as the server groups it: one asker, source and target; answered
 *  moves by the answer that settled them. */
function taskMoves(sessionId: string) {
  const groups = new Map<string, ProjectCrossingRow[]>();
  for (const r of rows) {
    if (r.kind !== 'MOVE_TASK') continue;
    const key = r.state === 'PENDING' ? 'PENDING' : `${r.state}|${r.decidedAt}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, moves]) => ({
    batchKey: `batch-${key}`,
    requestedBySessionId: ASKER,
    fromProjectId: SOURCE,
    toProjectId: moves[0].toProjectId,
    state: moves[0].state,
    since: moves[0].requestedAt,
    decidedAt: moves[0].decidedAt,
    drawnAs: sessionId === ASKER ? ['REQUESTER'] : ['TARGET_COORDINATOR'],
    moves,
  }));
}

function serve() {
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST' && path.endsWith('/task-moves/decision')) {
      posts.push({ path, body: init.body });
      const body = init.body as { decision: string; moves: Array<{ handoffId: string; crossingKey: string }> };
      const stale = body.moves.filter((m) => fence.has(m.handoffId));
      if (stale.length > 0) {
        throw Object.assign(
          new Error(`${stale.length} of the ${body.moves.length} moves in this answer cannot take it — ${stale[0].handoffId} names a different crossing. Nothing was written; re-read the moves and answer what they say now`),
          { code: 'APPROVAL_TARGET_MISMATCH', status: 409 },
        );
      }
      const ids = new Set(body.moves.map((m) => m.handoffId));
      rows = rows.map((r) => (ids.has(r.publicId ?? r.id)
        ? { ...r, state: body.decision === 'APPROVE' ? 'APPLIED' : 'DENIED', decidedAt: '2026-11-09T09:34:00.000Z' }
        : r));
      return taskMoves(path.split('/')[2]);
    }
    if (init?.method === 'POST') {
      posts.push({ path, body: init.body });
      const id = path.split('/')[4];
      if (refuse.has(id)) {
        throw Object.assign(new Error('the task is being landed right now'), { code: 'TASK_LANDING' });
      }
      const body = init.body as { decision: string };
      rows = rows.map((r) => ((r.publicId ?? r.id) === id
        ? { ...r, state: body.decision === 'APPROVE' ? 'APPLIED' : 'DENIED', decidedAt: '2026-11-09T09:34:00.000Z' }
        : r));
      return {};
    }
    if (path === `/projects/${TARGET}/handoffs`) return rows;
    if (path === `/sessions/${COORDINATOR}/task-moves` || path === `/sessions/${ASKER}/task-moves`) {
      return taskMoves(path.split('/')[2]);
    }
    throw new Error(`unexpected ${path}`);
  });
}

const EVENTS = [{ seq: 1, ts: '2026-11-09T08:00:00.000Z' }];
function Host({ sessionId, projectId, signal = '' }: { sessionId: string; projectId: string; signal?: string }) {
  const { inserts, pointers } = useCrossingDecisionCards(sessionId, projectId, EVENTS, signal);
  return (
    <div>
      <p data-pointers>{pointers.map((p) => p.label).join('|')}</p>
      {inserts.map((insert) => <div key={insert.key} data-anchor={String(insert.anchor)}>{insert.element}</div>)}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLDivElement;
let qc: QueryClient;

beforeEach(() => {
  rows = [];
  posts = [];
  refuse = new Set();
  fence = new Set();
  apiMock.mockReset();
  serve();
  host = document.createElement('div');
  document.body.appendChild(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(sessionId = COORDINATOR, projectId = TARGET) {
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <Host sessionId={sessionId} projectId={projectId} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const text = () => document.body.textContent ?? '';
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}
async function press(label: string) {
  act(() => button(label).click());
  await settle();
}
function openReview() {
  const preview = document.querySelector<HTMLButtonElement>('.crossing-decision-preview')!;
  act(() => preview.click());
}

describe('the crossing decision card in a coordinator conversation', () => {
  it('draws one card per batch, in the criteria card’s preview, with no raw ids', async () => {
    rows = [row(1), row(2), row(3), row(4, { kind: 'FILE_TASK', subjectTask: null, title: 'File this' })];
    await mount();
    const previews = [...document.querySelectorAll('.crossing-decision-preview')].map((p) => p.textContent);
    expect(previews).toHaveLength(2);
    expect(previews[0]).toContain('⇄');
    expect(previews[0]).toContain('Move these tasks here?');
    expect(previews[0]).toContain('move');
    expect(previews[0]).toContain('3 tasks from Runner link v1 · for criteria 4–6');
    expect(previews[0]).toContain('View details & act');
    expect(previews[1]).toContain('File this task here?');
    expect(previews[1]).toContain('file');
    for (const preview of previews) expect(preview).not.toMatch(/Crossing\d|0195c0de|key-/);
    // The pinned strip counts both batches, by the cards' own question.
    expect(document.querySelector('[data-pointers]')!.textContent).toBe('Move these tasks here?|File this task here?');
    // Drawn where the batch was asked: after the last event before it.
    expect(document.querySelector('[data-anchor]')!.getAttribute('data-anchor')).toBe('1');
  });

  it('opens the review: provenance, from/to, rows with criteria, reason, consequence, Approve and Refuse', async () => {
    rows = [row(1), row(2), row(3), row(4), row(5)];
    await mount();
    openReview();
    const review = text();
    expect(review).toContain('move · 5 waiting');
    expect(review).toContain(CROSSING_PROVENANCE);
    expect(review).toContain('From Runner link v1');
    expect(review).toContain('To this project');
    expect(review).toContain('Tasks to move');
    expect(review).toContain('Moved task 1');
    expect(review).toContain('Target criterion requested: 4');
    expect(review).not.toContain('Moved task 4');
    expect(review).toContain('Show 2 more');
    expect(review).toContain('“These tasks serve criteria here; their old project is done.”');
    expect(review).toContain(MOVE_TASKS_APPROVE_CONSEQUENCE);
    await press('Show 2 more');
    expect(text()).toContain('Moved task 5');
    expect(button('Approve').disabled).toBe(false);
    expect(button('Refuse').disabled).toBe(false);
  });

  it('Approve answers a batch of task moves with ONE call to the batch door, every move with its key, then leaves the receipt', async () => {
    rows = [row(1), row(2), row(3)];
    await mount();
    openReview();
    await press('Approve');
    expect(posts).toEqual([{
      path: `/sessions/${COORDINATOR}/task-moves/decision`,
      body: {
        decision: 'APPROVE',
        moves: [
          { handoffId: 'Crossing1', crossingKey: 'key-1' },
          { handoffId: 'Crossing2', crossingKey: 'key-2' },
          { handoffId: 'Crossing3', crossingKey: 'key-3' },
        ],
      },
    }]);
    expect(posts.some((p) => p.path.includes('/handoffs/'))).toBe(false);
    const preview = document.querySelector('.crossing-decision-preview')!;
    expect(preview.className).toContain('is-answered');
    expect(preview.textContent).toContain('moved');
    expect(preview.textContent).toContain('View details');
    expect(preview.textContent).not.toContain('View details & act');
    expect(text()).toMatch(/Decision recorded · ✓ Approved by you at \S+/);
    expect(document.querySelector('[data-pointers]')!.textContent).toBe('');
  });

  it('Refuse refuses a batch of task moves with one call too', async () => {
    rows = [row(1), row(2)];
    await mount();
    openReview();
    await press('Refuse');
    expect(posts).toEqual([{
      path: `/sessions/${COORDINATOR}/task-moves/decision`,
      body: {
        decision: 'DENY',
        moves: [
          { handoffId: 'Crossing1', crossingKey: 'key-1' },
          { handoffId: 'Crossing2', crossingKey: 'key-2' },
        ],
      },
    }]);
    expect(rows.map((r) => r.state)).toEqual(['DENIED', 'DENIED']);
    expect(text()).toMatch(/Decision recorded · ✓ Refused by you at/);
    expect(document.querySelector('.crossing-decision-preview')!.textContent).toContain('refused');
  });

  it('shows the batch door’s 409 on the card: nothing written, still waiting, still answerable', async () => {
    rows = [row(1), row(2), row(3)];
    fence = new Set(['Crossing2']);
    await mount();
    openReview();
    await press('Approve');
    expect(posts).toHaveLength(1);
    expect(rows.map((r) => r.state)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    const alert = document.querySelector('.crossing-decision-body [role="alert"]')!;
    expect(alert.textContent).toContain('That answer was not recorded');
    expect(alert.textContent).toContain('APPROVAL_TARGET_MISMATCH 1 of the 3 moves in this answer cannot take it');
    expect(alert.textContent).toContain('Nothing was written');
    expect(document.querySelector('.crossing-decision-preview')!.textContent).toContain('That answer was not recorded');
    expect(text()).toContain('move · 3 waiting');
    expect(text()).not.toContain('by you');
    expect(button('Approve').disabled).toBe(false);
    expect(document.querySelector('[data-pointers]')!.textContent).toBe('Move these tasks here?');
    // Answered again once the moves are re-read, it records and the refusal goes.
    fence = new Set();
    await press('Approve');
    expect(rows.map((r) => r.state)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toMatch(/Decision recorded · ✓ Approved by you at/);
  });

  it('Refuse on another kind keeps the existing door, one crossing at a time', async () => {
    rows = [row(1, { kind: 'DEPEND_ON_TASK' }), row(2, { kind: 'DEPEND_ON_TASK' })];
    await mount();
    expect(text()).toContain('Allow these dependencies?');
    openReview();
    await press('Refuse');
    expect(posts.map((p) => p.body)).toEqual([
      { decision: 'DENY', acknowledgedCrossingKey: 'key-1' },
      { decision: 'DENY', acknowledgedCrossingKey: 'key-2' },
    ]);
    expect(text()).toMatch(/✓ Refused by you at/);
    expect(document.querySelector('.crossing-decision-preview')!.textContent).toContain('refused');
  });

  it('shows a crossing the door refused on its row, keeps the others answered, and stays answerable', async () => {
    rows = [row(1, { kind: 'FILE_TASK' }), row(2, { kind: 'FILE_TASK' })];
    refuse = new Set(['Crossing2']);
    await mount();
    openReview();
    await press('Approve');
    expect(text()).toContain('That answer was not recorded TASK_LANDING the task is being landed right now');
    expect(document.querySelector('.crossing-decision-preview')!.textContent).toContain('1 answer was not recorded');
    expect(rows.map((r) => r.state)).toEqual(['APPLIED', 'PENDING']);
    expect(text()).toContain('file · 1 waiting');
    expect(button('Approve').disabled).toBe(false);
  });

  it('says a batch it saw waiting was answered at another end', async () => {
    rows = [row(1), row(2)];
    await mount();
    rows = rows.map((r) => ({ ...r, state: 'APPLIED', decidedAt: '2026-11-09T09:00:00.000Z' }));
    await act(async () => {
      await qc.invalidateQueries();
    });
    await settle();
    expect(text()).toContain('Decision recorded · Approved at another end');
    expect(text()).not.toContain('by you');
  });

  it('draws a batch answered before this window opened as its receipt', async () => {
    rows = [row(1, { state: 'DENIED', decidedAt: '2026-11-09T09:00:00.000Z' })];
    await mount();
    expect(text()).toContain('Move this task here?');
    expect(text()).toMatch(/Decision recorded · ✓ Refused by you at/);
  });

  it('draws nothing for a conversation that coordinates no project', async () => {
    rows = [row(1)];
    root = createRoot(host);
    act(() => {
      root!.render(
        <QueryClientProvider client={qc}>
          <Host sessionId="" projectId="" />
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(document.querySelector('.crossing-decision-preview')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe('the same card in the session that asked for the moves', () => {
  it('is drawn from the asker’s read, naming the target project, in a session that coordinates nothing', async () => {
    rows = [row(1), row(2), row(3), row(4, { kind: 'FILE_TASK', subjectTask: null, title: 'File this' })];
    await mount(ASKER, '');
    const previews = [...document.querySelectorAll('.crossing-decision-preview')].map((p) => p.textContent);
    // Only the moves: a filing is drawn in the coordinator conversation alone.
    expect(previews).toHaveLength(1);
    expect(previews[0]).toContain('Move these tasks to Runner hardening?');
    expect(previews[0]).toContain('3 tasks from Runner link v1 · for criteria 4–6');
    expect(document.querySelector('[data-pointers]')!.textContent).toBe('Move these tasks to Runner hardening?');
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([`/sessions/${ASKER}/task-moves`]);
    openReview();
    expect(text()).toContain('To Runner hardening');
    expect(text()).not.toContain('To this project');
  });

  it('answers through the asker’s batch door and leaves the same receipt', async () => {
    rows = [row(1), row(2)];
    await mount(ASKER, '');
    openReview();
    await press('Approve');
    expect(posts).toEqual([{
      path: `/sessions/${ASKER}/task-moves/decision`,
      body: {
        decision: 'APPROVE',
        moves: [
          { handoffId: 'Crossing1', crossingKey: 'key-1' },
          { handoffId: 'Crossing2', crossingKey: 'key-2' },
        ],
      },
    }]);
    expect(document.querySelector('.crossing-decision-preview')!.className).toContain('is-answered');
    expect(text()).toMatch(/Decision recorded · ✓ Approved by you at/);
  });

  it('answered in the coordinator conversation, says so at the asking end', async () => {
    rows = [row(1), row(2)];
    await mount(ASKER, '');
    expect(text()).toContain('move · 2 waiting');
    // The owner answers in the target project's coordinator conversation.
    rows = rows.map((r) => ({ ...r, state: 'DENIED', decidedAt: '2026-11-09T09:00:00.000Z' }));
    await act(async () => {
      await qc.invalidateQueries();
    });
    await settle();
    const preview = document.querySelector('.crossing-decision-preview')!;
    expect(preview.className).toContain('is-answered');
    expect(preview.textContent).toContain('refused');
    expect(text()).toContain('Decision recorded · Refused at another end');
    expect(text()).not.toContain('by you');
    expect(document.querySelector('[data-pointers]')!.textContent).toBe('');
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Approve')).toBe(false);
  });

  it('re-reads the moves the moment its row says they stopped waiting, with no poll', async () => {
    rows = [row(1), row(2)];
    root = createRoot(host);
    const render = (signal: string) => act(() => {
      root!.render(
        <QueryClientProvider client={qc}>
          <Host sessionId={ASKER} projectId="" signal={signal} />
        </QueryClientProvider>,
      );
    });
    render('Crossing1,Crossing2');
    await settle();
    expect(text()).toContain('move · 2 waiting');
    rows = rows.map((r) => ({ ...r, state: 'APPLIED', decidedAt: '2026-11-09T09:00:00.000Z' }));
    render('');
    await settle();
    expect(text()).toContain('Decision recorded · Approved at another end');
    expect(apiMock.mock.calls.filter(([path]) => path === `/sessions/${ASKER}/task-moves`)).toHaveLength(2);
  });
});
