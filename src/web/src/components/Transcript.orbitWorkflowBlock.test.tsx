// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_SCRIPT_ERROR,
  FLAKY_COST_LIMIT,
  REVIEW_DONE,
  REVIEW_FINISHED_NOTE,
  REVIEW_INTERRUPTED,
  REVIEW_RUNNING,
  REVIEW_WITH_LIMIT,
  wakeEvent,
  workflowFixture,
  type WorkflowFixture,
} from '../lib/orbitWorkflow.fixtures';
import { WorkflowRunsCtx, type WorkflowRuns } from '../lib/workflowRuns';
import type { RunEvent } from './Transcript';

/**
 * An Orbit workflow's block in the real Transcript, in each Phase 1 state board parts 2 and 3 draw
 * (docs/mocks/subagent-workflow/board.html): read from the server's workflow and its calls' runs.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({ loadTranscript: async () => null, saveTranscript: async () => {} }));

const { TaskActivityCtx, Transcript } = await import('./Transcript');

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

async function mount(fixture: WorkflowFixture, extra: RunEvent[] = [], runs: WorkflowRuns = fixture.runs) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <TaskActivityCtx.Provider value={{ live: new Map(), running: new Set(fixture.running) }}>
          <WorkflowRunsCtx.Provider value={runs}>
            <Transcript events={[...fixture.events, ...extra]} live={fixture.running.length > 0} />
          </WorkflowRunsCtx.Provider>
        </TaskActivityCtx.Provider>
      </MemoryRouter>,
    );
  });
}

const block = () => container.querySelector<HTMLElement>('[data-orbit-workflow]')!;
const head = () => block().querySelector<HTMLElement>(':scope > .chat-tool-row')!;
const open = async () => act(async () => head().click());
const callRows = () => [...block().querySelectorAll<HTMLElement>('.owf-call')];
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('an Orbit workflow block, folded', () => {
  it('heads with Workflow · name · description, ended / started and the cost, and spins while it runs', async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    expect(text(head().querySelector('.chat-tool-name'))).toBe('Workflow');
    expect(text(head().querySelector('.chat-tool-summary'))).toBe('review-changes · Review the scheduler diff');
    expect(text(head().querySelector('.owf-badge'))).toBe('7 / 12 · $0.50');
    expect(head().querySelector('[aria-label="running"]')).not.toBeNull();
  });

  it('says the cost against its limit only when the caller set one', async () => {
    await mount(workflowFixture(REVIEW_WITH_LIMIT));
    expect(text(head().querySelector('.owf-badge'))).toBe('7 / 12 · $0.50 of $5.00');
  });

  it('says the running phase and its running and queued counts on its second line', async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    expect(text(block().querySelector('.chat-tool-live'))).toBe('Verify · 3 running, 2 queued');
    // Folded, none of its calls is drawn.
    expect(callRows()).toHaveLength(0);
  });

  it('is checked off once it finished, with no second line', async () => {
    await mount(workflowFixture(REVIEW_DONE));
    expect(head().querySelector('[aria-label="done"]')).not.toBeNull();
    expect(head().querySelector('[aria-label="running"]')).toBeNull();
    expect(text(head().querySelector('.owf-badge'))).toBe('12 / 12 · $1.37');
    expect(block().querySelector('.chat-tool-live')).toBeNull();
  });
});

describe('an Orbit workflow block, open', () => {
  it('adds its time to the head and groups its calls by phase, each header counting its calls', async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    await open();
    expect(text(head().querySelector('.owf-badge'))).toMatch(/^7 \/ 12 · \$0\.50 · 4m 0[45]s$/);
    const groups = [...block().querySelectorAll('.owf-group-h')].map(text);
    expect(groups).toEqual(['Review 4 done', 'Verify 2 done · 1 failed · 3 running · 2 queued']);
  });

  it('draws each call as one row: label, result line, tier · model · cost, and its state', async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    await open();
    const rows = callRows();
    expect(rows).toHaveLength(12);
    const [done] = rows;
    expect(text(done.querySelector('.owf-call-label'))).toBe('review:correctness');
    expect(text(done.querySelector('.owf-call-line'))).toBe('2 findings');
    expect(text(done.querySelector('.owf-call-meta'))).toBe('M · DeepSeek Chat · $0.09');
    expect(done.querySelector('[aria-label="done"]')).not.toBeNull();
    const running = rows[7];
    expect(running.className).toContain('is-running');
    expect(text(running.querySelector('.owf-call-line'))).toBe('Cron parse accepts 61 minutes');
    expect(text(running.querySelector('.owf-call-meta'))).toBe('S · DeepSeek Chat');
    expect(running.querySelector('[aria-label="running"]')).not.toBeNull();
  });

  it('dims a queued call, a call made with no run yet, and says Queued', async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    await open();
    const queued = callRows().slice(10);
    expect(queued.map((row) => row.className)).toEqual([expect.stringContaining('is-queued'), expect.stringContaining('is-queued')]);
    expect(queued.map((row) => text(row.querySelector('.owf-queued')))).toEqual(['Queued', 'Queued']);
    expect(queued[0].querySelector('.owf-call-meta')).toBeNull();
  });

  it('marks a failed call ✕', async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    await open();
    const failed = callRows()[6];
    expect(failed.className).toContain('is-failed');
    expect(failed.querySelector('[aria-label="failed"]')).not.toBeNull();
    expect(text(failed.querySelector('.owf-call-meta'))).toBe('S · Claude Haiku 5.5');
  });

  it("opens a call's SubAgent card under its row on a click", async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    await open();
    const row = callRows()[0];
    await act(async () => row.click());
    const card = row.nextElementSibling as HTMLElement;
    expect(card.className).toBe('owf-call-card');
    expect(card.querySelector('[data-delegate-call="toolu_review#0"]')).not.toBeNull();
    // Today's SubAgent block, opened: the child's own steps and its tier and model from the call's run.
    expect(text(card)).toContain('Working on review:correctness.');
    expect(text(card.querySelector('.chat-tool-meta'))).toContain('M · DeepSeek Chat');
    await act(async () => row.click());
    expect(row.nextElementSibling?.className).not.toBe('owf-call-card');
  });

  it('draws a log() line as grey italic where the script wrote it, between the phases', async () => {
    await mount(workflowFixture(REVIEW_RUNNING));
    await open();
    const detail = block().querySelector('.owf-detail')!;
    const order = [...detail.children].map((el) => (el.classList.contains('owf-log') ? `log:${text(el)}` : text(el.querySelector('.owf-group-h'))));
    expect(order.slice(0, 3)).toEqual([
      'Review 4 done',
      'log:8 findings from 4 reviewers; verifying each one',
      'Verify 2 done · 1 failed · 3 running · 2 queued',
    ]);
  });
});

describe('an Orbit workflow block that did not finish', () => {
  it('interrupted: a red square and how many calls finished and how many did not', async () => {
    await mount(workflowFixture(REVIEW_INTERRUPTED));
    expect(head().querySelector('[aria-label="interrupted"]')).not.toBeNull();
    expect(text(head().querySelector('.owf-badge'))).toBe('5 / 12 · $0.61');
    const banner = block().querySelector('.owf-banner.is-warn');
    expect(text(banner)).toBe('Interrupted: the runner stopped. 5 calls finished and are kept; the other 7 did not finish.');
  });

  it('cost limit: the head says $x of $y and the banner how many running calls finished', async () => {
    await mount(workflowFixture(FLAKY_COST_LIMIT));
    expect(text(head().querySelector('.owf-badge'))).toBe('23 / 23 · $5.00 of $5.00');
    expect(head().querySelector('[aria-label="done"]')).not.toBeNull();
    expect(text(block().querySelector('.owf-banner.is-warn'))).toBe(
      'Stopped starting calls at the $5.00 limit the caller set. The 3 calls already running finished; the script returned what it had.',
    );
  });

  it('script error: ✕ and the error with the script line, before any call', async () => {
    await mount(workflowFixture(AUDIT_SCRIPT_ERROR));
    expect(head().querySelector('[aria-label="failed"]')).not.toBeNull();
    expect(text(head().querySelector('.owf-badge'))).toBe('0 / 0');
    expect(text(block().querySelector('.owf-banner.is-bad'))).toBe(
      "The script threw before any call: TypeError: Cannot read property 'length' of undefined (line 4)",
    );
  });

  it('a workflow that finished draws no banner', async () => {
    await mount(workflowFixture(REVIEW_DONE));
    expect(block().querySelector('.owf-banner')).toBeNull();
  });
});

describe("a workflow's finished wake turn", () => {
  it('is one strip: its calls, time, cost and what the script returned, not the reader’s bubble', async () => {
    const done = workflowFixture(REVIEW_DONE);
    await mount(done, [wakeEvent(100, REVIEW_FINISHED_NOTE)]);
    const strip = container.querySelector('.owf-wake')!;
    expect(text(strip.querySelector('.owf-wake-line'))).toBe(
      'Workflow finished · review-changes · 12 calls (11 done, 1 failed) · 6m 40s · $1.37',
    );
    expect(text(strip.querySelector('.owf-wake-outcome'))).toBe('Returned 3 confirmed findings.');
    expect(container.textContent).not.toContain('<orbit-workflow-finished>');
    expect(container.textContent).not.toContain('The control plane opened this turn');
  });

  it('says why a workflow did not finish', async () => {
    const failed = workflowFixture(AUDIT_SCRIPT_ERROR);
    const note = [
      '<orbit-workflow-finished>',
      '  Workflow audit-routes — Audit every route (run 350WfAudit000000000001) finished: FAILED',
      '    Calls done: 0, failed: 0. Cost: $0.00.',
      "    Error: the script threw: TypeError: Cannot read property 'length' of undefined",
      '    \tat workflow.js:4:23(12)',
      '  The control plane opened this turn for it.',
      '</orbit-workflow-finished>',
    ].join('\n');
    await mount(failed, [wakeEvent(100, note)]);
    const strip = container.querySelector('.owf-wake')!;
    expect(strip.className).toContain('is-failed');
    expect(text(strip.querySelector('.owf-wake-line'))).toBe('Workflow failed · audit-routes · 0 calls · 1s · $0.00');
    expect(text(strip.querySelector('.owf-wake-outcome'))).toBe(
      "The script threw: TypeError: Cannot read property 'length' of undefined (line 4)",
    );
  });
});
