import { createHash } from 'node:crypto';
import type { ProjectTextTranslation } from '@orbit/shared';
import type { CardFields } from '../sessions/card-translation';
import type { TranslationLanguages } from '../sessions/turn-translation';

/**
 * Settings › Translation for a project's title and its criteria's text (migration 1600, ProjectTextTranslation in
 * @orbit/shared translation.ts): what the done card, the Done when list and the why-not-done card draw. Translated by
 * the owner-card flow (sessions/card-translation.ts) and kept in project_text_translation with the digest of the words
 * it was made from, so an edit of the title or of any criterion leaves it stale. A criterion's verificationMethod is
 * not translated: none of those cards draws it.
 */

/** The agent-written fields of a project's source, `{ title, criteria: [{ text }] }`. */
export const PROJECT_TEXT_FIELDS = { title: true, criteria: [{ text: true }] } as const satisfies CardFields;

/** What project_text_translation.translation holds: the served shape plus the digest of its source. */
export type StoredProjectTextTranslation = ProjectTextTranslation & { sourceDigest: string };

/** sha256 of the title and each criterion's id and text, in ordinal order: any edit of either changes it. */
export function projectTextDigest(title: string, criteria: ReadonlyArray<{ id: string; text: string }>): string {
  return createHash('sha256')
    .update(JSON.stringify([title, criteria.map((criterion) => [criterion.id, criterion.text])]))
    .digest('hex');
}

/**
 * The stored translation as `GET /projects/:id` serves it, or null when none is usable: translation off (`langs`
 * null), no row, another language, or made from words the project no longer has. A failed one is `{ lang, failed }`.
 */
export function usableProjectTextTranslation(
  stored: unknown,
  langs: TranslationLanguages | null,
  digest: string,
): ProjectTextTranslation | null {
  if (!langs) return null;
  const row = stored as Partial<StoredProjectTextTranslation> | null | undefined;
  if (!row || row.lang !== langs.owner || row.sourceDigest !== digest) return null;
  if (row.failed) return { lang: row.lang, failed: true };
  const { sourceDigest: _digest, ...served } = row as StoredProjectTextTranslation;
  return served;
}
