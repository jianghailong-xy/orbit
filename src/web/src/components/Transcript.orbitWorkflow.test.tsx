// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunEvent, TaskActivityCtx, Transcript } from './Transcript';

/**
 * Orbit's own workflow (`mcp__orbit__workflow`, docs/subagent-workflow-design.md), drawn as Claude Code's Workflow
 * card is (docs/mocks/subagent-workflow/07-web-card-p1.png). The call answers with a launch receipt the moment the
 * workflow starts, and its agent() calls run for minutes after, nested under it as delegate calls. The events below
 * are the shapes the production smoke test of 2026-11-19 stored.
 */

const RECEIPT = JSON.stringify({ status: 'running', workflowRunId: '350PhFyB3FxEUt9iEImF5' }, null, 2);
const SCRIPT =
  "export const meta = { name: 'wf-p1-smoke', description: 'Phase 1 smoke test of Orbit workflows', phases: [{ title: 'Explore' }] }\n" +
  "phase('Explore')\nreturn await agent('find the tool', { type: 'explore', label: 'find:workflow-tool' })";

const ev = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({
  seq,
  type,
  ts: `2026-11-19T17:36:${String(seq).padStart(2, '0')}.000Z`,
  payload,
});

const W = 'toolu_owf';
const events: RunEvent[] = [
  ev(1, 'tool_use', { id: W, name: 'mcp__orbit__workflow', input: { description: 'Phase 1 smoke test', script: SCRIPT } }),
  ev(2, 'tool_result', { toolUseId: W, content: [{ type: 'text', text: RECEIPT }] }),
  ev(3, 'tool_use', {
    id: `${W}#0`, name: 'mcp__orbit__delegate', parentToolUseId: W, workflowRunId: '350PhFyB3FxEUt9iEImF5',
    input: { description: 'find:workflow-tool', prompt: 'find the tool', type: 'explore', workflow_phase: 'Explore' },
  }),
  ev(4, 'tool_use', { id: 'run1:toolu_g', name: 'Grep', parentToolUseId: `${W}#0`, input: { pattern: 'workflowToolName' } }),
  ev(5, 'tool_result', { toolUseId: 'run1:toolu_g', parentToolUseId: `${W}#0`, content: 'src/runner-go/subagent_workflow.go' }),
  ev(6, 'assistant', { text: 'edge phase done', parentToolUseId: W, workflowRunId: '350PhFyB3FxEUt9iEImF5' }),
];

const activity = (running: string[]) => ({ live: new Map(), running: new Set(running) });

function markup(running: string[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TaskActivityCtx.Provider value={activity(running)}>
        <Transcript events={events} live />
      </TaskActivityCtx.Provider>
    </MemoryRouter>,
  );
}

/** The workflow card's own row: from its label to the first nested card. */
function headRow(html: string): string {
  const start = html.indexOf('wf-p1-smoke');
  const rest = html.slice(start);
  const next = rest.indexOf('chat-tool-card');
  return next > 0 ? rest.slice(0, next) : rest;
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

describe("Orbit's workflow card", () => {
  it('is a Workflow card named by its script and description, not the raw MCP tool', () => {
    const html = markup([W]);
    expect(html).toContain('>Workflow<');
    expect(html).toContain('wf-p1-smoke · Phase 1 smoke test');
    expect(html).not.toContain('orbit · workflow');
    expect(html).toMatch(/chat-tool-card chat-tone-agent/);
  });

  it('spins while its work runs, though its call answered at once, and is checked off once it ends', () => {
    expect(headRow(markup([W]))).toContain('anticon-loading');
    expect(headRow(markup([W]))).not.toContain('anticon-check-circle');
    expect(headRow(markup([]))).toContain('anticon-check-circle');
  });

  it('opens to its calls as SubAgent cards and its log line, with the receipt hidden and the script folded', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <TaskActivityCtx.Provider value={activity([W])}>
            <Transcript events={events} live />
          </TaskActivityCtx.Provider>
        </MemoryRouter>,
      );
    });
    const row = [...container.querySelectorAll<HTMLElement>('.chat-tool-row')].find((r) => r.textContent?.includes('wf-p1-smoke'))!;
    await act(async () => row.click());
    const text = container.textContent ?? '';
    expect(text).toContain('find:workflow-tool');
    expect(text).toContain('edge phase done');
    // The receipt only says the work started.
    expect(text).not.toContain('350PhFyB3FxEUt9iEImF5');
    const source = container.querySelector('details.chat-workflow-source');
    expect(source?.querySelector('summary')?.textContent).toBe('Workflow source');
    expect(source?.hasAttribute('open')).toBe(false);
  });
});
