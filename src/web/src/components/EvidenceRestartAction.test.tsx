// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DecisionStrip,
  WAITING_ON_YOU_ACTION,
  type PendingDecisionQueue,
  type PendingDecisionRow,
} from './DecisionRail';
import {
  EVIDENCE_RESTART_ACTION,
  EVIDENCE_RESTART_EXPLANATION,
  EVIDENCE_RESTART_NOT_OFFERED,
  EVIDENCE_RESTART_REFUSED,
  EVIDENCE_RESTART_STALE,
  EVIDENCE_RESTART_STARTED,
  RESTART_TASK_OWNER_ACTION,
  evidenceRestartRequest,
} from './EvidenceRestartAction';

/**
 * Restart the task on the owner's pending-evidence row: drawn only on a row that carries
 * `ownerAction: 'RESTART_TASK'`, and pressed as P3's `POST /tasks/:taskId/evidence/:revision/restart`
 * with the busy, refused and started states of the press beside it.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api, ApiError } = await import('../api');
const apiMock = vi.mocked(api);

const SESSION_ID = '34w8n4fPauzw4a2i7dfX5';
const TASK_ID = '34w9LTJrtq7wkJ9gLWWjx';

function undecidable(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_ID,
    title: 'the owner card for an undecidable revision',
    projectId: null,
    criterion: { key: '6LrU4IhcAPoE8jL5UZY8oF', text: 'a criterion that was reworded' },
    evidenceRevision: '3',
    ageSeconds: 3 * 3600 + 46 * 60,
    claim: 'the card renders Restart the task',
    gaps: [],
    citations: [],
    decidability: {
      decidable: false,
      refusal: 'the standard this revision was judged against has changed since it was submitted',
      requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
      addressee: 'OWNER',
    },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ownerAction: RESTART_TASK_OWNER_ACTION,
    ...over,
  };
}

function queue(rows: PendingDecisionRow[]): PendingDecisionQueue {
  return {
    decidingSessionId: SESSION_ID,
    count: 0,
    oldestAgeSeconds: null,
    pending: [],
    waitingOnYou: rows,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  apiMock.mockReset();
});

function mount(payload: PendingDecisionQueue): { el: HTMLDivElement; qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <DecisionStrip queue={payload} open hasCard={() => false} onToggle={() => {}} />
      </QueryClientProvider>,
    );
  });
  return { el: host, qc };
}

const restartButton = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === EVIDENCE_RESTART_ACTION);

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((done) => setTimeout(done, 0));
  });
}

describe('Restart the task on the owner row', () => {
  it('is drawn on a row that carries the action, in place of the resubmit sentence', () => {
    const { el } = mount(queue([undecidable()]));

    expect(restartButton(el)).toBeDefined();
    expect(el.textContent).toContain(EVIDENCE_RESTART_EXPLANATION);
    expect(el.textContent).not.toContain(WAITING_ON_YOU_ACTION);
  });

  it('is not drawn on a row that does not carry it — the run’s own row, or an older server’s', () => {
    for (const row of [
      undecidable({ ownerAction: null, decidability: { ...undecidable().decidability, addressee: 'RUN' } }),
      undecidable({ ownerAction: undefined }),
    ]) {
      const { el } = mount(queue([row]));
      expect(restartButton(el)).toBeUndefined();
      expect(el.textContent).not.toContain(EVIDENCE_RESTART_ACTION);
      expect(el.textContent).toContain(WAITING_ON_YOU_ACTION);
      act(() => root?.unmount());
      host?.remove();
    }
    root = null;
    host = null;
  });

  it('only on the row that carries it, when two wait side by side', () => {
    const { el } = mount(queue([
      undecidable(),
      undecidable({ taskId: 'task-runs-own', title: 'the run’s own', ownerAction: null }),
    ]));
    const rows = [...el.querySelectorAll('.decision-rail-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain(EVIDENCE_RESTART_ACTION);
    expect(rows[1].textContent).not.toContain(EVIDENCE_RESTART_ACTION);
  });

  it('presses P3’s endpoint with the revision it was read at, busy until the server answers', async () => {
    let answer!: (value: unknown) => void;
    apiMock.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { el, qc } = mount(queue([undecidable()]));
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    act(() => restartButton(el)!.click());
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiMock.mock.calls[0] as [string, { method: string; body: { triggerId: string } }];
    expect(path).toBe(`/tasks/${TASK_ID}/evidence/3/restart`);
    expect(init.method).toBe('POST');
    expect(typeof init.body.triggerId).toBe('string');
    expect(init.body.triggerId.length).toBeGreaterThan(0);
    expect(restartButton(el)!.disabled).toBe(true);

    answer({ taskId: TASK_ID, evidenceRevision: '3', action: 'RESTART_TASK', started: {} });
    await flush();

    expect(el.textContent).toContain(EVIDENCE_RESTART_STARTED);
    expect(restartButton(el)).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', SESSION_ID, 'pending-decisions'] });
  });

  it('says a press that is no longer offered is out of date, and leaves the button to try again', async () => {
    apiMock.mockRejectedValue(new ApiError(
      'a run of this task is live and has been told to submit the revision again; nothing was started',
      409,
      EVIDENCE_RESTART_NOT_OFFERED,
    ));
    const { el } = mount(queue([undecidable()]));

    act(() => restartButton(el)!.click());
    await flush();

    expect(el.textContent).toContain(EVIDENCE_RESTART_STALE);
    expect(el.textContent).toContain('nothing was started');
    expect(el.querySelector('.evidence-restart-error')).not.toBeNull();
    expect(restartButton(el)!.disabled).toBe(false);
  });

  it('says any other refusal as Not restarted, with the server’s words', async () => {
    apiMock.mockRejectedValue(new ApiError('task not found', 404, undefined));
    const { el } = mount(queue([undecidable()]));

    act(() => restartButton(el)!.click());
    await flush();

    expect(el.textContent).toContain(EVIDENCE_RESTART_REFUSED);
    expect(el.textContent).not.toContain(EVIDENCE_RESTART_STALE);
    expect(el.textContent).toContain('task not found');
  });

  it('builds the request from the row’s address alone', () => {
    expect(evidenceRestartRequest({ taskId: 'a/b', evidenceRevision: '12' }, 't1')).toEqual({
      path: '/tasks/a%2Fb/evidence/12/restart',
      body: { triggerId: 't1' },
    });
  });
});

/**
 * The copy table the iOS/macOS and Android owner cards are proved against too. A missing table is
 * a failure, not a skip (D5 = A).
 */
describe('copy parity (shared fixture)', () => {
  const path = [
    resolve(process.cwd(), '../shared/src/evidence-restart-copy.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/evidence-restart-copy.fixture.json'),
  ].find((each) => existsSync(each));

  it('says the words the shared table says', () => {
    expect(path, 'src/shared/src/evidence-restart-copy.fixture.json is missing').toBeDefined();
    const fixture = JSON.parse(readFileSync(path!, 'utf8'));
    expect(fixture.ownerAction).toBe(RESTART_TASK_OWNER_ACTION);
    expect(fixture.refusalCode).toBe(EVIDENCE_RESTART_NOT_OFFERED);
    expect(fixture.copy).toEqual({
      action: EVIDENCE_RESTART_ACTION,
      explanation: EVIDENCE_RESTART_EXPLANATION,
      started: EVIDENCE_RESTART_STARTED,
      refused: EVIDENCE_RESTART_REFUSED,
      stale: EVIDENCE_RESTART_STALE,
    });
  });
});
