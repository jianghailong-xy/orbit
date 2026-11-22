// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_ROW_ROTATE_CHANGE_MS,
  BACKGROUND_ROW_ROTATE_PER_NAME_MS,
  type BackgroundRow,
  type BackgroundRowInput,
  type BackgroundRowItem,
  type BgShell,
} from '@orbit/shared';
import type { RunEvent } from './Transcript';
import { BackgroundShellsTray, lastAgentTurnStartedAt, lastUserMessageAt } from './BackgroundShellsTray';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, stopBackgroundJob: vi.fn() };
});
const { stopBackgroundJob } = await import('../api');

/**
 * The folded Background row draws what the shared rule says (src/shared backgroundRow.ts). Its
 * cases are read out of `background-row.fixture.json`, the file OrbitKit and Android read too, so
 * the three clients cannot drift; a copy of them here would be free to agree with a row no other
 * client draws.
 */

interface RowCase {
  case: string;
  list: BackgroundRowInput[];
  events?: RunEvent[];
  lastUserMessageAt: string | null;
  lastAgentTurnStartedAt?: string | null;
  sessionLive: boolean;
  expect: BackgroundRow;
}

/** A file of this repository, by both spellings: the web suite runs from `src/web`, a runner may
 *  start at the root. */
function fromRepo(...candidates: string[]): string {
  const found = candidates.map((each) => resolve(process.cwd(), each)).find(existsSync);
  if (!found) throw new Error(`none of ${candidates.join(', ')} is under ${process.cwd()}`);
  return readFileSync(found, 'utf8');
}

const fixture = JSON.parse(
  fromRepo('../shared/src/background-row.fixture.json', 'src/shared/src/background-row.fixture.json'),
) as { rotation: { perNameMs: number; changeMs: number }; cases: RowCase[] };

const css = fromRepo('src/index.css', 'src/web/src/index.css');

const shell = (s: BackgroundRowInput & Partial<BgShell>): BgShell => ({
  kind: 'shell',
  toolUseId: `toolu_${s.shellId}`,
  outputPath: '',
  ...s,
  description: s.description ?? undefined,
  endedAt: s.endedAt ?? undefined,
});

/** The person's message at `at`, as the event stream carries it. */
const userAt = (at: string | null, seq = 1): RunEvent[] =>
  at ? [{ seq, type: 'user', ts: at, turnId: `turn-${seq}`, payload: { text: 'Go on' } }] : [];

/** The agent's turn starting at `at`: an assistant event of its own turn. */
const agentTurnAt = (at: string | null | undefined, seq = 50): RunEvent[] =>
  at ? [{ seq, type: 'assistant', ts: at, turnId: `turn-agent-${seq}`, payload: { text: 'On it' } }] : [];

