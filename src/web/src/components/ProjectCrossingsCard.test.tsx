import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CrossingRow,
  crossingConfirmPrompt,
  decideCrossing,
  isAnswerable,
} from './ProjectCrossingsCard';
import type { ProjectCrossingRow } from '../lib/attribution';

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
    toProject: { title: 'Runner hardening', status: 'OPEN', acceptanceEpoch: '2' },
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

  it('shows the landing project acceptance epoch, because a reopen moves it', () => {
    expect(paint()).toContain('Landing epoch 2');
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
