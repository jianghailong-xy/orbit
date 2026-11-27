// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUMP_MISSED_RUN,
  BUMP_QUEUED_RUN,
  BUMP_STARTED_RUN,
  BUMP_TRY_SESSIONS,
  bumpMissedStatus,
  bumpQueuedStatus,
  bumpStartedStatus,
  CODEX_NOV13_RUN,
  CODEX_TIME_RECORD,
  CREATE_CARD,
  FREEZE_ENDED_RECORD,
  FREEZE_RUN,
  MORE_OFTEN_CARD,
  OPEN_PRS_CARD,
  LAND_CARD,
  SCHEDULE_NOW,
  WEEKLY_RECORD,
  freezeDetail,
  scheduleDetail,
} from '../test/scheduleFixtures';

import { scheduleCreateNotice } from '@orbit/shared';

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
vi.mock('../lib/schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/schedules')>()),
  viewerTimezone: () => 'Asia/Shanghai',
}));
const { api, ApiError } = await import('../api');
const cards = await import('./ScheduleCards');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const calls: Array<{ path: string; method: string; body: unknown }> = [];

function serve(extra: (path: string, method: string) => unknown = () => undefined) {
  apiMock.mockImplementation((async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ path, method, body: options.body });
    const answered = extra(path, method);
    if (answered !== undefined) return answered;
    if (method !== 'GET') return {};
    if (path === '/schedules/sch-freeze') return freezeDetail();
    const detail = /^\/schedules\/([^/?]+)$/.exec(path);
    if (detail) return scheduleDetail(detail[1]!);
    throw new Error(`unserved ${method} ${path}`);
  }) as never);
}

let root: Root | null = null;
let host: HTMLElement;

function Where() {
  return <output data-where="">{useLocation().pathname + useLocation().search}</output>;
}

async function render(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/here']}>
          <Routes>
            <Route path="/here" element={node} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const click = async (el: Element) => {
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
const facts = (card: Element) =>
  Object.fromEntries([...card.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SCHEDULE_NOW));
  calls.length = 0;
  apiMock.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.useRealTimers();
});

describe('the create card in a conversation (board 2/2 ①)', () => {
  it('reads back the goal, then When, Runs in, May, Costs and Today', async () => {
    serve();
    await render(<cards.ScheduleCardView card={CREATE_CARD} />);
    const card = host.querySelector('[data-schedule-card="create"]')!;
    expect(card.querySelector('.sched-card-head')!.textContent).toBe('Create scheduled task?');
    expect(card.querySelector('.sched-card-title')!.textContent).toBe('Codex stable check');
    expect(card.querySelector('.sched-card-readback')!.textContent).toBe(CREATE_CARD.readBack);
    expect(facts(card)).toEqual({
      When: 'Daily 10:00 · Asia/Shanghai · first run tomorrow',
      'Runs in': 'apiserver · Codex agent',
      May: 'Check only · reads and reports, edits nothing',
      Costs: 'Up to 7 runs a week, 30 min each',
      Today: 'Codex 0.48.0, same as pinned. Nothing to report.',
    });
    expect(card.querySelector('[data-fact="may"] b')!.textContent).toBe('Check only');
    expect(card.querySelector('[data-fact="costs"] b')!.textContent).toBe('7 runs a week');
    expect(card.querySelector('.sched-card-note')!.textContent).toBe("You'll hear about new versions and failures only.");
    expect([...card.querySelectorAll('.sched-card-foot button')].map((b) => b.textContent)).toEqual(['Not now', 'Create']);
  });

  it('ends with the notice the server built from the proposal’s findings, else the generic line', async () => {
    serve();
    // The proposal said findings 'versions': the server's card carries scheduleCreateNotice('versions').
    await render(<cards.ScheduleCardView card={{ ...CREATE_CARD, notice: scheduleCreateNotice('versions') }} />);
    expect(host.querySelector('.sched-card-note')!.textContent).toBe("You'll hear about new versions and failures only.");
    act(() => root?.unmount());
    host.remove();
    // A proposal with no findings: the server sends the generic line; a card with no notice at all draws it too.
    for (const notice of [scheduleCreateNotice(null), '']) {
      await render(<cards.ScheduleCardView card={{ ...CREATE_CARD, notice }} />);
      expect(host.querySelector('.sched-card-note')!.textContent).toBe("You'll hear about new findings and failures only.");
      act(() => root?.unmount());
      host.remove();
    }
    root = null;
  });

  it('Create allows the card; Not now declines it', async () => {
    serve();
    await render(<cards.ScheduleCardView card={CREATE_CARD} />);
    await click(button('Create'));
    expect(calls.find((c) => c.method === 'POST')).toEqual({ path: '/schedule-requests/req-codex-create/allow', method: 'POST', body: {} });
    expect(host.querySelector('.sched-card-foot')).toBeNull();
  });

  it('sends the browser’s zone when the card names none', async () => {
    serve();
    await render(<cards.ScheduleCardView card={{ ...CREATE_CARD, when: { ...CREATE_CARD.when, timezone: null } }} />);
    await click(button('Create'));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ timezone: 'Asia/Shanghai' });
  });

  it('shows a withdrawn card in the server’s words and offers no retry', async () => {
    serve((path, method) => {
      if (method === 'POST') {
        throw new ApiError('stale', 409, 'SCHEDULE_REQUEST_STALE', {
          reason: 'REVISION_MOVED',
          message: 'The schedule changed after this was asked, so the card was withdrawn and nothing was applied.',
        });
      }
      return undefined;
    });
    await render(<cards.ScheduleCardView card={CREATE_CARD} />);
    await click(button('Create'));
    expect(host.querySelector('[role="alert"]')!.textContent)
      .toBe('The schedule changed after this was asked, so the card was withdrawn and nothing was applied.');
    expect(button('Create')).toBeUndefined();
  });
});

