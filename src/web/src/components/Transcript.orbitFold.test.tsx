// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoordinatorDeliveryKind } from '@orbit/shared';
import type { ExchangeTreeLookup } from '../lib/orbitExchangeFold';
import { EXCHANGE_REVEAL_EVENT, ExchangeTreeCtx } from './OrbitExchangeFold';
import { ExportCtx, Transcript, type RunEvent } from './Transcript';

/**
 * Turns Orbit opened fold, with the agent's answer, into one line each, and a run of them into one
 * group line that opens by task (design: docs/mocks/coordinator-exchange-fold/). What the reader
 * said, the newest turn, and anything that went wrong or asks the reader stay drawn as before.
 */

const B1 = '0195c0de-0000-7000-8000-000000000011';
const B4 = '0195c0de-0000-7000-8000-000000000014';
const WATCH = '0195c0de-0000-7000-8000-0000000000c3';
const RUN_OF_B1 = '0195c0de-0000-7000-8000-0000000000a1';

let seq = 0;
let turn = 0;
const at = (m: number) => new Date(Date.parse('2026-11-11T09:00:00Z') + m * 60_000).toISOString();

function exchange(min: number, payload: Record<string, unknown>, reply: string, tools: string[] = ['mcp__orbit__task_get']): RunEvent[] {
  const turnId = `turn-${++turn}`;
  const out: RunEvent[] = [{ seq: ++seq, type: 'user', turnId, ts: at(min), payload }];
  for (const name of tools) {
    const id = `tool-${seq}`;
    out.push({ seq: ++seq, type: 'tool_use', turnId, ts: at(min), payload: { id, name, input: {} } });
    out.push({ seq: ++seq, type: 'tool_result', turnId, ts: at(min), payload: { toolUseId: id, content: 'ok' } });
  }
  out.push({ seq: ++seq, type: 'assistant', turnId, ts: at(min + 1), payload: { text: reply } });
  out.push({ seq: ++seq, type: 'turn_end', turnId, ts: at(min + 1), payload: {} });
  return out;
}

const delivery = (min: number, kind: CoordinatorDeliveryKind, taskId: string, title: string, revision: number | null = null) => ({
  text: `From Orbit · project “Link” has news about ${title}`,
  coordinatorDelivery: { kind, task: { id: taskId, title }, revision, count: null, deliveredAt: at(min), toCoordinator: true },
});

const watchText = (target: { kind: string; id: string; status?: string }) =>
  [
    `Orbit Watch ${WATCH} matched at generation 1: SESSION_IDLE 1/1`,
    '',
    'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
    '',
    '```json',
    JSON.stringify({
      watchId: WATCH,
      generation: 1,
      reason: 'SESSION_IDLE 1/1',
      changedTargets: [{ kind: target.kind, id: target.id, state: 'IDLE', ...(target.status ? { observed: { status: target.status } } : {}) }],
    }),
    '```',
  ].join('\n');

function conversation(): RunEvent[] {
  seq = 0;
  turn = 0;
  return [
    ...exchange(0, { text: 'Which tasks are waiting on me?' }, 'None right now.', []),
    ...exchange(10, delivery(10, 'EVIDENCE_SUBMITTED', B1, 'B1 Targeted hints', 2), '我确认了 B1（[定向提示](orbit-task:x)），它正在落地。\n\n**依据**'),
    ...exchange(20, { text: watchText({ kind: 'SESSION', id: RUN_OF_B1 }) }, '这是之前设的提醒，不用再做什么。'),
    ...exchange(30, delivery(30, 'DEPENDENT_READY', B4, 'B4 Link gateway'), 'B4 已经开工。'),
    ...exchange(40, { text: 'Why was B4b sent back?' }, 'It conflicts with B5.', []),
    ...exchange(50, delivery(50, 'EVIDENCE_SUBMITTED', B4, 'B4 Link gateway', 1), 'I confirmed B4.'),
  ];
}

