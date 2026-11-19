import type { JSX } from 'react';
import type { CriteriaChangesSinceConfirmed } from '@orbit/shared';
import {
  CRITERIA_CHANGE_NEW,
  CRITERIA_CHANGE_REVISED,
  CRITERIA_CHANGE_STRICTER,
  CRITERIA_CHANGE_WHAT_CHANGED,
  criteriaChangeKind,
  criteriaChangeWas,
} from '../lib/projectStart';

/** One row of "What changed": its mark, which criterion and what happened, and the words. */
export interface CriteriaChangeRow {
  key: string;
  mark: string;
  tone: 'is-new' | 'is-stricter' | 'is-revised';
  kind: string;
  text: string;
  was: string | null;
}

/** The rows a set of changes draws, new first, then stricter, then changed, each by ordinal. Removed
 *  criteria have no words left to show and are counted elsewhere. */
export function criteriaChangeRows(changes: CriteriaChangesSinceConfirmed): CriteriaChangeRow[] {
  const byOrdinal = <T extends { ordinal: number }>(list: T[]): T[] =>
    [...list].sort((a, b) => a.ordinal - b.ordinal);
  return [
    ...byOrdinal(changes.added).map((change): CriteriaChangeRow => ({
      key: `new:${change.key}`,
      mark: '+',
      tone: 'is-new',
      kind: criteriaChangeKind(change.ordinal, CRITERIA_CHANGE_NEW),
      text: change.text,
      was: null,
    })),
    ...byOrdinal(changes.stricter).map((change): CriteriaChangeRow => ({
      key: `stricter:${change.key}`,
      mark: '↑',
      tone: 'is-stricter',
      kind: criteriaChangeKind(change.ordinal, CRITERIA_CHANGE_STRICTER),
      text: change.verificationMethod,
      was: criteriaChangeWas(change.confirmedVerificationMethod),
    })),
    ...byOrdinal(changes.revised).map((change): CriteriaChangeRow => ({
      key: `revised:${change.key}`,
      mark: '~',
      tone: 'is-revised',
      kind: criteriaChangeKind(change.ordinal, CRITERIA_CHANGE_REVISED),
      text: change.text,
      was: null,
    })),
  ];
}

/**
 * "What changed", as the "Confirm the new criteria?" card asks it and as the receipt of that
 * confirmation records it — one component, so the question and its record read the same.
 */
export function CriteriaChangeList({ rows }: { rows: CriteriaChangeRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <ul className="criteria-change-list" aria-label={CRITERIA_CHANGE_WHAT_CHANGED}>
      {rows.map((row) => (
        <li key={row.key} className={row.tone}>
          <span className="criteria-change-mark" aria-hidden="true">{row.mark}</span>
          <span className="criteria-change-kind">{row.kind}</span>
          <span className="criteria-change-text">
            {row.text}
            {row.was ? <span className="criteria-change-was">{row.was}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
