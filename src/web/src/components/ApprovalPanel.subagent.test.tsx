// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalInfo } from '../api';
import { approvalAction, delegateCallOfApproval, delegateDescription } from '../lib/subagentRuns';
import { ApprovalPanel } from './ApprovalPanel';
import { type RunEvent, SubagentWaitingCtx, Transcript } from './Transcript';

/**
 * A SubAgent's approval card in its parent's approval area (docs/subagent-design.md §5.3, docs/mocks/subagent/02.png
 * mark 6): a grey `SubAgent · <description>` line above the card, and the SubAgent block saying
 * `Waiting for approval · <action>`. The card's toolUseId is the child's call as the runner writes it into the
 * parent's transcript (src/runner-go/subagent.go subagentToolID).
 */

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({
  seq,
  type,
  ts: `2026-11-11T10:00:${String(seq).padStart(2, '0')}.000Z`,
  payload,
});

const events: RunEvent[] = [
  ev(1, 'tool_use', {
    id: 'toolu_delegate',
    name: 'mcp__orbit__delegate',
    input: { description: 'Port the retry to the Go runner', prompt: 'Port it.', type: 'general' },
  }),
  ev(2, 'tool_use', {
    id: 'run9:toolu_read', name: 'Read', input: { file_path: '/repo/runner-go/quota/poll.go' },
    parentToolUseId: 'toolu_delegate', subagentRunId: 'run9',
  }),
  ev(3, 'tool_result', { toolUseId: 'run9:toolu_read', content: 'package quota', parentToolUseId: 'toolu_delegate' }),
  ev(4, 'tool_use', {
    id: 'run9:toolu_bash', name: 'Bash', input: { command: 'go test ./quota/...' },
    parentToolUseId: 'toolu_delegate', subagentRunId: 'run9',
  }),
];

const card: ApprovalInfo = {
  id: 'ap1',
  sessionId: 's1',
  toolName: 'Bash',
  input: { command: 'go test ./quota/...' },
  toolUseId: 'run9:toolu_bash',
  subagentRunId: '4mZbVqXr2yEo1aT7c9Lk3H',
  status: 'PENDING',
  createdAt: '2026-11-11T10:00:05.000Z',
};

describe('a SubAgent card finds its delegate call', () => {
  it('through the child call it was asked from', () => {
    const call = delegateCallOfApproval(card, events);
    expect(call).toBe('toolu_delegate');
    expect(delegateDescription(call, events)).toBe('Port the retry to the Go runner');
  });

  it("through any event of its run when the child's call has not arrived yet", () => {
    expect(delegateCallOfApproval(card, events.slice(0, 3))).toBe('toolu_delegate');
  });

  it("is no SubAgent's when it names no run", () => {
    expect(delegateCallOfApproval({ ...card, subagentRunId: undefined }, events)).toBeNull();
  });

  it('names the action in a few words', () => {
    expect(approvalAction('Bash', { command: 'go test ./quota/...' })).toBe('Run go test ./quota/...');
    expect(approvalAction('Edit', { file_path: '/repo/src/a/poller.ts' })).toBe('Edit poller.ts');
    expect(approvalAction('WebFetch', { url: 'https://example.com' })).toBe('WebFetch');
  });
});

describe('the SubAgent approval card', () => {
  it("shows a grey 'SubAgent · <description>' line above the card's head", () => {
    const html = renderToStaticMarkup(
      <ApprovalPanel approval={card} onDecide={() => undefined} subagent="Port the retry to the Go runner" />,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const line = doc.querySelector('.approval-card > .approval-subagent');
    expect(line?.textContent).toBe('SubAgent · Port the retry to the Go runner');
    expect(line?.nextElementSibling?.className).toBe('approval-head');
  });

  it('says only SubAgent when the description is not known yet, and nothing for a card the session asked', () => {
    const unnamed = renderToStaticMarkup(<ApprovalPanel approval={card} onDecide={() => undefined} subagent="" />);
    expect(new DOMParser().parseFromString(unnamed, 'text/html').querySelector('.approval-subagent')?.textContent).toBe('SubAgent');
    const own = renderToStaticMarkup(<ApprovalPanel approval={{ ...card, subagentRunId: undefined }} onDecide={() => undefined} />);
    expect(own).not.toContain('approval-subagent');
  });
});

describe('the SubAgent block while its card waits', () => {
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

  const render = (waiting: ReadonlyMap<string, string>) =>
    act(() =>
      root.render(
        <MemoryRouter>
          <SubagentWaitingCtx.Provider value={waiting}>
            <Transcript events={events} live />
          </SubagentWaitingCtx.Provider>
        </MemoryRouter>,
      ),
    );

  it("says 'Waiting for approval · <action>' under the folded row, in place of its latest step", () => {
    render(new Map([['toolu_delegate', 'Run go test ./quota/...']]));
    const block = container.querySelector('.chat-tool-card[data-seq="1"]') as HTMLElement;
    expect(block.querySelector('.chat-subagent-waiting')?.textContent).toBe('Waiting for approval · Run go test ./quota/...');
    expect(block.querySelector('.chat-tool-live')).toBeNull();
  });

  it('as the last step once opened', () => {
    render(new Map([['toolu_delegate', 'Run go test ./quota/...']]));
    const block = container.querySelector('.chat-tool-card[data-seq="1"]') as HTMLElement;
    act(() => (block.querySelector('.chat-tool-row') as HTMLElement).click());
    const steps = block.querySelector('.chat-subagent') as HTMLElement;
    expect(steps.lastElementChild?.className).toBe('chat-subagent-waiting');
    expect(steps.lastElementChild?.textContent).toBe('Waiting for approval · Run go test ./quota/...');
  });

  it('and shows its latest step again when nothing waits', () => {
    render(new Map());
    const block = container.querySelector('.chat-tool-card[data-seq="1"]') as HTMLElement;
    expect(block.querySelector('.chat-subagent-waiting')).toBeNull();
  });
});
