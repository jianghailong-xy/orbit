// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBAGENT_DONE,
  SUBAGENT_FAILED,
  SUBAGENT_INTERRUPTED,
  SUBAGENT_STEER,
  SUBAGENT_STOPPED,
  SUBAGENT_TWO,
} from '../lib/subagentFinished.fixtures';
import { queuedTurnEvent } from '../lib/acceptedUserTurn';
import { returnsToComposer } from '../lib/queuedTurnRestore';
import type { RunEvent } from './Transcript';

/**
 * A turn the control plane opened because a SubAgent ended used to draw as the reader's own bubble,
 * `⊕ Orbit attached: context` over the raw block, protocol sentences for the agent and all. It is one
 * line in the agent's stream instead (docs/mocks/subagent-finished-line): the purple ✦ of the
 * SubAgent card, how it ended, three lines of what it handed back as Markdown, and the rest one
 * native disclosure away.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { ExportCtx, Transcript } = await import('./Transcript');

const TS = '2026-11-15T16:30:00.000Z';

/** A `user` event as ingest stores a wake turn: the echo, and the same block recorded as the note. */
const wakeEvent = (block: string, extra: Record<string, unknown> = {}): RunEvent => ({
  seq: 9,
  type: 'user',
  turnId: 'turn-wake',
  ts: TS,
  payload: { text: block, controlPlaneNote: block, ...extra },
});

/** The sentences the block closes on: the agent's, never shown outside "What the agent read". */
const PROTOCOL = [
  'The control plane opened this turn for it',
  'It ended while you were working',
  'the user did not say it',
  'call delegate with resume',
  'review it before you commit',
];

