// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoneRequest, OwnerCardTranslation } from '@orbit/shared';
import { PROJECT_DONE_COPY, type ProjectDoneDocument } from '../lib/projectDone';
import { TRANSLATION_COPY } from '../lib/translation';
import { cardHost, clientWithMe, OWNER_LANG, ownerMe, translationRefused } from '../test/ownerCardTranslation';
import projectRead from '../test/projectRead.translation.json';
import { ProjectAcceptanceCard } from './ProjectAcceptanceCard';
import { ProjectDoneCard, ProjectDoneDialog, ProjectWhyNotDoneCard } from './ProjectSettlementCard';

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

/** Board 04-owner-cards.html on "Is this project done?" (the coordinator's done request). */

const project = {
  id: 'p1',
  title: 'Project closeout',
  status: 'OPEN' as const,
  acceptanceCriteriaItems: [{ id: 'c1', ordinal: 1, text: 'The release is on main' }],
};

const JUDGMENT = 'The goal is met. I checked the release evidence below.';
const request: DoneRequest = {
  criteriaDigest: 'digest-1',
  judgment: JUDGMENT,
  gaps: [{ criterionKey: 'c1', title: 'The live check', whyNotProven: 'The task made no commits.', coordinatorChecked: 'main has the files' }],
};
const translation: OwnerCardTranslation = {
  lang: OWNER_LANG,
  judgment: 'L’objectif est atteint.',
  gaps: [{ title: 'La vérification en direct', whyNotProven: 'La tâche n’a fait aucun commit.', coordinatorChecked: 'main a les fichiers' }],
};

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

