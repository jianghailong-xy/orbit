// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundJobTailResponse, BgShell } from '@orbit/shared';
import type { RunEvent } from './Transcript';

/**
 * A bg_run job is one card from start to end (the owner's job-card board, file 350t1lTONlrPMjilBdXx7, choices
 * A1 B1 C1 D1 E1 F1, and rulings R1-R4 of 2026-11-21). The call draws the card; the job's runner reports, its
 * wakes and the tail read say how it stands; the turns its wakes opened draw nothing.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getBackgroundJobTail: vi.fn(), stopBackgroundJob: vi.fn() };
});

const { ApiError, getBackgroundJobTail, stopBackgroundJob } = await import('../api');
const tailMock = vi.mocked(getBackgroundJobTail);
const stopMock = vi.mocked(stopBackgroundJob);
const { Transcript } = await import('./Transcript');
const { BgJobHostCtx, JobQueuedWakesCtx, TAIL_PACE_MS, TAIL_RETRY_MS } = await import('./JobCard');

const JOB = 'bgj_9f3a21c07d55';
const SESSION = '34ySession00000000001';
const STARTED = '2026-11-20T10:20:00.000Z';
const ENDED = '2026-11-20T10:32:40.000Z';
const TITLE = 'Wait for CI JavaScript job on 4c8f5a8a1b';
const COMMAND = 'gh run watch 19632123456 --exit-status --interval 30';

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, ts = STARTED): RunEvent =>
  ({ seq: ++seq, type, turnId: 'turn-1', ts, payload }) as RunEvent;

/** The bg_run call, its receipt, and the launch pair the runner writes beside it. */
function launch(kind = 'watch', description: string | null = TITLE, command = COMMAND): RunEvent[] {
  seq = 0;
  const input: Record<string, unknown> = { command, kind, wakeOnExit: true };
  if (description) input.description = description;
  const receipt = {
    receiptVersion: 1,
    ok: true,
    outcome: 'written',
    operation: 'bg_run',
    id: JOB,
    status: 'running',
    entity: { jobId: JOB, shellId: JOB, kind, command, description, status: 'running', startedAt: STARTED },
  };
  return [
    ev('user', { text: 'Watch the CI run and tell me' }),
    ev('tool_use', { id: 'toolu_bg', name: 'mcp__orbit__bg_run', input }),
    ev('tool_use', { id: JOB, name: 'Bash', input: { command, run_in_background: true, description } }),
    ev('tool_result', {
      toolUseId: JOB,
      content: `Command running in background with ID: ${JOB}. Output is being written to: /root/.orbit/runs/s/${JOB}.output. Read it with mcp__orbit__bg_output.`,
    }),
    ev('tool_result', { toolUseId: 'toolu_bg', content: [{ type: 'text', text: JSON.stringify(receipt) }] }),
    ev('background_task', { shellId: JOB, toolUseId: JOB, status: 'running', kind, command }),
  ];
}

/** The runner's terminal report. */
const ended = (status: 'completed' | 'failed' | 'killed', extra: Record<string, unknown> = {}): RunEvent =>
  ev('background_task', { shellId: JOB, toolUseId: JOB, status, kind: 'watch', command: COMMAND, ...extra }, ENDED);

const CI_TAIL = [
  'Refreshing run status every 30 seconds.',
  '✓ Swift in 6m12s',
  '✓ Android in 9m40s',
  'X JavaScript in 11m58s — cancelled',
  'run ended before JavaScript finished: completed cancelled',
];

/** A wake block for the job, as runner-api/background-job-wake.ts writes it. */
function wakeBlock(trigger: string[], tail: string[] = CI_TAIL, head = 'has news you were waiting for; the control plane opened this turn for it:'): string {
  return [
    '<background-job-wake>',
    `  A background job you started with bg_run ${head}`,
    `    ${JOB}｜watch｜${COMMAND}｜${TITLE}`,
    ...trigger.map((line) => `      ${line}`),
    `      output /root/.orbit/runs/s/${JOB}.output｜this covers bytes 0–4096`,
    '      output tail:',
    ...tail.map((line) => `        ${line}`),
    '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
    '</background-job-wake>',
  ].join('\n');
}