describe('the envelope card (board 2/2 ② ③)', () => {
  it('asks to run more often, with Now and Asked, Keep weekly and Allow', async () => {
    serve();
    await render(<cards.ScheduleCardView card={MORE_OFTEN_CARD} />);
    const card = host.querySelector('[data-schedule-card="envelope"]')!;
    expect(card.querySelector('.sched-card-head')!.textContent).toBe('Let Codex stable check run more often?');
    expect(facts(card)).toEqual({
      Now: 'Daily 09:00 · up to 1 run a week',
      Asked: 'Daily 10:00 · up to 7 runs a week, 30 min each',
    });
    expect(card.querySelector('[data-fact="asked"] b')!.textContent).toBe('Daily 10:00');
    expect(card.querySelector('.sched-card-note')!.textContent).toBe('Applies from the next run.');
    expect([...card.querySelectorAll('.sched-card-foot button')].map((b) => b.textContent)).toEqual(['Keep weekly', 'Allow']);
    await click(button('Keep weekly'));
    expect(calls.find((c) => c.method === 'POST')!.path).toBe('/schedule-requests/req-codex-daily/decline');
  });

  it('asks to land on main with the shared May copy', async () => {
    serve();
    await render(<cards.ScheduleCardView card={LAND_CARD} />);
    const card = host.querySelector('[data-schedule-card="envelope"]')!;
    expect(card.querySelector('.sched-card-head')!.textContent).toBe('Let Codex stable check land on main?');
    expect(facts(card).Asked).toBe("Edit and land on main — edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy.");
  });

  it('asks to open PRs, with Keep check only', async () => {
    serve();
    await render(<cards.ScheduleCardView card={OPEN_PRS_CARD} />);
    const card = host.querySelector('[data-schedule-card="envelope"]')!;
    expect(card.querySelector('.sched-card-head')!.textContent).toBe('Let Codex stable check open PRs?');
    expect(facts(card)).toEqual({
      Now: 'Check only — reads and reports',
      Asked: "Open a PR — edits in its own worktree and opens a PR. It can't merge or deploy.",
    });
    expect(card.querySelector('.sched-card-note')!.textContent)
      .toBe('Applies from the next run. Each run checks this again before it starts.');
    await click(button('Allow'));
    expect(calls.find((c) => c.method === 'POST')!.path).toBe('/schedule-requests/req-codex-pr/allow');
  });
});

