// @vitest-environment jsdom
import type { JSX } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OpenItemFacts, ProjectOpenItemRow } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import {
  CHECK_TIME_LIMIT_CONSEQUENCE,
  CHECK_TIME_LIMIT_PRESS,
  ItemAsCard,
  RERUN_CHECK_ACTION_LABEL,
  RETRY_ACTION_LABEL,
  RETRY_REASON_BACK,
  RETRY_REASON_HINT,
  RETRY_REASON_QUESTION,
  checkRanAgainstLimit,
} from './ProjectProgressStatus';
import { RUN_MERGE_CHECK_ANCHOR } from '../lib/projectStart';
import { projectCoordinatorStatusQuery, projectDetailsQuery, workspacesQuery } from '../lib/queries';

/**
 * The owner's Re-run asks for the owner's reason before anything is sent, and a check stopped at its
 * time limit says how long it ran against that limit and opens where the merge check is set.
 */

vi.mock('../api', () => ({ api: vi.fn(() => Promise.resolve({})) }));

const PROJECT_ID = '35aK2xQm8LrT0vHcE1pZq';
const PROMOTION_ID = '35aPromotion000000001';
const TASK_ID = '35aTask00000000000001';
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function check(over: Partial<NonNullable<OpenItemFacts['check']>> = {}): NonNullable<OpenItemFacts['check']> {
  return {
    name: 'MERGE_CHECK',
    command: 'npm test',
    expectedExitCode: 0,
    exitCode: null,
    timedOut: true,
    durationMs: 4 * HOUR,
    outputTail: 'still running…',
    timeoutSeconds: 4 * 3600,
    ...over,
  } as NonNullable<OpenItemFacts['check']>;
}

/** The background's card: project-branch → main's merge check, stopped at its 4h limit, the owner's. */
function timedOutPromotion(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: '35aItem0000000000000001',
    kind: 'INTEGRATION_CHECK_FAILED',
    title: 'Merge check failed: project/35aK2xQm → main',
    detailLine: 'npm test timed out',
    assignee: 'OWNER',
    assigneeReason: 'ESCALATED',
    waitingSince: at(5 * HOUR),
    escalateAt: null,
    escalatedAt: at(HOUR),
    taskId: null,
    sessionId: null,
    landingSessionId: null,
    promotionId: PROMOTION_ID,
    fuseEpisodeId: null,
    delivery: { state: 'DELIVERED', sessionId: '35aCoord0000000000001', at: at(5 * HOUR) },
    actions: ['ASK_COORDINATOR_AGAIN', 'RETRY'],
    requiredAction: 'Re-run the merge check after fixing the slow test.',
    question: null,
    facts: {
      task: null,
      targetRef: 'refs/heads/main',
      targetSha: null,
      files: [],
      nothingLanded: true,
      check: check(),
      branchUnchanged: false,
      errorCode: null,
      failure: null,
    },
    chat: { sessionId: '35aCoord0000000000001', stage: 'WITH_OWNER', refusal: null },
    coordinatorUnreachable: false,
    ...over,
  } as ProjectOpenItemRow;
}

function seeded(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(projectDetailsQuery(PROJECT_ID).queryKey, { id: PROJECT_ID, title: 'Checkout v2' } as never);
  qc.setQueryData(projectCoordinatorStatusQuery(PROJECT_ID).queryKey, undefined as never);
  qc.setQueryData(workspacesQuery().queryKey, []);
  return qc;
}

let seen = '';
function Where(): null {
  const location = useLocation();
  seen = `${location.pathname}${location.hash}`;
  return null;
}