describe('a SubAgent’s finished wake in the transcript', () => {
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

  async function mount(events: RunEvent[]) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>,
      );
    });
  }

  const line = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.sawake');
    if (!el) throw new Error(`no SubAgent line was rendered:\n${container.innerHTML}`);
    return el;
  };
  const row = (): Element => line().querySelector('summary.bgwake-row')!;
  const fold = (): HTMLDetailsElement => line().querySelector<HTMLDetailsElement>('details.bgwake-fold')!;
  /** What the line shows with its fold shut. */
  const shown = (): string => {
    const copy = line().cloneNode(true) as HTMLElement;
    copy.querySelector('.bgwake-body')?.remove();
    return copy.textContent ?? '';
  };
  const openFold = async () => {
    await act(async () => {
      fold().open = true;
      fold().dispatchEvent(new Event('toggle'));
    });
  };

  it('is one line in the agent’s stream with the result under it, not a message the user typed', async () => {
    await mount([wakeEvent(SUBAGENT_DONE)]);

    expect(container.querySelector('.chat-user'), 'no user bubble').toBeNull();
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.querySelector('[data-orbit-round]'), 'the line is no sticky anchor').toBeNull();
    expect(line().getAttribute('data-seq')).toBe('9');
    expect(line().className).toContain('is-ok');

    expect(row().querySelector('.bgwake-mark')?.textContent).toBe('✦');
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('SubAgent finished');
    expect(row().querySelector('.bgwake-name')?.textContent).toBe('Deploy 6bb50a957 to production');
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('done');
    expect(row().querySelector('.bgwake-time')?.textContent).not.toBe('');
    expect(row().querySelector('.bgwake-details-label')?.textContent).toBe('Details');

    // The result, outside the fold, as Markdown: backticks and bold take effect.
    const result = line().querySelector('.sawake-result')!;
    expect(fold().contains(result)).toBe(false);
    expect(result.querySelector('code')?.textContent).toBe('/tmp/orbit-upgrade.lock/pid');
    expect(result.querySelector('strong')?.textContent).toBe('916891');
    expect(result.textContent).not.toContain('**');
    expect(result.querySelector('.sawake-result-md')?.classList.contains('is-clamped')).toBe(true);
    const toggle = result.querySelector<HTMLButtonElement>('.sawake-result-toggle')!;
    expect(toggle.textContent).toBe('Show full result');
    await act(async () => toggle.click());
    expect(result.querySelector('.sawake-result-md')?.classList.contains('is-clamped')).toBe(false);
    expect(toggle.textContent).toBe('Show less');
    expect(fold().open, 'opening the result does not open the details').toBe(false);
    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('Show full result');

    for (const sentence of PROTOCOL) expect(shown()).not.toContain(sentence);
  });

  it('opens to the run, who queued it and what the agent read', async () => {
    await mount([wakeEvent(SUBAGENT_DONE)]);

    expect(fold().open).toBe(false);
    const body = fold().querySelector('.bgwake-body')!;
    expect(body.querySelector('.sawake-meta-runs')?.textContent).toBe('Run 34y5NxcqKYA179mC04VUB');
    expect([...body.querySelectorAll('.bgwake-meta')].map((el) => el.textContent)).toEqual([
      'Changes left in the working tree, uncommitted',
      'Queued by a SubAgent, not typed by you',
    ]);
    const raw = body.querySelector<HTMLDetailsElement>('details.bgwake-raw')!;
    expect(raw.open).toBe(false);
    expect(raw.querySelector('summary')?.textContent).toBe('What the agent read');
    expect(raw.querySelector('pre')?.textContent).toBe(SUBAGENT_DONE);
    // The agent's sentences are there, and only there.
    const outsideRaw = line().cloneNode(true) as HTMLElement;
    outsideRaw.querySelector('details.bgwake-raw')!.remove();
    for (const sentence of PROTOCOL) expect(outsideRaw.textContent).not.toContain(sentence);

    // With no delegate card on the page there is nothing to point at.
    await openFold();
    expect(body.querySelector('.sawake-card-link')).toBeNull();
  });

  it('points back at the delegate card the run was started from, when it is on the page', async () => {
    const scrolled = vi.fn();
    const call: RunEvent[] = [
      { seq: 1, type: 'user', turnId: 'turn-1', ts: TS, payload: { text: 'ship it' } },
      {
        seq: 2,
        type: 'tool_use',
        turnId: 'turn-1',
        ts: TS,
        payload: {
          id: 'toolu_deploy',
          name: 'mcp__orbit__delegate',
          input: { description: 'Deploy 6bb50a957 to production', prompt: 'Deploy it', background: true },
        },
      },
      {
        seq: 3,
        type: 'tool_result',
        turnId: 'turn-1',
        ts: TS,
        payload: { toolUseId: 'toolu_deploy', content: JSON.stringify({ runId: '34y5NxcqKYA179mC04VUB', status: 'running' }) },
      },
    ];
    await mount([...call, wakeEvent(SUBAGENT_DONE)]);

    const card = container.querySelector<HTMLElement>('[data-subagent-run="34y5NxcqKYA179mC04VUB"]');
    expect(card, 'the delegate card says which run it started').not.toBeNull();
    card!.scrollIntoView = scrolled;
    await openFold();
    const link = line().querySelector<HTMLAnchorElement>('.sawake-card-link')!;
    expect(link.textContent).toBe('↑ Its SubAgent card');
    await act(async () => link.click());
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it('turns red and says why for a run that did not finish', async () => {
    await mount([wakeEvent(SUBAGENT_INTERRUPTED)]);

    expect(line().className).toContain('is-failed');
    expect(row().querySelector('.bgwake-title')?.textContent).toBe('SubAgent did not finish');
    expect(row().querySelector('.bgwake-name')?.textContent).toBe('Port the retry to the Go runner');
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('interrupted');
    const outcome = line().querySelector('.sawake-outcome')!;
    expect(fold().contains(outcome)).toBe(false);
    expect(outcome.classList.contains('is-failed')).toBe(true);
    expect(outcome.querySelector('.sawake-reason')?.textContent).toMatch(
      /^The runner process hosting it stopped \(a restart, an update or a crash\)/,
    );
    expect(outcome.querySelector('.sawake-noresult')?.textContent).toBe('No result');

    await mount([wakeEvent(SUBAGENT_FAILED)]);
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('failed');
    expect(line().querySelector('.sawake-reason')?.textContent).toBe('It did not finish its work.');
    expect(line().querySelector('.sawake-result code')?.textContent).toBe('../quota/poller');

    await mount([wakeEvent(SUBAGENT_STOPPED)]);
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('stopped');
    expect(line().querySelector('.sawake-reason')?.textContent).toBe('It was stopped before it finished.');
  });

  it('counts several runs on the line and gives each a row of its own', async () => {
    await mount([wakeEvent(SUBAGENT_TWO)]);

    expect(row().querySelector('.bgwake-title')?.textContent).toBe('2 SubAgents finished');
    expect(row().querySelector('.bgwake-name')).toBeNull();
    expect(row().querySelector('.bgwake-status')?.textContent).toBe('1 of 2 failed');
    const runs = [...line().querySelectorAll<HTMLElement>('.sawake-runs > .sawake-run')];
    expect(runs.map((run) => [
      run.querySelector('.sawake-run-mark')?.textContent,
      run.querySelector('.sawake-run-name')?.textContent,
      run.querySelector('.bgwake-status')?.textContent,
    ])).toEqual([
      ['✓', 'Find every caller of pollQuota', 'done'],
      ['✕', 'Write the poller spec', 'failed'],
    ]);
    expect(runs[1].classList.contains('is-failed')).toBe(true);
    // One line of each result: the first.
    expect(runs[0].querySelector('.sawake-run-line')?.textContent).toBe(
      'Three callers, all in quota/: poller.ts, account.ts, limits.ts.',
    );
    expect(runs[1].querySelector('.sawake-run-line code')?.textContent).toBe('../quota/poller');
    expect(fold().querySelectorAll('.sawake-meta-runs > li')).toHaveLength(2);
    for (const sentence of PROTOCOL) expect(shown()).not.toContain(sentence);
  });

  it('says how far a wake written into the running turn got, as a steer does', async () => {
    await mount([
      { seq: 1, type: 'user', turnId: 'turn-running', ts: TS, payload: { text: 'fix the card' } },
      { seq: 2, type: 'assistant', turnId: 'turn-running', ts: TS, payload: { text: 'On it.' } },
      wakeEvent(SUBAGENT_STEER, { steer: true, delivery: 'enqueued' }),
      { seq: 10, type: 'user_delivery', turnId: 'turn-running', ts: TS, payload: { turnId: 'turn-wake', delivery: 'acknowledged' } },
    ]);

    expect(line().querySelector('.bgwake-steer')?.textContent).toBe('Read in this turn');
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
    expect(shown()).not.toContain('It ended while you were working');
  });

  it('keeps a background job’s news in the same note as its own line, and anything else in the fold', async () => {
    const job = [
      '<background-job-wake>',
      '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
      '    bgj_13c53745a88a｜job｜make test｜unit tests',
      '      ended｜completed｜exit code 0',
      '      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10',
      '      (no output)',
      '  The control plane recorded this for you; the user did not say it.',
      '</background-job-wake>',
    ].join('\n');
    await mount([wakeEvent(`${SUBAGENT_DONE}\n\n${job}`)]);
    expect(container.querySelectorAll('.bgwake')).toHaveLength(2);
    expect(container.querySelector('.bgwake:not(.sawake) .bgwake-title')?.textContent).toBe('Background job finished');
    expect(container.querySelector('.chat-user')).toBeNull();

    const extra = '<orbit-standing-role>\nYou coordinate project P.\n</orbit-standing-role>';
    await mount([wakeEvent(`${SUBAGENT_DONE}\n\n${extra}`)]);
    expect(container.querySelectorAll('.bgwake')).toHaveLength(1);
    expect(container.querySelector('.chat-user')).toBeNull();
    expect(fold().querySelector('.bgwake-body')?.textContent).toContain('Orbit attached');
    expect(shown()).not.toContain('Orbit attached');
  });

  // A wording it does not know is still Orbit's alone: the generic From Orbit line, never the reader's bubble
  // (owner rule 2026-11-16, OrbitEventLine).
  it('draws the From Orbit line for a block in a wording it does not know', async () => {
    const unknown = SUBAGENT_DONE.replace('finished: DONE', 'finished: CANCELLED');
    await mount([wakeEvent(unknown)]);
    expect(container.querySelector('.sawake')).toBeNull();
    expect(container.querySelector('.chat-user')).toBeNull();
    expect(container.querySelector('.orbitwake .bgwake-title')?.textContent).toBe('From Orbit');
  });

  it('keeps the line, the whole result and a fold the browser can open in an exported transcript', () => {
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <Transcript events={[wakeEvent(SUBAGENT_DONE)]} live={false} />
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html');
    expect(exported.querySelector('.sawake .bgwake-title')?.textContent).toBe('SubAgent finished');
    expect(exported.querySelector('details.bgwake-fold > summary.bgwake-row')).not.toBeNull();
    expect(exported.querySelector('details.bgwake-fold details.bgwake-raw pre')?.textContent).toBe(SUBAGENT_DONE);
    // No script to open a clamp with: all of the result is there.
    expect(exported.querySelector('.sawake-result-md.is-clamped')).toBeNull();
    expect(exported.querySelector('.sawake-result-toggle')).toBeNull();
    expect(exported.querySelector('.sawake-result')?.textContent).toContain('steps 2–6 can be re-run as written');
  });
});

describe('a SubAgent’s finished wake still on the queue', () => {
  const row = { turnId: 'wake-1', content: SUBAGENT_DONE, createdAt: TS, status: 'QUEUED' } as unknown as Parameters<
    typeof queuedTurnEvent
  >[0];

  it('is listed with its block as the control plane’s note, so the tail draws the same line', () => {
    expect(queuedTurnEvent(row).payload).toMatchObject({ controlPlaneNote: SUBAGENT_DONE });
  });

  it('never goes back to the composer as though the reader had typed it', () => {
    expect(returnsToComposer({ content: SUBAGENT_DONE })).toBe(false);
    expect(returnsToComposer({ content: 'deploy it' })).toBe(true);
  });
});