function stallBlock(): string {
  return [
    '<background-job-stall>',
    '  A background job you started with bg_run is still running and has written nothing for as long as you asked to be told about; the control plane opened this turn for it:',
    `    ${JOB}｜watch｜${COMMAND}｜${TITLE}`,
    '      gone quiet｜still running｜running for 22m 0s when this was sent',
    '      no new output for 10m 0s｜last output at 2026-11-20T10:32:00Z',
    `      output /root/.orbit/runs/s/${JOB}.output｜this covers bytes 0–2048`,
    '      output tail:',
    '        Waiting for apiserver-next to pass its health check…',
    '</background-job-stall>',
  ].join('\n');
}

const SCHEDULED = [
  '<scheduled-wakeup>',
  '  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:',
  '    2026-11-20T10:30:00.000Z scheduled 600 seconds out, due 2026-11-20T10:40:00.000Z',
  '    reason: check the deploy',
  '  The control plane recorded this for you; the user did not say it.',
  '</scheduled-wakeup>',
].join('\n');

/** The wake turn as ingest stores it: nothing typed, the block as the control plane's note. */
const wakeTurn = (block: string, ts = ENDED, delivery?: string): RunEvent =>
  ev('user', { text: block, controlPlaneNote: block, ...(delivery ? { delivery } : {}) }, ts);

const tailAnswer = (lines: string[], status = 'running', exitCode: number | null = null): BackgroundJobTailResponse => ({
  jobId: JOB,
  status,
  exitCode,
  lines,
  truncated: false,
  outputBytes: 2048,
  readAt: '2026-11-20T10:25:00.000Z',
});

/** The server's Background list, which alone says whether a job can be stopped. */
const serverShell = (extra: Partial<BgShell> = {}): BgShell => ({
  shellId: JOB,
  kind: 'job',
  toolUseId: JOB,
  command: COMMAND,
  description: TITLE,
  outputPath: '',
  startedSeq: 3,
  startedTs: STARTED,
  status: 'running',
  stoppable: true,
  ...extra,
});

let container: HTMLDivElement;
let root: Root;
let phone = false;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  phone = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 600px)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  tailMock.mockReset();
  stopMock.mockReset();
  tailMock.mockRejectedValue(new ApiError('the runner predates the read', 409, 'RUNNER_CANNOT_READ_JOB_OUTPUT'));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface MountOpts {
  live?: boolean;
  host?: boolean;
  shells?: BgShell[];
  queued?: Map<string, () => void>;
}

function tree(events: RunEvent[], { live = true, host = true, shells = [], queued = new Map() }: MountOpts = {}): ReactNode {
  return (
    <MemoryRouter>
      <BgJobHostCtx.Provider value={host ? { sessionId: SESSION, serverShells: shells, where: 'workstation' } : null}>
        <JobQueuedWakesCtx.Provider value={queued}>
          <Transcript events={events} live={live} />
        </JobQueuedWakesCtx.Provider>
      </BgJobHostCtx.Provider>
    </MemoryRouter>
  );
}

async function mount(events: RunEvent[], opts: MountOpts = {}) {
  await act(async () => {
    root.render(tree(events, opts));
  });
}