describe('Is this project done? in the owner’s language', () => {
  it('draws the judgment and gaps translated, and the toggle flips the whole card', async () => {
    await h.draw(<ProjectDoneCard project={project} doneRequest={request} translation={translation} onRecordDone={() => {}} onNotYet={() => {}} />);
    for (const said of ['L’objectif est atteint.', 'La vérification en direct', 'La tâche n’a fait aucun commit.', 'main a les fichiers']) {
      expect(h.text()).toContain(said);
    }
    expect(h.text()).not.toContain(JUDGMENT);
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);

    await h.press(TRANSLATION_COPY.showOriginal);
    for (const said of [JUDGMENT, 'The live check', 'The task made no commits.', 'main has the files']) {
      expect(h.text()).toContain(said);
    }
    expect(h.text()).not.toContain('L’objectif');
    expect(h.text()).toContain(`${TRANSLATION_COPY.original}·${TRANSLATION_COPY.showTranslation}`);
  });

  it.each([
    ['no translation', null, clientWithMe()],
    ['a failed translation', { lang: OWNER_LANG, failed: true as const }, clientWithMe()],
    ['translation switched off', translation, clientWithMe(ownerMe({ translationEnabled: false }))],
  ])('draws the original with %s', async (_, t, client) => {
    await h.draw(<ProjectDoneCard project={project} doneRequest={request} translation={t} onRecordDone={() => {}} onNotYet={() => {}} />, client);
    expect(h.text()).toContain(JUDGMENT);
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});

describe('a Not yet note the server could not translate', () => {
  it('shows the refusal with Retry and Send as written, which resends with sendAsWritten', async () => {
    const resent: boolean[] = [];
    function Host() {
      const [refused, setRefused] = useState(false);
      return (
        <ProjectDoneCard
          project={project}
          doneRequest={request}
          onRecordDone={() => {}}
          onNotYet={() => setRefused(true)}
          notYetRefused={refused ? async (sendAsWritten) => { resent.push(sendAsWritten); } : null}
        />
      );
    }
    await h.draw(<Host />);
    await h.press(PROJECT_DONE_COPY.notYet);
    await h.type('Il manque la vérification');
    await h.press(PROJECT_DONE_COPY.sendToCoordinator);
    expect(h.text()).toContain(TRANSLATION_COPY.sendFailed);
    await h.press(TRANSLATION_COPY.retry);
    await h.press(TRANSLATION_COPY.sendAsWritten);
    expect(resent).toEqual([false, true]);
  });

  it('says why when the refusal did (docs/ux/translation-failure-policy.html, frames 5 and 7)', async () => {
    function Host() {
      const [refused, setRefused] = useState(false);
      return (
        <ProjectDoneCard
          project={project}
          doneRequest={request}
          onRecordDone={() => {}}
          onNotYet={() => setRefused(true)}
          notYetRefused={refused ? async () => {} : null}
          notYetRefusal={refused ? translationRefused({ failureReason: 'HTTP', httpStatus: 503 }) : null}
        />
      );
    }
    await h.draw(<Host />);
    await h.press(PROJECT_DONE_COPY.notYet);
    await h.type('Il manque la vérification');
    await h.press(PROJECT_DONE_COPY.sendToCoordinator);
    expect(h.text()).toContain("The translator was unreachable, so your answer wasn't sent·Retry·Send as written");
    expect(h.text()).not.toContain(TRANSLATION_COPY.sendFailed);
  });
});

describe('the project page’s done dialog', () => {
  it('posts the refused note again with sendAsWritten: true', async () => {
    let declines = 0;
    apiMock.mockImplementation((async (path: string) => {
      if (path.endsWith('/decline')) {
        declines += 1;
        if (declines === 1) throw translationRefused();
        return {};
      }
      if (path.endsWith('/acceptance/confirmation')) return { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'digest-1', material: [] }, confirmation: null };
      return {};
    }) as never);
    const row = {
      itemId: 'done1', kind: 'DONE_REQUEST', title: 'Is this project done?', detailLine: '', assignee: 'OWNER', assigneeReason: 'DEFAULT',
      escalateAt: null, escalatedAt: null, taskId: null, sessionId: null, promotionId: null, fuseEpisodeId: null,
      delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null }, actions: [], facts: null, question: null,
      waitingSince: new Date(0).toISOString(), doneRequest: request, translation,
    } as never;
    await h.draw(<ProjectDoneDialog projectId="p1" open onClose={() => {}} project={project as never} doneRequestRow={row} />);
    expect(h.text()).toContain('L’objectif est atteint.');
    await h.press(PROJECT_DONE_COPY.notYet);
    await h.type('Il manque la vérification');
    await h.press(PROJECT_DONE_COPY.sendToCoordinator);
    await h.until(() => h.text().includes(TRANSLATION_COPY.sendFailed), 'the refusal');
    expect(h.text()).not.toContain('Project was not recorded done');
    await h.press(TRANSLATION_COPY.sendAsWritten);
    await h.until(() => declines === 2, 'the resend');
    const posts = apiMock.mock.calls.filter(([p]) => String(p).endsWith('/decline'));
    expect(posts[0]![0]).toBe('/projects/p1/done-requests/done1/decline');
    expect(posts[0]![1]).toEqual({ method: 'POST', body: { note: 'Il manque la vérification' } });
    expect(posts[1]![1]).toEqual({ method: 'POST', body: { note: 'Il manque la vérification', sendAsWritten: true } });
  });

  it("draws the refusal's reason: a damaged translation", async () => {
    apiMock.mockImplementation((async (path: string) => {
      if (path.endsWith('/decline')) throw translationRefused({ failureReason: 'MANGLED' });
      if (path.endsWith('/acceptance/confirmation')) return { state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'digest-1', material: [] }, confirmation: null };
      return {};
    }) as never);
    const row = {
      itemId: 'done1', kind: 'DONE_REQUEST', title: 'Is this project done?', detailLine: '', assignee: 'OWNER', assigneeReason: 'DEFAULT',
      escalateAt: null, escalatedAt: null, taskId: null, sessionId: null, promotionId: null, fuseEpisodeId: null,
      delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null }, actions: [], facts: null, question: null,
      waitingSince: new Date(0).toISOString(), doneRequest: request, translation,
    } as never;
    await h.draw(<ProjectDoneDialog projectId="p1" open onClose={() => {}} project={project as never} doneRequestRow={row} />);
    await h.press(PROJECT_DONE_COPY.notYet);
    await h.type('Il manque la vérification');
    await h.press(PROJECT_DONE_COPY.sendToCoordinator);
    const line = "The translation came back damaged, so your answer wasn't sent";
    await h.until(() => h.text().includes(line), 'the reason');
    expect(h.text()).toContain(`${line}·Retry·Send as written`);
  });
});

