// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIST_ROWS,
  PSQL_APPROVAL,
  RUN_WIDEN_CARD,
  SCHEDULE_NOW,
  WAITING_ITEMS,
  WS,
  listAnswer,
  scheduleDetail,
} from '../test/scheduleFixtures';

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
vi.mock('../lib/schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/schedules')>()),
  viewerTimezone: () => 'Asia/Shanghai',
}));
const { api } = await import('../api');
const { ScheduledPage } = await import('../pages/ScheduledPage');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const calls: Array<{ path: string; method: string; body: unknown }> = [];

function serve(detailOf: (id: string) => ReturnType<typeof scheduleDetail> = scheduleDetail) {
  apiMock.mockImplementation((async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ path, method, body: options.body });
    if (method !== 'GET') return {};
    if (path === '/owner-requests?state=open') return { requests: WAITING_ITEMS };
    if (path.startsWith('/owner-requests')) return { requests: [] };
    if (path.startsWith('/schedules?') || path === '/schedules') return listAnswer(LIST_ROWS);
    if (path === '/schedules/drafts') return { drafts: [] };
    if (path === '/workspaces') return [WS.apiserver, WS.web, WS.baseline];
    if (path === '/sessions/sess-pg-run-nov14/approvals?status=PENDING') return [PSQL_APPROVAL];
    if (path === `/schedule-requests/${RUN_WIDEN_CARD.id}`) return RUN_WIDEN_CARD;
    const detail = /^\/schedules\/([^/?]+)$/.exec(path);
    if (detail) return detailOf(detail[1]!);
    return [];
  }) as never);
}

let root: Root | null = null;
let host: HTMLElement;

function Where() {
  const loc = useLocation();
  return <output data-where="">{loc.pathname + loc.search}</output>;
}

async function open() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/scheduled']}>
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

const card = (kind: string) => host.querySelector<HTMLElement>(`.owner-request-card[data-kind="${kind}"]`)!;
const read = (el: HTMLElement) => ({
  title: el.querySelector('.owner-request-title')!.textContent,
  kind: el.querySelector('.owner-request-kind')!.textContent,
  why: el.querySelector('.owner-request-why')!.textContent,
  doors: [...el.querySelectorAll('.owner-request-actions button')].map((b) => b.textContent),
});
const press = async (el: HTMLElement, label: string) => {
  const target = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
  await act(async () => { target.click(); });
  await flush();
};

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

// There is no Waiting on you page (docs/mocks/waiting-on-you-removal, owner ruling 2026-11-16): a scheduled task's
// cards are drawn on the Scheduled page, above its timeline, and in the run's session where they were filed.
describe('Scheduled: a scheduled task’s four kinds of card (board 2/2 ④)', () => {
  it('draws them whole, newest first, in the owner-request frame, above the timeline', async () => {
    serve();
    await open();
    const drawn = [...host.querySelectorAll<HTMLElement>('[data-schedule-waiting] .owner-request-card')].map((c) => c.dataset.kind);
    expect(drawn).toEqual(['SCHEDULE_FAILED', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN', 'SCHEDULE_HELD']);
    const list = host.querySelector('[data-schedule-waiting]')!;
    const firstGroup = host.querySelector('.sched-group')!;
    expect(list.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a failure: Open run and Pause schedule', async () => {
    serve();
    await open();
    expect(read(card('SCHEDULE_FAILED'))).toEqual({
      title: 'Nightly pg spec sweep failed 3 runs in a row',
      kind: 'Scheduled',
      why: 'The last run ended without a report (Nov 14, 02:00). It keeps running on schedule until you pause it. Open the run to see where it stopped, or ask a session to fix the prompt.',
      doors: ['Open run', 'Pause schedule'],
    });
    await press(card('SCHEDULE_FAILED'), 'Pause schedule');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/schedules/sch-pg/pause', '/owner-requests/or-failed/done']);
  });

  it('a reported failure says what the run reported', async () => {
    serve((id) => {
      const detail = scheduleDetail(id);
      if (id !== 'sch-pg') return detail;
      const run = { ...detail.recentRuns[0]!, failureReason: 'REPORTED_FAILED', summary: 'psql could not reach 127.0.0.1:55490.' };
      return { ...detail, lastRun: run, recentRuns: [run] };
    });
    await open();
    expect(read(card('SCHEDULE_FAILED')).why).toBe(
      'The last run reported a failure: psql could not reach 127.0.0.1:55490 (Nov 14, 02:00). It keeps running on schedule until you pause it. Open the run to see where it stopped, or ask a session to fix the prompt.',
    );
  });

  it('a failure’s Open run goes to the run’s session', async () => {
    serve();
    await open();
    await press(card('SCHEDULE_FAILED'), 'Open run');
    expect(host.querySelector('[data-where]')!.textContent).toBe('/sessions/sess-pg-run-nov14');
  });

  it('a hold: why, and Open agent settings and Resume', async () => {
    serve();
    await open();
    expect(read(card('SCHEDULE_HELD'))).toEqual({
      title: 'Weekly dependency audit is held',
      kind: 'Scheduled',
      why: 'It could not start on Monday 09:00: the agent "auditor" in workspace web is disabled. Nothing runs until it is enabled and you resume.',
      doors: ['Open agent settings', 'Resume'],
    });
    await press(card('SCHEDULE_HELD'), 'Resume');
    expect(calls.find((c) => c.method === 'POST')!.path).toBe('/schedules/sch-audit/resume');
  });

  it('a hold whose agent the view does not name says “its agent”', async () => {
    serve((id) => {
      const detail = scheduleDetail(id);
      return id === 'sch-audit' ? { ...detail, schedule: { ...detail.schedule, agentName: null } } : detail;
    });
    await open();
    expect(read(card('SCHEDULE_HELD')).why)
      .toBe('It could not start on Monday 09:00: its agent is disabled. Nothing runs until it is enabled and you resume.');
  });

  it('a run’s approval: the command, the deadline, and Always allow with what it covers', async () => {
    serve();
    await open();
    const approval = card('SCHEDULE_APPROVAL');
    expect(read(approval)).toEqual({
      title: 'Nightly pg spec sweep wants to run a command',
      kind: 'Scheduled run',
      why: 'psql -h 127.0.0.1 -p 55490 -c "select 1"If nobody answers by 04:03 this run fails; the next one starts tomorrow. '
        + "Always allow covers psql:* in apiserver: later runs won't ask for this.",
      doors: ['Always allow', 'Allow once', 'Deny'],
    });
    await press(approval, 'Always allow');
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      path: '/sessions/sess-pg-run-nov14/approvals/appr-psql/decision',
      method: 'POST',
      body: { behavior: 'allow', rememberRules: [{ toolName: 'Bash', ruleContent: 'psql:*' }] },
    });
  });

  it('a run’s request for a wider envelope: Allow or Keep check only, through the schedule-request door', async () => {
    serve();
    await open();
    const widen = card('SCHEDULE_WIDEN');
    expect(read(widen)).toEqual({
      title: 'Let Codex stable check open PRs?',
      kind: 'Scheduled',
      why: "Codex 0.49.0 is out (pinned 0.48.0). Now: Check only. Asked: Open a PR · edits in its own worktree and opens a PR. It can't merge or deploy.",
      doors: ['Allow', 'Keep check only'],
    });
    await press(widen, 'Allow');
    expect(calls.find((c) => c.method === 'POST')!.path).toBe(`/schedule-requests/${RUN_WIDEN_CARD.id}/allow`);
    expect(calls.some((c) => c.path.startsWith('/owner-requests/or-widen'))).toBe(false);
  });
});
