// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCrossingRow } from '../lib/attribution';
import { CROSSING_PROVENANCE, MOVE_TASKS_APPROVE_CONSEQUENCE } from '../lib/crossingBatches';

/**
 * The crossing decision card as the coordinator conversation mounts it (`useCrossingDecisionCards`):
 * one card per batch drawn from the project's crossings read, one Approve that answers every
 * crossing of the batch through the existing door with its own key, the receipt it leaves, the
 * receipt a batch answered at another end leaves, and a crossing the door refused shown on its row.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { useCrossingDecisionCards } = await import('./CrossingDecisionCard');

const TARGET = 'TgtPub';
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

function serve() {
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
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
    throw new Error(`unexpected ${path}`);
  });
}

function Host({ projectId }: { projectId: string }) {
  const { inserts, pointers } = useCrossingDecisionCards(projectId, [{ seq: 1, ts: '2026-11-09T08:00:00.000Z' }]);
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

async function mount() {
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <Host projectId={TARGET} />
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

  it('Approve answers every crossing of the batch through the door, each with its own key, then leaves the receipt', async () => {
    rows = [row(1), row(2), row(3)];
    await mount();
    openReview();
    await press('Approve');
    expect(posts.map((p) => p.path).sort()).toEqual([
      `/projects/${TARGET}/handoffs/Crossing1/decision`,
      `/projects/${TARGET}/handoffs/Crossing2/decision`,
      `/projects/${TARGET}/handoffs/Crossing3/decision`,
    ]);
    expect(posts.map((p) => p.body)).toEqual(
      expect.arrayContaining([
        { decision: 'APPROVE', acknowledgedCrossingKey: 'key-1' },
        { decision: 'APPROVE', acknowledgedCrossingKey: 'key-2' },
        { decision: 'APPROVE', acknowledgedCrossingKey: 'key-3' },
      ]),
    );
    const preview = document.querySelector('.crossing-decision-preview')!;
    expect(preview.className).toContain('is-answered');
    expect(preview.textContent).toContain('moved');
    expect(preview.textContent).toContain('View details');
    expect(preview.textContent).not.toContain('View details & act');
    expect(text()).toMatch(/Decision recorded · ✓ Approved by you at \S+/);
    expect(document.querySelector('[data-pointers]')!.textContent).toBe('');
  });

  it('Refuse refuses them all', async () => {
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
    rows = [row(1), row(2)];
    refuse = new Set(['Crossing2']);
    await mount();
    openReview();
    await press('Approve');
    expect(text()).toContain('That answer was not recorded TASK_LANDING the task is being landed right now');
    expect(document.querySelector('.crossing-decision-preview')!.textContent).toContain('1 answer was not recorded');
    expect(rows.map((r) => r.state)).toEqual(['APPLIED', 'PENDING']);
    expect(text()).toContain('move · 1 waiting');
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
    expect(text()).toContain('Approved at another end');
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
          <Host projectId="" />
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(document.querySelector('.crossing-decision-preview')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
