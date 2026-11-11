// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRunView } from '@orbit/shared';
import { type RunEvent, SubagentRunsCtx, Transcript } from './Transcript';
import { delegateResultText, delegateRunsSignature, subagentMeta } from '../lib/subagentRuns';

/**
 * Orbit's SubAgent (`mcp__orbit__delegate`) drawn as docs/mocks/subagent/02.png: the Agent card's purple
 * row named SubAgent, `<type> · <description>`, grey `tier · model` on the right — then time and cost once
 * done — a Background tag, the child's latest step while it runs, and a grey Why first when opened. Result
 * shapes are the runner's (src/runner-go/subagent.go).
 */

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({
  seq,
  type,
  ts: `2026-11-11T10:00:${String(seq).padStart(2, '0')}.000Z`,
  payload,
});

const FG_RESULT = JSON.stringify({
  runId: 'run1',
  status: 'DONE',
  result: 'Three callers, all in **quota/**.',
  changedFiles: [],
  model: 'claude-sonnet-5-5',
  costUsd: 0.21,
});

const events: RunEvent[] = [
  ev(1, 'tool_use', {
    id: 'toolu_fg',
    name: 'mcp__orbit__delegate',
    input: { description: 'Find every caller of pollQuota', prompt: 'Find them.', type: 'explore', size: 'S' },
  }),
  ev(2, 'tool_use', { id: 'run1:toolu_c1', name: 'Grep', input: { pattern: 'pollQuota(' }, parentToolUseId: 'toolu_fg' }),
  ev(3, 'tool_result', { toolUseId: 'run1:toolu_c1', content: 'quota/a.ts', parentToolUseId: 'toolu_fg' }),
  ev(4, 'tool_result', { toolUseId: 'toolu_fg', content: [{ type: 'text', text: FG_RESULT }] }),
  ev(5, 'tool_use', {
    id: 'toolu_bg',
    name: 'mcp__orbit__delegate',
    input: { description: 'Write the backoff spec', prompt: 'Write it.', type: 'spec-writer', background: true },
  }),
  ev(6, 'tool_result', { toolUseId: 'toolu_bg', content: [{ type: 'text', text: '{"runId":"run2","status":"running"}' }] }),
  ev(7, 'tool_use', {
    id: 'run2:toolu_c2',
    name: 'Edit',
    input: { file_path: '/repo/src/apiserver/src/quota/poller.spec.ts', old_string: 'a', new_string: 'b' },
    parentToolUseId: 'toolu_bg',
  }),
];

const run = (over: Partial<SubagentRunView>): SubagentRunView => ({
  toolUseId: 'toolu_fg',
  type: 'explore',
  background: false,
  status: 'DONE',
  level: 'S',
  model: 'claude-sonnet-5-5',
  modelLabel: 'Sonnet 5.5',
  effort: null,
  reasons: ['Tier S, set by the caller: a search', 'Optimize For: Cost'],
  costUsd: 0.21,
  resultSummary: 'Three callers, all in quota/.',
  createdAt: '2026-11-11T10:00:01.000Z',
  endedAt: '2026-11-11T10:00:42.000Z',
  ...over,
});

