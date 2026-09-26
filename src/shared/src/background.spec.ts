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

// The workspace's own background sub-agents and workflows, in Claude Code's own wording (claude
// 2.1.282, copied from a production session whose tray showed none of them while they ran).
describe('background sub-agents and workflows', () => {
  const AGENT_ACK =
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste' +
    ' any part of it, including the agentId below, into a user-facing reply.) agentId: a05fc3596d22b3d3e';
  const WORKFLOW_RECEIPT =
    'Workflow launched in background. Task ID: w2f3yv1s8\nSummary: 3 competing designs; 2 judges\n' +
    'Transcript dir: /root/.claude/projects/x/subagents/workflows/wf_37d4e19e-c97';
  const call = (seq: number, id: string, name: string, input: object, parentToolUseId?: string): BgDeriveEvent => ({
    seq,
    type: RunEventType.TOOL_USE,
    ts: `2026-09-25T08:00:${String(seq).padStart(2, '0')}.000Z`,
    payload: { id, name, input, ...(parentToolUseId ? { parentToolUseId } : {}) },
  });
  const result = (seq: number, id: string, content: unknown, parentToolUseId?: string): BgDeriveEvent => ({
    seq,
    type: RunEventType.TOOL_RESULT,
    payload: { toolUseId: id, content, ...(parentToolUseId ? { parentToolUseId } : {}) },
  });
  const events: BgDeriveEvent[] = [
    call(1, 'tu_agent', 'Agent', { description: 'Deep-read wikova', run_in_background: true }),
    result(2, 'tu_agent', [{ type: 'text', text: AGENT_ACK }]),
    // One the sub-agent started: its end is reported to that sub-agent, never to this stream.
    call(3, 'tu_nested', 'Agent', { description: 'Crawler research' }, 'tu_agent'),
    result(4, 'tu_nested', AGENT_ACK.replace('a05fc3596d22b3d3e', 'a286710e930e01d6b'), 'tu_agent'),
    // An Agent run inline answers in its own result and has nothing running.
    call(5, 'tu_inline', 'Agent', { description: 'Quick lookup' }),
    result(6, 'tu_inline', 'Here is my research report.'),
    call(7, 'tu_wf', 'Workflow', { resumeFromRunId: 'wf_37d4e19e-c97' }),
    result(8, 'tu_wf', WORKFLOW_RECEIPT),
    ...noise(9, 'tu_read', 'Read', { file_path: '/repo/a.ts' }),
    // The agent resumed with SendMessage stops again, announced without its call's id.
    { seq: 20, type: RunEventType.BACKGROUND_TASK, payload: { toolUseId: '', shellId: 'a05fc3596d22b3d3e', status: 'completed' } },
  ];

  it('lists them from their receipts, running until their notification, titled by what they are', () => {
    const shells = deriveBackgroundShells(events, { sessionLive: true });
    expect(shells.map((s) => [s.kind, s.shellId, s.description, s.status])).toEqual([
      ['agent', 'a05fc3596d22b3d3e', 'Deep-read wikova', 'done'],
      ['workflow', 'w2f3yv1s8', '3 competing designs; 2 judges', 'running'],
    ]);
  });

  it('keeps the last progress a workflow ended with', () => {
    const ended = deriveBackgroundShells(
      [
        ...events,
        {
          seq: 30,
          type: RunEventType.BACKGROUND_TASK,
          payload: {
            toolUseId: 'tu_wf',
            shellId: 'w2f3yv1s8',
            status: 'completed',
            progress: {
              toolUseId: 'tu_wf',
              taskType: 'local_workflow',
              agents: [{ index: 4, label: 'design:page-wiki', state: 'done', toolCalls: 34 }],
              phases: [{ index: 1, title: 'Design' }],
            },
          },
        },
      ],
      { sessionLive: true },
    );
    const wf = ended.find((s) => s.kind === 'workflow');
    expect(wf?.status).toBe('done');
    expect(wf?.progress?.agents).toEqual([{ index: 4, label: 'design:page-wiki', state: 'done', toolCalls: 34 }]);
  });

  it('narrows to them losslessly', () => {
    const ctx = { sessionLive: true };
    expect(deriveBackgroundShells(selectBackgroundDerivationEvents(events), ctx)).toEqual(
      deriveBackgroundShells(events, ctx),
    );
    // The nested call is not read at all; the inline one is read and found to hold nothing.
    expect(
      selectBackgroundDerivationEvents(events)
        .filter((e) => e.type === RunEventType.TOOL_USE)
        .map((e) => (e.payload as { id: string }).id),
    ).toEqual(['tu_agent', 'tu_inline', 'tu_wf']);
  });
});
