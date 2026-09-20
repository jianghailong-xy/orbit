import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { TaskDetailPanel } from '../components/TaskDetailPanel';
import type { WriteToast } from '../components/TaskScheduleEditor';
import {
  ACCEPTANCE_AUTOMATIC_HINT,
  ACCEPTANCE_EMPTY,
  ACCEPTANCE_EXIT_CODE_NOT_AN_INTEGER,
  ACCEPTANCE_PAIR_EMPTY,
  ACCEPTANCE_PAIR_INCOMPLETE,
  TaskAcceptance,
  acceptanceDraftFrom,
  acceptancePatch,
  acceptanceProblem,
  canSaveAcceptance,
  taskAcceptanceMutations,
  type AcceptanceDraft,
  type TaskAcceptanceValues,
} from './TaskDetailPage';

// A static (effect-free) render never invokes a queryFn or a mutationFn, so `api` is stubbed both
// as a backstop against an accidental live call and as the place a request shows up when a test
// drives the exported mutation by hand. Partial, because the module also exports the attachment
// resolver a sibling import pulls in at load time.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

const TASK_ID = '3kL9pQr2';
const PROJECT_ID = '7bV4mNc1';

// The panel restores its drag-resized width on mount; Node has no localStorage to restore from.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

/** The three fields as a task that has them all — the state the block is worth having. */
const SET: TaskAcceptanceValues = {
  acceptanceCriteria: 'The **suite** passes',
  acceptanceCommand: 'npm test -w @orbit/web',
  acceptanceExpectedExitCode: 0,
};

