import type { WikiStoredTextEncoding } from '@orbit/shared';

/**
 * What the server keeps of a text it was handed, and what it reads back (contract `repoOps.storedText`).
 *
 * POSTGRES HOLDS EVERY CHARACTER BUT ONE. A `text` column and a string inside `jsonb` take any well-formed text
 * except U+0000: `text` fails the statement with 22021, `jsonb` with 22P05 ("unsupported Unicode escape
 * sequence"). A file can have one — three source files on main carry a raw NUL in a literal — and on 2026-10-09
 * the read of one failed its result with 22P05, five times, and was never settled. So a text with a NUL in it is
 * kept as its UTF-8 bytes in base64, and the reader turns it back into the text: what a pipeline reads is, byte
 * for byte, what `git show` printed on the runner. Every other text is kept as it is — every row the read cache
 * held before, and every file in practice.
 *
 * THE OTHER THING NO DATABASE HOLDS is a lone surrogate: half of a UTF-16 pair, which JSON can spell (`\ud800`)
 * and no byte sequence decodes to. `git show` prints bytes and the runner's encoder writes every invalid byte as
 * U+FFFD, so a file's text never has one. A string that does is not a text the runner read: the caller refuses
 * it (`wikiTextIsWellFormed`) rather than keep a U+FFFD in its place, which is what writing it would do.
 */

// Escaped, never written literally (runner-api/strip-nul.ts): a raw NUL in a source file is the hazard itself.
const NUL = '\u0000';

/** Half of a surrogate pair, alone. With the `u` flag a whole pair is one code point, and is not this. */
const LONE_SURROGATE = /\p{Cs}/u;

/** A text as a row keeps it, and the encoding that says how to read it back. */
export interface WikiStoredText {
  content: string;
  encoding: WikiStoredTextEncoding;
}

/** Whether the text is Unicode text: no lone surrogate. Every text a byte sequence decodes to is. */
export function wikiTextIsWellFormed(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/** Whether Postgres holds the text as it is, in a `text` column or inside `jsonb`. */
export function wikiTextIsStorable(text: string): boolean {
  return !text.includes(NUL) && wikiTextIsWellFormed(text);
}

/** Whether a JSON value can be written into `jsonb` as it is: every string in it, and every key, storable. */
export function wikiJsonIsStorable(value: unknown): boolean {
  if (typeof value === 'string') return wikiTextIsStorable(value);
  if (Array.isArray(value)) return value.every(wikiJsonIsStorable);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(([key, item]) => wikiTextIsStorable(key) && wikiJsonIsStorable(item));
  }
  return true;
}

/**
 * The text's UTF-8 bytes in base64. A lone surrogate is the caller's to refuse first: it has no bytes, and base64
 * of what `Buffer` makes of it would be a U+FFFD in its place — so it throws rather than keep something else.
 */
export function wikiTextBase64(text: string): string {
  if (!wikiTextIsWellFormed(text)) throw new Error('a text with a lone surrogate in it has no bytes to keep');
  return Buffer.from(text, 'utf8').toString('base64');
}

/** The text as a row keeps it: as it is, or — when it has a NUL — its UTF-8 bytes in base64. */
export function wikiStoredText(text: string): WikiStoredText {
  return wikiTextIsStorable(text) ? { content: text, encoding: 'text' } : { content: wikiTextBase64(text), encoding: 'base64' };
}

/** The text a row keeps, read back: `base64` decoded to the bytes it was, anything else as it is. */
export function wikiTextFromStored(content: string, encoding: string | null | undefined): string {
  return encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content;
}
