// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONDITION_KEEPS_AWAKE_LINE } from '@orbit/shared';
import {
  CEPH_RUN,
  COMMAND_WIDEN_CARD,
  CONDITIONS,
  CONDITION_NOW,
  IDS,
  MON_CANT_READ_ITEM,
  OSD_STILL_WAITING_ITEM,
  SCHEDULES,
  TASK_CREATE_APPROVAL,
  WHEN_CREATE_CARD,
  WHEN_CREATE_CARD_REPEAT,
  conditionListAnswer,
  conditionScheduleDetail,
} from '../../ui-migration/condition-fixtures.mjs';

// Conditions on the web (docs/condition-triggers-design.md §9; board docs/mocks/condition-triggers/01-board.png
// frames 2 to 6), on the ui-migration fixtures the screenshots are taken from.

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
vi.mock('../lib/schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/schedules')>()),
  viewerTimezone: () => 'UTC',
}));
const { api } = await import('../api');
const { ScheduledPage } = await import('./ScheduledPage');
const { ScheduleCardView, ScheduleRunStrip } = await import('../components/ScheduleCards');
const { OwnerRequestCard } = await import('../components/OwnerRequestCard');
const { ApprovalPanel } = await import('../components/ApprovalPanel');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const calls: Array<{ path: string; method: string; body: unknown }> = [];

function serve() {
  apiMock.mockImplementation((async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ path, method, body: options.body });
    if (method !== 'GET') return {};
    if (path.startsWith('/schedules?') || path === '/schedules') return conditionListAnswer();
    if (path === '/schedules/drafts') return { drafts: [] };
    const detail = /^\/schedules\/([^/?]+)$/.exec(path);
    if (detail) return conditionScheduleDetail(decodeURIComponent(detail[1]!));
    const condition = /^\/conditions\/([^/?]+)$/.exec(path);
    if (condition) return CONDITIONS.find((c) => c.id === decodeURIComponent(condition[1]!));
    if (path === '/workspaces') return [];
    throw new Error(`unserved ${method} ${path}`);
  }) as never);
}

let root: Root | null = null;
let host: HTMLElement;

function Where() {
  const loc = useLocation();
  return <output data-where="">{loc.pathname + loc.search}</output>;
}

async function mount(element: JSX.Element, url = '/at') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path={url.startsWith('/scheduled') ? '/scheduled' : '/at'} element={element} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const group = (key: string) => host.querySelector<HTMLElement>(`.sched-group[data-group="${key}"]`)!;
const rows = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>('.sched-row')].map((r) => ({
  gauge: r.querySelector<HTMLElement>('.sched-gauge')?.dataset.gauge ?? null,
  title: text(r.querySelector('.sched-row-title')),
  line: text(r.querySelector('.sched-row-line')),
  tag: r.querySelector('.sched-tag')?.textContent ?? null,
  right: text(r.querySelector('.sched-row-time')),
}));
const block = (name: string) => host.querySelector<HTMLElement>(`[data-inspector-block="${name}"]`)!;
const click = async (el: Element) => {
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CONDITION_NOW));
  calls.length = 0;
  apiMock.mockReset();
  serve();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.useRealTimers();
});

describe('the Scheduled page: a group of its own for conditions (board ④)', () => {
  it('lists the WHEN schedules and the startWhen task above Today, each with its newest reading and its age', async () => {
    await mount(<ScheduledPage />, '/scheduled');
    const keys = [...host.querySelectorAll<HTMLElement>('.sched-group')].map((g) => g.dataset.group);
    expect(keys).toEqual(['CONDITION', 'TODAY', 'TOMORROW']);
    expect(text(group('CONDITION').querySelector('h2'))).toBe('Waiting for a condition4');
    expect(rows(group('CONDITION')).slice(1)).toEqual([
      { gauge: 'waiting', title: 'Ceph capacity guard', line: '↻When raw used above 90% · HPC', tag: null, right: '6.9% · 1 min ago' },
      { gauge: 'waiting', title: 'Gateway 5xx guard', line: '↻When 5xx rate above 2% · Orbit Cloud', tag: null, right: '3.4% · just now' },
      { gauge: 'waiting', title: 'Set kubernetes pool to 3 copies', line: 'Task · once, when 3 or more OSDs are in · HPC', tag: null, right: '2 in · 3 min ago' },
    ]);
    // The total counts the task beside the schedules.
    expect(text(host.querySelector('[data-schedule-total]'))).toBe('7');
  });

  it("leads Waiting for a condition with a condition that can't be read, with the gauge and Can't read", async () => {
    await mount(<ScheduledPage />, '/scheduled');
    expect(rows(group('CONDITION'))[0]).toEqual(
      { gauge: 'cant-read', title: 'Mon disk guard', line: '↻When root disk below 5% · HPC', tag: "Can't read", right: '' },
    );
  });

  it('opens the task, not an inspector, from its row', async () => {
    await mount(<ScheduledPage />, '/scheduled');
    const task = [...group('CONDITION').querySelectorAll('.sched-row')].find((r) => r.textContent!.includes('kubernetes'))!;
    await click(task);
    expect(text(host.querySelector('[data-where]'))).toBe(`/tasks/${IDS.osdTask}`);
  });
});

