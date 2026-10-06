import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CrossingRow,
  MOVE_TASK_APPROVE_CONSEQUENCE,
  MOVE_TASK_CRITERION_GONE,
  MOVE_TASK_DENY_CONSEQUENCE,
  MOVE_TASK_REQUESTED_CRITERION_LABEL,
  MOVE_TASK_STATE_MEANING,
  MOVE_TASK_SUBJECT_LABEL,
  MOVE_TASK_WITHDRAWN_CRITERION_LABEL,
  MOVE_TASK_WITHDRAWN_CRITERION_NOTE,
  crossingConfirmPrompt,
  decideCrossing,
  isAnswerable,
} from './ProjectCrossingsCard';
import { CROSSING_STATE_MEANING, type ProjectCrossingRow } from '../lib/attribution';

const api = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({ api: (...args: unknown[]) => api(...(args as [])) }));

const PROJECT = '0195c0de-0000-7000-8000-000000000001';
const OTHER = '0195c0de-0000-7000-8000-000000000002';
const KEY = 'c'.repeat(64);

function row(over: Partial<ProjectCrossingRow> = {}): ProjectCrossingRow {
  return {
    id: '0195c0de-0000-7000-8000-0000000000f1',
    publicId: 'AAACrossing',
    fromProjectId: PROJECT,
    fromProjectPublicId: 'AAAFrom',
    toProjectId: OTHER,
    toProjectPublicId: 'AAATo',
    fromProject: { title: 'Coordinator control loop', status: 'OPEN' },
    toProject: { title: 'Runner hardening', status: 'OPEN' },
    kind: 'FILE_TASK',
    subjectTaskId: null,
    crossingKey: KEY,
    state: 'PENDING',
    title: 'Fix the drain race',
    reason: 'found while reading the runner logs',
    requestedAt: '2026-08-22T00:00:00.000Z',
    decidedAt: null,
    expiresAt: null,
    ...over,
  };
}

const paint = (props: Partial<Parameters<typeof CrossingRow>[0]> = {}) =>
  renderToStaticMarkup(
    <ul>
      <CrossingRow
        row={row()}
        confirming={null}
        busy={false}
        error={null}
        onAsk={() => {}}
        onCancel={() => {}}
        onAnswer={() => {}}
        {...props}
      />
    </ul>,
  );

describe('ProjectCrossingsCard — the question a person answers', () => {
  it('names both ends by title AND by id, so an answer is about a readable move', () => {
    const html = paint();
    expect(html).toContain('Coordinator control loop');
    expect(html).toContain('AAAFrom');
    expect(html).toContain('Runner hardening');
    expect(html).toContain('AAATo');
    expect(html).toContain('Fix the drain race');
  });

  it('reports no landing epoch: 0229 removed the acceptance epoch it named', () => {
    expect(paint()).not.toContain('Landing epoch');
  });

  it('says what the state IS and what follows from it, in words', () => {
    // AC5: the tag carries the server's own value, and the sentence beside it is what the reader
    // acts on. Neither is a colour.
    const pending = paint();
    expect(pending).toContain('PENDING');
    expect(pending).toContain('Waiting for your answer');
    expect(pending).toContain('the work is not filed anywhere until you answer');

    const denied = paint({ row: row({ state: 'DENIED' }) });
    expect(denied).toContain('Refused');
    expect(denied).toContain('refusing is final for this crossing');
  });

  it('offers no answer at all on a crossing that is no longer a question', () => {
    for (const state of ['APPROVED', 'DENIED', 'APPLIED'] as const) {
      expect(isAnswerable(state)).toBe(false);
      expect(paint({ row: row({ state }) })).not.toContain('Approve…');
    }
    expect(isAnswerable('PENDING')).toBe(true);
    expect(paint()).toContain('Approve…');
  });

  it('takes two presses, and the second one names the move it is agreeing to', () => {
    const first = paint();
    // The first press only asks: nothing is sent, and the confirm button does not exist yet.
    expect(first).toContain('Approve…');
    expect(first).not.toContain('Yes, approve');

    const second = paint({ confirming: 'APPROVE' });
    expect(second).toContain('Yes, approve');
    expect(second).toContain('Coordinator control loop');
    expect(second).toContain('Runner hardening');
    expect(second).toContain('Fix the drain race');
    // The crossing key is on the confirmation, because it is what the write echoes back.
    expect(second).toContain(KEY.slice(0, 12));
  });

  it('states the consequence of each answer rather than asking "are you sure"', () => {
    const approve = crossingConfirmPrompt(row(), 'APPROVE');
    expect(approve.verb).toBe('Approve');
    expect(approve.from).toBe('Coordinator control loop');
    expect(approve.to).toBe('Runner hardening');
    expect(approve.consequence).toContain('It is not filed by this answer.');

    const deny = crossingConfirmPrompt(row(), 'DENY');
    expect(deny.verb).toBe('Refuse');
    expect(deny.consequence).toContain('final for this crossing');
  });

  it('falls back to ids when a server sends no titles', () => {
    // AC3, mixed versions: an older build serves the crossing without the two joined projects.
    const prompt = crossingConfirmPrompt(
      row({ fromProject: null, toProject: null }),
      'APPROVE',
    );
    expect(prompt.from).toBe('AAAFrom');
    expect(prompt.to).toBe('AAATo');
  });

  it('sends the crossing key with the answer, which is what makes the press a fence', () => {
    api.mockClear();
    void decideCrossing(PROJECT, row(), 'APPROVE');
    expect(api).toHaveBeenCalledWith(
      `/projects/${PROJECT}/handoffs/AAACrossing/decision`,
      { method: 'POST', body: { decision: 'APPROVE', acknowledgedCrossingKey: KEY } },
    );
  });

  it('surfaces a refused answer on the row it was given on', () => {
    const html = paint({
      confirming: 'APPROVE',
      error: new Error('APPROVAL_TARGET_MISMATCH: that answer names a different crossing'),
    });
    expect(html).toContain('That answer was not recorded');
    expect(html).toContain('APPROVAL_TARGET_MISMATCH');
  });
});

