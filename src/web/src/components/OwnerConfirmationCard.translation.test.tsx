// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerConfirmationReviewView } from '@orbit/shared';
import { ownerConfirmationQuery } from '../lib/queries';
import { TRANSLATION_COPY } from '../lib/translation';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe, translationRefused } from '../test/ownerCardTranslation';
import {
  OWNER_CONFIRM_ACTION,
  OwnerConfirmationCard,
  SessionOwnerConfirmationCard,
  ownerDecisionRequest,
  type OwnerConfirmationView,
  type OwnerConfirmationWaiting,
} from './OwnerConfirmationCard';

/** Board 04-owner-cards.html on "Is this task done?" (task owner confirmation and its review). */

vi.mock('./ReviewCard', async () => await import('../test/inlineReviewCard'));
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const REPORT = 'Done. 38 invoices are filed.';
const JUDGMENT = 'The files match the criteria.';
const ASKED = 'Keep the duplicates folder?';

function review(over: Partial<OwnerConfirmationReviewView> = {}): OwnerConfirmationReviewView {
  return {
    reviewId: 'rev1',
    state: 'REVIEWED',
    notReviewedReason: null,
    outdated: null,
    reviewer: { kind: 'PROJECT_COORDINATOR', sessionId: 'coord', title: 'Coordinator' },
    since: '2026-09-13T10:39:00.000Z',
    dueAt: null,
    windowSeconds: 3600,
    headline: { kind: 'NEEDS_YOU', text: ASKED, more: 0 },
    review: {
      recordId: 'rec1',
      recordedAt: '2026-09-13T10:40:00.000Z',
      reviewedSha: null,
      judgment: JUDGMENT,
      checked: [],
      notChecked: [],
      leftOpen: [],
      needsYou: [{ key: 'n1', text: ASKED, options: [{ label: 'Keep it' }, { label: 'Delete it' }], recommendedOption: 0 }],
      translation: {
        lang: OWNER_LANG,
        judgment: 'Les fichiers respectent les critères.',
        needsYou: [{ text: 'Garder le dossier des doublons ?', options: [{ label: 'Le garder' }, { label: 'Le supprimer' }] }],
      },
    },
    returned: null,
    problems: null,
    ...over,
  };
}

function waiting(over: Partial<OwnerConfirmationWaiting> = {}): OwnerConfirmationWaiting {
  return {
    requestId: 'req1',
    sessionId: 's1',
    requestedAt: '2026-09-13T10:39:00.000Z',
    report: { text: REPORT, reportedAt: '2026-09-13T10:39:00.000Z', translation: { lang: OWNER_LANG, text: 'Fait. 38 factures sont classées.' } },
    review: review(),
    ...over,
  };
}

const view = (w = waiting()): OwnerConfirmationView => ({
  taskId: 't1',
  title: 'File the invoices',
  status: 'OPEN',
  projectId: null,
  completionCriterion: 'OWNER_CONFIRMED',
  acceptanceCriteria: 'Every invoice is filed.',
  waiting: w,
  decisions: [],
});

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

const card = (w: OwnerConfirmationWaiting, client = clientWithMe()) =>
  h.draw(<OwnerConfirmationCard view={view(w)} waiting={w} onDecide={() => {}} onSendBack={() => {}} />, client);

