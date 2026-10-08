import type { MouseEvent } from 'react';

/**
 * The Providers page's fold heads — a runner's card, an account pool's card, an engine row heading
 * several accounts — fold from a press anywhere on them, not only on their toggle
 * (docs/mocks/providers-group-row-click). The toggle stays the head's one button, for the keyboard
 * and a screen reader; a press anywhere else on the head is that press.
 *
 * Except a press on a control of the head's own (`controls`: Manage →, Add account, and the toggle,
 * which presses itself), on anything the head puts out over the page (React bubbles a portal's
 * press to it all the same), and one that ended a drag across the words: folding would throw that
 * selection away, as opening would a task row's (ProjectsPage).
 */
export const foldFromAnywhere =
  (toggle: () => void, controls = 'button, a, input') =>
  (event: MouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (!event.currentTarget.contains(target) || target.closest(controls)) return;
    if (window.getSelection()?.toString()) return;
    toggle();
  };
