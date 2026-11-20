// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCrossingRow } from '../lib/attribution';
import { crossingBatches } from '../lib/crossingBatches';
import { TRANSLATION_COPY } from '../lib/translation';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe } from '../test/ownerCardTranslation';
import { CrossingDecisionCard } from './CrossingDecisionCard';

/** Board 04-owner-cards.html on a crossing (a task moved or filed across projects). */

vi.mock('./ReviewCard', async () => await import('../test/inlineReviewCard'));

const TARGET = '0195c0de-0000-7000-8000-000000000010';
const REASON = 'These tasks serve criteria here; their old project is done.';

function row(i: number, over: Partial<ProjectCrossingRow> = {}): ProjectCrossingRow {
  return {
    id: `0195c0de-0000-7000-8000-00000000010${i}`,
    fromProjectId: '0195c0de-0000-7000-8000-000000000020',
    toProjectId: TARGET,
    fromProject: { title: 'Runner link v1', status: 'DONE' },
    toProject: { title: 'Runner hardening', status: 'OPEN' },
    kind: 'MOVE_TASK',
    subjectTaskId: `t${i}`,
    subjectTask: { id: `t${i}`, title: `Moved task ${i}` },
    requestedCriterion: null,
    withdrawnCriterion: null,
    crossingKey: `key-${i}`,
    state: 'PENDING',
    title: `Moved task ${i}`,
    reason: REASON,
    requestedAt: `2026-11-09T08:31:0${i}.000Z`,
    decidedAt: null,
    expiresAt: null,
    translation: { lang: OWNER_LANG, title: `Tâche déplacée ${i}`, reason: 'Ces tâches servent les critères ici.' },
    ...over,
  };
}

const h = cardHost();
beforeEach(() => h.mount());
afterEach(() => h.unmount());

const draw = (rows: ProjectCrossingRow[], client = clientWithMe()) =>
  h.draw(<CrossingDecisionCard batch={crossingBatches(rows, TARGET)[0]!} onDecide={() => {}} />, client);

describe('a crossing in the owner’s language', () => {
  it('draws every crossing’s title and reason translated; the toggle flips the whole card', async () => {
    await draw([row(1), row(2)]);
    expect(h.text()).toContain('Tâche déplacée 1');
    expect(h.text()).toContain('Tâche déplacée 2');
    expect(h.text()).toContain('Ces tâches servent les critères ici.');
    expect(h.text()).not.toContain(REASON);
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);

    await h.press(TRANSLATION_COPY.showOriginal);
    expect(h.text()).toContain('Moved task 1');
    expect(h.text()).toContain(REASON);
    expect(h.text()).not.toContain('Tâche déplacée');
    expect(h.text()).toContain(`${TRANSLATION_COPY.original}·${TRANSLATION_COPY.showTranslation}`);
  });

  it.each([
    ['no translation', [row(1, { translation: undefined })], clientWithMe()],
    ['a failed translation', [row(1, { translation: { lang: OWNER_LANG, failed: true } })], clientWithMe()],
    ['translation switched off', [row(1)], clientWithMe(ownerMe({ translationEnabled: false }))],
  ])('draws the original with %s', async (_, rows, client) => {
    await draw(rows, client);
    expect(h.text()).toContain('Moved task 1');
    expect(h.text()).toContain(REASON);
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});
