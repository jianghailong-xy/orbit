// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRunView } from '@orbit/shared';
import {
  SUBAGENT_DONE,
  SUBAGENT_FAILED,
  SUBAGENT_INTERRUPTED,
  SUBAGENT_STEER,
  SUBAGENT_STOPPED,
  SUBAGENT_TWO,
} from '../lib/subagentFinished.fixtures';
import { queuedTurnEvent } from '../lib/acceptedUserTurn';
import { queuedSubagentWake, returnsToComposer } from '../lib/queuedTurnRestore';
import type { RunEvent } from './Transcript';

/**
 * A background SubAgent is ONE card from start to end, as Claude Code's built-in Agent is
 * (docs/mocks/subagent-card-and-end-line, approved 2026-11-20). When its run ends, the card's row says how
 * (✓ alone for DONE; the mark and a word chip otherwise, grey for a stop), the line under the folded row
 * becomes the ending, and the opened card closes on an end block. The turn the control plane opened for
 * the end (`<orbit-subagent-finished>`) draws nothing: no line of its own, no From Orbit line, no bubble.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { SubagentRunsCtx, Transcript } = await import('./Transcript');
const { SubagentQueuedWakesCtx } = await import('./SubagentCardEnd');

const TS = '2026-11-15T16:30:00.000Z';
const ENDED = '2026-11-15T16:29:00.000Z';

/** The runs the fixtures' blocks name, by the fixture. */
const RUN_OF = new Map<string, { runId: string; status: SubagentRunView['status']; description: string }>([
  [SUBAGENT_DONE, { runId: '34y5NxcqKYA179mC04VUB', status: 'DONE', description: 'Deploy 6bb50a957 to production' }],
  [SUBAGENT_FAILED, { runId: '34y5PfailRUNid0000001', status: 'FAILED', description: 'Write the poller spec' }],
  [SUBAGENT_STOPPED, { runId: '34y5PstopRUNid0000002', status: 'STOPPED', description: 'Sweep stale worktrees' }],
  [SUBAGENT_INTERRUPTED, { runId: '34y5PintrRUNid0000003', status: 'INTERRUPTED', description: 'Port the retry to the Go runner' }],
]);

const FILES = [
  'src/apiserver/src/tasks/model-routing.ts',
  'src/apiserver/src/tasks/task-route-decision.ts',
  'src/web/src/components/TaskDetailPanel.modelRouting.test.tsx',
  'src/web/src/components/a.ts',
  'src/web/src/components/b.ts',
];

/** The runner's own text for a run it lost: what used to restate the reason a second time. */
const ORPHANED =
  'The SubAgent was interrupted: the runner process hosting it stopped (a restart, an update or a crash) before ' +
  'it reported an end. What it changed so far is in the working tree, uncommitted.';

const run = (toolUseId: string, status: SubagentRunView['status'], over: Partial<SubagentRunView> = {}): SubagentRunView => ({
  toolUseId,
  type: 'general',
  background: true,
  status,
  level: 'M',
  model: 'claude-sonnet-5-5',
  modelLabel: 'Sonnet 5.5',
  effort: 'medium',
  reasons: [],
  why: 'Tier M from the caller',
  removed: [],
  costUsd: 0,
  resultSummary: status === 'DONE' ? 'Three callers, all in **quota/**.' : status === 'INTERRUPTED' ? ORPHANED : null,
  workspaceName: null,
  description: null,
  engine: 'claude',
  readonly: false,
  changedFiles: status === 'DONE' ? [] : FILES,
  createdAt: '2026-11-15T16:26:00.000Z',
  endedAt: status === 'RUNNING' ? null : ENDED,
  ...over,
});

/** A background delegate call, its launch receipt, and one step of its child. */
const delegate = (seq: number, id: string, runId: string, description: string): RunEvent[] => [
  {
    seq,
    type: 'tool_use',
    turnId: 'turn-1',
    ts: TS,
    payload: { id, name: 'mcp__orbit__delegate', input: { description, prompt: 'Do it.', type: 'general', background: true } },
  },
  {
    seq: seq + 1,
    type: 'tool_result',
    turnId: 'turn-1',
    ts: TS,
    payload: { toolUseId: id, content: [{ type: 'text', text: JSON.stringify({ runId, status: 'running' }) }] },
  },
  {
    seq: seq + 2,
    type: 'tool_use',
    turnId: 'turn-1',
    ts: TS,
    payload: { id: `${runId}:c1`, name: 'Edit', input: { file_path: '/repo/x.ts', old_string: 'a', new_string: 'b' }, parentToolUseId: id },
  },
];

