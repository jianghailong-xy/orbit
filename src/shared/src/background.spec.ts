import { describe, expect, it } from 'vitest';
import {
  deriveBackgroundShells,
  selectBackgroundDerivationEvents,
  type BgDeriveEvent,
} from './background';
import { RunEventType } from './enums';

// Build the four event shapes the derivation reads. Mirrors what the runner persists for a
// Bash(run_in_background): the launch tool_use, its "running in background with ID…" tool_result,
// the agent's Read poll of the .output file, and the terminal background_task.
const launch = (seq: number, id: string, command: string, description?: string): BgDeriveEvent => ({
  seq,
  type: RunEventType.TOOL_USE,
  ts: `2026-07-10T00:00:${String(seq).padStart(2, '0')}.000Z`,
  payload: { id, name: 'Bash', input: { command, description, run_in_background: true } },
});
const launchResult = (seq: number, id: string, shellId: string, path: string): BgDeriveEvent => ({
  seq,
  type: RunEventType.TOOL_RESULT,
  ts: `2026-07-10T00:00:${String(seq).padStart(2, '0')}.000Z`,
  payload: {
    toolUseId: id,
    content: `Command running in background with ID: ${shellId}. Output is being written to: ${path}.`,
  },
});
const readPoll = (seq: number, id: string, path: string, output: string): BgDeriveEvent[] => [
  { seq, type: RunEventType.TOOL_USE, payload: { id, name: 'Read', input: { file_path: path } } },
  { seq: seq + 1, type: RunEventType.TOOL_RESULT, payload: { toolUseId: id, content: output } },
];
const bgTask = (seq: number, toolUseId: string, shellId: string, status: string): BgDeriveEvent => ({
  seq,
  type: RunEventType.BACKGROUND_TASK,
  payload: { toolUseId, shellId, status },
});

describe('deriveBackgroundShells', () => {
  it('recovers a completed agent shell — including its output — with NO background_output events', () => {
    // This is the exact shape of the reported session: agent-launched shells whose live
    // background_output tail is broadcast-only (never persisted), so the ONLY durable output
    // source is the agent's Read poll. The web read it; the iOS reducer didn't → "No output
    // captured yet". The server derivation must recover it here.
    const path = '/tmp/claude-0/x/tasks/byi5g0ifr.output';
    const events: BgDeriveEvent[] = [
      launch(7109, 'toolu_beta79', 'gh run watch "$RUN"', 'Watch beta.79 build (background)'),
      launchResult(7110, 'toolu_beta79', 'byi5g0ifr', path),
      ...readPoll(7134, 'toolu_read', path, '=== jobs ===\niOS · TestFlight: success'),
      bgTask(7300, 'toolu_beta79', 'byi5g0ifr', 'completed'),
    ];
    const shells = deriveBackgroundShells(events, { sessionLive: false });
    expect(shells).toHaveLength(1);
    const s = shells[0];
    expect(s.shellId).toBe('byi5g0ifr');
    expect(s.toolUseId).toBe('toolu_beta79');
    expect(s.description).toBe('Watch beta.79 build (background)');
    expect(s.command).toBe('gh run watch "$RUN"');
    expect(s.outputPath).toBe(path);
    expect(s.status).toBe('done');
    expect(s.latestOutput).toBe('=== jobs ===\niOS · TestFlight: success');
  });

  it('returns every launch in chronological order (the complete-list count)', () => {
    const events: BgDeriveEvent[] = [];
    for (const [seq, sid, desc] of [
      [3170, 'bx4e8f9vb', 'Watch PR CI'],
      [6180, 'bkjviefi1', 'Watch beta.78'],
      [7109, 'byi5g0ifr', 'Watch beta.79'],
    ] as const) {
      events.push(launch(seq, `tu_${sid}`, `cmd ${sid}`, desc));
      events.push(launchResult(seq + 1, `tu_${sid}`, sid, `/t/${sid}.output`));
      events.push(bgTask(seq + 2, `tu_${sid}`, sid, 'completed'));
    }
    const shells = deriveBackgroundShells(events, { sessionLive: false });
    expect(shells.map((s) => s.shellId)).toEqual(['bx4e8f9vb', 'bkjviefi1', 'byi5g0ifr']);
    expect(shells.every((s) => s.status === 'done')).toBe(true);
  });

  it('a launch with no terminal signal is running while live, unknown once settled', () => {
    const events: BgDeriveEvent[] = [
      launch(10, 'tu', 'sleep 999', 'watcher'),
      launchResult(11, 'tu', 'brunning1', '/t/brunning1.output'),
    ];
    expect(deriveBackgroundShells(events, { sessionLive: true })[0].status).toBe('running');
    expect(deriveBackgroundShells(events, { sessionLive: false })[0].status).toBe('unknown');
  });

  it('ignores a launch whose tool_result never confirmed a background id', () => {
    const events: BgDeriveEvent[] = [launch(10, 'tu', 'echo hi', 'nope')];
    expect(deriveBackgroundShells(events, { sessionLive: true })).toHaveLength(0);
  });
});