const FG = run({});
const BG_RUNNING = run({
  toolUseId: 'toolu_bg',
  type: 'spec-writer',
  background: true,
  status: 'RUNNING',
  level: 'M',
  modelLabel: 'Opus 5.5',
  model: 'claude-opus-5-5',
  effort: 'medium',
  reasons: ['Tier M, set by the caller: one service plus its spec'],
  costUsd: 0,
  resultSummary: null,
  endedAt: null,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(runs: SubagentRunView[], live = true) {
  act(() =>
    root.render(
      <MemoryRouter>
        <SubagentRunsCtx.Provider value={new Map(runs.map((r) => [r.toolUseId, r]))}>
          <Transcript events={events} live={live} />
        </SubagentRunsCtx.Provider>
      </MemoryRouter>,
    ),
  );
}

const card = (seq: number) => container.querySelector(`.chat-tool-card[data-seq="${seq}"]`) as HTMLElement;
const text = (el: Element | null) => el?.textContent ?? null;

describe('the SubAgent block', () => {
  it('folds to one row: SubAgent, type · description, and grey tier · model', () => {
    render([FG, BG_RUNNING]);
    const bg = card(5);
    expect(bg.className).toContain('chat-tone-agent');
    expect(bg.className).toContain('chat-tool-task');
    expect(text(bg.querySelector('.chat-tool-name'))).toBe('SubAgent');
    expect(text(bg.querySelector('.chat-tool-summary'))).toBe('spec-writer · Write the backoff spec');
    expect(text(bg.querySelector('.chat-tool-meta'))).toBe('M · Opus 5.5 · medium');
    // Folded, the Why is nowhere: no colour and no tag beyond the meta.
    expect(container.querySelector('.chat-subagent-why')).toBeNull();
  });

  it('adds duration and cost to the meta once the run is done', () => {
    render([FG, BG_RUNNING]);
    const fg = card(1);
    expect(text(fg.querySelector('.chat-tool-summary'))).toBe('explore · Find every caller of pollQuota');
    expect(text(fg.querySelector('.chat-tool-meta'))).toBe('S · Sonnet 5.5 · 41s · $0.21');
    expect(fg.querySelector('.chat-tool-status.ok')).not.toBeNull();
    expect(fg.querySelector('.chat-tool-tag')).toBeNull();
  });

  it('tags a background run, spins while it runs and shows its latest step under the row', () => {
    render([FG, BG_RUNNING]);
    const bg = card(5);
    expect(text(bg.querySelector('.chat-tool-tag'))).toBe('Background');
    expect(bg.querySelector('.chat-tool-status.running')).not.toBeNull();
    expect(text(bg.querySelector('.chat-tool-live'))).toBe('Edit poller.spec.ts');
    // A finished foreground run has no live line.
    expect(card(1).querySelector('.chat-tool-live')).toBeNull();
  });

  it('checks a background run off and drops its live line once its run has ended', () => {
    const ended = { ...BG_RUNNING, status: 'DONE' as const, endedAt: '2026-11-11T10:03:13.000Z', costUsd: 0.5, resultSummary: 'Added six cases.' };
    render([FG, ended], false);
    const bg = card(5);
    expect(bg.querySelector('.chat-tool-live')).toBeNull();
    expect(text(bg.querySelector('.chat-tool-meta'))).toBe('M · Opus 5.5 · medium · 3m 12s · $0.50');
    act(() => (bg.querySelector('.chat-tool-row') as HTMLElement).click());
    // The receipt is not the result: the run's own result is.
    expect(bg.textContent).toContain('Added six cases.');
    expect(bg.textContent).not.toContain('"status":"running"');
  });

  it('opens on a grey Why line first, then the child steps and the result as Markdown', () => {
    render([FG, BG_RUNNING]);
    const fg = card(1);
    act(() => (fg.querySelector('.chat-tool-row') as HTMLElement).click());
    const detail = fg.querySelector('.chat-tool-detail')!;
    const why = detail.firstElementChild!;
    expect(why.className).toBe('chat-subagent-why');
    expect(why.textContent).toBe('Why · Tier S, set by the caller: a search · Optimize For: Cost');
    expect(text(why.querySelector('b'))).toBe('Why');
    expect(detail.querySelector('.chat-subagent')).not.toBeNull();
    expect(detail.textContent).toContain('Three callers, all in quota/.');
    expect(detail.querySelector('strong')?.textContent).toBe('quota/');
    expect(detail.textContent).not.toContain('runId');
    // No prompt: the board opens on Why, steps and result.
    expect(detail.textContent).not.toContain('Find them.');
  });

  it('draws the row before its run is read, with no meta and no Why', () => {
    render([]);
    const fg = card(1);
    expect(text(fg.querySelector('.chat-tool-name'))).toBe('SubAgent');
    expect(fg.querySelector('.chat-tool-meta')).toBeNull();
    act(() => (fg.querySelector('.chat-tool-row') as HTMLElement).click());
    expect(fg.querySelector('.chat-subagent-why')).toBeNull();
  });
});

describe('subagentRuns helpers', () => {
  it('reads runs only for a transcript that delegated, and again whenever a call or its end lands', () => {
    expect(delegateRunsSignature([ev(1, 'tool_use', { id: 'x', name: 'Bash', input: {} })])).toBe('');
    expect(delegateRunsSignature(events)).toBe('1,4,5,6');
    expect(
      delegateRunsSignature([...events, ev(9, 'background_task', { toolUseId: 'toolu_bg', status: 'completed' })]),
    ).toBe('1,4,5,6,9');
  });

  it('says nothing about a run it has not read, and hides a bare receipt', () => {
    expect(subagentMeta(undefined)).toBeNull();
    expect(delegateResultText('{"runId":"r","status":"running"}', undefined)).toBeNull();
    expect(delegateResultText('plain text', undefined)).toBe('plain text');
  });
});
