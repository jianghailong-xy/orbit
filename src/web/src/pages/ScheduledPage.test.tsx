// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_COPY, scheduleFill } from '@orbit/shared';
import {
  DRAFT_CARD,
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
    if (path.startsWith('/owner-requests')) return { requests: [] };
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

const groups = () => [...host.querySelectorAll<HTMLElement>('.sched-group')];
const group = (key: string, title?: string) =>
  groups().find((g) => g.dataset.group === key && (!title || g.querySelector('h2')!.textContent!.startsWith(title)))!;
const rows = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>('.sched-row')];
const row = (g: HTMLElement, title: string) =>
  rows(g).find((r) => r.querySelector('.sched-row-title')!.textContent === title)!;
const describeRow = (r: HTMLElement) => ({
  circle: r.querySelector<HTMLElement>('.sched-circle')!.dataset.circle,
  title: r.querySelector('.sched-row-title')!.textContent,
  line: r.querySelector('.sched-row-line')!.textContent,
  tag: r.querySelector('.sched-tag')?.textContent ?? null,
  time: r.querySelector('.sched-row-time')!.textContent,
});
const click = async (el: Element) => {
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
const inspector = () => host.querySelector<HTMLElement>('.sched-inspector')!;
const block = (name: string) => inspector().querySelector<HTMLElement>(`[data-inspector-block="${name}"]`)!;

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

describe('the Scheduled page: a timeline by date (board 1/2 ①)', () => {
  it('loads its 9 schedules with one schedules read, and reads a detail only when a row is opened', async () => {
    serve();
    await open();
    expect(LIST_ROWS).toHaveLength(9);
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/schedules')).map((c) => c.path);
    expect(reads().filter((p) => p !== '/schedules/drafts')).toEqual(['/schedules']);
    // The past runs and findings the timeline draws came with that one read.
    await click(host.querySelector('.sched-past-toggle [role="switch"]')!);
    expect(rows(group('TODAY')).filter((r) => r.classList.contains('is-past'))).toHaveLength(3);
    expect(reads().filter((p) => p !== '/schedules/drafts')).toEqual(['/schedules']);
    await click(row(group('TOMORROW'), 'Codex stable check'));
    expect(reads().filter((p) => p !== '/schedules/drafts')).toEqual(['/schedules', '/schedules/sch-codex']);
  });

  it('has the title, the total and the tools', async () => {
    serve();
    await open();
    expect(host.querySelector('.sched-head h1')!.textContent).toBe('Scheduled');
    expect(host.querySelector('[data-schedule-total]')!.textContent).toBe(String(LIST_ROWS.length));
    expect(host.querySelector('[data-schedule-filter]')!.textContent).toBe('All workspaces ▾');
    expect(host.querySelector('.sched-past-toggle')!.textContent).toBe('Show past runs');
  });

  it('groups Today, Tomorrow, the days of the week, then Paused, in the viewer’s zone: no group of errors', async () => {
    serve();
    await open();
    expect(SCHEDULE_TZ).toBe('Asia/Shanghai');
    expect(groups().map((g) => g.querySelector('h2')!.textContent)).toEqual([
      'TodayFri, Nov 14', 'TomorrowSat, Nov 15', 'MondayNov 17', 'Paused2',
    ]);
  });

  it('tags a failing schedule on its own row, on the day of its next run, and lists a held one under Paused', async () => {
    serve();
    await open();
    expect(describeRow(row(group('TOMORROW'), 'Nightly pg spec sweep'))).toEqual({
      circle: 'failed', title: 'Nightly pg spec sweep', line: '↻Every day at 02:00 · apiserver · Check only', tag: 'Failed 3 in a row', time: '02:00',
    });
    expect(rows(group('PAUSED')).map(describeRow)).toEqual([
      { circle: 'held', title: 'Weekly dependency audit', line: '↻Every Monday at 09:00 · web · the agent "auditor" is disabled', tag: 'Held', time: '' },
      { circle: 'paused', title: 'Gateway CSP report digest', line: '↻Every day at 08:00 · web · paused Nov 7', tag: null, time: '' },
    ]);
  });

  it('drops the Failed tag while a run of the schedule is under way (Run now, owner 2026-11-19)', async () => {
    const list = listAnswer();
    const pg = LIST_ROWS.find((s) => s.title === 'Nightly pg spec sweep')!;
    const retry = {
      id: 'run-pg-retry', scheduleId: pg.id, scheduleRevision: pg.revision, plannedAt: '2025-11-14T04:27:00.000Z',
      trigger: 'MANUAL' as const, state: 'RUNNING' as const, attempt: 1, startedAt: '2025-11-14T04:27:00.000Z', endedAt: null,
      sessionId: null, key: null, summary: null, links: [], failureReason: null, heldReason: null, newFinding: false, notified: false,
    };
    serve({ list: { ...list, runs: [...(list.runs ?? []), retry] } });
    await open();
    const retryRow = rows(group('TODAY')).find((r) => r.querySelector('.sched-row-title')!.textContent === 'Nightly pg spec sweep')!;
    expect(describeRow(retryRow)).toMatchObject({ circle: 'running', tag: null, time: '12:27' });
    expect(describeRow(row(group('TOMORROW'), 'Nightly pg spec sweep'))).toMatchObject({ circle: 'open', tag: null, time: '02:00' });
  });

  it('says “its agent” for a hold whose view names no agent', async () => {
    serve({ schedules: LIST_ROWS.map((s) => (s.id === 'sch-audit' ? { ...s, agentName: null } : s)) });
    await open();
    expect(describeRow(row(group('PAUSED'), 'Weekly dependency audit')).line)
      .toBe('↻Every Monday at 09:00 · web · its agent is disabled');
  });

  it('puts one-off and repeating schedules in the same column, by time', async () => {
    serve();
    await open();
    expect(rows(group('TODAY')).map(describeRow)).toEqual([
      { circle: 'running', title: 'Docs link check', line: '↻Every day at 12:00 · web · Check only · running for 21 min', tag: null, time: '12:00' },
      { circle: 'open', title: 'Release notes draft', line: '↻Every Friday at 17:00 · Orbit baseline · Open a PR', tag: null, time: '17:00' },
      { circle: 'open', title: 'Deploy health check', line: 'Once · apiserver · Check only', tag: null, time: '18:00' },
    ]);
    expect(rows(group('TOMORROW')).map((r) => [describeRow(r).title, describeRow(r).time])).toEqual([
      ['Nightly pg spec sweep', '02:00'], ['Codex stable check', '09:00'], ['Claude CLI version check', '10:30'], ['Docs link check', '12:00'],
    ]);
  });

  it('draws a draft dashed on the day of its first run, and a paused schedule faint with when it paused', async () => {
    serve();
    await open();
    const monday = group('DAY', 'Monday');
    expect(describeRow(row(monday, 'Weekday issue summary'))).toEqual({
      circle: 'draft', title: 'Weekday issue summary',
      line: '↻Weekdays at 09:00 · apiserver · Check only · draft, waiting for you', tag: null, time: '09:00',
    });
    expect(row(monday, 'Weekday issue summary').classList).toContain('is-draft');
    expect(describeRow(row(group('PAUSED'), 'Gateway CSP report digest'))).toEqual({
      circle: 'paused', title: 'Gateway CSP report digest', line: '↻Every day at 08:00 · web · paused Nov 7', tag: null, time: '',
    });
  });

  it('filters by workspace through the list door', async () => {
    serve();
    await open('/scheduled?workspace=ws-web');
    expect(calls.some((c) => c.path === '/schedules?workspaceId=ws-web')).toBe(true);
    expect(host.querySelector('[data-schedule-filter]')!.textContent).toBe('web ▾');
  });
});

describe('Show past runs (board 1/2 ②)', () => {
  it('is off by default, and on adds today’s ended runs with their circles', async () => {
    serve();
    await open();
    const past = () => rows(group('TODAY')).filter((r) => r.classList.contains('is-past')).map(describeRow);
    expect(past()).toEqual([]);
    await click(host.querySelector('.sched-past-toggle [role="switch"]')!);
    expect(past()).toEqual([
      { circle: 'failed', title: 'Nightly pg spec sweep', line: 'Ended without a report', tag: 'Failed', time: '02:00' },
      { circle: 'done', title: 'Codex stable check', line: 'Known 0.49.0, linked PR #831 · not notified', tag: 'Known', time: '10:00' },
      { circle: 'new', title: 'Claude CLI version check', line: '2.1.310 is out · you were notified', tag: 'New', time: '10:30' },
    ]);
  });

  it('a reported failure’s line says what the run reported', async () => {
    const answer = listAnswer();
    serve({
      list: {
        ...answer,
        runs: answer.runs.map((r) => (r.id === 'run-pg-nov14'
          ? { ...r, failureReason: 'REPORTED_FAILED', summary: 'psql could not reach 127.0.0.1:55490.' }
          : r)),
      },
    });
    await open();
    await click(host.querySelector('.sched-past-toggle [role="switch"]')!);
    expect(describeRow(rows(group('TODAY')).find((r) => r.classList.contains('is-past'))!)).toEqual({
      circle: 'failed', title: 'Nightly pg spec sweep', line: 'Reported a failure: psql could not reach 127.0.0.1:55490', tag: 'Failed', time: '02:00',
    });
  });
});

describe('the line at the end of the list (board 1/2 ③)', () => {
  it('sends one sentence to the chosen workspace and draws a draft row at once', async () => {
    serve();
    await open();
    const input = host.querySelector<HTMLInputElement>('.sched-add-input')!;
    expect(input.placeholder).toBe('Describe a scheduled task…');
    expect(host.querySelector('[data-schedule-add-workspace]')!.textContent).toBe('apiserver ▾');
    const sentence = 'every weekday at 9, summarise new GitHub issues in orbit and tell me only if there are any';
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, sentence);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('.sched-add-hint')!.textContent).toBe('↵ to ask');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      path: '/schedules/drafts', method: 'POST', body: { workspaceId: 'ws-apiserver', text: sentence },
    });
    const draft = [...host.querySelectorAll<HTMLElement>('.sched-row')].find((r) => r.dataset.row === 'pending:sess-new')!;
    expect(describeRow(draft)).toMatchObject({ circle: 'draft', title: sentence, line: 'apiserver · draft, waiting for you' });
    expect(inspector().dataset.scheduleInspector).toBe('pending');
    expect(button(inspector(), 'Open conversation')).toBeTruthy();
    expect(input.value).toBe('');
  });
});

