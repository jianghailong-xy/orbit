// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_COPY, type ScheduleChangeOpening } from '@orbit/shared';

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const { ScheduleChangePage } = await import('./ScheduleChangePage');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A schedule's Change… (docs/scheduled-tasks-design.md §8.2, board 03-change ③): Orbit's opening and a composer
 * until the person's first words open the conversation; a schedule whose conversation is open goes straight to it.
 */

const T = SCHEDULE_COPY.changeConversation;
const OPENING: ScheduleChangeOpening = {
  scheduleId: 'sch-codex',
  title: 'Codex stable check',
  revision: 4,
  does: 'Every day at 09:00 Beijing time I check the latest stable Codex.',
  when: 'Every day at 09:00 · Asia/Shanghai',
  runsIn: 'apiserver · Codex agent',
  may: 'Open a PR · edits in its own worktree and opens a PR',
  costs: 'Up to 7 runs a week, 30 min each',
};

const calls: Array<{ path: string; method: string; body: unknown }> = [];
function serve(open: string | null, created = true) {
  apiMock.mockImplementation((async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ path, method, body: options.body });
    if (path === '/schedules/sch-codex/change' && method === 'GET') return { sessionId: open, opening: OPENING };
    if (path === '/schedules/sch-codex/change' && method === 'POST') return { sessionId: 'sess-change', created };
    throw new Error(`unserved ${method} ${path}`);
  }) as never);
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

function Where() {
  return <output data-where="">{useLocation().pathname}</output>;
}

let root: Root | null = null;
let host: HTMLElement;
async function open() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/scheduled/sch-codex/change']}>
          <Routes>
            <Route path="/scheduled/:id/change" element={<ScheduleChangePage />} />
            <Route path="*" element={null} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  calls.length = 0;
  apiMock.mockReset();
});

const where = () => host.querySelector('[data-where]')!.textContent;

describe('Change…', () => {
  it('opens with Orbit’s message and an empty composer, and writes nothing', async () => {
    serve(null);
    await open();
    expect(host.querySelector('h1')!.textContent).toBe('Change Codex stable check');
    const opening = host.querySelector('[data-schedule-change-opening]')!;
    expect(opening.textContent).toContain('What should change about Codex stable check? This is what it does now:');
    expect([...opening.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Does', 'When', 'Runs in', 'May', 'Costs']);
    expect(opening.textContent).toContain(T.tail);
    expect(host.querySelector('textarea')!.getAttribute('placeholder')).toBe('Say what to change…');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('goes straight to the schedule’s open change conversation', async () => {
    serve('sess-open');
    await open();
    expect(where()).toBe('/sessions/sess-open');
  });

  it('opens the conversation with the person’s first words and gives way to it', async () => {
    serve(null);
    await open();
    const box = host.querySelector('textarea')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, '改成工作日早上 8 点');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      path: '/schedules/sch-codex/change', method: 'POST', body: { text: '改成工作日早上 8 点' },
    });
    expect(where()).toBe('/sessions/sess-change');
  });
});
