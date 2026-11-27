// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_COPY, scheduleFill } from '@orbit/shared';
import {
  DRAFT_CARD,
  EVERY_ROWS,
  LIST_ROWS,
  SCHEDULE_NOW,
  SCHEDULE_TZ,
  WS,
  listAnswer,
  scheduleDetail,
} from '../test/scheduleFixtures';

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
vi.mock('../lib/schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/schedules')>()),
  viewerTimezone: () => 'Asia/Shanghai',
}));
const { api, ApiError } = await import('../api');
const { ScheduledPage } = await import('./ScheduledPage');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

interface Served {
  schedules?: typeof LIST_ROWS;
  drafts?: (typeof DRAFT_CARD)[];
  list?: ReturnType<typeof listAnswer>;
}
const calls: Array<{ path: string; method: string; body: unknown }> = [];

function serve({ schedules = LIST_ROWS, drafts = [DRAFT_CARD], list }: Served = {}) {
  apiMock.mockImplementation((async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ path, method, body: options.body });
    if (method === 'POST' && path === '/schedules/drafts') return { sessionId: 'sess-new', session: {} };
    if (method !== 'GET') return {};
    if (path.startsWith('/schedules?') || path === '/schedules') return list ?? listAnswer(schedules);
    if (path === '/schedules/drafts') return { drafts };
    const detail = /^\/schedules\/([^/?]+)$/.exec(path);
    if (detail) return scheduleDetail(decodeURIComponent(detail[1]!));
    if (path === '/workspaces') return [WS.apiserver, WS.web, WS.baseline];
    if (path === '/sessions/sess-codex-watch') return { id: 'sess-codex-watch', title: 'Codex release watch' };
    throw new Error(`unserved ${method} ${path}`);
  }) as never);
}

let root: Root | null = null;
let host: HTMLElement;

function Where() {
  const loc = useLocation();
  return <output data-where="">{loc.pathname}</output>;
}

async function open(url = '/scheduled') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/scheduled" element={<ScheduledPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}


const rows = () => [...host.querySelectorAll<HTMLElement>('.sched-row')];
const row = (title: string) => rows().find((r) => r.querySelector('.sched-row-title')!.textContent === title)!;
const line = (title: string) => rows()
  .filter((r) => r.querySelector('.sched-row-title')!.textContent === title)
  .map((r) => [...r.querySelectorAll('.sched-row-line')].map((l) => l.textContent!).join('\n'))
  .filter((text) => !text.includes('slots missed'))
  .join('\n');
const click = async (el: Element) => {
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};
const block = (name: string) => host.querySelector<HTMLElement>(`[data-inspector-block="${name}"]`)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SCHEDULE_NOW));
  localStorage.clear();
  calls.length = 0;
  apiMock.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.useRealTimers();
});

describe('the Scheduled page: EVERY rules, their planned end and missed slots', () => {
  it('writes the EVERY sentence and the end on a row: until 18:00 today, and runs left', async () => {
    serve({ schedules: EVERY_ROWS, drafts: [] });
    await open('/scheduled?past=1');
    expect(line('Queue depth sweep')).toContain('Every 30 min, 09:00–18:00, Mon–Fri');
    expect(line('Queue depth sweep')).toContain('until 18:00 today');
    expect(line('Canary burst watch')).toContain('Every hour');
    expect(line('Canary burst watch')).toContain('3 runs left');
  });

  it('says a later end by its date, and "1 run left" in the singular', async () => {
    const later = EVERY_ROWS.map((r) => r.id === 'sch-sweep'
      ? { ...r, endAt: new Date(Date.UTC(2025, 10, 25, 10)).toISOString() }
      : { ...r, runsLeft: 1 });
    serve({ schedules: later, drafts: [] });
    await open('/scheduled?past=1');
    expect(line('Queue depth sweep')).toContain('until Nov 25');
    expect(line('Canary burst watch')).toContain('1 run left');
  });

  it('collapses the consecutive missed slots into one row, and one line in the inspector', async () => {
    serve({ schedules: EVERY_ROWS, drafts: [] });
    await open('/scheduled?past=1');
    const missed = rows().filter((r) => r.querySelector('.sched-row-line')!.textContent!.includes('slots missed'));
    expect(missed).toHaveLength(1);
    expect(missed[0]!.querySelector('.sched-row-line')!.textContent).toBe('4 slots missed, 01:00–04:00');
    await click(row('Canary burst watch'));
    const history = [...host.querySelectorAll('[data-history="missed"]')];
    expect(history).toHaveLength(1);
    expect(history[0]!.textContent).toContain('4 slots missed, 01:00–04:00');
    expect(host.querySelectorAll('[data-history="run"]')).toHaveLength(0);
  });

  it('shows the end in the inspector with controls that open the composer to extend or remove it', async () => {
    serve({ schedules: EVERY_ROWS, drafts: [] });
    await open('/scheduled?past=1');
    await click(row('Queue depth sweep'));
    expect(block('end').textContent).toContain('until 18:00 today');
    const remove = [...block('end').querySelectorAll('button')].find((b) => b.textContent === 'Remove the end')!;
    const extend = [...block('end').querySelectorAll('button')].find((b) => b.textContent === 'Extend the end')!;
    expect(extend).toBeTruthy();
    await click(remove);
    expect(host.querySelector('[data-where]')!.textContent).toBe('/workspaces/ws-apiserver/new');
  });
});
