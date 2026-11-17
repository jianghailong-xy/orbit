// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSLATION_COPY } from '../lib/translation';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe, translationRefused } from '../test/ownerCardTranslation';
import { AnsweredQuestionCard, CoordinatorQuestionCard, type ProjectOpenItemRow } from './CoordinatorQuestionCard';

/** Board 04-owner-cards.html frames 1–4 on the coordinator's question. */

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const QUESTION = 'Should the new export keep the old columns?';
const TRANSLATED = 'Le nouvel export garde-t-il les anciennes colonnes ?';

function row(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: 'item1',
    kind: 'COORDINATOR_QUESTION',
    title: `Coordinator asks: ${QUESTION}`,
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    escalateAt: null,
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    facts: null,
    waitingSince: new Date(0).toISOString(),
    question: {
      question: QUESTION,
      options: [{ label: 'Keep the old columns', description: 'Both shapes for one release' }, { label: 'Update the sheet' }],
      recommendedOption: 0,
      blocksTaskIds: [],
      ifUnanswered: null,
    },
    translation: {
      lang: OWNER_LANG,
      question: TRANSLATED,
      options: [{ label: 'Garder les anciennes colonnes', description: 'Les deux formats pendant une version' }, { label: 'Modifier la feuille' }],
    },
    ...over,
  };
}

const h = cardHost();
beforeEach(() => {
  apiMock.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  h.mount();
});
afterEach(() => {
  h.unmount();
  vi.unstubAllGlobals();
});

const draw = (r: ProjectOpenItemRow, client = clientWithMe()) =>
  h.draw(<CoordinatorQuestionCard projectId="p1" row={r} now={0} />, client);

describe('the coordinator question in the owner’s language', () => {
  it('draws the translation with Translated · Show original, and the toggle flips the whole card', async () => {
    await draw(row());
    expect(h.text()).toContain(TRANSLATED);
    expect(h.text()).toContain('Garder les anciennes colonnes');
    expect(h.text()).toContain('Les deux formats pendant une version');
    expect(h.text()).not.toContain(QUESTION);
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);

    await h.press(TRANSLATION_COPY.showOriginal);
    expect(h.text()).toContain(QUESTION);
    expect(h.text()).toContain('Keep the old columns');
    expect(h.text()).not.toContain(TRANSLATED);
    expect(h.text()).not.toContain('Garder');
    expect(h.text()).toContain(`${TRANSLATION_COPY.original}·${TRANSLATION_COPY.showTranslation}`);

    await h.press(TRANSLATION_COPY.showTranslation);
    expect(h.text()).toContain(TRANSLATED);
  });

  it.each([
    ['no translation', row({ translation: undefined }), clientWithMe()],
    ['a failed translation', row({ translation: { lang: OWNER_LANG, failed: true } }), clientWithMe()],
    ['a translation in another language', row({ translation: { lang: 'de', question: 'Deutsch' } }), clientWithMe()],
    ['translation switched off', row(), clientWithMe(ownerMe({ translationEnabled: false }))],
  ])('draws the original with %s', async (_, r, client) => {
    await draw(r, client);
    expect(h.text()).toContain(QUESTION);
    expect(h.text()).toContain('Keep the old columns');
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });

  it('draws an answered question translated too', async () => {
    const r = row();
    await h.draw(
      <AnsweredQuestionCard
        record={{
          itemId: r.itemId,
          question: r.question!,
          askedAt: r.waitingSince,
          resolution: 'ANSWERED',
          resolvedBy: 'USER',
          resolvedAt: r.waitingSince,
          answer: { option: 0, text: null },
          delivery: null,
          withdrawReason: null,
          translation: { lang: OWNER_LANG, question: TRANSLATED },
        }}
      />,
    );
    expect(h.text()).toContain(TRANSLATED);
    await h.press('View details');
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);
    await h.press(TRANSLATION_COPY.showOriginal);
    expect(h.text()).toContain(QUESTION);
  });
});

describe('an answer the server could not translate', () => {
  it('shows the refusal with Retry and Send as written, which posts sendAsWritten: true', async () => {
    apiMock.mockRejectedValueOnce(translationRefused());
    await draw(row());
    await h.type('Garder les deux, mais demander aux finances');
    await h.press('Send answer');
    await h.until(() => h.text().includes(TRANSLATION_COPY.sendFailed), 'the refusal');
    expect(h.text()).toContain(TRANSLATION_COPY.retry);
    expect(h.text()).toContain(TRANSLATION_COPY.sendAsWritten);
    expect(h.text()).not.toContain('That answer was not recorded');

    apiMock.mockRejectedValueOnce(translationRefused());
    await h.press(TRANSLATION_COPY.retry);
    await h.until(() => apiMock.mock.calls.length === 2, 'the retry');
    expect(apiMock.mock.calls[1]![1]).toMatchObject({ body: { option: 0, text: 'Garder les deux, mais demander aux finances' } });
    expect((apiMock.mock.calls[1]![1] as { body: object }).body).not.toHaveProperty('sendAsWritten');

    apiMock.mockResolvedValueOnce({ itemId: 'item1', state: 'RESOLVED', resolution: 'ANSWERED', delivery: null });
    await h.until(() => h.text().includes(TRANSLATION_COPY.sendAsWritten), 'the refusal again');
    await h.press(TRANSLATION_COPY.sendAsWritten);
    await h.until(() => apiMock.mock.calls.length >= 3, 'the send as written');
    expect(apiMock.mock.calls[2]![0]).toBe('/projects/p1/open-items/item1/answer');
    expect(apiMock.mock.calls[2]![1]).toMatchObject({
      method: 'POST',
      body: { option: 0, text: 'Garder les deux, mais demander aux finances', sendAsWritten: true },
    });
  });
});
