// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';

// The export inlines highlight.js's stylesheet through vite's `?raw`, which a worktree's linked
// node_modules refuses (see sessionExport.test.tsx). What it holds is not what this file is about.
vi.mock('highlight.js/styles/github.css?raw', () => ({ default: '' }));
const { buildSessionHtml } = await import('../lib/sessionExport');

/**
 * A finished turn ends in one row under its reply, where Codex puts its own: a copy button that
 * hands back the reply the turn ended on, as written, and the time the turn ended (owner,
 * 2026-10-09, board docs/mocks/turn-foot-web). It stands where the blank divider between turns
 * stood, so a turn that never finished keeps its error line instead (Transcript.turnEnd.test).
 */

// Local dates, so that "today" and "yesterday" are the same two days in every time zone.
const NOW = new Date(2026, 8, 28, 20, 0);
const TODAY = new Date(2026, 8, 28, 15, 21).toISOString();
const YESTERDAY = new Date(2026, 8, 27, 16, 5).toISOString();

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

const REPLY = [
  '编辑器详细设计已更新。',
  '',
  '| # | 决策 |',
  '|---|---|',
  '| D-1 | **自动检查点** |',
  '',
  '确认后，下一份写 Orchestrator 详细设计。',
].join('\n');

const user = (seq: number): RunEvent => ({ seq, type: 'user', payload: { text: 'go' }, ts: TODAY });
const said = (seq: number, text: string, parentToolUseId?: string): RunEvent => ({
  seq,
  type: 'assistant',
  payload: { text, parentToolUseId },
  ts: TODAY,
});
const ran = (seq: number, id: string, name = 'Bash'): RunEvent[] => [
  { seq, type: 'tool_use', payload: { id, name, input: { command: 'ls' } }, ts: TODAY },
  { seq: seq + 1, type: 'tool_result', payload: { toolUseId: id, content: 'ok' }, ts: TODAY },
];
const ended = (seq: number, ts = TODAY, subtype = 'success'): RunEvent => ({
  seq,
  type: 'turn_end',
  payload: { subtype },
  ts,
});

const page = (events: RunEvent[]): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Transcript events={events} />);
  return host;
};
const feet = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('.chat-turn-foot')];
const parts = (foot: HTMLElement) => [...foot.children].map((el) => el.className);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the end of a finished turn', () => {
  it('is one row under the reply: copy, then the time the turn ended', () => {
    const host = page([user(1), said(2, REPLY), ended(3)]);

    const [foot] = feet(host);
    expect(feet(host)).toHaveLength(1);
    expect(parts(foot)).toEqual(['chat-copy', 'chat-time']);
    expect(foot.textContent).toBe(clock(TODAY));
    expect(foot.previousElementSibling?.matches('.chat-assistant[data-seq="2"]')).toBe(true);
    // ⌘F still lands on the turn's end: the row keeps the stamp the divider carried.
    expect(foot.dataset.seq).toBe('3');
    // The reply's own box is still its words alone.
    const reply = host.querySelector<HTMLElement>('.chat-assistant')!;
    expect([...reply.children].map((el) => el.className)).toEqual(['md']);
  });

  it('gives a turn that ended today its time alone, and an earlier one its date too', () => {
    const host = page([user(1), said(2, 'a'), ended(3, YESTERDAY), user(4), said(5, 'b'), ended(6, TODAY)]);

    expect(feet(host).map((foot) => foot.textContent)).toEqual([
      `${day(YESTERDAY)}, ${clock(YESTERDAY)}`,
      clock(TODAY),
    ]);
  });

  it('waits for the turn to end', () => {
    expect(feet(page([user(1), said(2, REPLY)]))).toHaveLength(0);
    expect(feet(page([user(1), said(2, REPLY), ended(3)]))).toHaveLength(1);
  });

  it('keeps the time but offers nothing to copy when the turn wrote nothing', () => {
    const [foot] = feet(page([user(1), ...ran(2, 't1'), ended(4)]));

    expect(parts(foot)).toEqual(['chat-time']);
  });

  it('is drawn for a turn the user stopped, under the words it got to', () => {
    const host = page([
      user(1),
      said(2, '先跑 web 的单测。'),
      { seq: 3, type: 'tool_use', payload: { id: 't1', name: 'Bash', input: { command: 'npm test' } }, ts: TODAY },
      { seq: 4, type: 'tool_result', payload: { toolUseId: 't1', content: 'interrupted', isError: true }, ts: TODAY },
      { seq: 5, type: 'interrupt', payload: {}, ts: TODAY },
      ended(6, TODAY, 'error_during_execution'),
    ]);

    expect(feet(host).map(parts)).toEqual([['chat-copy', 'chat-time']]);
  });

  it('is the old blank divider when a turn carries neither a reply nor a time', () => {
    const host = page([user(1), { seq: 2, type: 'turn_end', payload: { subtype: 'success' } }]);

    expect(host.querySelectorAll('.chat-turn-divider')).toHaveLength(1);
    expect(feet(host)).toHaveLength(0);
  });
});

describe('the copy button at the end of a turn', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  const show = (events: RunEvent[]) => act(() => root.render(<Transcript events={events} />));
  const copyButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.chat-turn-foot .chat-copy')];

  it('hands back the reply the turn ended on, as written, not the narration before it', async () => {
    show([user(1), said(2, 'Let me read the design doc first.'), ...ran(3, 't1'), said(5, REPLY), ended(6)]);

    await act(async () => copyButtons()[0].click());

    expect(writeText).toHaveBeenCalledExactlyOnceWith(REPLY);
  });

  it('says it copied, then offers to copy again', async () => {
    show([user(1), said(2, REPLY), ended(3)]);
    const [button] = copyButtons();
    expect(button.getAttribute('aria-label')).toBe('Copy reply');

    await act(async () => button.click());
    expect(button.getAttribute('aria-label')).toBe('Copied');
    expect(button.title).toBe('Copied');

    await act(async () => vi.advanceTimersByTime(1600));
    expect(button.getAttribute('aria-label')).toBe('Copy reply');
  });

  it("copies the turn's own words: neither a sub-agent's nor an earlier turn's", async () => {
    show([
      user(1),
      said(2, 'first answer'),
      ended(3),
      user(4),
      { seq: 5, type: 'tool_use', payload: { id: 'agent', name: 'Task', input: { prompt: 'look around' } }, ts: TODAY },
      said(6, 'the sub-agent’s notes', 'agent'),
      { seq: 7, type: 'tool_result', payload: { toolUseId: 'agent', content: 'done' }, ts: TODAY },
      ended(8),
    ]);

    expect(feet(container).map(parts)).toEqual([['chat-copy', 'chat-time'], ['chat-time']]);
    await act(async () => copyButtons()[0].click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith('first answer');
  });
});

describe('a saved copy of the conversation', () => {
  it("keeps each turn's time and hides its copy button, which needs the app to work", () => {
    const html = buildSessionHtml({ id: 'session-1', title: 'Design' }, [user(1), said(2, REPLY), ended(3)], new Map(), 'light');
    const saved = new DOMParser().parseFromString(html, 'text/html');

    expect(saved.querySelector('.chat-turn-foot .chat-time')?.textContent).toBe(clock(TODAY));
    expect(html).toMatch(/\.orbit-export \.chat-copy,[^{]*\{\s*display:\s*none !important;/);
  });
});
