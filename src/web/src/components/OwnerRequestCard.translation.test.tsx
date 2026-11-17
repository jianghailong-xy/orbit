// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSLATION_COPY } from '../lib/translation';
import type { OwnerRequest } from '../lib/ownerRequests';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe, translationRefused } from '../test/ownerCardTranslation';
import { OwnerRequestCard } from './OwnerRequestCard';

/** Board 04-owner-cards.html on an owner request (request_owner_action). */

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function request(over: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    id: 'req1',
    kind: 'DECISION',
    state: 'PENDING',
    title: 'Pick the release channel',
    why: 'The tag goes out tonight.',
    blocksTaskIds: [],
    ifUnanswered: 'the beta channel is used',
    options: [{ label: 'Beta', description: 'Testers first' }, { label: 'Stable' }],
    recommendedOption: 0,
    steps: null,
    secretSpec: null,
    secretGrant: null,
    verifyHint: 'the tag is on the beta page',
    expiresAt: null,
    askedBySessionId: 's1',
    projectId: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolvedBySessionId: null,
    resolutionNote: null,
    answer: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    translation: {
      lang: OWNER_LANG,
      title: 'Choisir le canal de version',
      why: 'Le tag part ce soir.',
      ifUnanswered: 'le canal bêta est utilisé',
      options: [{ label: 'Bêta', description: 'Les testeurs d’abord' }, { label: 'Stable' }],
      verifyHint: 'le tag est sur la page bêta',
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

const draw = (r: OwnerRequest, client = clientWithMe()) =>
  h.draw(<MemoryRouter><OwnerRequestCard request={r} now={NOW} /></MemoryRouter>, client);

describe('an owner request in the owner’s language', () => {
  it('draws the translation with Translated · Show original; the toggle flips the whole card', async () => {
    await draw(request());
    for (const said of ['Choisir le canal de version', 'Le tag part ce soir.', 'le canal bêta est utilisé', 'Les testeurs d’abord', 'le tag est sur la page bêta']) {
      expect(h.text()).toContain(said);
    }
    expect(h.text()).not.toContain('Pick the release channel');
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);

    await h.press(TRANSLATION_COPY.showOriginal);
    for (const said of ['Pick the release channel', 'The tag goes out tonight.', 'the beta channel is used', 'Testers first', 'the tag is on the beta page']) {
      expect(h.text()).toContain(said);
    }
    expect(h.text()).not.toContain('Choisir');
    expect(h.text()).toContain(`${TRANSLATION_COPY.original}·${TRANSLATION_COPY.showTranslation}`);
  });

  it('translates a manual step’s text and keeps its command as written', async () => {
    await draw(request({
      kind: 'MANUAL_STEP',
      options: null,
      recommendedOption: null,
      steps: [{ text: 'Open the console', command: 'gh auth login' }],
      translation: { lang: OWNER_LANG, steps: [{ text: 'Ouvrez la console' }] },
    }));
    expect(h.text()).toContain('Ouvrez la console');
    expect(h.text()).toContain('gh auth login');
    expect(h.text()).not.toContain('Open the console');
  });

  it.each([
    ['no translation', request({ translation: null }), clientWithMe()],
    ['a failed translation', request({ translation: { lang: OWNER_LANG, failed: true } }), clientWithMe()],
    ['translation switched off', request(), clientWithMe(ownerMe({ translationEnabled: false }))],
  ])('draws the original with %s', async (_, r, client) => {
    await draw(r, client);
    expect(h.text()).toContain('Pick the release channel');
    expect(h.text()).toContain('The tag goes out tonight.');
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});

describe('an answer the server could not translate', () => {
  it('shows the refusal; Send as written posts sendAsWritten: true', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('/owner-requests/req1/')) throw translationRefused();
      return undefined as never;
    });
    await draw(request());
    await h.type('Bêta, mais prévenez les testeurs');
    await h.press('Send answer');
    await h.until(() => h.text().includes(TRANSLATION_COPY.sendFailed), 'the refusal');
    expect(h.text()).toContain(TRANSLATION_COPY.retry);
    expect(h.text()).not.toContain('That was not recorded');

    await h.press(TRANSLATION_COPY.sendAsWritten);
    await h.until(() => apiMock.mock.calls.filter(([p]) => String(p).includes('/req1/done')).length === 2, 'the resend');
    const posts = apiMock.mock.calls.filter(([p]) => String(p).includes('/req1/done'));
    expect(posts[0]![1]).toMatchObject({ body: { option: 0, text: 'Bêta, mais prévenez les testeurs' } });
    expect((posts[0]![1] as { body: object }).body).not.toHaveProperty('sendAsWritten');
    expect(posts[1]![1]).toMatchObject({ method: 'POST', body: { option: 0, text: 'Bêta, mais prévenez les testeurs', sendAsWritten: true } });
  });

  it('holds a refused decline reason the same way', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('/owner-requests/req1/')) throw translationRefused();
      return undefined as never;
    });
    await draw(request());
    await h.press('Decline…');
    await h.type('Pas ce soir', 'textarea[aria-label="Reason for declining"]');
    await h.press('Decline');
    await h.until(() => h.text().includes(TRANSLATION_COPY.sendFailed), 'the refusal');
    await h.press(TRANSLATION_COPY.sendAsWritten);
    await h.until(() => apiMock.mock.calls.filter(([p]) => String(p).includes('/req1/decline')).length === 2, 'the resend');
    const posts = apiMock.mock.calls.filter(([p]) => String(p).includes('/req1/decline'));
    expect(posts[1]![1]).toMatchObject({ body: { reason: 'Pas ce soir', sendAsWritten: true } });
  });
});