const lookup: ExchangeTreeLookup = {
  taskOfSession: (id) => (id === RUN_OF_B1 ? { id: B1 } : null),
  upstreamOf: (id) => (id === B4 ? [B1] : []),
  taskTitle: () => undefined,
};

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

function mount(events: RunEvent[], { exporting = false } = {}) {
  const transcript = <Transcript events={events} />;
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ExchangeTreeCtx.Provider value={{ lookup, want: () => {} }}>
            {exporting ? <ExportCtx.Provider value={{ images: new Map() }}>{transcript}</ExportCtx.Provider> : transcript}
          </ExchangeTreeCtx.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const all = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => all(sel).map((el) => el.textContent);

describe('turns Orbit opened, folded', () => {
  it('folds a run of them into one group line, and keeps what the reader said and the newest turn', () => {
    mount(conversation());
    const group = q('.orbit-exchanges')!;
    expect(group.querySelector('.orbit-exchanges-count')!.textContent).toBe('3 Orbit updates handled');
    expect(group.querySelector('.orbit-exchanges-kinds')!.textContent).toBe('1 evidence, 1 can start, 1 watch');
    // Nothing of the folded turns is drawn: not their lines, not their replies.
    expect(container.textContent).not.toContain('我确认了 B1');
    expect(container.textContent).not.toContain('B4 已经开工');
    // The reader's own turns and the newest turn are drawn as they always were.
    expect(container.textContent).toContain('Which tasks are waiting on me?');
    expect(container.textContent).toContain('It conflicts with B5.');
    expect(all('.coordinator-delivery')).toHaveLength(1);
    expect(container.textContent).toContain('I confirmed B4.');
  });

  it('opens the group by task — the tasks a task waits on above it — and an exchange back to what it was', () => {
    mount(conversation());
    act(() => q('.orbit-exchanges-line')!.click());
    // One root: B1, with B4 under it. Shut, a branch sums up everything below it.
    expect(text('.orbit-exchanges-body > .orbit-branch > .orbit-branch-line .orbit-branch-title')).toEqual(['B1 Targeted hints']);
    expect(q('.orbit-branch-meta')!.textContent).toBe('3 updates · 1 downstream · last: B4 已经开工。');

    act(() => q('.orbit-branch-line')!.click());
    const rows = all('.orbit-branch.is-open > .orbit-branch-body > .orbit-exchange .orbit-exchange-line');
    // Under its task a row drops the task's name; the watch on B1's run is B1's.
    expect(rows.map((r) => r.querySelector('.orbit-exchange-what')!.textContent)).toEqual([
      'Evidence revision 2 submitted',
      'Watch triggered',
    ]);
    expect(rows[0].querySelector('.orbit-exchange-reply')!.textContent).toBe('我确认了 B1（定向提示），它正在落地。');

    act(() => rows[0].click());
    expect(q('.orbit-exchange.is-open .coordinator-delivery')).not.toBeNull();
    expect(q('.orbit-exchange.is-open')!.textContent).toContain('依据');
  });

  it('draws one exchange between two things the reader said as a line of its own', () => {
    const events = conversation().filter((e) => e.turnId !== 'turn-3' && e.turnId !== 'turn-4');
    mount(events);
    expect(q('.orbit-exchanges')).toBeNull();
    const line = q('.orbit-exchange-root .orbit-exchange-line')!;
    expect(line.querySelector('.orbit-exchange-what')!.textContent).toBe('Evidence revision 2 submitted: B1 Targeted hints');
    expect(line.querySelector('.orbit-exchange-time')!.textContent).not.toBe('');
  });

  it('leaves in view what went wrong or asks the reader', () => {
    seq = 0;
    turn = 0;
    const events = [
      ...exchange(0, delivery(0, 'PROJECT_BLOCKER_RAISED', B1, 'B1 Targeted hints'), 'B1 is blocked; restarting it.'),
      ...exchange(5, { text: watchText({ kind: 'TASK', id: B4, status: 'FAILED' }) }, 'B4 failed.'),
      ...exchange(10, delivery(10, 'EVIDENCE_SUBMITTED', B4, 'B4 Link gateway', 1), 'Need your call on B4.', ['mcp__orbit__ask_owner']),
      ...exchange(15, delivery(15, 'EVIDENCE_SUBMITTED', B1, 'B1 Targeted hints', 3), 'I confirmed B1.', []),
      ...exchange(20, { text: 'ok' }, 'Done.', []),
    ];
    mount(events);
    expect(container.textContent).toContain('B1 is blocked; restarting it.');
    expect(container.textContent).toContain('B4 failed.');
    expect(container.textContent).toContain('Need your call on B4.');
    // The one that is none of those still folds: its reply is the row's words, not a message of its own.
    expect(all('.orbit-exchange-root')).toHaveLength(1);
    expect(q('.orbit-exchange-root .orbit-exchange-reply')!.textContent).toBe('I confirmed B1.');
    expect(text('.chat-msg.chat-assistant')).not.toContain('I confirmed B1.');
  });

  it('folds a stopped run, a run notice and a task run\'s message under their tasks', () => {
    seq = 0;
    turn = 0;
    const NOTE = [
      `<orbit-run-notice task="${B4}" run-session="${RUN_OF_B1}" from-session="${RUN_OF_B1}" from-mode="auto">`,
      'A run of the task “B4 Link gateway” used notify. It did not reach the account owner.',
      'Message: Background job bgj_1 ended (exit code 0)',
      'Nothing is waiting for your reply. If the owner should know or decide, use ask_owner with your recommendation.',
      '</orbit-run-notice>',
    ].join('\n');
    const events = [
      ...exchange(0, delivery(0, 'TASK_RUN_STOPPED', B1, 'B1 Targeted hints'), 'B1 is waiting on purpose; nothing to do.'),
      ...exchange(5, { text: NOTE, controlPlaneNote: NOTE }, 'A progress signal from B4; nothing to do.'),
      ...exchange(10, {
        text: 'B4 scope note: I will keep the old route until A3 lands.',
        sessionMessage: { fromSessionId: RUN_OF_B1, fromTitle: 'Task: B4 Link gateway', fromAgentName: 'orbit', fromTaskId: B4 },
      }, 'Agreed with B4’s scope note.'),
      ...exchange(20, { text: 'ok' }, 'Done.', []),
    ];
    mount(events);
    expect(q('.orbit-exchanges-count')!.textContent).toBe('3 Orbit updates handled');
    expect(q('.orbit-exchanges-kinds')!.textContent).toBe('1 project update, 1 run notice, 1 message');
    expect(q('.smc')).toBeNull();
    expect(text('.chat-msg.chat-user')).toEqual(['ok']);
    act(() => q('.orbit-exchanges-line')!.click());
    // B4 waits on B1: one root, with the notice and the message under B4.
    expect(text('.orbit-exchanges-body > .orbit-branch > .orbit-branch-line .orbit-branch-title')).toEqual(['B1 Targeted hints']);
    act(() => q('.orbit-branch-line')!.click());
    act(() => all('.orbit-branch .orbit-branch .orbit-branch-line')[0].click());
    expect(text('.orbit-branch .orbit-branch .orbit-exchange-what')).toEqual(['Run notice', 'Message']);
    act(() => all('.orbit-branch .orbit-branch .orbit-exchange-line')[1].click());
    expect(q('.orbit-exchange.is-open .smc')).not.toBeNull();
  });

  it('folds only a short answer: a watch under 220 characters, anything else under 80, never a reply', () => {
    const wake = (id: string, name: string) => [
      '<background-job-wake>',
      '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
      `    ${id}｜query｜bash q.sh｜${name}`,
      '      ended｜completed｜exit code 0',
      `      output /root/.orbit/runs/x/${id}.output｜this covers bytes 0–20`,
      '  The control plane recorded this for you; the user did not write it. Read the whole output with mcp__orbit__bg_output by id.',
      '</background-job-wake>',
    ].join('\n');
    const job = (min: number, id: string, reply: string) =>
      exchange(min, { text: wake(id, id), controlPlaneNote: wake(id, id) }, reply, ['mcp__orbit__bg_output']);
    const replyFrom = (min: number, reply: string) =>
      exchange(min, { text: '', sessionReplies: [{ requestId: `r${min}`, fromSessionId: RUN_OF_B1, fromTitle: 'B1 run', outcome: 'REPLIED' }] }, reply);
    seq = 0;
    turn = 0;
    const events = [
      ...exchange(0, { text: 'Why is 11-10 not ready?' }, 'I started a query.', []),
      ...job(5, 'bgj_1', 'Still running.'),
      ...job(10, 'bgj_2', `Found it: ${'the job waits on lane 7, which never arrives. '.repeat(2)}`),
      ...exchange(15, { text: watchText({ kind: 'SESSION', id: RUN_OF_B1 }) }, `Duplicate wake; ${'nothing new. '.repeat(15)}`),
      ...exchange(20, { text: watchText({ kind: 'SESSION', id: RUN_OF_B1 }) }, `B1 landed. ${'All three gates are green on main. '.repeat(7)}`),
      ...replyFrom(25, 'Exempt.'),
      ...exchange(30, { text: 'ok' }, 'Done.', []),
    ];
    // 14, 102, 211 and 256 characters.
    expect(events.filter((e) => e.type === 'assistant').map((e) => String(e.payload.text).length).slice(1, 5)).toEqual([14, 102, 211, 256]);
    mount(events);
    // Each folds alone: the job's long answer stands between them.
    expect(text('.orbit-exchange-root .orbit-exchange-what').map((w) => w!.split(':')[0])).toEqual(['Background job finished', 'Watch triggered']);
    expect(q('.orbit-exchanges')).toBeNull();
    // A job's answer of 80 or more, a watch's of 220 or more, and any reply stay drawn as they were.
    expect(container.textContent).toContain('Found it: the job waits on lane 7');
    expect(container.textContent).toContain('B1 landed.');
    expect(container.textContent).toContain('Exempt.');
    // A watch's short answer folds even past 80: it is its row's words, not a message of its own.
    expect(text('.chat-msg.chat-assistant').some((t) => t!.includes('Duplicate wake'))).toBe(false);
  });

  it('leaves a turn the agent has not answered as the line its card draws', () => {
    const events = conversation().filter((e) => !(e.turnId === 'turn-2' && e.type === 'assistant'));
    mount(events);
    expect(q('.orbit-exchanges-count')!.textContent).toBe('2 Orbit updates handled');
    expect(all('.coordinator-delivery')).toHaveLength(2);
  });

  it('folds nothing in an export, which has no way to open a fold', () => {
    mount(conversation(), { exporting: true });
    expect(q('.orbit-exchanges, .orbit-exchange-root')).toBeNull();
    expect(container.textContent).toContain('我确认了 B1');
  });

  it('opens the way down to a find hit inside the group', () => {
    const events = conversation();
    mount(events);
    const hit = events.find((e) => e.type === 'assistant' && String(e.payload.text).startsWith('这是之前'))!.seq;
    act(() => {
      q('[data-orbit-fold]')!.dispatchEvent(new CustomEvent(EXCHANGE_REVEAL_EVENT, { detail: { seq: hit } }));
    });
    expect(q('.orbit-exchanges.is-open')).not.toBeNull();
    expect(q('.orbit-branch.is-open')).not.toBeNull();
    expect(q(`.orbit-exchange.is-open [data-seq="${hit}"]`)!.textContent).toContain('这是之前设的提醒');
    // Only the exchange holding the hit opens.
    expect(all('.orbit-exchange.is-open')).toHaveLength(1);
  });
});