/**
 * The project's own title and criteria, over `GET /projects/:id` as the server serves it: the read of
 * project-text-translation.pg.spec.ts (a), taken against PostgreSQL and passed through the HTTP layer's
 * public-id mapping (`addTwins`). Its translator is a stub that answers `ZH[<the text>]`.
 */
const served = projectRead as unknown as ProjectDoneDocument & { acceptanceCriteriaItems: Array<{ id: string; text: string }> };
const words = served.translation!;
const originals = served.acceptanceCriteriaItems.map((item) => item.text);
const translated = words.criteria!.map((criterion) => criterion.text);
const zhOwner = () => clientWithMe(ownerMe({ translationLanguage: 'zh-Hans' }));
const texts = (selector: string) => [...document.body.querySelectorAll(selector)].map((el) => el.textContent);
const metaTitle = () => texts('.project-settlement-meta')[0]!.split(' · ')[0];

const FALLBACKS = [
  ['no translation', { ...served, translation: undefined }, zhOwner],
  ['a failed translation', { ...served, translation: { lang: 'zh-Hans' as const, failed: true as const } }, zhOwner],
  ['a translation in another language', served, () => clientWithMe(ownerMe({ translationLanguage: 'ja' }))],
  ['translation switched off', served, () => clientWithMe(ownerMe({ translationLanguage: 'zh-Hans', translationEnabled: false }))],
] as const;

describe('the done card’s title and Done when, over the served read', () => {
  const card = (project: ProjectDoneDocument) => <ProjectDoneCard project={project} ownerInitiated onRecordDone={() => {}} />;

  it('owner-started: draws them translated, and the toggle shows the originals', async () => {
    await h.draw(card(served), zhOwner());
    expect(metaTitle()).toBe(words.title);
    expect(texts('.project-done-criterion-text')).toEqual(translated);
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);
    expect(h.text()).toContain(PROJECT_DONE_COPY.noRequestMeta);

    await h.press(TRANSLATION_COPY.showOriginal);
    expect(metaTitle()).toBe(served.title);
    expect(texts('.project-done-criterion-text')).toEqual(originals);
    await h.press(TRANSLATION_COPY.showTranslation);
    expect(texts('.project-done-criterion-text')).toEqual(translated);
  });

  it('coordinator request: one toggle flips the judgment, gaps, title and criteria together', async () => {
    const [first, second] = served.acceptanceCriteriaItems;
    // The open-items row's own translation, in the same language; its second gap has no title, so the card
    // draws that criterion's text.
    const asked: DoneRequest = { ...request, gaps: [{ ...request.gaps[0]!, criterionKey: first!.id }, { criterionKey: second!.id } as DoneRequest['gaps'][number]] };
    const judged: OwnerCardTranslation = { ...translation, lang: 'zh-Hans' };
    await h.draw(<ProjectDoneCard project={served} doneRequest={asked} translation={judged} onRecordDone={() => {}} onNotYet={() => {}} />, zhOwner());
    expect(metaTitle()).toBe(words.title);
    expect(texts('.project-done-criterion-text')).toEqual(translated);
    expect(texts('.project-done-gap-title')).toEqual([judged.gaps![0]!.title, translated[1]]);
    expect(h.text()).toContain(judged.judgment);
    expect(texts('.chat-translate-foot')).toHaveLength(1);

    await h.press(TRANSLATION_COPY.showOriginal);
    expect(metaTitle()).toBe(served.title);
    expect(texts('.project-done-criterion-text')).toEqual(originals);
    expect(texts('.project-done-gap-title')).toEqual(['The live check', originals[1]]);
    expect(h.text()).toContain(JUDGMENT);
  });

  it('the receipt draws the title translated, with the same toggle', async () => {
    await h.draw(<ProjectDoneCard project={{ ...served, status: 'DONE', doneBy: 'OWNER' }} />, zhOwner());
    expect(metaTitle()).toBe(words.title);
    await h.press(TRANSLATION_COPY.showOriginal);
    expect(metaTitle()).toBe(served.title);
  });

  it('draws a criterion the translation does not hold in its own words, matched by id', async () => {
    await h.draw(card({ ...served, translation: { ...words, criteria: [words.criteria![1]!] } }), zhOwner());
    expect(texts('.project-done-criterion-text')).toEqual([originals[0], translated[1]]);
  });

  it.each(FALLBACKS)('draws the originals with %s, on both variants', async (_, project, client) => {
    for (const ui of [card(project), <ProjectDoneCard project={project} doneRequest={request} onRecordDone={() => {}} />]) {
      await h.draw(ui, client());
      expect(metaTitle()).toBe(served.title);
      expect(texts('.project-done-criterion-text')).toEqual(originals);
      expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
    }
  });
});

