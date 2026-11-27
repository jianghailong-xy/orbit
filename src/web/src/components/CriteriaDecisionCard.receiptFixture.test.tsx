// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CriteriaDecisionReceipt, type SettledCriteriaDecision } from './CriteriaDecisionCard';

/**
 * The shared cases (src/shared/src/criteria-decision-receipt.fixture.json) OrbitKit is proved
 * against too (`CriteriaDecisionReceiptFixtureTests`): a settled decision, and what the receipt's
 * fold "What this approved · …" says about it — its closed line, its rows, the fold over the
 * untouched ones and the note under them (decision D1 A).
 */
type Row = { ordinal: number | null; text: string; badge: string };
type Fixture = {
  cases: {
    name: string;
    settled: SettledCriteriaDecision;
    expected: {
      warningTone: boolean;
      summary: string;
      legend: string | null;
      rows: Row[];
      unchanged: { line: string; rows: { ordinal: number; text: string }[] } | null;
      note: string | null;
    };
  }[];
};
const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../shared/src/criteria-decision-receipt.fixture.json'), 'utf8'),
) as Fixture;

const text = (node: Element | null | undefined): string => node?.textContent ?? '';

describe('the criteria-decision receipt, from the shared fixture', () => {
  for (const { name, settled, expected } of fixture.cases) {
    it(name, () => {
      const doc = new DOMParser().parseFromString(
        renderToStaticMarkup(<CriteriaDecisionReceipt settled={settled} />), 'text/html');
      const card = doc.body.firstElementChild!;
      // The warning tone is `.criteria-decision`'s (index.css: --warning-border / --warning-bg).
      expect(card.classList.contains('criteria-decision')).toBe(expected.warningTone);

      const fold = card.querySelector(':scope details.criteria-decision-unchanged')!;
      expect(text(fold.querySelector(':scope > summary'))).toBe(expected.summary);
      expect(fold.querySelector(':scope > .criteria-decision-legend')?.textContent ?? null)
        .toBe(expected.legend);

      const rows = [...fold.querySelectorAll('li.criteria-decision-entry')].map((li) => ({
        ordinal: li.hasAttribute('value') ? Number(li.getAttribute('value')) : null,
        text: text(li.querySelector('.criteria-decision-text')),
        badge: text(li.querySelector('.criteria-decision-new')),
      }));
      expect(rows).toEqual(expected.rows);

      const inner = fold.querySelector(':scope details.criteria-decision-unchanged');
      expect(inner ? {
        line: text(inner.querySelector(':scope > summary')),
        rows: [...inner.querySelectorAll('li')].map((li) => ({
          ordinal: Number(li.getAttribute('value')),
          text: text(li.querySelector('.criteria-decision-text')),
        })),
      } : null).toEqual(expected.unchanged);

      expect(fold.querySelector(':scope > .criteria-decision-hold')?.textContent ?? null)
        .toBe(expected.note);
    });
  }
});
