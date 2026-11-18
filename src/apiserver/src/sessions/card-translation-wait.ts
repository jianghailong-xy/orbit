import { TRANSLATION_TIMEOUT_MS } from '@orbit/shared';

/**
 * A push or Feishu card waiting for its card's translation (project 'Translate every owner card', decision 3A): the
 * alert goes out in the owner's language when the card's translation is ready within the translation timeout, else in
 * the original. The translation jobs that run on this process (card-translation.ts `queueOwnerCardTranslation`,
 * reply-translation.ts `translateApprovalCard`) say here when a card's translation into a language has been tried —
 * stored, failed, or found nothing to do — and every alert waiting on it reads the card again.
 *
 * A card is named the way its translation job names it: `open-item:<id>`, `owner-request:<id>`, `crossing:<id>`,
 * `approval:<id>`.
 */

const waiting = new Map<string, Set<() => void>>();

const keyOf = (card: string, lang: string): string => `${card}:${lang}`;

/** The translation of `card` into `lang` has been tried: wake everything waiting on it. */
export function cardTranslationSettled(card: string, lang: string): void {
  const key = keyOf(card, lang);
  const wakers = waiting.get(key);
  if (!wakers) return;
  waiting.delete(key);
  for (const wake of wakers) wake();
}

export interface CardTranslationWait {
  /** Resolves when the translation was tried, or after `timeoutMs`, whichever is first. Never rejects. */
  settled: Promise<void>;
  /** Stop waiting (resolves `settled`). Call it once the wait is no longer needed. */
  cancel(): void;
}

/**
 * Start waiting for `card`'s translation into `lang`. Start it BEFORE reading the card, so a translation stored
 * between the read and the wait still wakes it.
 */
export function waitForCardTranslation(card: string, lang: string, timeoutMs: number = TRANSLATION_TIMEOUT_MS): CardTranslationWait {
  const key = keyOf(card, lang);
  let resolve!: () => void;
  const settled = new Promise<void>((r) => { resolve = r; });
  const done = (): void => {
    clearTimeout(timer);
    const wakers = waiting.get(key);
    wakers?.delete(done);
    if (wakers?.size === 0) waiting.delete(key);
    resolve();
  };
  const timer = setTimeout(done, Math.max(0, timeoutMs));
  const wakers = waiting.get(key) ?? new Set<() => void>();
  wakers.add(done);
  waiting.set(key, wakers);
  return { settled, cancel: done };
}