describe("the inspector's Condition and How it checks blocks, and the history (board ⑥)", () => {
  it('shows the reading, its age, the firing and re-arm lines, then the interval, runner, command and approval', async () => {
    await mount(<ScheduledPage />, `/scheduled?id=${IDS.ceph}`);
    const condition = block('condition');
    expect(text(condition.querySelector('.cond-reading'))).toBe('6.9%checked 1 min ago');
    expect(text(condition.querySelector('[data-condition-firing]'))).toBe('Fires above 90% for 10 min. Ready again below 85%.');
    expect(condition.querySelector('[data-condition-repeat]')).toBeNull();
    expect(text(condition.querySelector('.cond-bar-labels'))).toBe('85%90%');
    expect(block('next').hidden).toBe(true);
    const checks = block('checks');
    expect(text(checks)).toBe(
      'Every 5 min on workstation-gpu, without a model.ceph df -f json | jq .stats.total_used_raw_ratio'
      + 'Read-only. Approved by you on Nov 17.',
    );
    expect(checks.querySelector('[data-condition-awake]')).toBeNull();
  });

  it('draws Fired with the run it started and Ready again, and the run only once', async () => {
    await mount(<ScheduledPage />, `/scheduled?id=${IDS.ceph}`);
    const lines = [...block('history').querySelectorAll<HTMLElement>('.sched-history-row')].map((r) => ({
      kind: r.dataset.history,
      what: text(r.querySelector('.sched-history-what')),
      who: text(r.querySelector('.sched-who')),
    }));
    expect(lines.map((l) => l.kind)).toEqual(['condition', 'condition', 'revision']);
    expect(lines[0]).toEqual({ kind: 'condition', what: 'Ready again · 82.9%', who: 'Condition' });
    expect(lines[1]).toEqual({ kind: 'condition', what: 'Fired · 90.4% for 10 min · Run of Nov 21', who: 'Run' });
    expect(lines[2]!.who).toBe('You');
    await click([...block('history').querySelectorAll('button')].find((b) => b.textContent === 'Run of Nov 21')!);
    expect(text(host.querySelector('[data-where]'))).toContain(`/sessions/${CEPH_RUN.sessionId}`);
  });

  it('says a repeat in words, Fired again in the history, and keeps a cloud workspace awake', async () => {
    await mount(<ScheduledPage />, `/scheduled?id=${IDS.gateway}`);
    expect(text(block('condition').querySelector('[data-condition-repeat]'))).toBe('And again every 2 hours while it stays that way.');
    expect(text(block('checks').querySelector('[data-condition-awake]'))).toBe(CONDITION_KEEPS_AWAKE_LINE);
    const whats = [...block('history').querySelectorAll('.sched-history-what')].map(text);
    expect(whats.slice(0, 2)).toEqual(['Fired again · 3.1% for 5 min · Run of Nov 22', 'Fired · 2.6% for 5 min · Run of Nov 22']);
  });

  it('keeps the timed inspector as it was for a timed schedule', async () => {
    await mount(<ScheduledPage />, `/scheduled?id=${IDS.notes}`);
    expect(block('next').hidden).toBe(false);
    expect(host.querySelector('[data-inspector-block="condition"]')).toBeNull();
  });
});