describe('Is this task done? in the owner’s language', () => {
  it('draws the report, the review’s judgment and its question translated; the toggle flips all of it', async () => {
    await card(waiting());
    for (const said of ['Fait. 38 factures sont classées.', 'Les fichiers respectent les critères.', 'Garder le dossier des doublons ?', 'Le garder']) {
      expect(h.text()).toContain(said);
    }
    for (const said of [REPORT, JUDGMENT, ASKED]) expect(h.text()).not.toContain(said);
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);

    await h.press(TRANSLATION_COPY.showOriginal);
    for (const said of [REPORT, JUDGMENT, ASKED, 'Keep it']) expect(h.text()).toContain(said);
    expect(h.text()).not.toContain('Fait.');
    expect(h.text()).not.toContain('Garder');
    expect(h.text()).toContain(`${TRANSLATION_COPY.original}·${TRANSLATION_COPY.showTranslation}`);
  });

  it('translates a PROBLEMS record’s reason and problems', async () => {
    const problems = {
      recordId: 'p', recordedAt: '2026-09-13T10:41:00.000Z', reviewedSha: null,
      reason: 'Two invoices are missing.', problems: [{ key: 'p1', text: 'October invoice absent' }],
      translation: { lang: OWNER_LANG, reason: 'Il manque deux factures.', problems: [{ text: 'Facture d’octobre absente' }] },
    };
    const { shownConfirmationReview } = await import('./OwnerConfirmationReview');
    const shown = shownConfirmationReview(review({ problems }), (t) => t);
    expect(shown.problems?.reason).toBe('Il manque deux factures.');
    expect(shown.problems?.problems[0]?.text).toBe('Facture d’octobre absente');
    expect(shown.problems?.problems[0]?.key).toBe('p1');
    expect(shown.headline).toEqual({ kind: 'NEEDS_YOU', text: 'Garder le dossier des doublons ?', more: 0 });
  });

  it.each([
    ['no translation', waiting({ report: { text: REPORT, reportedAt: '2026-09-13T10:39:00.000Z' }, review: review({ review: { ...review().review!, translation: undefined } }) }), clientWithMe()],
    ['a failed translation', waiting({ report: { text: REPORT, reportedAt: '2026-09-13T10:39:00.000Z', translation: { lang: OWNER_LANG, failed: true } }, review: review({ review: { ...review().review!, translation: { lang: OWNER_LANG, failed: true } } }) }), clientWithMe()],
    ['translation switched off', waiting(), clientWithMe(ownerMe({ translationEnabled: false }))],
  ])('draws the original with %s', async (_, w, client) => {
    await card(w, client);
    for (const said of [REPORT, JUDGMENT, ASKED]) expect(h.text()).toContain(said);
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});

describe('a confirmation the server could not translate', () => {
  it('shows the refusal with Retry and Send as written, which posts sendAsWritten: true', async () => {
    let posts = 0;
    apiMock.mockImplementation((async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        posts += 1;
        if (posts === 1) throw translationRefused();
        return {};
      }
      return view();
    }) as never);
    const client = clientWithMe();
    client.setQueryData(ownerConfirmationQuery('t1').queryKey, view());
    await h.draw(<MemoryRouter><SessionOwnerConfirmationCard sessionId="s1" taskId="t1" onSendBack={() => {}} /></MemoryRouter>, client);
    await h.press(OWNER_CONFIRM_ACTION);
    await h.until(() => h.text().includes(TRANSLATION_COPY.sendFailed), 'the refusal');
    expect(h.text()).toContain(TRANSLATION_COPY.retry);
    await h.press(TRANSLATION_COPY.sendAsWritten);
    await h.until(() => posts === 2, 'the resend');
    const sent = apiMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
    expect(sent[0]![0]).toBe('/tasks/t1/owner-confirmation');
    expect((sent[0]![1] as { body: object }).body).not.toHaveProperty('sendAsWritten');
    expect(sent[1]![1]).toMatchObject({ body: { decision: 'CONFIRM', requestId: 'req1', reviewRecordId: 'rec1', sendAsWritten: true } });
  });

  it('carries sendAsWritten on a send-back the composer resends as written', () => {
    expect(ownerDecisionRequest('t1', 'req1', 'SEND_BACK', 'Pas fini', undefined, true).body).toEqual({
      decision: 'SEND_BACK', requestId: 'req1', note: 'Pas fini', sendAsWritten: true,
    });
    expect(ownerDecisionRequest('t1', 'req1', 'SEND_BACK', 'Pas fini').body).not.toHaveProperty('sendAsWritten');
  });
});