function card(row: ProjectOpenItemRow): JSX.Element {
  return (
    <MemoryRouter initialEntries={['/coordinator']}>
      <QueryClientProvider client={seeded()}>
        <ItemAsCard projectId={PROJECT_ID} row={row} now={NOW} />
        <Where />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const buttons = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('button')).filter((b) => text(b) === label);
const youRow = () => document.querySelector('[data-who="you"]');
const dialog = () => document.querySelector('.project-open-item-dialog');

/** Types into a React-controlled textarea the way a keyboard does. */
function type(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const retryCalls = () => vi.mocked(api).mock.calls.filter(([path]) => String(path).endsWith('/integration/retry'));

// jsdom has no ResizeObserver; the reason field's auto-size uses one.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.mocked(api).mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('Re-run asks for the owner\'s reason', () => {
  it('opens a prompt, empty to start, with its hint, and sends nothing on the press itself', async () => {
    await act(async () => root.render(card(timedOutPromotion())));
    const [rerun] = buttons(youRow()!, RERUN_CHECK_ACTION_LABEL);
    expect(rerun).toBeTruthy();
    await act(async () => rerun!.click());

    expect(retryCalls()).toHaveLength(0);
    const prompt = dialog();
    expect(prompt).toBeTruthy();
    expect(text(prompt)).toContain(RETRY_REASON_QUESTION);
    expect(text(prompt)).toContain(RETRY_REASON_HINT);
    const field = prompt!.querySelector('textarea')!;
    expect(field.value).toBe('');
    // Empty is not a press: the confirm waits for a reason.
    const [confirm] = buttons(prompt!, RERUN_CHECK_ACTION_LABEL);
    expect(confirm!.disabled).toBe(true);
  });

  it('a candidate\'s re-run carries exactly the typed text, never the row\'s own sentence', async () => {
    await act(async () => root.render(card(timedOutPromotion())));
    await act(async () => buttons(youRow()!, RERUN_CHECK_ACTION_LABEL)[0]!.click());
    const prompt = dialog()!;
    await act(async () => type(prompt.querySelector('textarea')!, 'The runner was swapping; it has more memory now.'));
    await act(async () => buttons(prompt, RERUN_CHECK_ACTION_LABEL)[0]!.click());

    expect(retryCalls()).toEqual([[
      `/projects/${PROJECT_ID}/promotions/${PROMOTION_ID}/integration/retry`,
      { method: 'POST', body: { reason: 'The runner was swapping; it has more memory now.' } },
    ]]);
  });

  it('a task landing\'s Retry asks the same way and carries the typed text', async () => {
    const row = timedOutPromotion({
      promotionId: null,
      taskId: TASK_ID,
      title: 'Merge check failed: Retry failed webhook deliveries',
    });
    await act(async () => root.render(card(row)));
    await act(async () => buttons(youRow()!, RETRY_ACTION_LABEL)[0]!.click());
    expect(retryCalls()).toHaveLength(0);
    const prompt = dialog()!;
    await act(async () => type(prompt.querySelector('textarea')!, 'A fix to the slow test landed since.'));
    await act(async () => buttons(prompt, RETRY_ACTION_LABEL)[0]!.click());

    expect(retryCalls()).toEqual([[
      `/projects/${PROJECT_ID}/tasks/${TASK_ID}/integration/retry`,
      { method: 'POST', body: { reason: 'A fix to the slow test landed since.' } },
    ]]);
  });

  it('Back closes the prompt and sends no request', async () => {
    await act(async () => root.render(card(timedOutPromotion())));
    await act(async () => buttons(youRow()!, RERUN_CHECK_ACTION_LABEL)[0]!.click());
    const prompt = dialog()!;
    await act(async () => type(prompt.querySelector('textarea')!, 'Changed my mind'));
    await act(async () => buttons(prompt, RETRY_REASON_BACK)[0]!.click());

    expect(retryCalls()).toHaveLength(0);
    expect(vi.mocked(api).mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST'))
      .toHaveLength(0);
  });
});

describe('a check stopped at its time limit', () => {
  it('says the run time against the limit in the You row', async () => {
    await act(async () => root.render(card(timedOutPromotion())));
    expect(text(youRow())).toContain('The check ran 4h of a 4h limit.');
    expect(text(youRow())).toContain(CHECK_TIME_LIMIT_CONSEQUENCE);
  });

  it('reads both figures off the row, and says only the run time when the limit was not recorded', () => {
    expect(checkRanAgainstLimit(4 * HOUR, 4 * 3600)).toBe('The check ran 4h of a 4h limit.');
    expect(checkRanAgainstLimit(90 * 60_000 + 12_000, 5400)).toBe('The check ran 1h 30m of a 1h 30m limit.');
    expect(checkRanAgainstLimit(4 * HOUR, undefined)).toBe('The check ran 4h and was stopped at its time limit.');
  });

  it('"Change the check or its time limit…" opens How it runs at the merge check', async () => {
    await act(async () => root.render(card(timedOutPromotion())));
    const [press] = buttons(youRow()!, CHECK_TIME_LIMIT_PRESS);
    expect(press).toBeTruthy();
    expect(press!.className).toContain('project-open-item-quiet');
    await act(async () => press!.click());
    expect(seen).toBe(`/projects/${PROJECT_ID}#${RUN_MERGE_CHECK_ANCHOR}`);
  });

  it('a check that failed rather than timed out has neither the line nor the press', async () => {
    const row = timedOutPromotion();
    row.facts = { ...row.facts!, check: check({ timedOut: false, exitCode: 1, durationMs: 6 * 60_000 }) };
    await act(async () => root.render(card(row)));
    expect(buttons(document, CHECK_TIME_LIMIT_PRESS)).toHaveLength(0);
    expect(text(document.body)).not.toContain('limit.');
  });
});
