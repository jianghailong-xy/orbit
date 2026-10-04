// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTaskProgress } from '@orbit/shared';
import { type RunEvent, EventFullCtx, TaskActivityCtx, Transcript } from './Transcript';
import { BackgroundShellsTray } from './BackgroundShellsTray';

/**
 * A session running background agents and workflows (Claude Code's Agent and Workflow tools): each
 * call returns the moment its work starts, so a card that checked itself off at that result read as
 * finished for the twenty minutes the work ran. The receipts, the progress payloads and the shapes
 * below are Claude Code 2.1.282's, from a production session.
 */

const AGENT_ACK =
  'Async agent launched successfully. (This tool result is internal metadata — never quote or paste' +
  ' any part of it, including the agentId below, into a user-facing reply.) agentId: a05fc3596d22b3d3e';
const WORKFLOW_RECEIPT =
  'Workflow launched in background. Task ID: w2f3yv1s8\nSummary: 3 competing designs; 2 judges\n' +
  'Transcript dir: /root/.claude/projects/x/subagents/workflows/wf_37d4e19e-c97';

const PROGRESS = {
  toolUseId: 'toolu_wf',
  taskId: 'w2f3yv1s8',
  taskType: 'local_workflow',
  usage: { totalTokens: 0, toolUses: 113, durationMs: 1020000 },
  phases: [
    { index: 1, title: 'Design' },
    { index: 2, title: 'Judge' },
  ],
  agents: [
    { index: 4, label: 'design:page-wiki', phaseIndex: 1, state: 'done', toolCalls: 34 },
    { index: 6, label: 'design:entity-graph', phaseIndex: 1, state: 'running', toolCalls: 46, lastToolName: 'Bash', lastToolSummary: 'grep -rn entity' },
    { index: 7, label: 'judge:product', phaseIndex: 2, state: 'start' },
  ],
};

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({
  seq,
  type,
  ts: `2026-09-25T08:00:${String(seq).padStart(2, '0')}.000Z`,
  payload,
});

const events: RunEvent[] = [
  ev(1, 'tool_use', { id: 'toolu_agent', name: 'Agent', input: { description: 'Deep-read wikova', prompt: 'Read ~/wikova.' } }),
  ev(2, 'tool_result', { toolUseId: 'toolu_agent', content: [{ type: 'text', text: AGENT_ACK }] }),
  ev(3, 'tool_use', { id: 'toolu_sub', name: 'Bash', input: { command: 'ls ~/wikova' }, parentToolUseId: 'toolu_agent' }),
  ev(4, 'tool_result', { toolUseId: 'toolu_sub', content: 'apiserver', parentToolUseId: 'toolu_agent' }),
  ev(5, 'assistant', { text: 'Now the enqueue side.', parentToolUseId: 'toolu_agent' }),
  ev(10, 'tool_use', { id: 'toolu_wf', name: 'Workflow', input: { resumeFromRunId: 'wf_37d4e19e-c97' } }),
  ev(11, 'tool_result', { toolUseId: 'toolu_wf', content: WORKFLOW_RECEIPT }),
];

const running = (ids: string[]) => ({
  live: new Map([['toolu_wf', parseTaskProgress(PROGRESS)!]]),
  running: new Set(ids),
});

function markup(activity = running(['toolu_wf'])): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TaskActivityCtx.Provider value={activity}>
        <Transcript events={events} live />
      </TaskActivityCtx.Provider>
    </MemoryRouter>,
  );
}

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

