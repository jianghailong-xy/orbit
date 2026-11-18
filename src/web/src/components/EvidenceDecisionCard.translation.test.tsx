// @vitest-environment jsdom
import { useMutation } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSLATION_COPY } from '../lib/translation';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe, translationRefused } from '../test/ownerCardTranslation';
import type { PendingDecisionRow } from './DecisionRail';
import { EvidenceDecisionCard, sendEvidenceDecision } from './EvidenceDecisionCard';
import { RefusedSendBack } from './TranslationParts';

/** Board 04-owner-cards.html on the completion-evidence card, and its send-back refused at the composer. */

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const CLAIM = 'The evidence card renders from the pending read.';
const GAP = 'full-api was not run.';

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: 't1',
    title: 'Evidence card',
    projectId: 'p1',
    criterion: { key: 'k1', text: 'The card renders from the read' },
    evidenceRevision: '2',
    ageSeconds: 600,
    claim: CLAIM,
    gaps: [GAP],
    citations: [],
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    translation: { lang: OWNER_LANG, claim: 'La carte se dessine depuis la lecture.', gaps: ['full-api n’a pas été lancé.'] },
    ...over,
  };
}

const h = cardHost();
beforeEach(() => {
  apiMock.mockReset();
  h.mount();
});
afterEach(() => {
  h.unmount();
});

const card = (r: PendingDecisionRow, client = clientWithMe()) =>
  h.draw(
    <EvidenceDecisionCard
      standing={{ state: 'DECIDABLE', address: { taskId: r.taskId, evidenceRevision: r.evidenceRevision }, row: r }}
      onConfirm={() => {}}
      onChatAbout={() => {}}
    />,
    client,
  );

describe('the evidence card in the owner’s language', () => {
  it('draws the claim and gaps translated, and the toggle flips both', async () => {
    await card(row());
    expect(h.text()).toContain('La carte se dessine depuis la lecture.');
    expect(h.text()).toContain('full-api n’a pas été lancé.');
    expect(h.text()).not.toContain(CLAIM);
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);
    await h.press(TRANSLATION_COPY.showOriginal);
    expect(h.text()).toContain(CLAIM);
    expect(h.text()).toContain(GAP);
    expect(h.text()).not.toContain('La carte');
    expect(h.text()).toContain(`${TRANSLATION_COPY.original}·${TRANSLATION_COPY.showTranslation}`);
  });

  it.each([
    ['no translation', row({ translation: undefined }), clientWithMe()],
    ['a failed translation', row({ translation: { lang: OWNER_LANG, failed: true } }), clientWithMe()],
    ['translation switched off', row(), clientWithMe(ownerMe({ translationEnabled: false }))],
  ])('draws the original with %s', async (_, r, client) => {
    await card(r, client);
    expect(h.text()).toContain(CLAIM);
    expect(h.text()).toContain(GAP);
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});

describe('a send-back the server could not translate', () => {
  it('shows the refusal above the composer; Send as written posts sendAsWritten: true', async () => {
    let posts = 0;
    apiMock.mockImplementation((async () => {
      posts += 1;
      if (posts === 1) throw translationRefused();
      return { decision: 'SEND_BACK' };
    }) as never);
    type Press = { sessionId: string; decidingSessionId: string; taskId: string; evidenceRevision: string; note: string; sendAsWritten?: boolean };
    // The composer's press as WorkspaceView makes it.
    function Composer() {
      const decision = useMutation({
        mutationFn: (press: Press) => sendEvidenceDecision(press, press.decidingSessionId, 'SEND_BACK', press.note, press.sendAsWritten),
      });
      return (
        <>
          <RefusedSendBack mutation={decision} when={(press) => press.sessionId === 's1'} />
          <button type="button" onClick={() => decision.mutate({ sessionId: 's1', decidingSessionId: 's1', taskId: 't1', evidenceRevision: '2', note: 'Lancez full-api' })}>
            Send
          </button>
        </>
      );
    }
    await h.draw(<Composer />);
    expect(h.text()).not.toContain(TRANSLATION_COPY.sendFailed);
    await h.press('Send');
    await h.until(() => h.text().includes(TRANSLATION_COPY.sendFailed), 'the refusal');
    expect(h.text()).toContain(TRANSLATION_COPY.retry);
    expect(h.text()).toContain(TRANSLATION_COPY.sendAsWritten);
    await h.press(TRANSLATION_COPY.sendAsWritten);
    await h.until(() => posts === 2, 'the resend');
    expect(apiMock.mock.calls[0]![1]).toEqual({ method: 'POST', body: { decidingSessionId: 's1', evidenceRevision: '2', decision: 'SEND_BACK', note: 'Lancez full-api' } });
    expect(apiMock.mock.calls[1]![0]).toBe('/tasks/t1/evidence/decision');
    expect(apiMock.mock.calls[1]![1]).toEqual({
      method: 'POST',
      body: { decidingSessionId: 's1', evidenceRevision: '2', decision: 'SEND_BACK', note: 'Lancez full-api', sendAsWritten: true },
    });
    await h.until(() => !h.text().includes(TRANSLATION_COPY.sendFailed), 'the refusal gone once sent');
  });
});