function renderAcceptance(task: TaskAcceptanceValues = {}): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TaskAcceptance taskId={TASK_ID} task={task} projectId={PROJECT_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The same three as the control holds them, and the control with nothing in it. */
const SET_DRAFT = acceptanceDraftFrom(SET);
const BLANK: AcceptanceDraft = { criteria: '', command: '', exitCode: '' };

/** A pair of spies in place of the real toast, which needs a router and a portal. */
function toast() {
  return { success: vi.fn(), error: vi.fn() } as unknown as WriteToast & {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/** A cache holding every view a write to this task refreshes, plus one that must be left alone. */
function seededCache() {
  const qc = new QueryClient();
  qc.setQueryData(['task', TASK_ID], { id: TASK_ID });
  qc.setQueryData(['tasks', 'page', null], { items: [] });
  qc.setQueryData(['project', PROJECT_ID, 'tasks', 'root'], { items: [] });
  qc.setQueryData(['project', '2wX8dHt5', 'tasks', 'root'], { items: [] });
  return qc;
}

const invalidatedIn = (qc: QueryClient) => (key: unknown[]) =>
  qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;

describe('the task detail page’s acceptance block', () => {
  it('shows a task’s criteria as prose and its command as a pair with the exit code', () => {
    const html = renderAcceptance(SET);

    // Markdown, not source: the criteria are written the way the description above them is, and
    // `**suite**` reaching the reader as asterisks is the difference between the two renderings.
    expect(html).toContain('<strong>suite</strong>');
    expect(html).not.toContain('**suite**');
    // The pair, together, with the code it is judged by.
    expect(html).toContain('npm test -w @orbit/web');
    expect(html).toContain('done when it exits');
    expect(html).toContain('>0<');
    // And the sentence that says what filling the pair in buys: no person deciding.
    expect(html).toContain(ACCEPTANCE_AUTOMATIC_HINT);
    // An empty task's copy has no business on a task that has all three.
    expect(html).not.toContain(ACCEPTANCE_EMPTY);
    expect(html).not.toContain(ACCEPTANCE_PAIR_EMPTY);
  });

  it('says what is missing when a task has neither, and still says what filling them in would do', () => {
    const html = renderAcceptance({});

    expect(html).toContain(ACCEPTANCE_EMPTY);
    expect(html).toContain(ACCEPTANCE_PAIR_EMPTY);
    // The hint is not decoration on a filled-in pair: a reader looking at an unset acceptance is
    // exactly the one deciding whether to set it.
    expect(html).toContain(ACCEPTANCE_AUTOMATIC_HINT);
    // Nothing is held: a command or a code from nowhere would read as a judgement already made.
    expect(html).not.toContain('done when it exits');
  });

  it('sends only what moved, so an edit to the prose cannot move the judgement path', () => {
    // Nothing moved, so there is nothing to send — and Save is shut on a draft like this.
    expect(acceptancePatch(SET_DRAFT, SET_DRAFT)).toEqual({});
    // The criteria alone. The pair is deliberately NOT restated: any `acceptanceCommand` in the
    // body — including a null repeating the null the server already holds — makes it re-derive the
    // task's completion criterion, and restating it would be how an owner-confirmed task quietly
    // becomes an evidence-judged one.
    expect(acceptancePatch({ ...SET_DRAFT, criteria: 'The suite passes' }, SET_DRAFT)).toEqual({
      acceptanceCriteria: 'The suite passes',
    });
    expect(acceptancePatch({ ...BLANK, criteria: 'The suite passes' }, BLANK)).toEqual({
      acceptanceCriteria: 'The suite passes',
    });
    // Whitespace on its own is not an edit to either field.
    expect(acceptancePatch({ ...SET_DRAFT, criteria: `  ${SET.acceptanceCriteria}  ` }, SET_DRAFT)).toEqual(
      {},
    );
    expect(acceptancePatch({ ...SET_DRAFT, exitCode: ' 0 ' }, SET_DRAFT)).toEqual({});
    // Half the pair replaced moves the pair whole, code as the integer the server stores.
    expect(acceptancePatch({ ...SET_DRAFT, exitCode: '1' }, SET_DRAFT)).toEqual({
      acceptanceCommand: 'npm test -w @orbit/web',
      acceptanceExpectedExitCode: 1,
    });
  });

  it('saves an edit and reads it back from what the task then holds', async () => {
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockResolvedValueOnce({});
    const observer = new MutationObserver(qc, {
      ...taskAcceptanceMutations(qc, message, TASK_ID, PROJECT_ID).save,
      retry: false,
    });

    await observer.mutate(
      acceptancePatch({ criteria: 'The **suite** passes', command: 'npm test', exitCode: '0' }, BLANK),
    );

    // What the write carries: the values as edited, the code as the integer the server stores.
    expect(vi.mocked(api).mock.calls[0]![0]).toBe(`/tasks/${TASK_ID}`);
    expect(vi.mocked(api).mock.calls[0]![1]).toEqual({
      method: 'PATCH',
      body: {
        acceptanceCriteria: 'The **suite** passes',
        acceptanceCommand: 'npm test',
        acceptanceExpectedExitCode: 0,
      },
    });
    expect(message.success).toHaveBeenCalledWith('Acceptance saved');
    // The refetch is what reads it back: the section paints from the task, not from the draft that
    // produced it, so without this the box would show the edit while the block showed the value it
    // replaced. The list rows and the task's project pages carry the same fields.
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', TASK_ID])).toBe(true);
    expect(invalidated(['tasks', 'page', null])).toBe(true);
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', '2wX8dHt5', 'tasks', 'root'])).toBe(false);

    // Read back: given the task the server now holds, the block shows what was saved.
    const saved = renderAcceptance({
      acceptanceCriteria: 'The **suite** passes',
      acceptanceCommand: 'npm test',
      acceptanceExpectedExitCode: 0,
    });
    expect(saved).toContain('<strong>suite</strong>');
    expect(saved).toContain('npm test');
    expect(saved).toContain('done when it exits');
  });

  it('clears to null, never to an empty string', async () => {
    // Whitespace is not a value: "" and null would be two stored states for one intention, and the
    // trimmed-to-nothing draft is the one a reader produces by selecting all and pressing space.
    // Clearing a stored pair and stored prose is what moves here, so both do.
    expect(acceptancePatch({ criteria: '   ', command: '', exitCode: '\t' }, SET_DRAFT)).toEqual({
      acceptanceCriteria: null,
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
    });

    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockResolvedValueOnce({});
    const observer = new MutationObserver(qc, {
      ...taskAcceptanceMutations(qc, message, TASK_ID, PROJECT_ID).save,
      retry: false,
    });

    await observer.mutate(acceptancePatch({ criteria: '   ', command: '   ', exitCode: '   ' }, SET_DRAFT));

    const body = (vi.mocked(api).mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body).toEqual({
      acceptanceCriteria: null,
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
    });
    // Not one empty string anywhere in the request: a `''` would store a second kind of unset.
    expect(Object.values(body)).not.toContain('');

    // And the cleared task renders as unset rather than as a blank that looks set.
    const cleared = renderAcceptance({
      acceptanceCriteria: null,
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
    });
    expect(cleared).toContain(ACCEPTANCE_EMPTY);
    expect(cleared).toContain(ACCEPTANCE_PAIR_EMPTY);
  });

  it('refuses half a pair, and re-sends the whole pair when only one half is edited', () => {
    const bare: AcceptanceDraft = { criteria: '', command: '', exitCode: '' };
    const commandOnly: AcceptanceDraft = { criteria: '', command: 'npm test', exitCode: '' };
    const codeOnly: AcceptanceDraft = { criteria: '', command: '', exitCode: '0' };
    const notANumber: AcceptanceDraft = { criteria: '', command: 'npm test', exitCode: 'nope' };

    // Half a pair is a declaration nothing can satisfy: the server derives the completion criterion
    // from the merged declaration, so an exit code with no command would complete the task on a
    // command that does not exist.
    expect(acceptanceProblem(commandOnly)).toBe(ACCEPTANCE_PAIR_INCOMPLETE);
    expect(acceptanceProblem(codeOnly)).toBe(ACCEPTANCE_PAIR_INCOMPLETE);
    expect(acceptanceProblem(notANumber)).toBe(ACCEPTANCE_EXIT_CODE_NOT_AN_INTEGER);
    expect(acceptanceProblem({ criteria: '', command: 'npm test', exitCode: '0' })).toBeNull();
    // Clearing both is a valid save — it is how a task stops being judged by a command.
    expect(acceptanceProblem({ criteria: '', command: ' ', exitCode: '' })).toBeNull();

    expect(canSaveAcceptance(commandOnly, bare)).toBe(false);
    expect(canSaveAcceptance(codeOnly, bare)).toBe(false);
    // An untouched draft has nothing to send, and a Save that sends nothing looks like it worked.
    expect(canSaveAcceptance({ ...bare, criteria: 'x' }, { ...bare, criteria: 'x' })).toBe(false);
    expect(canSaveAcceptance({ criteria: 'x', command: '', exitCode: '' }, bare)).toBe(true);

    // Replacing the command sends the pair whole: an omitted field means "leave this alone", so a
    // body carrying only the new command would keep the exit code of the command it replaced.
    expect(acceptancePatch({ criteria: '', command: 'npm test -w @orbit/web', exitCode: '0' }, BLANK)).toEqual({
      acceptanceCommand: 'npm test -w @orbit/web',
      acceptanceExpectedExitCode: 0,
    });
  });

  it('is drawn by the task detail panel itself, criteria included', () => {
    // Through the panel, not just beside it: this is the surface a reader opens, and the section
    // existing as a component is worth nothing if that surface does not draw it.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
    });
    qc.setQueryData(['task', TASK_ID], {
      id: TASK_ID,
      title: 'Run the nightly ingest',
      status: 'OPEN',
      sessions: [],
      comments: [],
      dependsOn: [],
      dependedOnBy: [],
      ...SET,
    });

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

    expect(html).toContain('tdp-section-title">Acceptance');
    expect(html).toContain('<strong>suite</strong>');
    expect(html).toContain('npm test -w @orbit/web');
    expect(html).toContain(ACCEPTANCE_AUTOMATIC_HINT);
  });

  it('is handed the task’s project, which is what its refresh reaches for', () => {
    // Source-level, the way the panel’s own “Start at” field is pinned there: which props the panel
    // passes is invisible to a static render — no markup differs — and the project is the one that
    // matters, since it is what a save refreshes beyond this task.
    const panel = readFileSync(
      fileURLToPath(new URL('../components/TaskDetailPanel.tsx', import.meta.url)),
      'utf8',
    );
    expect(panel).toContain(
      '<TaskAcceptance taskId={taskId} task={q.data} projectId={q.data?.projectId} />',
    );
  });
});
