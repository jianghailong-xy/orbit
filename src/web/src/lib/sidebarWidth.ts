import type { CSSProperties } from 'react';

// The left sidebar is user-resizable; the chosen width persists across refreshes. Settings and Admin
// draw their nav at the same width, so their page panel starts where the app's does.
export const SIDEBAR_WIDTH_KEY = 'orbit:sidebar-width';
export const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

export const clampSidebarWidth = (w: number): number =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w));

export function savedSidebarWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return saved > 0 ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
}

/** Style for a Settings-like nav: its width as the variable Settings.css reads. */
export const sidebarWidthStyle = () => ({ '--sidebar-width': `${savedSidebarWidth()}px` }) as CSSProperties;
