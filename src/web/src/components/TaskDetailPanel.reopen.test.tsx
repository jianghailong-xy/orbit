import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { WriteToast } from './TaskScheduleEditor';
import {
  REOPEN_ACTION_LABEL,
  REOPEN_MODAL_BODY,
  REOPEN_MODAL_PROJECT,
  REOPEN_MODAL_RETIRED,
  REOPEN_RECORDED,
  TaskDetailPanel,
  reopenMutationOptions,
  reopenParagraphs,
} from './TaskDetailPanel';

// A static render never invokes a queryFn, so the cache is seeded instead.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

// The panel restores its drag-resized width on mount; Node has no localStorage to restore from.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const TASK_ID = '3kL9pQr2';
const PROJECT_ID = '7bV4mNc1';

/** A task, by default open and runnable; `over` is what a case is about. */
function task(over: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Run the nightly ingest',
    status: 'OPEN',
    assignee: { id: 'w-codex', name: 'Builder' },
    sessions: [],
    comments: [],
    dependsOn: [],
    dependedOnBy: [],
    ...over,
  };
}

/** The three buttons of the header's action strip, as their labels. */
function headButtonLabels(data: Record<string, unknown>): string[] {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
  qc.setQueryData(['task', TASK_ID], data);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskDetailPanel
          taskId={TASK_ID}
          onOpenTask={() => {}}
          onClose={() => {}}
          onDelete={() => {}}
          deleting={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const head = /<div class="tdp-head-actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  return [...head.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gu)]
    .map((m) => m[1].replace(/<[^>]*>/gu, ''));
}

function toast(): WriteToast & { success: ReturnType<typeof vi.fn> } {
  return { success: vi.fn(), error: vi.fn() } as unknown as WriteToast & {
    success: ReturnType<typeof vi.fn>;
  };
}

/**
 * The button is offered where the verb means something and nowhere else. DONE is the case that had
 * no way back at all; CANCELLED and FAILED are the two the platform lets a run pick up only through
 * a retry, which spends a run to change a status. An open task is already open.
 */
describe('the Reopen press in the task detail panel', () => {
  for (const status of ['DONE', 'CANCELLED', 'FAILED']) {
    it(`is offered on a ${status} task`, () => {
      expect(headButtonLabels(task({ status }))).toContain(REOPEN_ACTION_LABEL);
    });
  }

  for (const status of ['OPEN', 'IN_PROGRESS']) {
    it(`is not offered on a ${status} task`, () => {
      expect(headButtonLabels(task({ status }))).not.toContain(REOPEN_ACTION_LABEL);
    });
  }
});

/**
 * What the press SENDS: one PATCH, and the three fields are the contract. `status: OPEN` alone is
 * refused by the server on a row that carries a retirement — the rows this door exists for — so the
 * two nulls are as load-bearing as the status, and they are asserted as present rather than as
 * absent.
 */
describe('the Reopen write', () => {
  it('sends status OPEN with both retirement fields cleared, and refreshes the project beside the task', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['task', TASK_ID], {});
    qc.setQueryData(['tasks', 'page', null], { items: [] });
    qc.setQueryData(['project', PROJECT_ID, 'tasks', 'root'], { items: [] });
    qc.setQueryData(['project', 'nobody-elses-project', 'tasks', 'root'], { items: [] });
    const message = toast();
    const reopened = vi.fn();
    const mocked = vi.mocked(api);
    mocked.mockResolvedValueOnce({ id: TASK_ID, status: 'OPEN' });

    const options = reopenMutationOptions(qc, message, TASK_ID, PROJECT_ID, reopened);
    await options.mutationFn();

    expect(mocked).toHaveBeenCalledWith(`/tasks/${TASK_ID}`, {
      method: 'PATCH',
      body: { status: 'OPEN', supersededByTaskId: null, terminalReason: null },
    });

    options.onSuccess();
    expect(reopened).toHaveBeenCalled();
    expect(message.success).toHaveBeenCalledWith(REOPEN_RECORDED);
    const invalidated = (key: unknown[]): boolean =>
      qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;
    expect(invalidated(['task', TASK_ID])).toBe(true);
    expect(invalidated(['tasks', 'page', null])).toBe(true);
    // The project's status is a projection of the work under it, so it is read again too — and only
    // the project this task is filed under.
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', 'nobody-elses-project', 'tasks', 'root'])).toBe(false);
  });

  it('leaves a refusal inside the question rather than toasting it away', () => {
    const options = reopenMutationOptions(new QueryClient(), toast(), TASK_ID, null, vi.fn());
    // No `onError`: the server's sentence (a verification task holding a verdict, say) is rendered
    // in the modal the press came from, where the reader is still deciding.
    expect(Object.keys(options)).toEqual(['mutationFn', 'onSuccess']);
  });
});

/**
 * The question's sentences, in the order they are read. The two conditional ones are conditional
 * because the two FACTS are: only a task filed under a project can take that project out of DONE,
 * and only a row carrying a retirement has a record that reopening clears before it can run again.
 */
describe('the Reopen question', () => {
  it('explains what reopening does, and what it leaves alone', () => {
    expect(reopenParagraphs(task())).toEqual([{ text: REOPEN_MODAL_BODY, strong: false }]);
  });

  it('adds the project sentence on a task filed under a project', () => {
    expect(reopenParagraphs(task({ projectId: PROJECT_ID }))).toEqual([
      { text: REOPEN_MODAL_BODY, strong: false },
      { text: REOPEN_MODAL_PROJECT, strong: false },
    ]);
  });

  it('says the supersession is cleared, in the loudest line, on the rows that carry one', () => {
    expect(reopenParagraphs(task({ projectId: PROJECT_ID, terminalReason: 'SUPERSEDED' }))).toEqual([
      { text: REOPEN_MODAL_BODY, strong: false },
      { text: REOPEN_MODAL_PROJECT, strong: false },
      { text: REOPEN_MODAL_RETIRED, strong: true },
    ]);
    // ABANDONED is the other value of the same column and needs no second sentence: the record is
    // cleared either way.
    expect(reopenParagraphs(task({ terminalReason: 'ABANDONED' }))).toEqual([
      { text: REOPEN_MODAL_BODY, strong: false },
      { text: REOPEN_MODAL_RETIRED, strong: true },
    ]);
  });
});