describe('the why-not-done card over the served read', () => {
  it('draws the criteria translated, and the toggle shows the originals', async () => {
    await h.draw(<ProjectWhyNotDoneCard project={served} />, zhOwner());
    expect(texts('.project-why-item-title')).toEqual(translated);
    expect(h.text()).toContain(PROJECT_DONE_COPY.whyHeading);

    await h.press(TRANSLATION_COPY.showOriginal);
    expect(texts('.project-why-item-title')).toEqual(originals);
  });

  it('offers no toggle once the project is done, where it draws no criterion', async () => {
    await h.draw(<ProjectWhyNotDoneCard project={{ ...served, status: 'DONE' }} />, zhOwner());
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });

  it.each(FALLBACKS)('draws the originals with %s', async (_, project, client) => {
    await h.draw(<ProjectWhyNotDoneCard project={project} />, client());
    expect(texts('.project-why-item-title')).toEqual(originals);
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});

describe('the project page’s Done when list over the served read', () => {
  // The row's Markdown unwraps its paragraph, so the criterion's words are the row's first node.
  const rows = () => [...document.body.querySelectorAll('.acceptance-row-text')].map((el) => el.firstChild!.textContent);
  async function drawList(read: unknown, client = zhOwner()) {
    apiMock.mockImplementation((async () => read) as never);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    await h.draw(<ProjectAcceptanceCard projectId={served.id!} />, client);
    await h.until(() => rows().length === originals.length, 'the criteria');
  }

  it('draws the criteria translated, and the toggle shows the originals', async () => {
    await drawList(served);
    expect(rows()).toEqual(translated);
    expect(h.text()).toContain(`${TRANSLATION_COPY.translated}·${TRANSLATION_COPY.showOriginal}`);

    await h.press(TRANSLATION_COPY.showOriginal);
    expect(rows()).toEqual(originals);
  });

  it('keeps a press on a translated row on the criterion’s own words', async () => {
    const [first, second] = served.acceptanceCriteriaItems;
    await drawList({ ...served, acceptanceCriteriaItems: [{ ...first, satisfiedBy: 'CONFIRMATION' }, second] });
    await h.press('Confirm…');
    const dialog = document.body.querySelector('[role="dialog"]')!.textContent!;
    expect(dialog).toContain(originals[0]);
    expect(dialog).not.toContain(translated[0]);
  });

  it.each(FALLBACKS)('draws the originals with %s', async (_, project, client) => {
    await drawList(project, client());
    expect(rows()).toEqual(originals);
    expect(h.text()).not.toContain(TRANSLATION_COPY.showOriginal);
  });
});
