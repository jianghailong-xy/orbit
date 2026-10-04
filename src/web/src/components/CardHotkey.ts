import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The keyboard, for the cards that ask the reader a question.
 *
 * WHY ONE MODULE
 * --------------
 * Enter confirms the primary action. Chat about this has no shortcut; the approval card's always
 * allow and the project settlement card's delegation keep their ⌘/Ctrl chord, and the two cards
 * whose primary press is hard to take back — `Merge to main` and `Approve & re-seal` — take the
 * chord for it instead of the bare key. The same predicate leaves every key to a focused field with
 * text and the bare key to a focused button, whose own Enter is the same press. An empty field has
 * no typing to protect, so the card can still answer.
 *
 * WHICH CARD HOLDS THEM
 * ---------------------
 * A window listener per card would fire every card's answer on one press, so a press with two cards
 * asking would write to two doors at once. The keys therefore belong to ONE card: of the cards
 * asking, the one drawn highest on the page (owner decision 2026-10-03 — under the old rule, keys
 * only for a card asking alone, a coordinator conversation with its ruler and its merge both up
 * had no shortcut at all). Only that card shows a hint, so the reader sees which button the key
 * presses before pressing it. Once it is answered, goes stale, or has a press of its own in flight,
 * it stops asking and the keys walk down to the next card, the way they walk the approval queue.
 * A held key does not walk with them: its repeats are not presses (`isCardAnswer`), so one long
 * press cannot answer two cards.
 *
 * "Highest" is document order, read off the element each card is drawn as (`anchor`), and not the
 * order the claims arrived in: each card claims when its own read comes back, and the read that
 * comes back first is not the card on top. A claim that names no element ranks after every one
 * that does, in the order it arrived.
 *
 * The claim is per CARD, not per key: the approval card wants both the bare key and the chord, and
 * one card holds both of its keys or neither. `useCardKeyClaim` is that claim; `useDecisionCardKeys`
 * is it plus the primary confirmation the decision cards share.
 */

/** The modifier's own name, for the hint. The chord is `metaKey || ctrlKey` on every platform, as
 *  it has been since the approval card took it; only the label is platform-specific. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
export const SHORTCUT_HINT = IS_MAC ? '⌘ + Enter' : 'Ctrl + Enter';
export const ENTER_HINT = 'Enter';

/** The cards asking for the keys right now, each with the element it is drawn as. A `Map` keeps
 *  insertion order, which is the order the claims arrived in — the tiebreak for claims that name
 *  no element, and nothing more. */
const askers = new Map<symbol, RefObject<Element | null> | undefined>();
/** The cards to tell when that set changes: each holding its own claim's answer in local state.
 *  Deliberately not an external store — a store subscription (`useSyncExternalStore`) around this
 *  one boolean put every render of a card that asks behind a scheduler task, which is enough to
 *  starve a test harness that turns React Query over by hand (`ProjectSettlementCard.test.tsx`). */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Opening a review form suspends every background card, including when the form has no hotkey. */
export function refreshCardKeys(): void {
  announce();
}

function reviewDialog(): Element | null {
  return document.querySelector('.review-card-content[data-review-open="true"]');
}

/** The claim the keys belong to: the asking card drawn highest on the page. */
function holder(): symbol | null {
  const dialog = reviewDialog();
  let top: symbol | null = null;
  let topAt: Element | null = null;
  for (const [claim, anchor] of askers) {
    const at = anchor?.current ?? null;
    if (dialog && (!at || !dialog.contains(at))) continue;
    const above =
      at !== null &&
      (topAt === null || (at.compareDocumentPosition(topAt) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    if (top === null || above) {
      top = claim;
      topAt = at;
    }
  }
  return top;
}

/** Whether a key event is a card's answer, in the spelling the caller asked for. */
function isCardAnswer(e: KeyboardEvent, requireMod: boolean): boolean {
  // A held key repeats, and by the first repeat the press has handed the keys to the next card
  // down: answering that one too is a decision nobody made.
  if (e.key !== 'Enter' || e.isComposing || e.repeat) return false;
  const hasMod = e.metaKey || e.ctrlKey;
  if (requireMod ? !hasMod : hasMod) return false;
  const el = document.activeElement;
  const isFieldWithText =
    el instanceof HTMLElement &&
    (el.isContentEditable
      ? el.textContent !== ''
      : (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
        (el as HTMLInputElement | HTMLTextAreaElement).value !== '');
  const isButton = el instanceof HTMLElement && el.tagName === 'BUTTON';
  return !(isFieldWithText || (!requireMod && isButton));
}

/**
 * This card's claim on the keys while it is asking, and whether they are its.
 *
 * `asking` is the card's own answer to "could a press succeed right now", the same fact its buttons
 * carry in `disabled` — a card that cannot be answered does not hold the keyboard against the card
 * that can. `anchor` is the element the card is drawn as, which is how the claim knows where on the
 * page it stands. The subscription is what redraws the hint: a card that stops being the top asker
 * unmounts nothing, and its key hint has to go with its keys.
 */
export function useCardKeyClaim(asking: boolean, anchor?: RefObject<Element | null>): boolean {
  const token = useRef<symbol>(Symbol('card-keys'));
  const [owns, setOwns] = useState(false);
  useEffect(() => {
    if (!asking) {
      // A card that stops asking stops holding the keyboard against the others — and says so, in
      // case it was the one holding it.
      setOwns(false);
      return;
    }
    const claim = token.current;
    const update = (): void => setOwns(holder() === claim);
    askers.set(claim, anchor);
    // Tell the cards already asking (this one claims last and is told by `update`, below), so a
    // card drawn below this one stops showing keys the moment this one asks.
    announce();
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
      askers.delete(claim);
      announce();
    };
  }, [asking, anchor]);
  return owns && asking;
}

/**
 * The approval card's two triggers, unchanged since it took Enter: the bare key approves, the chord
 * always-allows, and neither fires while a field with text has the keyboard.
 *
 * `active` is whether this card holds the keys — `useCardKeyClaim`'s answer, which the caller gets
 * once for the card, because a card claiming twice is never the only asker.
 */
export function useApproveHotkey(active: boolean, onTrigger: () => void, opts?: {
  requireMod?: boolean;
  anchor?: RefObject<Element | null>;
}): void {
  const requireMod = opts?.requireMod ?? true;
  const anchor = opts?.anchor;
  const fn = useRef(onTrigger);
  fn.current = onTrigger;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      const dialog = reviewDialog();
      if (dialog && (!anchor?.current || !dialog.contains(anchor.current))) return;
      if (!isCardAnswer(e, requireMod)) return;
      e.preventDefault();
      fn.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, requireMod, anchor]);
}

/**
 * Enter for a decision card's primary confirmation. Chat about this has no shortcut, so a card
 * with only that button still enabled holds no keys against another card's confirmation.
 */
export function useDecisionCardKeys({
  confirmEnabled,
  onConfirm,
  anchor,
}: {
  /** Whether `Confirm done` — or the primary action's own words — could succeed right now. */
  confirmEnabled: boolean;
  onConfirm: () => void;
  /** The element the card is drawn as — see `useCardKeyClaim`. */
  anchor?: RefObject<Element | null>;
}): boolean {
  const owns = useCardKeyClaim(confirmEnabled, anchor);
  useApproveHotkey(owns, onConfirm, { requireMod: false, anchor });
  return owns;
}