const card = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-bg-job="${JOB}"]`);
  if (!el) throw new Error(`no Job card was rendered:\n${container.innerHTML}`);
  return el;
};
const row = (): HTMLElement => card().querySelector<HTMLElement>('.chat-tool-row')!;
const openCard = () => act(() => row().click());

describe('a bg_run call is its job’s one card', () => {
  it('draws one card where the call was, and nothing for the runner’s launch pair', async () => {
    await mount(launch());
    expect(container.querySelectorAll('[data-bg-job]')).toHaveLength(1);
    expect(card().classList.contains('chat-tool-card')).toBe(true);
    // Not the generic MCP card, and no Bash card for the launch the runner wrote for the Background list.
    expect(container.textContent).not.toContain('orbit · bg_run');
    expect(container.textContent).not.toContain('Bash');
    expect(container.textContent).not.toContain('running in background with ID');
    expect(container.querySelector('.chat-steps')).toBeNull();
  });

  it('carries a terminal icon, the description as its title, the kind chip and the run time — and never the word Job', async () => {
    await mount([...launch(), ended('completed', { exitCode: 0 })]);
    expect(row().querySelector('.chat-tool-icon .anticon')).not.toBeNull();
    expect(row().querySelector('.chat-job-title')?.textContent).toBe(TITLE);
    expect(row().querySelector('.chat-job-kind')?.textContent).toBe('watch');
    expect(row().querySelector('.chat-job-elapsed')?.textContent).toBe('12m 40s');
    expect(row().textContent).not.toMatch(/\bJob\b/);
    expect(container.querySelector('.chat-job-sub'), 'one line at desktop width').toBeNull();
  });

  it('is named by its command when started without a description', async () => {
    await mount(launch('job', null, 'npm run build'));
    expect(row().querySelector('.chat-job-title')?.textContent).toBe('npm run build');
    expect(row().querySelector('.chat-job-kind')?.textContent).toBe('job');
  });

  it('stays the generic call when bg_run refused', async () => {
    seq = 0;
    await mount([
      ev('tool_use', { id: 'toolu_bg', name: 'mcp__orbit__bg_run', input: { command: 'make', kind: 'job' } }),
      ev('tool_result', { toolUseId: 'toolu_bg', content: 'Plan mode refuses a background job.', isError: true }),
    ]);
    expect(container.querySelector('[data-bg-job]')).toBeNull();
    expect(container.querySelector('.chat-tool-card')).not.toBeNull();
  });
});

describe('the folded card, in each state', () => {
  it('running: a spinner and the newest line, read live', async () => {
    tailMock.mockResolvedValue(tailAnswer(['✓ src/components/Transcript.test.tsx (412 tests) 9.8s', '  running 3 of 641 files']));
    await mount(launch());
    expect(tailMock).toHaveBeenCalledWith(SESSION, JOB);
    expect(card().classList.contains('is-running')).toBe(true);
    expect(row().querySelector('.chat-tool-status.running')).not.toBeNull();
    expect(card().querySelector('.chat-job-line')?.textContent).toBe('  running 3 of 641 files');
    expect(row().querySelector('.chat-subagent-end-chip')).toBeNull();
  });

  it('running on a runner too old to read its output: no line and no error, the spinner kept', async () => {
    await mount(launch());
    expect(tailMock).toHaveBeenCalledTimes(1);
    expect(card().querySelector('.chat-job-line')).toBeNull();
    expect(row().querySelector('.chat-tool-status.running')).not.toBeNull();
    expect(card().textContent).not.toMatch(/error|RUNNER/i);
  });

  it('exit 0: a check and the last two lines, grey, with Show full output', async () => {
    await mount([...launch(), ended('completed', { exitCode: 0 }), wakeTurn(wakeBlock(['ended｜completed｜exit code 0']))]);
    expect(card().classList.contains('is-done')).toBe(true);
    expect(row().querySelector('.chat-tool-status.ok')).not.toBeNull();
    expect(row().querySelector('.chat-subagent-end-chip'), 'no word for a clean exit').toBeNull();
    const ending = card().querySelector('.chat-job-ending.is-done')!;
    expect(ending.querySelector('.chat-job-tail')?.textContent).toBe(CI_TAIL.slice(-2).join('\n'));
    expect(ending.querySelector('button')?.textContent).toBe('Show full output');
  });

  it('exit N: a red exit chip, a cross, the last two lines in red, and Show full output that opens the card', async () => {
    await mount([...launch(), ended('failed', { exitCode: 1 }), wakeTurn(wakeBlock(['ended｜failed｜exit code 1']))]);
    expect(card().classList.contains('is-failed')).toBe(true);
    const chip = row().querySelector('.chat-subagent-end-chip.is-failed')!;
    expect(chip.textContent).toBe('exit 1');
    expect(row().querySelector('.chat-tool-status.err')).not.toBeNull();
    const ending = card().querySelector('.chat-job-ending.is-failed')!;
    expect(ending.querySelector('.chat-job-tail')?.textContent).toBe(CI_TAIL.slice(-2).join('\n'));
    act(() => ending.querySelector<HTMLButtonElement>('button')!.click());
    expect(card().classList.contains('is-open')).toBe(true);
  });

  it('exit N from the runner’s report alone, before any wake is loaded', async () => {
    await mount([...launch(), ended('failed', { exitCode: 2, output: 'npm error network ECONNRESET\nERROR: exit code 1\n' })]);
    expect(row().querySelector('.chat-subagent-end-chip.is-failed')?.textContent).toBe('exit 2');
    expect(card().querySelector('.chat-job-tail')?.textContent).toBe('npm error network ECONNRESET\nERROR: exit code 1');
  });

  it.each([
    ['requested', 'Killed by the agent.'],
    ['stopped_by_owner', 'The person who owns this session stopped it from the app.'],
    ['runner_shutdown', 'The runner process hosting it stopped — a restart or a self-update — and the job was killed with it.'],
    ['session_cancelled', 'The session was cancelled, or handed to another runner process, and the job was killed with it.'],
  ])('killed (%s): a grey chip and the stop mark, and a line naming who stopped it', async (reason, line) => {
    await mount([...launch(), ended('killed', { reason })]);
    expect(card().classList.contains('is-killed')).toBe(true);
    expect(row().querySelector('.chat-subagent-end-chip.is-stopped')?.textContent).toBe('killed');
    expect(row().querySelector('.chat-tool-status.stopped')).not.toBeNull();
    expect(row().querySelector('.chat-tool-status.err'), 'a stop is no failure').toBeNull();
    expect(card().querySelector('.chat-job-ending.is-stopped')?.textContent).toBe(line);
  });

  it('killed, as its wake told it, when the runner’s report is not loaded', async () => {
    const events = launch().slice(0, 5);
    await mount([...events, wakeTurn(wakeBlock(['ended｜killed｜reason runner_shutdown (the runner process hosting it stopped — a restart or a self-update — and the job was killed with it)']))]);
    expect(row().querySelector('.chat-subagent-end-chip.is-stopped')?.textContent).toBe('killed');
    expect(card().querySelector('.chat-job-ending')?.textContent).toContain('a restart or a self-update');
  });

  it('quiet: an amber chip saying for how long, still spinning — and no line where it woke the agent', async () => {
    await mount([...launch(), wakeTurn(stallBlock())]);
    const chip = row().querySelector('.chat-job-chip.is-quiet')!;
    expect(chip.textContent).toBe('quiet 10m');
    expect(row().querySelector('.chat-tool-status.running')).not.toBeNull();
    expect(card().querySelector('.chat-job-line')?.textContent).toBe('Waiting for apiserver-next to pass its health check…');
    expect(container.querySelector('.bgwake')).toBeNull();
  });

  it('service: never ends, and keeps spinning', async () => {
    await mount(launch('service', 'npm run dev'));
    expect(row().querySelector('.chat-job-kind')?.textContent).toBe('service');
    expect(row().querySelector('.chat-tool-status.running')).not.toBeNull();
    expect(row().querySelector('.chat-subagent-end-chip')).toBeNull();
  });

  it('new output: still running, the tail refreshes, and no chip of its own', async () => {
    const outputWake = wakeBlock(['new output｜running'], ['check "Swift" → success (3 of 6 done)']);
    await mount([...launch(), wakeTurn(outputWake, '2026-11-20T10:28:00.000Z')]);
    expect(row().querySelector('.chat-tool-status.running')).not.toBeNull();
    expect(row().querySelector('.chat-subagent-end-chip, .chat-job-chip')).toBeNull();
    expect(card().querySelector('.chat-job-line')?.textContent).toBe('check "Swift" → success (3 of 6 done)');
    expect(container.querySelector('.bgwake')).toBeNull();
  });

  it('ended but not yet read: Waiting for the agent to read it · Don’t send, which keeps it back', async () => {
    const dontSend = vi.fn();
    await mount([...launch(), ended('failed', { exitCode: 1 })], { queued: new Map([[JOB, dontSend]]) });
    const waiting = card().querySelector('.chat-subagent-queued')!;
    expect(waiting.textContent).toBe("Waiting for the agent to read it · Don't send");
    act(() => waiting.querySelector<HTMLButtonElement>('button')!.click());
    expect(dontSend).toHaveBeenCalledTimes(1);
    expect(card().classList.contains('is-open'), 'the press does not toggle the card').toBe(false);
    // Opened, it is still there.
    openCard();
    expect(card().querySelector('.chat-subagent-queued')).not.toBeNull();
  });
});

describe('the opened card', () => {
  it('shows the command, where and when it ran, the last 40 lines with Show all, and each time it woke the agent', async () => {
    const long = Array.from({ length: 214 }, (_, i) => `line ${i + 1}`);
    await mount([...launch(), ended('failed', { exitCode: 1 }), wakeTurn(wakeBlock(['ended｜failed｜exit code 1'], long), ENDED, 'acknowledged')]);
    openCard();
    const detail = card().querySelector('.chat-job-detail')!;
    expect(detail.querySelector('.chat-pre-wrap.cmd')?.textContent).toBe(`$ ${COMMAND}`);
    const meta = detail.querySelector('.chat-job-meta')!.textContent!;
    expect(meta.startsWith(`${JOB} · watch · started `)).toBe(true);
    expect(meta.endsWith(' · ran 12m 40s · on workstation')).toBe(true);
    const output = detail.querySelector('.chat-job-output pre')!;
    expect(output.textContent!.split('\n')).toEqual(long.slice(-40));
    const all = detail.querySelector<HTMLButtonElement>('.chat-job-output button')!;
    expect(all.textContent).toBe('Show all 214 lines');
    act(() => all.click());
    expect(detail.querySelector('.chat-job-output pre')!.textContent!.split('\n')).toHaveLength(214);

    const wakes = detail.querySelector('.chat-job-wakes')!;
    expect(wakes.querySelector('.chat-subagent-end-head')?.textContent).toBe('Woke the agent 1 time');
    const rows = wakes.querySelectorAll('.chat-job-wake');
    expect(rows).toHaveLength(1);
    expect(rows[0].firstElementChild?.textContent).toMatch(/^\d\d:\d\d · exit 1 · read by the agent at \d\d:\d\d$/);
    const raw = rows[0].querySelector('details')!;
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('summary')?.textContent).toBe('What the agent read');
    expect(raw.querySelector('pre')?.textContent).toContain(`${JOB}｜watch｜`);
  });

  it('counts every wake, one row each: new output, quiet, then its end', async () => {
    await mount([
      ...launch(),
      wakeTurn(wakeBlock(['new output｜running'], ['3 of 6 done']), '2026-11-20T10:25:00.000Z'),
      wakeTurn(stallBlock(), '2026-11-20T10:30:00.000Z'),
      ended('completed', { exitCode: 0 }),
      wakeTurn(wakeBlock(['ended｜completed｜exit code 0'])),
    ]);
    openCard();
    expect(card().querySelector('.chat-job-wakes .chat-subagent-end-head')?.textContent).toBe('Woke the agent 3 times');
    const words = [...card().querySelectorAll('.chat-job-wake')].map((el) => el.firstElementChild!.textContent!.split(' · ')[1]);
    expect(words).toEqual(['new output', 'quiet 10m', 'exit 0']);
  });
});

describe('the turns a job’s wakes open', () => {
  it('draw nothing, while a schedule_wakeup with no job keeps its line', async () => {
    await mount([...launch(), ended('failed', { exitCode: 1 }), wakeTurn(wakeBlock(['ended｜failed｜exit code 1'])), wakeTurn(SCHEDULED)]);
    const lines = container.querySelectorAll('.bgwake');
    expect(lines).toHaveLength(1);
    expect(lines[0].querySelector('.bgwake-title')?.textContent).toBe('Scheduled wakeup');
    expect(lines[0].querySelector('.bgwake-name')?.textContent).toBe('check the deploy');
    expect(container.querySelectorAll('.chat-user')).toHaveLength(1);
  });
});

describe('Stop', () => {
  async function confirmStop(trigger: HTMLElement) {
    await act(async () => trigger.click());
    const popup = document.body.querySelector<HTMLElement>('.orbit-popconfirm')!;
    expect(popup.querySelector('.orbit-popconfirm-title')?.textContent).toBe('Stop this job?');
    const confirm = [...popup.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Stop')!;
    await act(async () => confirm.click());
  }

  it('asks first, then calls the stop route — from the opened card', async () => {
    stopMock.mockResolvedValue({ jobId: JOB, status: 'stopping' });
    await mount(launch(), { shells: [serverShell()] });
    openCard();
    const stop = card().querySelector<HTMLElement>('.chat-job-detail .chat-job-stop button')!;
    expect(stop.textContent).toBe('Stop');
    expect(stopMock).not.toHaveBeenCalled();
    await confirmStop(stop);
    expect(stopMock).toHaveBeenCalledWith(SESSION, JOB);
  });

  it('is on the folded card’s hover menu too, and pressing it does not open the card', async () => {
    stopMock.mockResolvedValue({ jobId: JOB, status: 'stopping' });
    await mount(launch(), { shells: [serverShell()] });
    const stop = row().querySelector<HTMLElement>('.chat-job-stop.is-hover button')!;
    await confirmStop(stop);
    expect(stopMock).toHaveBeenCalledWith(SESSION, JOB);
    expect(card().classList.contains('is-open')).toBe(false);
  });

  it('is not offered where the Background list marks the job not stoppable, nor once it ended, nor without a session', async () => {
    await mount(launch(), { shells: [serverShell({ stoppable: false })] });
    expect(card().querySelector('.chat-job-stop')).toBeNull();
    openCard();
    expect(card().querySelector('.chat-job-stop')).toBeNull();

    await mount([...launch(), ended('completed', { exitCode: 0 })], { shells: [serverShell()] });
    expect(card().querySelector('.chat-job-stop')).toBeNull();

    await mount(launch(), { host: false });
    expect(card().querySelector('.chat-job-stop')).toBeNull();
  });
});

describe('reading the tail while the card is on screen', () => {
  let observers: Array<{ cb: IntersectionObserverCallback; el?: Element; disconnected: boolean }>;
  const setOnScreen = async (on: boolean) => {
    await act(async () => {
      for (const o of observers) {
        if (!o.disconnected && o.el) o.cb([{ isIntersecting: on, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });
  };

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private o: { cb: IntersectionObserverCallback; el?: Element; disconnected: boolean };
        constructor(cb: IntersectionObserverCallback) {
          this.o = { cb, disconnected: false };
          observers.push(this.o);
        }
        observe(el: Element) {
          this.o.el = el;
        }
        disconnect() {
          this.o.disconnected = true;
        }
        unobserve() {}
      },
    );
    vi.useFakeTimers();
    tailMock.mockResolvedValue(tailAnswer(['one', 'two']));
  });

  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('starts when the card comes on screen, asks every 5 s after each answer, and stops when it leaves', async () => {
    await mount(launch());
    expect(tailMock, 'nothing is asked for a card that is not on screen').not.toHaveBeenCalled();
    await setOnScreen(true);
    expect(tailMock).toHaveBeenCalledTimes(1);
    expect(card().querySelector('.chat-job-line')?.textContent).toBe('two');
    await advance(TAIL_PACE_MS - 1);
    expect(tailMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(tailMock).toHaveBeenCalledTimes(2);
    await setOnScreen(false);
    await advance(TAIL_PACE_MS * 4);
    expect(tailMock).toHaveBeenCalledTimes(2);
    await setOnScreen(true);
    expect(tailMock).toHaveBeenCalledTimes(3);
  });

  it('stops while the app is in the background', async () => {
    await mount(launch());
    await setOnScreen(true);
    expect(tailMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(TAIL_PACE_MS * 3);
    expect(tailMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(tailMock).toHaveBeenCalledTimes(2);
  });

  it('stops when an answer says the job ended, and shows how it ended', async () => {
    tailMock.mockResolvedValueOnce(tailAnswer(['one'])).mockResolvedValueOnce(tailAnswer(['one', 'Error: boom'], 'failed', 1));
    await mount(launch());
    await setOnScreen(true);
    await advance(TAIL_PACE_MS);
    expect(tailMock).toHaveBeenCalledTimes(2);
    expect(row().querySelector('.chat-subagent-end-chip.is-failed')?.textContent).toBe('exit 1');
    await advance(TAIL_PACE_MS * 4);
    expect(tailMock).toHaveBeenCalledTimes(2);
  });

  it('stops when the job’s end arrives in the transcript, after one last read for its final lines', async () => {
    await mount(launch());
    await setOnScreen(true);
    expect(tailMock).toHaveBeenCalledTimes(1);
    tailMock.mockResolvedValue(tailAnswer(['one', 'two', 'done'], 'completed', 0));
    await mount([...launch(), ended('completed', { exitCode: 0 })]);
    expect(tailMock).toHaveBeenCalledTimes(2);
    await advance(TAIL_PACE_MS * 4);
    expect(tailMock).toHaveBeenCalledTimes(2);
    expect(card().querySelector('.chat-job-tail')?.textContent).toBe('two\ndone');
  });

  it('waits 30 s after an offline runner, and never asks again after a 404', async () => {
    tailMock.mockRejectedValueOnce(new ApiError('offline', 503, 'RUNNER_OFFLINE'));
    await mount(launch());
    await setOnScreen(true);
    expect(tailMock).toHaveBeenCalledTimes(1);
    expect(card().querySelector('.chat-job-line')).toBeNull();
    await advance(TAIL_RETRY_MS - 1);
    expect(tailMock).toHaveBeenCalledTimes(1);
    tailMock.mockRejectedValueOnce(new ApiError('gone', 404, 'BACKGROUND_JOB_NOT_FOUND'));
    await advance(1);
    expect(tailMock).toHaveBeenCalledTimes(2);
    await advance(TAIL_RETRY_MS * 3);
    expect(tailMock).toHaveBeenCalledTimes(2);
    expect(row().querySelector('.chat-tool-status.running')).not.toBeNull();
  });
});

describe('at phone width', () => {
  it('keeps the icon, title, exit chip and mark on the first line, and moves the kind and run time to a grey second line', async () => {
    phone = true;
    await mount([...launch(), ended('failed', { exitCode: 1 })]);
    expect(row().querySelector('.chat-job-title')?.textContent).toBe(TITLE);
    expect(row().querySelector('.chat-subagent-end-chip.is-failed')?.textContent).toBe('exit 1');
    expect(row().querySelector('.chat-tool-status.err')).not.toBeNull();
    expect(row().querySelector('.chat-job-kind, .chat-job-elapsed'), 'not on the first line').toBeNull();
    const sub = card().querySelector('.chat-job-sub')!;
    expect(sub.querySelector('.chat-job-kind')?.textContent).toBe('watch');
    expect(sub.querySelector('.chat-job-elapsed')?.textContent).toBe('12m 40s');
    expect(card().textContent).not.toMatch(/\bJob\b/);
  });
});
