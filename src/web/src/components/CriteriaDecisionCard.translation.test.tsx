// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSLATION_COPY } from '../lib/translation';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe } from '../test/ownerCardTranslation';
import { CriteriaDecisionCard, type PendingCriteriaDecisionRow } from './CriteriaDecisionCard';

/** Board 04-owner-cards.html on a criteria-change proposal ("Approve & re-seal"). */

vi.mock('./ReviewCard', async () => await import('../test/inlineReviewCard'));

const SEAL = 'a'.repeat(64);
const REWORDED = 'Full API is green on the merge boundary';
const ADDED = 'The scheduled nodes are green';

function row(over: Partial<PendingCriteriaDecisionRow> = {}): PendingCriteriaDecisionRow {
  const wording = (text: string) => ({ text, verificationMethod: 'Run the suite', completionCriterionOverrideReason: null });
  return {
    intentId: '7f3a91c2-1d4e-4a6b-8c9d-0e1f2a3b4c5d',
    projectId: 'p1',
    commitToken: 'token',
    actionDigest: 'd'.repeat(64),
    filedAt: '2026-09-09T01:14:24.471Z',
    ageSeconds: 60,
    baselineSeal: SEAL,
    currentSeal: SEAL,
    proposed: [
      { id: 'c1', ordinal: 1, text: REWORDED, verificationMethod: 'Run the suite', completionCriterionOverrideReason: null },
      { id: null, ordinal: 2, text: ADDED, verificationMethod: 'Run the suite', completionCriterionOverrideReason: null },
    ],
    diff: {
      entries: [
        {
          change: 'CHANGED', definitionId: 'c1', ordinal: 1, proposed: wording(REWORDED), onRecord: wording('Full API was green last week'),
          changed: ['text'],
          rewrites: [{ field: 'text', segments: [
            { side: 'KEPT', text: 'Full API ' }, { side: 'REMOVED', text: 'was green last week' }, { side: 'ADDED', text: 'is green on the merge boundary' },
          ] }],
        },
        { change: 'NEW', definitionId: null, ordinal: 2, proposed: wording(ADDED), onRecord: null, changed: [], rewrites: [] },
      ],
      sameCount: 0, changedCount: 1, newCount: 1, removedCount: 0,
    },
    supersededIntentId: null,
    decidability: { decidable: true, refusal: null, requiredAction: null },
    translation: {
      lang: OWNER_LANG,
      proposed: [{ text: 'L’API complète est verte à la fusion' }, { text: 'Les nœuds planifiés sont verts' }],
    },
    ...over,
  };
}

const h = cardHost();
beforeEach(() => h.mount());
afterEach(() => h.unmount());

const draw = (r: PendingCriteriaDecisionRow, client = clientWithMe()) =>
  h.draw(<CriteriaDecisionCard standing={{ state: 'DECIDABLE', intentId: r.intentId, row: r }} onDecide={() => {}} />, client);

describe('a criteria-change proposal in the owner’s language', () => {
  it('draws the proposed criteria translated, and the toggle brings back the original rewrite', async () => {
    await draw(row());
    expect(h.text()).toContain('L’API complète est verte à la fusion');
    expect(h.text()).toContain('Les nœuds planifiés sont verts');
    expect(h.text()).not.toContain(ADDED);
    expect(h.el().querySelector('del')).toBeNull();
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);

    await h.press(TRANSLATION_COPY.showOriginal);
    expect(h.text()).toContain(ADDED);
    expect(h.el().querySelector('del')?.textContent).toBe('was green last week');
    expect(h.text()).not.toContain('Les nœuds');
    expect(h.text()).toContain(`${TRANSLATION_COPY.original}·${TRANSLATION_COPY.showTranslation}`);
  });

  it.each([
    ['no translation', row({ translation: undefined }), clientWithMe()],
    ['a failed translation', row({ translation: { lang: OWNER_LANG, failed: true } }), clientWithMe()],
    ['translation switched off', row(), clientWithMe(ownerMe({ translationEnabled: false }))],
  ])('draws the original with %s', async (_, r, client) => {
    await draw(r, client);
    expect(h.text()).toContain(ADDED);
    expect(h.el().querySelector('del')?.textContent).toBe('was green last week');
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});