describe('the change line (board 2/2 ② ③ ⑤)', () => {
  it('names the change with the title in bold, and has Undo and Open', async () => {
    serve();
    await render(<cards.ScheduleRecordLine record={CODEX_TIME_RECORD} />);
    const line = host.querySelector('[data-schedule-record]')!;
    expect(line.textContent).toBe('Changed Codex stable check: time 10:00 → 09:00UndoOpen');
    expect(line.querySelector('b')!.textContent).toBe('Codex stable check');
    await click(button('Undo'));
    expect(calls.find((c) => c.method === 'POST')).toEqual({ path: '/schedules/sch-codex/undo', method: 'POST', body: { revision: 4 } });
    expect(button('Undo').disabled).toBe(true);
    await click(button('Open'));
    expect(host.querySelector('[data-where]')!.textContent).toBe('/scheduled?id=sch-codex');
  });

  it('says a cut to weekly as Daily → Mondays 10:00', async () => {
    serve();
    await render(<cards.ScheduleRecordLine record={WEEKLY_RECORD} />);
    expect(host.querySelector('[data-schedule-record]')!.textContent).toBe('Changed Codex stable check: Daily → Mondays 10:00UndoOpen');
  });

  it('says an end the run made itself', async () => {
    serve();
    await render(<cards.ScheduleRecordLine record={FREEZE_ENDED_RECORD} />);
    expect(host.querySelector('[data-schedule-record]')!.textContent)
      .toBe('Ended Release 2.0 freeze watch: goal reached · by this runUndoOpen');
  });
});

function RunSession({ sessionId }: { sessionId: string }) {
  const read = cards.useSessionScheduleCards(sessionId);
  const of = cards.useScheduleRunOfSession(sessionId, read);
  const inserts = cards.useSessionScheduleInserts(null, undefined, [], of);
  if (!of) return null;
  return (
    <>
      <cards.ScheduleRunStrip of={of} />
      <cards.ScheduleRunReport of={of} />
      <span data-inserts="">{inserts.length}</span>
    </>
  );
}

/** A run from June: far older than the schedule's last 50 runs, so no page of its runs would hold it. */
const JUNE_RUN = {
  ...CODEX_NOV13_RUN, id: 'run-codex-jun02', plannedAt: '2025-06-02T02:00:00.000Z', startedAt: '2025-06-02T02:01:00.000Z',
  endedAt: '2025-06-02T02:03:00.000Z', state: 'NO_CHANGE' as const, key: '0.31.0', summary: 'Still 0.31.0.', links: [],
  sessionId: 'sess-codex-run-jun02',
};

/** The session's schedule-cards answer names its run; any scan of the account's schedules or runs is refused. */
function serveRun(sessionId: string, run: typeof CODEX_NOV13_RUN) {
  serve((path) => {
    if (path === `/sessions/${sessionId}/schedule-cards`) return { run, cards: [], records: [] };
    if (path.startsWith('/schedules?') || /\/runs(\?|$)/.test(path)) throw new Error(`scanned ${path}`);
    return undefined;
  });
}

describe('a run’s session (board 2/2 ⑤ ⑥)', () => {
  it('has the strip and the report card', async () => {
    serveRun('sess-codex-run-nov13', CODEX_NOV13_RUN);
    await render(<RunSession sessionId="sess-codex-run-nov13" />);
    expect(host.querySelector('[data-schedule-strip]')!.textContent).toBe(
      'Scheduled run · planned 10:00, started 10:01 · access Open a PR',
    );
    const report = host.querySelector('[data-schedule-report]')!;
    expect(report.querySelector('.sched-report-head')!.textContent).toBe('Reported: Changed · 0.49.0 · you were notified');
    expect(report.textContent).toContain('Codex 0.49.0 is out (pinned 0.48.0).');
    expect(report.querySelector('a')!.getAttribute('href')).toBe('https://github.com/openai/codex/releases/tag/0.49.0');
  });

  it('knows a run older than the schedule’s last 50 from the session alone, with no ?schedule= and no scan', async () => {
    serveRun('sess-codex-run-jun02', JUNE_RUN);
    await render(<RunSession sessionId="sess-codex-run-jun02" />);
    expect(host.querySelector('[data-schedule-strip]')!.textContent).toBe(
      'Scheduled run · planned 10:00, started 10:01 · access Open a PR',
    );
    expect(host.querySelector('.sched-report-head')!.textContent).toBe('Reported: No change · 0.31.0');
    expect(calls.map((c) => c.path)).toEqual(['/sessions/sess-codex-run-jun02/schedule-cards', '/schedules/sch-codex']);
  });

  it('knows a run of a schedule that has ended', async () => {
    serveRun('sess-freeze-run', FREEZE_RUN);
    await render(<RunSession sessionId="sess-freeze-run" />);
    expect(host.querySelector('.sched-report-head')!.textContent).toBe('Reported: Changed · released@2.0.0 · you were notified');
  });

  it('a reported failure’s report says what the run reported', async () => {
    serveRun('sess-codex-run-nov13', {
      ...CODEX_NOV13_RUN, state: 'FAILED', failureReason: 'REPORTED_FAILED', key: null, links: [],
      summary: 'The releases page returned 503.',
    });
    await render(<RunSession sessionId="sess-codex-run-nov13" />);
    expect(host.querySelector('.sched-report-head')!.textContent).toBe('Reported a failure: The releases page returned 503');
  });

  it('draws nothing for a session that serves no run', async () => {
    serve((path) => (path === '/sessions/sess-plain/schedule-cards' ? { run: null, cards: [], records: [] } : undefined));
    await render(<RunSession sessionId="sess-plain" />);
    expect(host.querySelector('[data-schedule-strip]')).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['/sessions/sess-plain/schedule-cards']);
  });
});