/** A background job's news, as the control plane writes it beside a SubAgent's end in one note. */
const JOB = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_13c53745a88a｜job｜make test｜unit tests',
  '      ended｜completed｜exit code 0',
  '      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10',
  '      (no output)',
  '  The control plane recorded this for you; the user did not say it.',
  '</background-job-wake>',
].join('\n');

const opening: RunEvent = { seq: 1, type: 'user', turnId: 'turn-1', ts: TS, payload: { text: 'Start them.' } };

/** A `user` event as ingest stores a wake turn: the echo, and the same block recorded as the note. */
const wakeEvent = (seq: number, block: string, extra: Record<string, unknown> = {}): RunEvent => ({
  seq,
  type: 'user',
  turnId: `turn-wake-${seq}`,
  ts: TS,
  payload: { text: block, controlPlaneNote: block, ...extra },
});
const reply = (seq: number, text: string, turnId = `turn-wake-${seq - 1}`): RunEvent => ({
  seq,
  type: 'assistant',
  turnId,
  ts: TS,
  payload: { text },
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
});

function mount(events: RunEvent[], runs: SubagentRunView[], queued: ReadonlyMap<string, () => void> = new Map()) {
  act(() =>
    root.render(
      <MemoryRouter>
        <SubagentRunsCtx.Provider value={new Map(runs.map((r) => [r.toolUseId, r]))}>
          <SubagentQueuedWakesCtx.Provider value={queued}>
            <Transcript events={events} live={false} />
          </SubagentQueuedWakesCtx.Provider>
        </SubagentRunsCtx.Provider>
      </MemoryRouter>,
    ),
  );
}

/** The one SubAgent of a block: its card, its view and its whole conversation. */
function oneRun(block: string, over: Partial<SubagentRunView> = {}) {
  const { runId, status, description } = RUN_OF.get(block)!;
  const events = [opening, ...delegate(2, 'toolu_bg', runId, description), wakeEvent(9, block), reply(10, 'Carrying on.')];
  return { events, view: run('toolu_bg', status, over), runId };
}

