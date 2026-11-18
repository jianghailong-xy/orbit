// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import type { OwnerCardTranslation, ProjectOpenItemRow } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOVER_NOTE_CAPTION, ItemAsCard } from './ProjectProgressStatus';
import { projectDetailsQuery } from '../lib/queries';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe } from '../test/ownerCardTranslation';

/**
 * The card of an item the coordinator handed over (open_item_hand_over): its note under
 * HANDOVER_NOTE_CAPTION in the coordinator row, translated with the card's one flip while a usable
 * translation exists, the note as written otherwise, and nothing when there is no note.
 */

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

const PROJECT_ID = '35aK2xQm8LrT0vHcE1pZq';
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const NOTE = 'The conflict is in your retry policy';
const TRANSLATED = 'Le conflit est dans votre politique de nouvelle tentative';

function handedOver(over: Partial<ProjectOpenItemRow> = {}): ProjectOpenItemRow {
  return {
    itemId: '35aItem0000000000000001',
    kind: 'INTEGRATION_CONFLICT',
    title: 'Merge conflict: Retry failed webhook deliveries',
    detailLine: '9 files conflict with project/35aK2xQm',
    assignee: 'OWNER',
    assigneeReason: 'HANDED_OVER',
    handoverNote: NOTE,
    waitingSince: new Date(NOW - 3_600_000).toISOString(),
    escalateAt: null,
    escalatedAt: null,
    taskId: '35aTask00000000000001',
    sessionId: '35aSession000000000001',
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'DELIVERED', sessionId: '35aCoord0000000000001', at: new Date(NOW).toISOString() },
    actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION'],
    question: null,
    facts: null,
    chat: { sessionId: '35aCoord0000000000001', stage: 'WITH_OWNER', refusal: null },
    coordinatorUnreachable: false,
    ...over,
  } as ProjectOpenItemRow;
}

const translation: OwnerCardTranslation = { lang: OWNER_LANG, handoverNote: TRANSLATED };

const host = cardHost();
beforeEach(() => host.mount());
afterEach(() => host.unmount());

async function draw(row: ProjectOpenItemRow, me = ownerMe()) {
  const qc = clientWithMe(me);
  qc.setQueryData(projectDetailsQuery(PROJECT_ID).queryKey, { id: PROJECT_ID, title: 'Checkout v2' });
  await host.draw(
    <MemoryRouter>
      <ItemAsCard projectId={PROJECT_ID} row={row} now={NOW} />
    </MemoryRouter>,
    qc,
  );
}

const block = () => host.el().querySelector('[data-who="coordinator"] .project-open-item-handover');
const caption = () => block()?.querySelector('.project-open-item-handover-caption')?.textContent;
const note = () => block()?.querySelector('.project-open-item-handover-note')?.textContent;

describe('a handed-over item draws the coordinator’s note under its caption', () => {
  it('the caption is Orbit’s English', () => {
    expect(HANDOVER_NOTE_CAPTION).toBe('Why the coordinator handed it over');
  });

  it('translated while a usable translation exists, with the card’s flip back to the original', async () => {
    await draw(handedOver({ translation }));
    expect(caption()).toBe(HANDOVER_NOTE_CAPTION);
    expect(note()).toBe(TRANSLATED);
    expect(block()?.textContent).toContain('Translated');
    await host.press('Show original');
    expect(caption()).toBe(HANDOVER_NOTE_CAPTION);
    expect(note()).toBe(NOTE);
    expect(block()?.textContent).toContain('Show translation');
  });

  it('the note as written, with no flip, when there is no translation', async () => {
    await draw(handedOver());
    expect(caption()).toBe(HANDOVER_NOTE_CAPTION);
    expect(note()).toBe(NOTE);
    expect(host.el().querySelector('.chat-translate-foot')).toBeNull();
  });

  it('the note as written when the translation failed, is in another language or translation is off', async () => {
    await draw(handedOver({ translation: { lang: OWNER_LANG, failed: true } }));
    expect(note()).toBe(NOTE);
    await draw(handedOver({ translation: { lang: 'ja', handoverNote: 'JA' } }));
    expect(note()).toBe(NOTE);
    await draw(handedOver({ translation }), ownerMe({ translationEnabled: false }));
    expect(note()).toBe(NOTE);
    expect(host.el().querySelector('.chat-translate-foot')).toBeNull();
  });

  it('nothing, caption included, when the note is null', async () => {
    await draw(handedOver({ handoverNote: null }));
    expect(block()).toBeNull();
    expect(host.text()).not.toContain(HANDOVER_NOTE_CAPTION);
    expect(host.text()).toContain('It handed this to you on purpose.');
  });

  it('the status sentence no longer quotes the note: it is drawn once, under the caption', async () => {
    await draw(handedOver());
    const status = host.el().querySelector('[data-who="coordinator"] .project-open-item-who-status');
    expect(status?.textContent).toBe('It handed this to you on purpose.');
  });
});
