/** How long a list's scrollbar stays up after its last scroll — about what macOS gives its own. */
export const SCROLLBAR_SHOWN_MS = 1_000;

/**
 * Keeps the scrollbar of a list marked `.autohide-scrollbar` out of sight until the list scrolls,
 * the way macOS's overlay scrollbars behave. The app's own ::-webkit-scrollbar styling (index.css)
 * draws every thumb for good otherwise.
 *
 * A scroll marks the list `data-scrolling`, which is all the stylesheet looks at, and the mark
 * clears once the list has been still for SCROLLBAR_SHOWN_MS. Scroll events don't bubble but they
 * do capture, so this one listener on the document serves every such list — a list opts in with
 * the class alone.
 */
export function installScrollbarAutohide(): void {
  const timers = new WeakMap<Element, number>();
  document.addEventListener(
    'scroll',
    (event) => {
      const list = event.target;
      if (!(list instanceof Element) || !list.classList.contains('autohide-scrollbar')) return;
      // Forced on, so a list already scrolling is left alone rather than restyled per event.
      list.toggleAttribute('data-scrolling', true);
      window.clearTimeout(timers.get(list));
      timers.set(
        list,
        window.setTimeout(() => list.removeAttribute('data-scrolling'), SCROLLBAR_SHOWN_MS),
      );
    },
    { capture: true, passive: true },
  );
}