describe('the cards (board ② ③) and the widen card for a changed command', () => {
  it("draws the schedule create card's When lines and the command", async () => {
    await mount(<ScheduleCardView card={WHEN_CREATE_CARD as never} />);
    const when = host.querySelector<HTMLElement>('[data-fact="when"]')!;
    expect(when.querySelector('b')!.textContent).toBe('Raw used above 90%');
    expect(text(when)).toBe(
      'Raw used above 90% for 10 minFires again only after it drops below 85%. Checked every 5 min on '
      + 'workstation-gpu, no model.ceph df -f json | jq .stats.total_used_raw_ratio',
    );
    expect(text(host.querySelector('[data-fact="today"]'))).toBe('6.9%. Nothing to report.');
    expect(host.querySelector('.sched-card-head svg')).not.toBeNull();
  });

  it('adds the repeat and keeps-awake lines when the card has them', async () => {
    await mount(<ScheduleCardView card={WHEN_CREATE_CARD_REPEAT as never} />);
    expect(text(host.querySelector('[data-when-repeat]'))).toBe('And again every 2 hours while it stays that way.');
    expect(text(host.querySelector('[data-when-awake]'))).toBe(CONDITION_KEEPS_AWAKE_LINE);
  });

  it('shows both commands verbatim on the widen card, with Keep the approved command', async () => {
    await mount(<ScheduleCardView card={COMMAND_WIDEN_CARD as never} />);
    expect(text(host.querySelector('.sched-card-head'))).toBe('Let Ceph capacity guard check with a new command?');
    expect(text(host.querySelector('[data-fact="now"] code'))).toBe('ceph df -f json | jq .stats.total_used_raw_ratio');
    expect(text(host.querySelector('[data-fact="asked"] code'))).toBe("ceph df -f json | jq '.stats.total_used_raw_ratio * 100'");
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Keep the approved command', 'Allow']);
  });

  it("draws the task create card's Starts when, Today and If never", async () => {
    await mount(<ApprovalPanel approval={TASK_CREATE_APPROVAL as never} onDecide={() => undefined} />);
    expect(text(host.querySelector('.approval-head'))).toBe('📝 Confirm: create 1 task that starts on a condition?');
    const facts = host.querySelector<HTMLElement>('[data-start-when-facts]')!;
    expect([...facts.querySelectorAll('dt')].map(text)).toEqual(['Starts when', 'Today', 'If never']);
    expect(text(facts.querySelector('[data-fact="starts-when"]'))).toBe(
      '3 or more OSDs are inOnce. Checked every 5 min on workstation-gpu, no model.ceph osd stat -f json | jq .num_in_osds',
    );
    expect(text(facts.querySelector('[data-fact="today"]'))).toBe('2 in. Not yet.');
    expect(text(facts.querySelector('[data-fact="if-never"]'))).toBe('Asks you after 30 days of waiting');
  });
});

describe('a run its condition started names the firing (board ⑤)', () => {
  it('says when it fired, the reading and its hold, and the access', async () => {
    const detail = conditionScheduleDetail(IDS.ceph);
    await mount(<ScheduleRunStrip of={{ schedule: SCHEDULES.ceph as never, run: CEPH_RUN as never, detail: detail as never }} />);
    expect(text(host.querySelector('[data-schedule-strip="condition"]'))).toBe('Fired 03:12 · 90.4% for 10 min · Check only');
  });
});

describe('Waiting on you: the can\'t-read card and the 30-day question (board ⑥)', () => {
  it("draws the can't-read card in the server's words, with Pause and Look into it", async () => {
    await mount(<OwnerRequestCard request={MON_CANT_READ_ITEM as never} now={Date.parse(CONDITION_NOW)} />);
    expect(text(host.querySelector('.owner-request-title'))).toBe("Can't read: Root disk below 5%");
    expect(text(host.querySelector('.owner-request-kind'))).toBe('Condition');
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Pause', 'Look into it']);
    await click(buttons[1]!);
    expect(text(host.querySelector('[data-where]'))).toBe(`/scheduled?id=${IDS.mon}`);
  });

  it('pauses the schedule and settles the item on Pause', async () => {
    await mount(<OwnerRequestCard request={MON_CANT_READ_ITEM as never} now={Date.parse(CONDITION_NOW)} />);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Pause')!);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/schedules/${IDS.mon}/pause`,
      `/owner-requests/${IDS.monItem}/done`,
    ]);
  });

  it('answers the 30-day question with Keep waiting or Stop', async () => {
    await mount(<OwnerRequestCard request={OSD_STILL_WAITING_ITEM as never} now={Date.parse(CONDITION_NOW)} />);
    expect(text(host.querySelector('.owner-request-title'))).toBe('Still waiting for 3 or more OSDs are in. Keep waiting?');
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Keep waiting', 'Stop']);
    await click(buttons[1]!);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { path: `/owner-requests/${IDS.osdItem}/done`, method: 'POST', body: { option: 1 } },
    ]);
  });
});

describe('the gauge bar', () => {
  it('scales a small percentage so its lines can be read, and a large one to 0..100', async () => {
    const { conditionGauge } = await import('../lib/conditions');
    expect(conditionGauge({ compare: { op: 'GT', value: 2 }, rearm: { op: 'LT', value: 1 }, unit: '%', lastValue: 3.4 }))
      .toEqual({ value: 3.4 / 4.25, fire: 2 / 4.25, rearm: 1 / 4.25 });
    expect(conditionGauge({ compare: { op: 'GT', value: 90 }, rearm: { op: 'LT', value: 85 }, unit: '%', lastValue: 6.9 }))
      .toEqual({ value: 0.069, fire: 0.9, rearm: 0.85 });
    expect(conditionGauge({ compare: { op: 'EXIT_ZERO', value: null }, rearm: null, unit: null, lastValue: 0 })).toBeNull();
  });
});