const MARK_CLASS: Record<BackgroundRowItem['mark'], string> = {
  running: 'running',
  done: 'ok',
  failed: 'err',
  killed: 'pending',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

function render(list: BgShell[], events: RunEvent[], live: boolean) {
  act(() => root.render(<BackgroundShellsTray events={events} live={live} serverShells={list} />));
}

const one = (selector: string) => container.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const toggle = () => act(() => one('.bg-tray-row')!.click());
const shownName = () => one('.bg-rot-name:not(.bg-rot-out)')?.textContent;

describe('the folded row, by background-row.fixture.json', () => {
  it('reads the rotation constants the shared rule uses', () => {
    expect(fixture.rotation).toEqual({
      perNameMs: BACKGROUND_ROW_ROTATE_PER_NAME_MS,
      changeMs: BACKGROUND_ROW_ROTATE_CHANGE_MS,
    });
  });

  it.each(fixture.cases.map((c) => [c.case, c] as const))('%s', (_name, c) => {
    // A case that carries its transcript is read through the reader, as every client must.
    if (c.events) {
      expect(lastUserMessageAt(c.events)).toBe(c.lastUserMessageAt);
      expect(lastAgentTurnStartedAt(c.events)).toBe(c.lastAgentTurnStartedAt ?? null);
    }
    render(
      c.list.map(shell),
      c.events ?? [...userAt(c.lastUserMessageAt), ...agentTurnAt(c.lastAgentTurnStartedAt)],
      c.sessionLive,
    );
    const want = c.expect;
    if (want.hidden) {
      expect(container.innerHTML).toBe('');
      return;
    }
    expect(one('.bg-tray-label')?.textContent).toBe(want.label);
    expect(container.textContent).not.toMatch(/total/);
    expect(one('.wt-expand')?.getAttribute('aria-label')).toBe(want.accessibilityLabel);

    const marks = all('.bg-tray-row .chat-tool-status');
    expect(marks).toHaveLength(1);
    if (want.name.mode === 'rotate') {
      expect(one('.bg-rot')?.getAttribute('aria-hidden')).toBe('true');
      expect(all('.bg-rot-name').map((n) => n.textContent)).toEqual([want.name.items[0].name]);
      expect(one('.bg-rot-name')?.dataset.truncate).toBe(want.name.items[0].truncate);
      expect(one('.bg-tray-name')).toBeNull();
      expect(marks[0].classList.contains('running')).toBe(true);
    } else {
      const item = want.name.item;
      expect(one('.bg-rot')).toBeNull();
      expect(one('.bg-tray-name')?.textContent).toBe(item.name);
      expect(one('.bg-tray-name')?.dataset.truncate).toBe(item.truncate);
      expect(marks[0].classList.contains(MARK_CLASS[item.mark])).toBe(true);
    }

    if (want.countLine === null) {
      expect(one('.bg-tray-count')).toBeNull();
    } else {
      expect(one('.bg-tray-count')?.textContent).toBe(want.countLine);
    }

    // As the Agents row: the name, then past the spacer the count, the mark, the arrow at the edge.
    const name = one(want.name.mode === 'rotate' ? '.bg-rot' : '.bg-tray-name')!;
    const order = [name, one('.wt-spacer')!, one('.bg-tray-count'), marks[0], one('.wt-expand')!].filter(
      (el): el is HTMLElement => el !== null,
    );
    const rowChildren = [...one('.bg-tray-row')!.children];
    expect(order.map((el) => rowChildren.indexOf(el))).toEqual(
      [...order.map((el) => rowChildren.indexOf(el))].sort((a, b) => a - b),
    );
    expect(order.every((el) => rowChildren.includes(el))).toBe(true);
    expect(rowChildren.slice(-2)).toEqual([marks[0], one('.wt-expand')]);
    if (want.countLine !== null) expect(rowChildren.slice(-3, -2)).toEqual([one('.bg-tray-count')]);
  });

  it('lets the rotating names, not the spacer, take the free space', () => {
    expect(css).toMatch(/\.bg-rot\s*\{[^}]*flex:\s*1 1 auto/);
    expect(css).toMatch(/\.bg-rot \+ \.wt-spacer\s*\{[^}]*flex:\s*none/);
  });

  it('draws the one name in the brand tint, as the Tasks card draws its .ct-one', () => {
    expect(css).toMatch(/\.ct-one,\s*\.bg-tray-name\s*\{[^}]*color:\s*var\(--brand\)/);
    expect(css).toMatch(/\.bg-rot-name\s*\{[^}]*color:\s*var\(--brand\)/);
  });
});

// Three running, the newest started last in the list: the row names it first.
const THREE = [
  shell({ shellId: 'bgj_a', command: '', description: 'web tsc + full Vitest suite', startedSeq: 10, status: 'running', endedAt: null }),
  shell({ shellId: 'bgj_b', command: '', description: 'OrbitKit swift test', startedSeq: 20, status: 'running', endedAt: null }),
  shell({ shellId: 'bgj_c', command: '', description: 'apiserver tsc + full npm test', startedSeq: 30, status: 'running', endedAt: null }),
];
const NEWEST_FIRST = ['apiserver tsc + full npm test', 'OrbitKit swift test', 'web tsc + full Vitest suite'];
const SINCE = userAt('2026-11-16T02:40:00.000Z');

describe('the rotation', () => {
  it('pushes the next name up every 3000 ms in a 300 ms change, newest first, and loops', () => {
    vi.useFakeTimers();
    render(THREE, SINCE, true);
    const rot = one('.bg-rot')!;
    expect(rot.classList.contains('is-push')).toBe(true);
    expect(rot.style.getPropertyValue('--bg-rot-change')).toBe(`${BACKGROUND_ROW_ROTATE_CHANGE_MS}ms`);
    expect(shownName()).toBe(NEWEST_FIRST[0]);

    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS - 1));
    expect(shownName()).toBe(NEWEST_FIRST[0]);
    act(() => vi.advanceTimersByTime(1));
    // Mid-change: the old name leaves, the new one comes in.
    expect(one('.bg-rot-out')?.textContent).toBe(NEWEST_FIRST[0]);
    expect(one('.bg-rot-in')?.textContent).toBe(NEWEST_FIRST[1]);
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_CHANGE_MS));
    expect(one('.bg-rot-out')).toBeNull();
    expect(one('.bg-rot-in')).toBeNull();
    expect(shownName()).toBe(NEWEST_FIRST[1]);

    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS * 2));
    expect(shownName()).toBe(NEWEST_FIRST[0]);
    // The count and the label never move.
    expect(one('.bg-tray-count')?.textContent).toBe('3 running');
    expect(one('.wt-expand')?.getAttribute('aria-label')).toBe('Background processes, 3 running');
  });

  it('push is a translateY up; the change keyframes come from the shared change time', () => {
    expect(css).toMatch(/\.bg-rot\.is-push \.bg-rot-in\s*\{[^}]*animation:\s*bg-rot-push-in var\(--bg-rot-change\)/);
    expect(css).toMatch(/\.bg-rot\.is-push \.bg-rot-out\s*\{[^}]*animation:\s*bg-rot-push-out var\(--bg-rot-change\)/);
    expect(css).toMatch(/@keyframes bg-rot-push-in\s*\{\s*from\s*\{[^}]*translateY\(100%\)/);
    expect(css).toMatch(/@keyframes bg-rot-push-out\s*\{[\s\S]*?to\s*\{[^}]*translateY\(-100%\)/);
  });

  it('crossfades in place under prefers-reduced-motion: no translate', () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query }) as MediaQueryList,
    );
    vi.useFakeTimers();
    render(THREE, SINCE, true);
    const rot = one('.bg-rot')!;
    expect(rot.classList.contains('is-fade')).toBe(true);
    expect(rot.classList.contains('is-push')).toBe(false);
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS));
    expect(one('.bg-rot-out')?.textContent).toBe(NEWEST_FIRST[0]);
    expect(one('.bg-rot-in')?.textContent).toBe(NEWEST_FIRST[1]);

    expect(css).toMatch(/\.bg-rot\.is-fade \.bg-rot-in\s*\{[^}]*animation:\s*bg-rot-fade-in var\(--bg-rot-change\)/);
    expect(css).toMatch(/\.bg-rot\.is-fade \.bg-rot-out\s*\{[^}]*animation:\s*bg-rot-fade-out var\(--bg-rot-change\)/);
    for (const name of ['bg-rot-fade-in', 'bg-rot-fade-out']) {
      const body = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?\\}\\s*)\\}`))?.[1];
      expect(body, name).toMatch(/opacity/);
      expect(body, name).not.toMatch(/transform|translate/);
    }
    // And a stylesheet-only fallback, if the setting changes after the row was drawn.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.bg-rot\.is-push \.bg-rot-in\s*\{\s*animation-name:\s*bg-rot-fade-in/,
    );
  });

  it('holds while the list is open, and carries on from the same name when it closes', () => {
    vi.useFakeTimers();
    render(THREE, SINCE, true);
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS + BACKGROUND_ROW_ROTATE_CHANGE_MS));
    expect(shownName()).toBe(NEWEST_FIRST[1]);

    toggle();
    // Opened: the full name and the count; no rotating name.
    expect(one('.bg-tray-title')?.textContent).toBe('Background processes');
    expect(one('.bg-tray-count')?.textContent).toBe('3 running');
    expect(one('.bg-rot')).toBeNull();
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS * 5));

    toggle();
    expect(shownName()).toBe(NEWEST_FIRST[1]);
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS));
    expect(one('.bg-rot-in')?.textContent).toBe(NEWEST_FIRST[2]);
  });

  it('holds while the tab is hidden', () => {
    vi.useFakeTimers();
    render(THREE, SINCE, true);
    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS * 5));
    expect(shownName()).toBe(NEWEST_FIRST[0]);
    expect(one('.bg-rot-out')).toBeNull();

    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS + BACKGROUND_ROW_ROTATE_CHANGE_MS));
    expect(shownName()).toBe(NEWEST_FIRST[1]);
  });

  it('does not rotate a single running name', () => {
    vi.useFakeTimers();
    render([THREE[0]], SINCE, true);
    act(() => vi.advanceTimersByTime(BACKGROUND_ROW_ROTATE_PER_NAME_MS * 3));
    expect(one('.bg-rot')).toBeNull();
    expect(one('.bg-tray-name')?.textContent).toBe('web tsc + full Vitest suite');
  });
});

describe('the session it is fed', () => {
  const failedAt = '2026-11-16T02:45:00.000Z';
  const FAILED = [
    shell({ shellId: 'bgj_f', command: '', description: 'OrbitKit swift test', startedSeq: 10, status: 'failed', endedAt: failedAt }),
  ];

  const wakeEvents = (assistantAt: string): RunEvent[] => [
    ...userAt('2026-11-16T02:40:00.000Z'),
    // The control plane's wake: nothing typed, only its recorded note; the agent answers in its turn.
    {
      seq: 2,
      type: 'user',
      ts: '2026-11-16T02:46:00.000Z',
      turnId: 'turn-wake',
      payload: { text: '<background-job id="bgj_f">failed</background-job>', controlPlaneNote: '<background-job id="bgj_f">failed</background-job>' },
    },
    { seq: 3, type: 'assistant', ts: assistantAt, turnId: 'turn-wake', payload: { text: 'Fixing it' } },
  ];

  it('a wake turn is not a user message, but it is the agent\'s turn: it clears the failed item', () => {
    const events = wakeEvents('2026-11-16T02:46:05.000Z');
    expect(lastUserMessageAt(events)).toBe('2026-11-16T02:40:00.000Z');
    expect(lastAgentTurnStartedAt(events)).toBe('2026-11-16T02:46:00.000Z');
    render(FAILED, events, true);
    expect(container.innerHTML).toBe('');
  });

  it('a failed bg_run job leaves the row once a later agent turn starts', () => {
    const job = [
      shell({ shellId: 'bgj_j', kind: 'job', command: 'npm run build', description: 'Release build', startedSeq: 10, status: 'failed', endedAt: failedAt }),
    ];
    const before = userAt('2026-11-16T02:40:00.000Z');
    render(job, [...before, ...agentTurnAt('2026-11-16T02:44:00.000Z')], true);
    expect(one('.bg-tray-name')?.textContent).toBe('Release build');
    render(job, [...before, ...agentTurnAt('2026-11-16T02:44:00.000Z'), ...agentTurnAt('2026-11-16T02:50:00.000Z', 60)], true);
    expect(container.innerHTML).toBe('');
  });

  it('reads the start of the latest agent turn from the earliest event of that turn', () => {
    expect(lastAgentTurnStartedAt(userAt('2026-11-16T02:40:00.000Z'))).toBeNull();
    const events: RunEvent[] = [
      { seq: 1, type: 'assistant', ts: '2026-11-16T02:41:00.000Z', turnId: 't1', payload: {} },
      { seq: 2, type: 'assistant', ts: '2026-11-16T02:42:00.000Z', turnId: 't2', payload: {} },
      { seq: 3, type: 'tool_use', ts: '2026-11-16T02:43:00.000Z', turnId: 't2', payload: {} },
    ];
    expect(lastAgentTurnStartedAt(events)).toBe('2026-11-16T02:42:00.000Z');
  });

  it("the person's next message folds it away", () => {
    render(FAILED, [...userAt('2026-11-16T02:40:00.000Z'), ...userAt('2026-11-16T02:47:00.000Z', 2)], true);
    expect(container.innerHTML).toBe('');
  });

  it('a session that is not live drops its stale running items (sessionLive)', () => {
    render([THREE[0]], SINCE, false);
    expect(container.innerHTML).toBe('');
  });
});

describe('the opened list', () => {
  it('lists every process, bg_run jobs among them, drawn as a background command (no kind chip)', () => {
    const list = [
      shell({ shellId: 'bq1x7m', command: 'make backfill', description: 'Backfill the events', startedSeq: 5, status: 'done', endedAt: '2026-11-16T02:30:00.000Z' }),
      shell({ shellId: 'bgj_9k2', kind: 'job', command: 'npm test -w @orbit/web', description: 'web suite', startedSeq: 20, status: 'running', endedAt: null }),
      shell({ shellId: 'bgj_7aa', kind: 'job', command: 'swift test', description: '', startedSeq: 30, status: 'failed', endedAt: '2026-11-16T02:45:00.000Z' }),
    ];
    render(list, SINCE, true);
    // Folded: the running one is named, the failure not counted; the done one ended before the last message.
    expect(one('.bg-tray-name')?.textContent).toBe('web suite');
    expect(one('.bg-tray-count')?.textContent).toBe('1 running');

    toggle();
    const rows = all('.bg-shell');
    expect(rows.map((r) => r.querySelector('.bg-shell-cmd')?.textContent)).toEqual([
      'Backfill the events',
      'web suite',
      'swift test',
    ]);
    expect(rows.map((r) => r.querySelector('.bg-shell-id')?.textContent)).toEqual(['bq1x7m', 'bgj_9k2', 'bgj_7aa']);
    expect(one('.bg-shell-kind')).toBeNull();
    expect(one('.wt-expand')?.getAttribute('aria-label')).toBe('Hide background processes');
    expect(container.textContent).not.toMatch(/total/);
  });
});

// Ruling R1 (2026-11-21): a job's row in the opened list goes to its Job card. R3: a running job's row can stop it.
// A failed job is no longer counted (E2, revised 2026-11-21): the person can do nothing about it.
describe('a bg_run job in the opened list', () => {
  const JOBS = [
    shell({ shellId: 'bgj_run', kind: 'job', command: 'npm test -w @orbit/web', description: 'web suite', startedSeq: 20, status: 'running', endedAt: null, stoppable: true }),
    shell({ shellId: 'bgj_bad', kind: 'job', command: 'swift test', description: 'OrbitKit swift test', startedSeq: 30, status: 'failed', endedAt: '2026-11-16T02:45:00.000Z' }),
  ];
  const rowOf = (id: string) => all('.bg-shell').find((r) => r.querySelector('.bg-shell-id')?.textContent === id)!;

  it('does not count a failed job', () => {
    render(JOBS, SINCE, true);
    expect(one('.bg-tray-count')?.textContent).toBe('1 running');
    expect(one('.bg-tray-count .ct-failed')).toBeNull();
  });

  it('scrolls to its Job card when tapped, and folds the list', () => {
    const cardEl = document.createElement('div');
    cardEl.dataset.bgJob = 'bgj_bad';
    const scrolled = vi.fn();
    cardEl.scrollIntoView = scrolled;
    document.body.appendChild(cardEl);
    try {
      render(JOBS, SINCE, true);
      toggle();
      act(() => rowOf('bgj_bad').querySelector<HTMLElement>('.bg-shell-head')!.click());
      expect(scrolled).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
      expect(one('.bg-tray-list'), 'the list folds').toBeNull();
    } finally {
      cardEl.remove();
    }
  });

  it('opens its details as before when its card is not on the page', () => {
    render(JOBS, SINCE, true);
    toggle();
    act(() => rowOf('bgj_bad').querySelector<HTMLElement>('.bg-shell-head')!.click());
    expect(rowOf('bgj_bad').classList.contains('bg-shell-open')).toBe(true);
  });

  it('offers Stop on a running job its runner can stop, behind a confirm that calls the stop route', async () => {
    vi.mocked(stopBackgroundJob).mockReset().mockResolvedValue({ jobId: 'bgj_run', status: 'stopping' });
    act(() => root.render(<BackgroundShellsTray sessionId="34ySession" events={SINCE} live serverShells={JOBS} />));
    toggle();
    expect(rowOf('bgj_bad').querySelector('.bg-shell-stop'), 'not on a job that ended').toBeNull();
    const stop = rowOf('bgj_run').querySelector<HTMLElement>('.bg-shell-stop button')!;
    expect(stop.textContent).toBe('Stop');
    await act(async () => stop.click());
    expect(stopBackgroundJob).not.toHaveBeenCalled();
    const popup = document.body.querySelector<HTMLElement>('.orbit-popconfirm')!;
    expect(popup.querySelector('.orbit-popconfirm-title')?.textContent).toBe('Stop this job?');
    await act(async () => [...popup.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Stop')!.click());
    expect(stopBackgroundJob).toHaveBeenCalledWith('34ySession', 'bgj_run');
    // The press did not open the row.
    expect(rowOf('bgj_run').classList.contains('bg-shell-open')).toBe(false);
  });

  it('hides Stop where the list marks the job not stoppable (an older runner)', () => {
    const older = JOBS.map((j) => ({ ...j, stoppable: false }));
    act(() => root.render(<BackgroundShellsTray sessionId="34ySession" events={SINCE} live serverShells={older} />));
    toggle();
    expect(one('.bg-shell-stop')).toBeNull();
  });
});