describe('a conversation’s scheduled-task inserts', () => {
  function Inserts({ sessionId }: { sessionId: string }) {
    const events = [{ seq: 1, ts: '2025-11-14T04:00:00.000Z' }, { seq: 2, ts: '2025-11-14T04:22:00.000Z' }];
    const read = cards.useSessionScheduleCards(sessionId);
    const inserts = cards.useSessionScheduleInserts(sessionId, read, events, null);
    return <>{inserts.map((insert) => <div key={insert.key} data-anchor={String(insert.anchor)}>{insert.element}</div>)}</>;
  }

  it('draws the session’s cards and change lines where they happened', async () => {
    serve((path) => (path === '/sessions/sess-codex-watch/schedule-cards'
      ? { run: null, cards: [CREATE_CARD, OPEN_PRS_CARD], records: [CODEX_TIME_RECORD] }
      : undefined));
    await render(<Inserts sessionId="sess-codex-watch" />);
    const drawn = [...host.querySelectorAll<HTMLElement>('[data-anchor]')].map((el) => [
      el.dataset.anchor,
      el.querySelector('[data-schedule-card]')?.getAttribute('data-schedule-card') ?? (el.querySelector('[data-schedule-record]') ? 'record' : null),
    ]);
    // The change line (12:19) was made before the access card (12:20); the create card (12:01) first of all.
    expect(drawn).toEqual([['1', 'create'], ['1', 'record'], ['1', 'envelope']]);
  });
});

// ── board docs/mocks/scheduled-run-not-started ②③④ (owner's B1) ─────────────────────────────────────

/** A run's session page as the transcript draws its head: every insert the session's schedule read gives it. */
function RunHead({ sessionId }: { sessionId: string }) {
  const read = cards.useSessionScheduleCards(sessionId);
  const of = cards.useScheduleRunOfSession(sessionId, read);
  const inserts = cards.useSessionScheduleInserts(sessionId, read, [{ seq: 1 }], of, { runner: 'HPC', engine: 'Claude Code' });
  return <>{inserts.map((insert) => <div key={insert.key}>{insert.element}</div>)}</>;
}

function serveRunStatus(sessionId: string, run: unknown, runStatus: unknown, writes: (path: string) => unknown = () => ({})) {
  serve((path, method) => {
    if (method === 'POST') return writes(path);
    if (path === `/sessions/${sessionId}/schedule-cards`) return { run, runStatus, cards: [], records: [] };
    return undefined;
  });
}

const runCard = () => host.querySelector<HTMLElement>('[data-schedule-run-card]');
const runCardParts = () => {
  const card = runCard()!;
  return {
    kind: card.dataset.scheduleRunCard,
    title: card.querySelector('.sched-run-title')!.textContent,
    body: card.querySelector('.sched-run-body')!.textContent,
    chips: [...card.querySelectorAll('.sched-run-chip')].map((el) => el.textContent),
    meta: [...card.querySelectorAll('.sched-run-meta')].map((el) => el.textContent),
    doors: [...card.querySelectorAll('button')].map((el) => el.textContent),
  };
};
const press = (label: string) => click([...runCard()!.querySelectorAll('button')].find((b) => b.textContent === label)!);

