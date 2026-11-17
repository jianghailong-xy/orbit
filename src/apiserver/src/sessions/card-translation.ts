import type { OwnerCardTranslation } from '@orbit/shared';
import { mapBounded, queueTranslation } from './reply-translation';
import { translate } from './translation';
import type { TranslationLanguages } from './turn-translation';

/**
 * Settings › Translation for the owner cards that live outside a session (project 'Translate every owner card',
 * board docs/mocks/session-translation/04-owner-cards.html; wire shape OwnerCardTranslation in @orbit/shared
 * translation.ts): a coordinator's question (project_open_item) and an owner request (owner_request), and the
 * other cards later tasks add.
 *
 * The approval card's rules (reply-translation.ts translateCard), over a card's NAMED fields: each named field
 * with text is translated from the agent's language into the owner's; a card translates whole or is recorded
 * `{ lang, failed: true }`, never half; fenced code, inline code and URLs inside a field stay verbatim
 * (`protectVerbatim`), and a field that is not named — a step's `command` or `link` — is never sent at all.
 *
 * When (decision 1A): in the background once the card is filed, and once more when a card still open is read
 * without a translation in the owner's current language (translation turned on later, or the language changed).
 * At most one translation of a card into a language is queued or running at a time on this process.
 */

/** Which of a card's fields are the agent's words: `true` names a string field, `[fields]` an array whose
 *  entries are objects with those fields, `[true]` an array of strings. */
export type CardFields = { readonly [field: string]: true | readonly [CardFields | true] };

/** A coordinator question's (`CoordinatorQuestion`, project_open_item.payload) agent-written fields. */
export const COORDINATOR_QUESTION_FIELDS = {
  question: true,
  options: [{ label: true, description: true }],
  ifUnanswered: true,
} as const satisfies CardFields;

/** An owner request's (request_owner_action, owner_request) agent-written fields. A step's `command` and `link`
 *  are left out on purpose: the owner copies and opens them exactly as written. */
export const OWNER_REQUEST_FIELDS = {
  title: true,
  why: true,
  ifUnanswered: true,
  options: [{ label: true, description: true }],
  steps: [{ text: true }],
  verifyHint: true,
} as const satisfies CardFields;

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

type Piece = { text: string; put: (translated: string) => void };

/** The pieces of `source` that `fields` names and that have text, each with where its translation goes in `out`. */
function collect(source: unknown, fields: CardFields, out: Record<string, unknown>, pieces: Piece[]): void {
  const from = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
  for (const [key, shape] of Object.entries(fields)) {
    const value = from[key];
    if (shape === true) {
      if (hasText(value)) pieces.push({ text: value, put: (text) => { out[key] = text; } });
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) continue;
    const [entry] = shape;
    const list: unknown[] = value.map((v) => (entry === true ? (typeof v === 'string' ? v : '') : {}));
    out[key] = list;
    value.forEach((v, at) => {
      if (entry !== true) collect(v, entry, list[at] as Record<string, unknown>, pieces);
      else if (hasText(v)) pieces.push({ text: v, put: (text) => { list[at] = text; } });
    });
  }
}

/** Whether `source` has any text in the fields `fields` names: a card with none has nothing to translate. */
export function cardFieldsHaveText(source: unknown, fields: CardFields): boolean {
  const pieces: Piece[] = [];
  collect(source, fields, {}, pieces);
  return pieces.length > 0;
}

/** The fields `fields` names of `source`, from the agent's language into the owner's. Throws TranslationFailed
 *  when any piece fails: a card is shown whole in one language or the other. */
export async function translateCardFields(
  source: unknown,
  fields: CardFields,
  langs: TranslationLanguages,
): Promise<OwnerCardTranslation> {
  const out: Record<string, unknown> = {};
  const pieces: Piece[] = [];
  collect(source, fields, out, pieces);
  const texts = await mapBounded(pieces, (piece) => translate(piece.text, langs.agent, langs.owner));
  pieces.forEach((piece, at) => piece.put(texts[at]));
  return { ...out, lang: langs.owner } as OwnerCardTranslation;
}

/** Whether a stored `translation` is one in the owner's current language — a failed one counts: it was tried. */
export function translatedInto(stored: unknown, langs: TranslationLanguages): boolean {
  return (stored as { lang?: unknown } | null | undefined)?.lang === langs.owner;
}

/** One card, as the table that holds it reads and writes it. */
export interface OwnerCardStore {
  /** The card's kind and id, e.g. `open-item:<id>`: what keeps a second translation of it from being queued. */
  key: string;
  /** The card while it is still open: its source and the fields to translate. Null once it has ended. */
  read(): Promise<{ source: unknown; fields: CardFields; translation: unknown } | null>;
  /** Store `translation` on the card if it is still open; true when it was written. */
  write(translation: OwnerCardTranslation): Promise<boolean>;
  /** After a write: tell the owner's clients to read the card again. */
  published(): void;
}

/**
 * Translate one card and store it, or record `{ lang, failed: true }`. A card that has ended, has no text, or is
 * already translated into the owner's language is left alone.
 */
export async function translateOwnerCardNow(
  store: OwnerCardStore,
  langs: TranslationLanguages,
): Promise<OwnerCardTranslation | null> {
  const card = await store.read();
  if (!card || !cardFieldsHaveText(card.source, card.fields)) return null;
  if (translatedInto(card.translation, langs)) return card.translation as OwnerCardTranslation;
  let translation: OwnerCardTranslation;
  try {
    translation = await translateCardFields(card.source, card.fields, langs);
  } catch {
    translation = { lang: langs.owner, failed: true };
  }
  if (!(await store.write(translation))) return null;
  store.published();
  return translation;
}

const queued = new Set<string>();

/**
 * Queue `store`'s card for translation into the owner's language (`langs`), on the replies' and cards' bounded
 * queue, unless that card's translation into that language is already queued or running. Returns at once:
 * true when it queued one. Nothing it does can fail the caller; a lost job (a restart) leaves the original.
 */
export function queueOwnerCardTranslation(store: OwnerCardStore, langs: TranslationLanguages): boolean {
  const key = `${store.key}:${langs.owner}`;
  if (queued.has(key)) return false;
  queued.add(key);
  queueTranslation(async () => {
    try {
      await translateOwnerCardNow(store, langs);
    } finally {
      queued.delete(key);
    }
  });
  return true;
}