/** A request to move a task that already exists, as `GET /projects/:id/handoffs` serves one. */
function moveRow(over: Partial<ProjectCrossingRow> = {}): ProjectCrossingRow {
  return row({
    kind: 'MOVE_TASK',
    subjectTaskId: 'AAAMovedTask',
    subjectTaskPublicId: 'AAAMovedTask',
    subjectTask: { id: 'AAAMovedTask', publicId: 'AAAMovedTask', title: 'Wire the drain watchdog' },
    // The title the task had when the move was asked; the card reads the task as it is now.
    title: 'Watchdog (as first asked)',
    requestedCriterion: { key: 'AAATargetCriterion', text: 'A wedged drain restarts within a minute.' },
    withdrawnCriterion: { key: 'AAASourceCriterion', text: 'The control loop never drops a turn.' },
    reason: 'the watchdog belongs to the runner goal',
    ...over,
  });
}

describe('ProjectCrossingsCard — a request to move a task that already exists', () => {
  it('names the task it moves by its title now AND by its id', () => {
    const html = paint({ row: moveRow() });
    expect(html).toContain(`${MOVE_TASK_SUBJECT_LABEL}: `);
    expect(html).toContain('Wire the drain watchdog');
    expect(html).toContain('AAAMovedTask');
    expect(html).not.toContain('Watchdog (as first asked)');
    // A subject read that came back empty still names the task, by the title it was asked under.
    expect(paint({ row: moveRow({ subjectTask: null }) })).toContain('Watchdog (as first asked)');
  });

  it('names the project it leaves and the one it joins, by title and by id', () => {
    const html = paint({ row: moveRow() });
    expect(html).toContain('Coordinator control loop');
    expect(html).toContain('AAAFrom');
    expect(html).toContain('Runner hardening');
    expect(html).toContain('AAATo');
    expect(html.indexOf('AAAFrom')).toBeLessThan(html.indexOf('AAATo'));
  });

  it('shows the target criterion the request names, and the source criterion the move takes back', () => {
    const html = paint({ row: moveRow() });
    expect(html).toContain(`${MOVE_TASK_REQUESTED_CRITERION_LABEL}: `);
    expect(html).toContain('A wedged drain restarts within a minute.');
    expect(html).toContain('AAATargetCriterion');
    expect(html).toContain(`${MOVE_TASK_WITHDRAWN_CRITERION_LABEL}: `);
    expect(html).toContain('The control loop never drops a turn.');
    expect(html).toContain('AAASourceCriterion');
    expect(html).toContain(MOVE_TASK_WITHDRAWN_CRITERION_NOTE);
  });

  it('says nothing about criteria the request does not touch', () => {
    const bare = paint({ row: moveRow({ requestedCriterion: null, withdrawnCriterion: null }) });
    expect(bare).not.toContain(MOVE_TASK_REQUESTED_CRITERION_LABEL);
    expect(bare).not.toContain(MOVE_TASK_WITHDRAWN_CRITERION_LABEL);
    // An older server sends neither field at all.
    const older = paint({
      row: moveRow({ requestedCriterion: undefined, withdrawnCriterion: undefined, subjectTask: undefined }),
    });
    expect(older).not.toContain(MOVE_TASK_REQUESTED_CRITERION_LABEL);
    expect(older).toContain('AAAMovedTask');
  });

  it('says so when the target project no longer states the criterion the request names', () => {
    const html = paint({ row: moveRow({ requestedCriterion: { key: 'AAATargetCriterion', text: null } }) });
    expect(html).toContain(MOVE_TASK_CRITERION_GONE);
    expect(html).toContain('AAATargetCriterion');
  });

  it('says what each state means for a move, never what it means for a filing', () => {
    for (const state of ['PENDING', 'APPROVED', 'DENIED', 'APPLIED'] as const) {
      const html = paint({ row: moveRow({ state }) });
      expect(html).toContain(MOVE_TASK_STATE_MEANING[state]);
      expect(html).not.toContain(CROSSING_STATE_MEANING[state]);
    }
    expect(MOVE_TASK_STATE_MEANING.PENDING).toBe(
      'the task stays in its project until you answer, and confirming moves it',
    );
    expect(MOVE_TASK_STATE_MEANING.APPLIED).toBe('the task was moved when this request was confirmed');
  });

  it('takes two presses, and the second says that confirming IS the move', () => {
    const first = paint({ row: moveRow() });
    expect(first).toContain('Approve…');
    expect(first).not.toContain('Yes, approve');
    expect(first).not.toContain(MOVE_TASK_APPROVE_CONSEQUENCE);

    const second = paint({ row: moveRow(), confirming: 'APPROVE' });
    expect(second).toContain(
      'Approve moving “Wire the drain watchdog” from Coordinator control loop to Runner hardening?',
    );
    expect(second).toContain(MOVE_TASK_APPROVE_CONSEQUENCE);
    expect(second).toContain('Yes, approve');
    expect(second).toContain(KEY.slice(0, 12));
    // The filing's sentence is false of a move: this answer is what moves it.
    expect(second).not.toContain('It is not filed by this answer.');
  });

  it('gives each answer to a move its own consequence', () => {
    const approve = crossingConfirmPrompt(moveRow(), 'APPROVE');
    expect(approve).toEqual({
      verb: 'Approve',
      from: 'Coordinator control loop',
      to: 'Runner hardening',
      subject: 'Wire the drain watchdog',
      consequence: MOVE_TASK_APPROVE_CONSEQUENCE,
    });
    expect(MOVE_TASK_APPROVE_CONSEQUENCE).toBe(
      'Confirming is the move: the task joins the target project as soon as you answer, and nobody has to send the request again.',
    );
    const deny = crossingConfirmPrompt(moveRow(), 'DENY');
    expect(deny.verb).toBe('Refuse');
    expect(deny.consequence).toBe(MOVE_TASK_DENY_CONSEQUENCE);
    expect(MOVE_TASK_DENY_CONSEQUENCE).toBe(
      'Refusing is final for this request, and the task stays where it is. If you change your mind, move the task yourself.',
    );
    expect(paint({ row: moveRow(), confirming: 'DENY' })).toContain(MOVE_TASK_DENY_CONSEQUENCE);
  });

  it('leaves the words of a filing and of a dependency exactly as they were', () => {
    for (const kind of ['FILE_TASK', 'DEPEND_ON_TASK']) {
      const asked = row({ kind, subjectTaskId: kind === 'DEPEND_ON_TASK' ? 'AAAWaitedOn' : null });
      expect(crossingConfirmPrompt(asked, 'APPROVE')).toEqual({
        verb: 'Approve',
        from: 'Coordinator control loop',
        to: 'Runner hardening',
        subject: 'Fix the drain race',
        consequence:
          'The writer may then file this work under the target project. It is not filed by this answer.',
      });
      expect(crossingConfirmPrompt(asked, 'DENY').consequence).toBe(
        'Refusing is final for this crossing. If you change your mind, file the work yourself.',
      );
      const html = paint({ row: asked });
      expect(html).toContain(CROSSING_STATE_MEANING.PENDING);
      expect(html).not.toContain(MOVE_TASK_SUBJECT_LABEL);
      expect(html).not.toContain(MOVE_TASK_STATE_MEANING.PENDING);
    }
  });

  it('shows the code and the reason the server refused a confirmation with', () => {
    const refusal = Object.assign(
      new Error(
        'task AAAMovedTask is being landed (LAND_TASK AAAJob is RUNNING), and a landing belongs to the '
          + 'project the task is in — nothing was written and the request is still waiting. Confirm it '
          + 'again once that job has ended, or deny it.',
      ),
      { code: 'MOVE_TASK_LANDING_IN_FLIGHT' },
    );
    const html = paint({ row: moveRow(), confirming: 'APPROVE', error: refusal });
    expect(html).toContain('That answer was not recorded');
    expect(html).toContain('MOVE_TASK_LANDING_IN_FLIGHT');
    expect(html).toContain('the request is still waiting. Confirm it again once that job has ended');
    // The second step stays open, so the same request can be confirmed again once the job ends.
    expect(html).toContain('Yes, approve');
  });
});