describe('a run’s session where the run did not get under way (board scheduled-run-not-started)', () => {
  it('② Didn’t run: why, each try, when it gave up and the next run, with Run now and Open schedule, and no report', async () => {
    serveRunStatus(BUMP_TRY_SESSIONS[4]!, BUMP_MISSED_RUN, bumpMissedStatus(), () => ({ run: { sessionId: 'sess-bump-now' } }));
    await render(<RunHead sessionId={BUMP_TRY_SESSIONS[4]!} />);
    expect(host.querySelector('[data-schedule-strip]')!.textContent).toBe(
      'Scheduled run · planned 03:32 · access Edit and land on main',
    );
    expect(runCardParts()).toEqual({
      kind: 'DIDNT_RUN',
      title: "Didn't run",
      body: "HPC didn't pick it up on any of 5 tries, so the run never started. Nothing was changed.",
      chips: ['03:32', '03:43', '03:58', '04:23', '05:34'],
      meta: ['gave up 05:44', 'Next run: tomorrow 06:00'],
      doors: ['Run now', 'Open schedule'],
    });
    expect(host.querySelector('[data-schedule-report]'), 'no red "Found no runner online" card').toBeNull();
    expect(host.textContent).not.toContain('Found no runner online');
    await press('Run now');
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/schedules/sch-bump/run');
    expect(host.querySelector('[data-where]')!.textContent).toBe('/sessions/sess-bump-now');
  });

  it('② reads the same from an earlier try, and says a full runner was full', async () => {
    serveRunStatus(BUMP_TRY_SESSIONS[0]!, { ...BUMP_MISSED_RUN, failureReason: 'RUNNER_FULL' }, bumpMissedStatus(1));
    await render(<RunHead sessionId={BUMP_TRY_SESSIONS[0]!} />);
    expect(runCardParts().body).toBe('HPC was full the whole time, so the run never started. Nothing was changed.');
    await press('Open schedule');
    expect(host.querySelector('[data-where]')!.textContent).toBe('/scheduled?id=sch-bump');
  });

  it('③ Queued · runner full: the queue’s sentence said of the run, the wait and the deadline, with Cancel run', async () => {
    serveRunStatus(BUMP_TRY_SESSIONS[0]!, BUMP_QUEUED_RUN, bumpQueuedStatus());
    await render(<RunHead sessionId={BUMP_TRY_SESSIONS[0]!} />);
    expect(runCardParts()).toEqual({
      kind: 'QUEUED_FULL',
      title: 'Queued · runner full',
      body: 'HPC is running 20 of 20 sessions. The run starts as soon as one finishes.',
      chips: [],
      meta: ['Waiting 1 h 12 min · gives up at 03:32 tomorrow'],
      doors: ['Cancel run', 'Open schedule'],
    });
    await press('Cancel run');
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/schedule-runs/run-bump-nov14/stop');
  });

  it('④ Started on try 3: why this try stopped, and Open the run to the session it went on in', async () => {
    serveRunStatus(BUMP_TRY_SESSIONS[1]!, BUMP_STARTED_RUN, bumpStartedStatus(2));
    await render(<RunHead sessionId={BUMP_TRY_SESSIONS[1]!} />);
    expect(runCardParts()).toEqual({
      kind: 'STARTED_ON',
      title: 'Started on try 3',
      body: 'This try stopped before its engine started (Claude Code exited). Try 3 started at 03:58.',
      chips: [],
      meta: [],
      doors: ['Open the run →'],
    });
    await press('Open the run →');
    expect(host.querySelector('[data-where]')!.textContent).toBe('/sessions/sess-bump-try-3');
  });

  it('draws no card in the session the run went on in, nor from a server that predates the run status', async () => {
    serveRunStatus(BUMP_TRY_SESSIONS[2]!, BUMP_STARTED_RUN, bumpStartedStatus(3));
    await render(<RunHead sessionId={BUMP_TRY_SESSIONS[2]!} />);
    expect(host.querySelector('[data-schedule-strip]')!.textContent).toBe(
      'Scheduled run · planned 03:32, started 03:58 · access Edit and land on main',
    );
    expect(runCard()).toBeNull();
    act(() => root?.unmount());
    root = null;
    host.remove();
    serveRunStatus(BUMP_TRY_SESSIONS[4]!, BUMP_MISSED_RUN, undefined);
    await render(<RunHead sessionId={BUMP_TRY_SESSIONS[4]!} />);
    expect(runCard()).toBeNull();
    expect(host.querySelector('[data-schedule-report]')!.textContent).toBe('Found no runner online');
  });
});