// Ordinary tool traffic — the bulk of a real session, and none of it readable by the derivation.
// `content` stands in for the megabytes of file bodies these carry in production.
const noise = (seq: number, id: string, name: string, input: unknown): BgDeriveEvent[] => [
  { seq, type: RunEventType.TOOL_USE, payload: { id, name, input } },
  { seq: seq + 1, type: RunEventType.TOOL_RESULT, payload: { toolUseId: id, content: 'x'.repeat(4096) } },
];

describe('selectBackgroundDerivationEvents', () => {
  // A session shaped like the ones that made /background expensive: two real background shells
  // buried in ordinary Read/Write/Bash/Grep traffic.
  const path = '/tmp/tasks/bshell01.output';
  const all: BgDeriveEvent[] = [
    ...noise(1, 'tu_read_src', 'Read', { file_path: '/repo/src/index.ts' }),
    launch(10, 'tu_bg1', 'npm run build', 'Build (background)'),
    launchResult(11, 'tu_bg1', 'bshell01', path),
    ...noise(20, 'tu_write', 'Write', { file_path: '/repo/a.ts', content: 'y'.repeat(2048) }),
    ...noise(30, 'tu_bash', 'Bash', { command: 'git status' }), // foreground Bash
    ...readPoll(40, 'tu_poll', path, 'build ok'),
    ...noise(50, 'tu_grep', 'Grep', { pattern: 'TODO' }),
    launch(60, 'tu_bg2', 'sleep 999', 'Watcher (background)'),
    launchResult(61, 'tu_bg2', 'bshell02', '/tmp/tasks/bshell02.output'),
    bgTask(70, 'tu_bg1', 'bshell01', 'completed'),
  ];

  it('derives exactly the same shells as scanning everything — the narrowing is lossless', () => {
    const ctx = { sessionLive: false };
    expect(deriveBackgroundShells(selectBackgroundDerivationEvents(all), ctx)).toEqual(
      deriveBackgroundShells(all, ctx),
    );
    // Not vacuously equal: this fixture really does have shells to lose.
    expect(deriveBackgroundShells(all, ctx).map((s) => s.shellId)).toEqual(['bshell01', 'bshell02']);
  });

  it('drops ordinary tool traffic — the payloads that made the whole-history scan expensive', () => {
    const kept = selectBackgroundDerivationEvents(all);
    const keptToolUseNames = kept
      .filter((e) => e.type === RunEventType.TOOL_USE)
      .map((e) => (e.payload as { name: string }).name);
    // Only the background Bash launches and the .output Read poll survive.
    expect(keptToolUseNames).toEqual(['Bash', 'Read', 'Bash']);
    // A foreground Bash, a Write, a source-file Read and a Grep — plus all four results — are gone.
    expect(kept.map((e) => e.seq)).toEqual([10, 11, 40, 41, 60, 61, 70]);
  });

  it('keeps a tool_result only when it answers one of the calls the derivation reads', () => {
    const kept = selectBackgroundDerivationEvents(all);
    const keptResultIds = kept
      .filter((e) => e.type === RunEventType.TOOL_RESULT)
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(keptResultIds).toEqual(['tu_bg1', 'tu_poll', 'tu_bg2']);
  });

  it('keeps every background_* event — they are few and always relevant', () => {
    const events: BgDeriveEvent[] = [
      ...noise(1, 'tu', 'Read', { file_path: '/a.ts' }),
      { seq: 5, type: RunEventType.BACKGROUND_TASK, payload: { shellId: 'b1', status: 'completed' } },
      { seq: 6, type: RunEventType.BACKGROUND_OUTPUT, payload: { shellId: 'b1', content: 'tail' } },
    ];
    expect(selectBackgroundDerivationEvents(events).map((e) => e.seq)).toEqual([5, 6]);
  });
});
