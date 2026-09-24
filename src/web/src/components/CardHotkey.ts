import { useEffect, useRef, useState } from 'react';

/**
 * The keyboard, for the cards that ask the reader a question.
 *
 * WHY ONE MODULE
 * --------------
 * Five cards now take Enter: the approval card, which took it first (`ApprovalPanel`), and the four
 * that ask a two-way question and hand the reply to the composer — the evidence decision, the owner
 * confirmation, the acceptance confirmation and the project settlement. One gesture over one screen
 * deserves one predicate, so what counts as "the reader pressed the card's answer" is decided here
 * and nowhere else: the bare key for the primary answer, the ⌘/Ctrl chord for the second, neither
 * while a field has the keyboard, and the bare key yields to a focused button, whose own Enter is
 * the same press.
 *
 * WHY A CARD CAN STAND DOWN
 * -------------------------
 * A window listener per card would fire every card's answer on one press, so a press with two cards
 * asking would write to two doors at once. The keys therefore belong to the card that is the ONLY
 * one asking: with a second card asking, Enter would have to choose between two questions, and a
 * key that answers somebody else's question is worse than a key that answers none. Both cards then
 * show no hint and stay quiet, and the reader presses the button they are looking at. Three cards
 * on one screen is a screen with no shortcut, which is the correct amount of shortcut for it.
 *
 * The claim is per CARD, not per key: the approval card wants both the bare key and the chord, and
 * a card that claimed twice would never be the only asker. `useCardKeyClaim` is that claim;
 * `useDecisionCardKeys` is it plus the two answers the four cards share.
 */

/** The modifier's own name, for the hint. The chord is `metaKey || ctrlKey` on every platform, as
 *  it has been since the approval card took it; only the label is platform-specific. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
export const SHORTCUT_HINT = IS_MAC ? '⌘ + Enter' : 'Ctrl + Enter';
export const ENTER_HINT = 'Enter';

/** The cards asking for the keys right now. A `Set` keeps insertion order, which is mount order,
 *  which is the order the cards are stacked in down the conversation. */
const askers = new Set<symbol>();
/** The cards to tell when that set changes: each holding its own claim's answer in local state.
 *  Deliberately not an external store — a store subscription (`useSyncExternalStore`) around this
 *  one boolean put every render of a card that asks behind a scheduler task, which is enough to
 *  starve a test harness that turns React Query over by hand (`ProjectSettlementCard.test.tsx`). */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Whether a key event is a card's answer, in the spelling the caller asked for. */
function isCardAnswer(e: KeyboardEvent, requireMod: boolean): boolean {
  if (e.key !== 'Enter' || e.isComposing) return false;
  const hasMod = e.metaKey || e.ctrlKey;
  if (requireMod ? !hasMod : hasMod) return false;
  const el = document.activeElement;
  const isField =
    el instanceof HTMLElement &&
    (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  const isButton = el instanceof HTMLElement && el.tagName === 'BUTTON';
  return !(isField || (!requireMod && isButton));
}

/**
 * This card's claim on the keys while it is asking, and whether they are its.
 *
 * `asking` is the card's own answer to "could a press succeed right now", the same fact its buttons
 * carry in `disabled` — a card that cannot be answered does not hold the keyboard against the card
 * that can. The subscription is what redraws the hint: a card that stops being the only asker
 * unmounts nothing, and its key hint has to go with its keys.
 */
export function useCardKeyClaim(asking: boolean): boolean {
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
    const update = (): void => setOwns(askers.size === 1 && askers.has(claim));
    askers.add(claim);
    // Tell the cards already asking (this one claims last and is told by `update`, below), so the
    // card that was alone stops showing keys the moment it is not.
    announce();
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
      askers.delete(claim);
      announce();
    };
  }, [asking]);
  return owns && asking;
}

/**
 * The approval card's two triggers, unchanged since it took Enter: the bare key approves, the chord
 * always-allows, and neither fires while a field has the keyboard.
 *
 * `active` is whether this card holds the keys — `useCardKeyClaim`'s answer, which the caller gets
 * once for the card, because a card claiming twice is never the only asker.
 */
export function useApproveHotkey(active: boolean, onTrigger: () => void, opts?: { requireMod?: boolean }): void {
  const requireMod = opts?.requireMod ?? true;
  const fn = useRef(onTrigger);
  fn.current = onTrigger;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!isCardAnswer(e, requireMod)) return;
      e.preventDefault();
      fn.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, requireMod]);
}

/**
 * The four cards that ask a two-way question: Enter for the first answer, the ⌘/Ctrl chord for the
 * second — the one that hands the reply to the composer.
 *
 * Each enabled flag is that answer's own `disabled`, because the two answers of these cards are not
 * dead together: a settlement card whose project was settled elsewhere keeps `Chat about this` live
 * while its confirm is dark, and the key must follow the button rather than the card.
 */
export function useDecisionCardKeys({
  confirmEnabled,
  chatEnabled,
  onConfirm,
  onChatAbout,
}: {
  /** Whether `Confirm done` — or the primary action's own words — could succeed right now. */
  confirmEnabled: boolean;
  /** Whether the second answer, the one that arms the composer, could. */
  chatEnabled: boolean;
  onConfirm: () => void;
  onChatAbout: () => void;
}): boolean {
  const confirm = useRef(onConfirm);
  confirm.current = onConfirm;
  const chat = useRef(onChatAbout);
  chat.current = onChatAbout;
  const owns = useCardKeyClaim(confirmEnabled || chatEnabled);
  useEffect(() => {
    if (!owns) return;
    const onKey = (e: KeyboardEvent): void => {
      // The chord is asked first: `isCardAnswer` never reads the same event as both, and a chord
      // whose answer is dead does nothing rather than falling through to the bare key's.
      if (isCardAnswer(e, true)) {
        if (!chatEnabled) return;
        e.preventDefault();
        chat.current();
        return;
      }
      if (!isCardAnswer(e, false)) return;
      if (!confirmEnabled) return;
      e.preventDefault();
      confirm.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [owns, confirmEnabled, chatEnabled]);
  return owns;
}