describe('the inspector (board 1/2 ②)', () => {
  async function openCodex() {
    serve();
    await open();
    await click(row(group('TOMORROW'), 'Codex stable check'));
    expect(row(group('TOMORROW'), 'Codex stable check').classList).toContain('is-selected');
  }

  it('opens beside the list, with the rule, next run and last result', async () => {
    await openCodex();
    expect(inspector().querySelector('.sched-inspector-title')!.textContent).toBe('Codex stable check');
    expect(inspector().querySelector('.sched-inspector-meta')!.textContent)
      .toBe('↻Every day at 09:00 · Asia/Shanghai · apiserver · Open a PR');
    expect(block('next').textContent).toBe('Next runTomorrow 09:00Last · Today 10:00 · Known 0.49.0, linked PR #831 · not notified');
  });

  it('widens by dragging its left edge, within the list’s room, and keeps the width in this browser', async () => {
    await openCodex();
    const page = document.querySelector<HTMLElement>('.sched-page')!;
    const handle = document.querySelector<HTMLElement>('[data-schedule-resizer]')!;
    expect(handle.nextElementSibling).toBe(inspector());
    expect(page.style.getPropertyValue('--sched-inspector-width')).toBe('');
    vi.spyOn(inspector(), 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);
    vi.spyOn(handle.previousElementSibling!, 'getBoundingClientRect').mockReturnValue({ width: 700 } as DOMRect);
    const mouse = (type: string, clientX: number) =>
      act(() => { (type === 'mousedown' ? handle : document).dispatchEvent(new MouseEvent(type, { bubbles: true, clientX })); });
    mouse('mousedown', 1000);
    mouse('mousemove', 850);
    expect(page.style.getPropertyValue('--sched-inspector-width')).toBe('550px');
    mouse('mousemove', 0);
    expect(page.style.getPropertyValue('--sched-inspector-width')).toBe('740px');
    mouse('mouseup', 0);
    expect(localStorage.getItem('orbit.scheduleInspectorWidth')).toBe('740');
  });

  it('has Run now, Pause, Change… and ⋯', async () => {
    await openCodex();
    expect([...block('doors').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Run now', 'Pause', 'Change…', '⋯']);
    await click(button(block('doors'), 'Run now'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/schedules/sch-codex/run')).toBe(true);
    await click(button(block('doors'), 'Pause'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/schedules/sch-codex/pause')).toBe(true);
  });

  it('shows a refused Run now in the server’s words', async () => {
    await openCodex();
    const served = apiMock.getMockImplementation()!;
    apiMock.mockImplementation((async (path: string, options: { method?: string } = {}) => {
      if (options.method === 'POST' && path.endsWith('/run')) {
        throw new ApiError('Over what you allowed this week.', 409, 'SCHEDULE_OVER_BUDGET', { message: 'This week already had 7 runs, all it is allowed.' });
      }
      return served(path, options as never);
    }) as never);
    await click(button(block('doors'), 'Run now'));
    expect(inspector().querySelector('[role="alert"]')!.textContent).toBe('This week already had 7 runs, all it is allowed.');
  });

  it('Change… opens the schedule’s change conversation, not a form (§8.2)', async () => {
    await openCodex();
    await click(button(block('doors'), 'Change…'));
    expect(host.querySelector('[data-where]')!.textContent).toMatch(/^\/scheduled\/[^/]+\/change$/);
    expect(document.querySelector('form')).toBeNull();
  });

  it('reads back What it does, What was asked and the notes for the next run', async () => {
    await openCodex();
    const sections = [...inspector().querySelectorAll('.sched-section')].map((s) => s.textContent);
    expect(sections).toEqual(['What it does', 'What was asked', 'Notes for the next run', 'This month', 'History']);
    expect(block('does').textContent).toBe(scheduleDetail('sch-codex').readBack);
    expect(block('asked').textContent).toBe(`${scheduleDetail('sch-codex').schedule.intent}Your words in Codex release watch, Nov 3`);
    expect(block('note').textContent).toBe('Release notes moved to github.com/openai/codex/releases. The old changelog URL is 404.Left by the run of Nov 14');
    expect(block('month').textContent).toBe('14 runs · 41 minAllowed: up to 7 runs a week, 30 min each');
  });

  it('lists runs and revisions together, newest first, with who and Undo', async () => {
    await openCodex();
    const history = [...block('history').querySelectorAll<HTMLElement>('.sched-history-row')].map((r) => ({
      kind: r.dataset.history,
      when: r.querySelector('.sched-history-when')!.textContent,
      what: r.querySelector('.sched-history-what')!.textContent,
      who: r.querySelector('.sched-who')?.textContent ?? null,
      undo: [...r.querySelectorAll('button')].some((b) => b.textContent === 'Undo'),
    }));
    expect(history).toEqual([
      { kind: 'revision', when: 'Today 12:19', what: 'Time 10:00 → 09:00', who: 'Session', undo: true },
      { kind: 'revision', when: 'Today 12:19', what: 'Access → Open a PR', who: 'You allowed', undo: false },
      { kind: 'run', when: 'Today 10:00', what: 'Known 0.49.0 · session', who: null, undo: false },
      { kind: 'run', when: 'Nov 13 10:01', what: 'New 0.49.0 · session', who: null, undo: false },
      { kind: 'revision', when: 'Nov 12 13:50', what: 'Prompt: check the releases page, not the changelog', who: 'Run', undo: true },
      { kind: 'run', when: 'Nov 12 13:47', what: 'No change · late · session', who: null, undo: false },
      { kind: 'revision', when: 'Nov 3 10:12', what: 'Created · Check only · up to 7 runs a week', who: 'You', undo: false },
    ]);
    await click(button(block('history'), 'Undo'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/schedules/sch-codex/undo')!.body).toEqual({ revision: 4 });
  });

  it('opens a run’s session from its history row, naming the schedule and run', async () => {
    await openCodex();
    const nov13 = [...block('history').querySelectorAll<HTMLElement>('.sched-history-row')][3]!;
    await click(button(nov13, 'session'));
    expect(host.querySelector('[data-where]')!.textContent).toBe('/sessions/sess-codex-run-nov13');
  });

  async function chooseDelete() {
    await click(button(block('doors'), '⋯'));
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent === 'Delete')!;
    await click(remove);
  }
  const deletes = () => calls.filter((c) => c.method === 'DELETE');
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');

  it('asks before deleting from ⋯: the dialog names the schedule and says what is lost, and sends nothing', async () => {
    await openCodex();
    await chooseDelete();
    expect(deletes()).toEqual([]);
    const shown = dialog()!;
    expect(shown.textContent).toContain(scheduleFill(SCHEDULE_COPY.deleteConfirm.title, { title: 'Codex stable check' }));
    expect(shown.textContent).toContain(SCHEDULE_COPY.deleteConfirm.body);
    expect([...shown.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel', 'Delete']);
    // The menu closed first: the dialog is not inside a popover.
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('Cancel deletes nothing', async () => {
    await openCodex();
    await chooseDelete();
    await click(button(dialog()!, 'Cancel'));
    expect(dialog()).toBeNull();
    expect(deletes()).toEqual([]);
  });

  it('Delete in the dialog sends exactly one DELETE', async () => {
    await openCodex();
    await chooseDelete();
    await click(button(dialog()!, 'Delete'));
    expect(deletes()).toEqual([{ path: '/schedules/sch-codex', method: 'DELETE', body: undefined }]);
    expect(dialog()).toBeNull();
  });
});

describe('a draft’s inspector (board 1/2 ④)', () => {
  it('is the create card with Open conversation', async () => {
    serve();
    await open();
    await click(row(group('DAY', 'Monday'), 'Weekday issue summary'));
    const panel = inspector();
    expect(panel.dataset.scheduleInspector).toBe('draft');
    expect(panel.querySelector('.sched-inspector-meta')!.textContent).toBe('Draft · set up by the agent in apiserver from what you typed');
    const card = panel.querySelector<HTMLElement>('[data-schedule-card="create"]')!;
    expect(card.querySelector('.sched-card-head')!.textContent).toBe('Create scheduled task?');
    expect([...card.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['When', 'Runs in', 'May', 'Costs', 'Today']);
    expect([...card.querySelectorAll('dd')].map((d) => d.textContent)).toEqual([
      'Weekdays at 09:00 · Asia/ShanghaiFirst run Monday',
      'apiserver · Claude agent',
      'Check only · reads and reports, edits nothing',
      'Up to 5 runs a week, 30 min each',
      '12 issues are open now. The first run reports what comes after.',
    ]);
    expect([...card.querySelectorAll('.sched-card-foot button')].map((b) => b.textContent)).toEqual(['Open conversation', 'Not now', 'Create']);
    await click(button(card, 'Create'));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/schedule-requests/req-weekday/allow' });
    await click(button(card, 'Open conversation'));
    expect(host.querySelector('[data-where]')!.textContent).toBe('/sessions/sess-weekday-issues');
  });
});

describe('the empty page (board 1/2 ⑤)', () => {
  it('has only the line and three examples; an example fills the line', async () => {
    serve({ schedules: [], drafts: [] });
    await open();
    expect(host.querySelector('[data-schedule-total]')!.textContent).toBe('0');
    expect(host.querySelector('.sched-lead')!.textContent)
      .toBe('Nothing scheduled. Say what should happen and when; an agent sets it up and asks you once.');
    expect(groups()).toEqual([]);
    const examples = [...host.querySelectorAll<HTMLButtonElement>('[data-schedule-examples] button')];
    expect(examples.map((b) => b.textContent)).toEqual([
      'Every day at 10:00, check the Codex stable release against our pinned version',
      'Every Monday at 9, list dependencies with known vulnerabilities',
      'At 18:00 today, check that the deploy is healthy and tell me',
    ]);
    await click(examples[2]!);
    expect(host.querySelector<HTMLInputElement>('.sched-add-input')!.value).toBe('At 18:00 today, check that the deploy is healthy and tell me');
    expect(document.querySelector('form')).toBeNull();
  });
});

describe('the keyboard', () => {
  const press = async (key: string, target: EventTarget = document.body) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    await flush();
  };
  // A run's row, a missed run's and a waiting task's never show as selected, so the cursor steps over them.
  const all = () => [...host.querySelectorAll<HTMLElement>('.sched-row')]
    .filter((r) => !/^(run|missed|CONDITION:task):/.test(r.dataset.row!));
  beforeEach(() => { Element.prototype.scrollIntoView = () => {}; });
  const selectedTitle = () => host.querySelector('.sched-row.is-selected .sched-row-title')?.textContent ?? null;

  it('Down and Up move the selection through the rows as drawn, open its inspector, and stop at the ends', async () => {
    serve();
    await open();
    const titles = all().map((r) => r.querySelector('.sched-row-title')!.textContent);
    expect(host.querySelector('.sched-row[data-row^="run:"]')).not.toBeNull();
    await press('ArrowDown');
    expect(selectedTitle()).toBe(titles[0]);
    expect(document.activeElement).toBe(all()[0]);
    await press('ArrowDown');
    expect(selectedTitle()).toBe(titles[1]);
    expect(inspector().querySelector('.sched-inspector-title')!.textContent).toBe(titles[1]);
    await press('ArrowUp');
    expect(selectedTitle()).toBe(titles[0]);
    await press('ArrowUp');
    expect(selectedTitle()).toBe(titles[0]);
    for (let i = 0; i < titles.length + 2; i += 1) await press('ArrowDown');
    expect(selectedTitle()).toBe(titles[titles.length - 1]);
  });

  it('leaves the keys alone while typing in the line at the end', async () => {
    serve();
    await open();
    const input = host.querySelector<HTMLElement>('input, textarea')!;
    await press('ArrowDown', input);
    expect(selectedTitle()).toBeNull();
  });
});
