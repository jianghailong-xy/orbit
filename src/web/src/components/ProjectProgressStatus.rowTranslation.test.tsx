// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import type { OwnerCardTranslation, ProjectOpenItemRow } from '@orbit/shared';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOpenItems } from './ProjectProgressStatus';
import { projectOpenItemsQuery, type Me } from '../lib/queries';
import { clientWithMe, OWNER_LANG, ownerMe } from '../test/ownerCardTranslation';

/** The project page's open-items list row, drawn in the owner's language while a usable translation exists. */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT_ID = '34ODoUKJGEsfbgcJDGS4q';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const QUESTION = 'Should the new export keep the old columns?';
const ORIGINAL_TITLE = `Coordinator asks: ${QUESTION}`;
const ORIGINAL_LINE = 'Blocks 1 task · If you don’t answer: the export keeps both shapes';
const TRANSLATED_TITLE = 'Coordinator asks: Le nouvel export garde-t-il les anciennes colonnes ?';
const TRANSLATED_LINE = 'Blocks 1 task · If you don’t answer: l’export garde les deux formats';

const TRANSLATION: OwnerCardTranslation = {
  lang: OWNER_LANG,
  question: 'Le nouvel export garde-t-il les anciennes colonnes ?',
  ifUnanswered: 'l’export garde les deux formats',
  title: TRANSLATED_TITLE,
  detailLine: TRANSLATED_LINE,
};

function row(translation: OwnerCardTranslation | undefined): ProjectOpenItemRow {
  return {
    itemId: 'item1',
    kind: 'COORDINATOR_QUESTION',
    title: ORIGINAL_TITLE,
    detailLine: ORIGINAL_LINE,
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    waitingSince: new Date(NOW - 60_000).toISOString(),
    escalateAt: null,
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    facts: null,
    question: { question: QUESTION, options: [{ label: 'Keep' }], blocksTaskIds: ['t1'], ifUnanswered: 'the export keeps both shapes' },
    ...(translation ? { translation } : {}),
  } as ProjectOpenItemRow;
}

function paint(r: ProjectOpenItemRow, me: Me | null = ownerMe()): string {
  const qc = clientWithMe(me);
  qc.setQueryData(projectOpenItemsQuery(PROJECT_ID).queryKey, { needsYou: [r], withCoordinator: [] });
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ProjectOpenItems projectId={PROJECT_ID} now={NOW} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('the open-items list row in the owner’s language', () => {
  it('draws the translated title and detail line while a usable translation exists, with no flip of its own', () => {
    const html = paint(row(TRANSLATION));
    expect(html).toContain('Le nouvel export garde-t-il les anciennes colonnes ?');
    expect(html).toContain('l’export garde les deux formats');
    expect(html).toContain('Coordinator asks: ');
    expect(html).not.toContain(QUESTION);
    expect(html).not.toContain('the export keeps both shapes');
    expect(html).not.toContain('Show original');
  });

  it.each<[string, OwnerCardTranslation | undefined, Me | null]>([
    ['no translation', undefined, ownerMe()],
    ['a failed translation', { lang: OWNER_LANG, failed: true }, ownerMe()],
    ['a translation in another language', { ...TRANSLATION, lang: 'de' }, ownerMe()],
    ['translation switched off', TRANSLATION, ownerMe({ translationEnabled: false })],
    ['no account read yet', TRANSLATION, null],
  ])('draws row.title and row.detailLine with %s', (_case, translation, me) => {
    const html = paint(row(translation), me);
    expect(html).toContain(QUESTION);
    expect(html).toContain('the export keeps both shapes');
    expect(html).not.toContain('Le nouvel export');
    expect(html).not.toContain('l’export garde');
  });

  it('keeps the original title when a usable translation carries only a detail line (an older server)', () => {
    const { title: _title, ...older } = TRANSLATION;
    const html = paint(row(older));
    expect(html).toContain(QUESTION);
    expect(html).toContain('l’export garde les deux formats');
  });
});