/** Every element on the page that stands for a SubAgent: its cards, and any line drawn for its end. */
const subagentElements = () => container.querySelectorAll('[data-delegate-call], .bgwake, .orbitwake, .sawake');
const theCard = (): HTMLElement => {
  const cards = container.querySelectorAll<HTMLElement>('[data-delegate-call]');
  expect(cards).toHaveLength(1);
  return cards[0];
};
const openCard = (card: HTMLElement) => act(() => card.querySelector<HTMLElement>('.chat-tool-row')!.click());
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('a background SubAgent, from start to end', () => {
  it('runs as one card with its live line', () => {
    const { events, runId } = oneRun(SUBAGENT_DONE);
    mount(events.slice(0, 4), [run('toolu_bg', 'RUNNING')]);
    const card = theCard();
    expect(card.dataset.subagentRun).toBe(runId);
    expect(card.querySelector('.chat-tool-status.running')).not.toBeNull();
    expect(card.querySelector('.chat-tool-live')?.textContent).toBe('Edit x.ts');
    expect(card.querySelector('.chat-subagent-ending, .chat-subagent-end-chip')).toBeNull();
  });

  it('ends DONE on the same card: ✓ and no word, two lines of its result, and nothing where the end turn opened', () => {
    const { events } = oneRun(SUBAGENT_DONE);
    mount(events, [oneRun(SUBAGENT_DONE).view]);
    expect(subagentElements()).toHaveLength(1);
    const card = theCard();
    expect(card.querySelector('.chat-tool-status.ok')?.getAttribute('aria-label')).toBe('done');
    expect(card.querySelector('.chat-subagent-end-chip')).toBeNull();
    expect(card.querySelector('.chat-tool-live')).toBeNull();
    const ending = card.querySelector('.chat-subagent-ending.is-ok .chat-subagent-ending-md')!;
    expect(ending.querySelector('strong')?.textContent).toBe('quota/');
    // The end turn: nothing at all — only the reader's own message is a bubble, and the agent's answer reads on.
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
    expect(container.textContent).toContain('Carrying on.');
    expect(container.textContent).not.toContain('SubAgent finished');
    expect(container.textContent).not.toContain('From Orbit');
  });

  for (const [block, word, tone, mark, reason] of [
    [SUBAGENT_FAILED, 'failed', 'is-failed', '.chat-tool-status.err', 'It did not finish its work.'],
    [SUBAGENT_INTERRUPTED, 'interrupted', 'is-failed', '.chat-tool-status.err', 'The runner hosting it stopped (a restart, an update or a crash) before it finished.'],
    [SUBAGENT_STOPPED, 'stopped', 'is-stopped', '.chat-tool-status.stopped', 'Stopped by the agent.'],
  ] as const) {
    it(`ends ${word} on the same card: the mark, a ${word} chip, the reason once and the files it left`, () => {
      const { events, view } = oneRun(block);
      mount(events, [view]);
      expect(subagentElements()).toHaveLength(1);
      const card = theCard();
      expect(card.querySelector('.chat-tool-status.ok')).toBeNull();
      expect(card.querySelector(mark)?.getAttribute('aria-label')).toBe(word);
      const chip = card.querySelector('.chat-subagent-end-chip')!;
      expect(chip.textContent).toBe(word);
      expect(chip.classList.contains(tone)).toBe(true);
      const ending = card.querySelector(`.chat-subagent-ending.${tone}`)!;
      expect(ending.querySelector('.chat-subagent-ending-reason')?.textContent).toBe(reason);
      expect(ending.querySelector('.chat-subagent-ending-files')?.textContent).toBe(
        '5 files left uncommitted Show filesmodel-routing.ts · task-route-decision.ts · +3',
      );
      expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
      expect(container.querySelector('.bgwake, .orbitwake')).toBeNull();
    });
  }

  it('says an interrupted run’s reason once, folded and opened, never the runner’s restatement', () => {
    const { events, view, runId } = oneRun(SUBAGENT_INTERRUPTED, {
      changedFiles: Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`),
    });
    mount(events, [view]);
    const card = theCard();
    expect(card.querySelector('.chat-subagent-ending-files')?.textContent).toContain('9 files left uncommitted');
    expect(count(card.textContent!, 'before it finished')).toBe(1);
    expect(card.textContent).not.toContain('The SubAgent was interrupted');

    // `Show files` opens the card on its end block.
    act(() => card.querySelector<HTMLElement>('.chat-subagent-ending-files button')!.click());
    expect(card.classList.contains('is-open')).toBe(true);
    const end = card.querySelector('.chat-subagent-end.is-failed')!;
    expect(end.querySelector('.chat-subagent-end-head')?.textContent).toMatch(
      /^Interrupted .+: the runner hosting it stopped \(a restart, an update or a crash\) before it finished\.$/,
    );
    expect(card.querySelector('.chat-subagent-ending')).toBeNull();
    expect(card.textContent).not.toContain('The SubAgent was interrupted');
    // Reason once in the card's text, outside what the agent read.
    const shown = card.cloneNode(true) as HTMLElement;
    shown.querySelector('details.chat-subagent-end-raw')!.remove();
    expect(count(shown.textContent!, 'before it finished')).toBe(1);

    expect(end.querySelector('.chat-subagent-end-files-head')?.textContent).toBe('9 files left uncommitted in the working tree:');
    const files = () => [...end.querySelectorAll('.chat-subagent-end-files li')].map((li) => li.textContent);
    expect(files()).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', '… 6 more']);
    act(() => end.querySelector<HTMLElement>('.chat-subagent-end-files button')!.click());
    expect(files()).toHaveLength(9);

    const raw = end.querySelector<HTMLDetailsElement>('details.chat-subagent-end-raw')!;
    expect(raw.open).toBe(false);
    expect(raw.querySelector('summary')?.textContent).toBe('What the agent read');
    expect(raw.querySelector('pre')?.textContent).toBe(SUBAGENT_INTERRUPTED);
    const at = new Date(TS).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    expect(end.querySelector('.chat-subagent-end-run')?.textContent).toBe(`Run ${runId} · read by the agent at ${at}`);
  });

  it('greys a stopped run’s end when opened, as no failure', () => {
    const { events, view } = oneRun(SUBAGENT_STOPPED);
    mount(events, [view]);
    const card = theCard();
    openCard(card);
    expect(card.querySelector('.chat-subagent-end.is-stopped .chat-subagent-end-head')?.textContent).toMatch(
      /^Stopped .+ by the agent\.$/,
    );
    expect(card.querySelector('.chat-subagent-end.is-failed')).toBeNull();
  });

  it('updates each card of a wake that names two runs, and draws nothing at the wake', () => {
    const events = [
      opening,
      ...delegate(2, 'toolu_a', '34y5Qcall0000000000001', 'Find every caller of pollQuota'),
      ...delegate(5, 'toolu_b', '34y5Qspec0000000000002', 'Write the poller spec'),
      wakeEvent(9, SUBAGENT_TWO),
      reply(10, 'One of them failed.'),
    ];
    mount(events, [run('toolu_a', 'DONE'), run('toolu_b', 'FAILED')]);
    expect(subagentElements()).toHaveLength(2);
    const [a, b] = [...container.querySelectorAll<HTMLElement>('[data-delegate-call]')];
    expect(a.querySelector('.chat-tool-status.ok')).not.toBeNull();
    expect(b.querySelector('.chat-subagent-end-chip')?.textContent).toBe('failed');
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
    expect(container.textContent).not.toContain('SubAgents finished');
    // Each card holds the block the agent read.
    openCard(a);
    expect(a.querySelector('.chat-subagent-end-raw pre')?.textContent).toBe(SUBAGENT_TWO);
  });

  it('draws nothing for a wake written into the running turn', () => {
    const events = [
      opening,
      ...delegate(2, 'toolu_a', '34y5Qcall0000000000001', 'Find every caller of pollQuota'),
      reply(5, 'Still working.', 'turn-1'),
      { ...wakeEvent(9, SUBAGENT_STEER, { steer: true, delivery: 'enqueued' }), turnId: 'turn-1' },
      { seq: 10, type: 'user_delivery', turnId: 'turn-1', ts: TS, payload: { turnId: 'turn-1', delivery: 'acknowledged' } },
    ];
    mount(events, [run('toolu_a', 'DONE')]);
    expect(subagentElements()).toHaveLength(1);
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
    expect(container.querySelector('.bgwake-steer')).toBeNull();
    expect(container.textContent).not.toContain('It ended while you were working');
  });

  it('draws nothing for a background job’s news written beside the end either: the job’s own card says it', () => {
    const { events, view } = oneRun(SUBAGENT_DONE);
    events[4] = wakeEvent(9, `${SUBAGENT_DONE}\n\n${JOB}`);
    mount(events, [view]);
    expect(container.querySelectorAll('.bgwake')).toHaveLength(0);
    // Only the opening message is a bubble.
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
    expect(container.querySelectorAll('[data-delegate-call]')).toHaveLength(1);
  });

  it('draws the From Orbit line for a block in a wording it does not know', () => {
    const unknown = SUBAGENT_DONE.replace('finished: DONE', 'finished: CANCELLED');
    mount([wakeEvent(9, unknown)], []);
    expect(container.querySelector('.chat-user')).toBeNull();
    expect(container.querySelector('.orbitwake .bgwake-title')?.textContent).toBe('From Orbit');
  });
});

describe('a SubAgent’s end turn still on the queue', () => {
  it('says so on the card with Don’t send, which withdraws it; the line is gone once it is delivered', () => {
    const { events, view, runId } = oneRun(SUBAGENT_INTERRUPTED);
    const queuedEvents = events.slice(0, 4);
    const dontSend = vi.fn();
    mount(queuedEvents, [view], new Map([[runId, dontSend]]));
    const card = theCard();
    const line = card.querySelector('.chat-subagent-queued')!;
    expect(line.textContent).toBe("Waiting for the agent to read it · Don't send");
    // Folded and opened alike.
    openCard(card);
    expect(card.querySelector('.chat-subagent-queued')).not.toBeNull();
    act(() => card.querySelector<HTMLElement>('.chat-subagent-queued button')!.click());
    expect(dontSend).toHaveBeenCalledTimes(1);
    // The card did not toggle on the press.
    expect(card.classList.contains('is-open')).toBe(true);

    // Delivered: off the queue, in the transcript, and read.
    mount(events, [view]);
    expect(container.querySelector('.chat-subagent-queued')).toBeNull();
    expect(subagentElements()).toHaveLength(1);
  });

  it('is told apart from the tail’s own rows: a SubAgent-only wake leaves the tail, and so does one with job news', () => {
    expect(queuedSubagentWake({ content: SUBAGENT_TWO })).toEqual({
      runIds: ['34y5Qcall0000000000001', '34y5Qspec0000000000002'],
      alone: true,
    });
    // A job's news beside it waits on the job's card too (JobCard): nothing is left for the tail to draw.
    expect(queuedSubagentWake({ content: `${SUBAGENT_DONE}\n\n${JOB}` })?.alone).toBe(true);
    expect(queuedSubagentWake({ content: 'deploy it' })).toBeNull();
    expect(queuedSubagentWake({ content: SUBAGENT_DONE, sessionMessage: {} })).toBeNull();
  });

  it('is listed with its block as the control plane’s note', () => {
    const row = { turnId: 'wake-1', content: SUBAGENT_DONE, createdAt: TS, status: 'QUEUED' } as unknown as Parameters<
      typeof queuedTurnEvent
    >[0];
    expect(queuedTurnEvent(row).payload).toMatchObject({ controlPlaneNote: SUBAGENT_DONE });
  });

  it('never goes back to the composer as though the reader had typed it', () => {
    expect(returnsToComposer({ content: SUBAGENT_DONE })).toBe(false);
    expect(returnsToComposer({ content: 'deploy it' })).toBe(true);
  });
});