describe('background agent and workflow cards', () => {
  it('names a workflow by its receipt, badges its agents and spins while it runs', () => {
    const html = markup();
    expect(html).toContain('3 competing designs; 2 judges');
    expect(html).toContain('>1/3<'); // agents done out of all
    // The call's own result would have put a check here; the work is still going.
    const card = html.slice(html.indexOf('3 competing designs'));
    expect(card.slice(0, card.indexOf('chat-tool-card') > 0 ? card.indexOf('chat-tool-card') : undefined)).toContain('anticon-loading');
  });

  it('checks the card off once the work is no longer running', () => {
    const card = (html: string) => html.slice(html.indexOf('3 competing designs'));
    expect(card(markup(running([])))).toContain('anticon-check-circle');
  });

  it('draws an Agent call as an agent card again, not the generic row the 08-14 rename left it', () => {
    const html = markup();
    expect(html).toMatch(/chat-tool-card chat-tone-agent chat-tool-task/);
    expect(html).toContain('Deep-read wikova');
  });

  it('opens a workflow to its agents by phase, and hides the receipt and the ack', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TaskActivityCtx.Provider value={running(['toolu_wf'])}>
            <Transcript events={events} live />
          </TaskActivityCtx.Provider>
        </MemoryRouter>,
      );
    });
    const rows = [...container.querySelectorAll<HTMLElement>('.chat-tool-row')];
    const wf = rows.find((r) => r.textContent?.includes('Workflow'))!;
    const agent = rows.find((r) => r.textContent?.includes('Deep-read wikova'))!;
    await act(async () => {
      wf.click();
      agent.click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('design:entity-graph');
    expect(text).toContain('Bash grep -rn entity');
    expect(text).toContain('46 tools');
    expect(text).toContain('queued');
    expect(text).toContain('113 tool calls · 17m');
    // Neither receipt is shown: one says only that the work started, the other is internal metadata.
    expect(text).not.toContain('Workflow launched in background');
    expect(text).not.toContain('Async agent launched');
    // The sub-agent's own transcript is nested under its call.
    expect(container.querySelector('.chat-subagent')?.textContent).toContain('Now the enqueue side.');
  });

  it('opens each workflow agent to its own durable calls and results, with the source folded separately', async () => {
    const key = 'toolu_wf:workflow-agent:reader-a';
    const otherKey = 'toolu_wf:workflow-agent:reader-b';
    const progress = {
      ...PROGRESS,
      agents: [
        { ...PROGRESS.agents[0], transcriptKey: key },
        { ...PROGRESS.agents[1], transcriptKey: otherKey },
      ],
    };
    const workflowEvents = [
      ev(1, 'tool_use', { id: 'toolu_wf', name: 'Workflow', input: { script: 'export const meta = { name: "Read project" };' } }),
      ev(2, 'tool_result', { toolUseId: 'toolu_wf', content: WORKFLOW_RECEIPT }),
      ev(3, 'tool_use', { id: key, name: 'Agent', input: { description: 'design:page-wiki' }, parentToolUseId: 'toolu_wf' }),
      ev(4, 'tool_use', { id: 'read-a', name: 'Bash', input: { command: 'cat src/project.ts' }, parentToolUseId: key }),
      { ...ev(5, 'tool_result', { toolUseId: 'read-a', content: 'clipped result', parentToolUseId: key }), truncated: true },
      ev(6, 'assistant', { text: 'Reader A finding', parentToolUseId: key }),
      ev(7, 'tool_result', { toolUseId: key, content: 'Reader A complete', parentToolUseId: 'toolu_wf' }),
      ev(8, 'tool_use', { id: otherKey, name: 'Agent', input: { description: 'design:entity-graph' }, parentToolUseId: 'toolu_wf' }),
      ev(9, 'assistant', { text: 'Reader B finding', parentToolUseId: otherKey }),
      // Reloads have no live progress; the final durable snapshot keeps the same linkage.
      ev(10, 'background_task', { toolUseId: 'toolu_wf', status: 'completed', progress }),
    ];
    const fetchFull = vi.fn(async () => ({ payload: { content: 'Full project file contents' } }));
    await act(async () => {
      root.render(
        <MemoryRouter>
          <EventFullCtx.Provider value={fetchFull}>
            <Transcript events={workflowEvents} />
          </EventFullCtx.Provider>
        </MemoryRouter>,
      );
    });
    await act(async () => container.querySelector<HTMLElement>('.chat-tool-row')!.click());
    const rows = [...container.querySelectorAll<HTMLButtonElement>('button.agent-progress-agent')];
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector<HTMLDetailsElement>('.chat-workflow-source')?.open).toBe(false);
    expect(container.querySelectorAll('.chat-tool-task')).toHaveLength(0); // no duplicate Agent cards
    expect(container.textContent).not.toContain('Reader A finding');
    await act(async () => rows[0].click());
    expect(rows[0].getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Reader A finding');
    expect(container.textContent).toContain('Reader A complete');
    expect(container.textContent).not.toContain('Reader B finding');
    expect(fetchFull).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLElement>('.agent-progress-transcript .chat-tool-row')!.click());
    expect(fetchFull).toHaveBeenCalledWith(5);
    expect(container.textContent).toContain('cat src/project.ts');
    expect(container.textContent).toContain('Full project file contents');
    await act(async () => rows[1].click());
    expect(container.textContent).toContain('Reader B finding');
  });

  it('keeps child Agent transcripts accessible before workflow progress arrives', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={[
            ev(1, 'tool_use', { id: 'wf', name: 'Workflow', input: {} }),
            ev(2, 'tool_use', { id: 'wf:workflow-agent:a', name: 'Agent', input: { description: 'Reader' }, parentToolUseId: 'wf' }),
            ev(3, 'assistant', { text: 'Available without progress', parentToolUseId: 'wf:workflow-agent:a' }),
          ]} live />
        </MemoryRouter>,
      );
    });
    await act(async () => container.querySelector<HTMLElement>('.chat-tool-row')!.click());
    await act(async () => container.querySelector<HTMLElement>('.chat-tool-task .chat-tool-row')!.click());
    expect(container.textContent).toContain('Available without progress');
  });
});

describe('the tray', () => {
  it('names each row by kind and says where a running workflow is', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <BackgroundShellsTray
            events={events}
            live
            liveProgress={new Map([['toolu_wf', parseTaskProgress(PROGRESS)!]])}
          />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLElement>('.bg-tray-row')!.click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('2 running · 2 total');
    expect([...container.querySelectorAll('.bg-shell-kind')].map((n) => n.textContent)).toEqual(['Agent', 'Workflow']);
    expect(container.querySelector('.bg-shell-sub')?.textContent).toBe(
      'Design 1/2 · design:entity-graph running · 113 tool calls',
    );
  });
});
