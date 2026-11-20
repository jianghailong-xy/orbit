import { useState, type MouseEvent as ReactMouseEvent } from 'react';

/** The directory column's width: dragged like the app sidebar's, in the app sidebar's range. */
export const WIKI_DIRECTORY_WIDTH = { initial: 248, min: 200, max: 480, mainMin: 560 } as const;

const WIDTH_KEY = 'orbit:wiki-directory-width';

/**
 * Where a drag can take the column: the sidebar's range, and never so wide that the page beside it drops under
 * `mainMin` (the docked chat already takes its share of the window). Measured when the drag starts. A page already
 * narrower than that holds the column where it is: a drag outwards never narrows it.
 */
export function wikiDirectoryMax(start: number, mainWidth: number): number {
  const { min, max, mainMin } = WIKI_DIRECTORY_WIDTH;
  return Math.max(min, Math.min(max, Math.max(start, Math.floor(start + mainWidth - mainMin))));
}

export const clampWikiDirectoryWidth = (width: number, max: number = WIKI_DIRECTORY_WIDTH.max): number =>
  Math.min(max, Math.max(WIKI_DIRECTORY_WIDTH.min, Math.round(width)));

export function readWikiDirectoryWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (stored > 0 && Number.isFinite(stored)) return clampWikiDirectoryWidth(stored);
  } catch {
    // Storage unavailable: the default width.
  }
  return WIKI_DIRECTORY_WIDTH.initial;
}

/** The column's width and the mouse-down for its border's handle; the width is kept in this browser on release. */
export function useWikiDirectoryWidth(): [number, (event: ReactMouseEvent<HTMLElement>) => void] {
  const [width, setWidth] = useState(readWikiDirectoryWidth);
  const startResize = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const main = event.currentTarget.closest('.wk-page')?.querySelector('.wk-main');
    const max = wikiDirectoryMax(width, main?.getBoundingClientRect().width ?? Infinity);
    let next = width;
    const onMove = (ev: MouseEvent) => {
      next = clampWikiDirectoryWidth(width + ev.clientX - startX, max);
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {
        // Storage unavailable: the width lasts this page.
      }
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return [width, startResize];
}
