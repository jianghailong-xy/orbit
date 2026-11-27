import type { EvidenceTranslation, OwnerCardTranslation } from '@orbit/shared';
import { cardTranslationSettled } from './card-translation-wait';
import { mapBounded, queueTranslation } from './reply-translation';
import { translate } from './translation';
import type { TranslationLanguages } from './turn-translation';

/**
 * Settings › Translation for the owner cards that live outside a session (project 'Translate every owner card',
 * board docs/mocks/session-translation/04-owner-cards.html; wire shape OwnerCardTranslation in @orbit/shared
 * translation.ts): a coordinator's question, start request and done request (project_open_item), an owner request
 * (owner_request), completion evidence (task_completion_evidence), an owner-confirmation review
 * (task_owner_confirmation_review_record), a crossing (project_handoff_approval) and a criteria-change proposal
 * (project_criteria_change_translation, beside the frozen project_ratified_action_intent).
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

/** A PROJECT_REOPEN request's agent-written fields: an owner request's, and the work it plans (`payload.plannedWork`). */
export const PROJECT_REOPEN_FIELDS = { ...OWNER_REQUEST_FIELDS, plannedWork: true } as const satisfies CardFields;

/** A START_REQUEST's (`ProjectStartRequest`, project_open_item.payload) agent-written field. */
export const START_REQUEST_FIELDS = { why: true } as const satisfies CardFields;

/** A DONE_REQUEST's (`DoneRequest`, project_open_item.payload) agent-written fields. A gap's `criterionKey` and
 *  `evidenceRefs` are left out: they are keys and references, read exactly as written. */
export const DONE_REQUEST_FIELDS = {
  judgment: true,
  gaps: [{ title: true, whyNotProven: true, coordinatorChecked: true }],
} as const satisfies CardFields;

/** A completion-evidence envelope's (task_completion_evidence.evidence) agent-written fields. A check's `ref` and
 *  `command` are never sent. */
export const EVIDENCE_FIELDS = { claim: true, gaps: [true] } as const satisfies CardFields;

/** An owner-confirmation REVIEW record's agent-written fields the owner decides on: the reviewer's call and the
 *  lines only the owner can answer (task_owner_confirmation_review_record.judgment, body.needsYou). */
export const CONFIRMATION_REVIEW_FIELDS = {
  judgment: true,
  needsYou: [{ text: true, options: [{ label: true, description: true }] }],
} as const satisfies CardFields;

/** An owner-confirmation PROBLEMS record's agent-written fields (reason, body.problems). */
export const CONFIRMATION_PROBLEMS_FIELDS = { reason: true, problems: [{ text: true }] } as const satisfies CardFields;

/** A crossing's (project_handoff_approval) agent-written fields. */
export const CROSSING_FIELDS = { title: true, reason: true } as const satisfies CardFields;

/** A criteria-change proposal's agent-written fields: each proposed criterion's words. */
export const CRITERIA_CHANGE_FIELDS = {
  proposed: [{ text: true, verificationMethod: true }],
} as const satisfies CardFields;

/** What a card's `translation` holds: most cards' shape, or completion evidence's. */
export type CardTranslation = OwnerCardTranslation | EvidenceTranslation;

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
): Promise<CardTranslation> {
  const out: Record<string, unknown> = {};
  const pieces: Piece[] = [];
  collect(source, fields, out, pieces);
  const texts = await mapBounded(pieces, (piece) => translate(piece.text, langs.agent, langs.owner));
  pieces.forEach((piece, at) => piece.put(texts[at]));
  return { ...out, lang: langs.owner } as CardTranslation;
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
  write(translation: CardTranslation): Promise<boolean>;
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
): Promise<CardTranslation | null> {
  const card = await store.read();
  if (!card || !cardFieldsHaveText(card.source, card.fields)) return null;
  if (translatedInto(card.translation, langs)) return card.translation as CardTranslation;
  let translation: CardTranslation;
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
      // A push or Feishu card waiting for this translation (decision 3A) reads the card again now.
      cardTranslationSettled(store.key, langs.owner);
    }
  });
  return true;
}
