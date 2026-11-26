import { act } from 'react';

/**
 * Rests a mouse pointer on `element` for `ms`, as a reader does before an app Tooltip opens, and returns the open tip's
 * text (null when none opened). The app Tooltip opens on hover after its delay (CONTROL_TOOLTIP_DELAY_MS, or
 * TEXT_TOOLTIP_DELAY_MS on plain text), so wait past the one the element uses.
 */
export async function hoverTooltip(element: Element, ms = 700): Promise<string | null> {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, pointerType: 'mouse' } as const;
    element.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false }));
    element.dispatchEvent(new PointerEvent('pointerover', init));
    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    element.dispatchEvent(new PointerEvent('pointermove', init));
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  return document.querySelector('[role="tooltip"]')?.textContent ?? null;
}
