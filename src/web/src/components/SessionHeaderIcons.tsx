// The wide session header's two glyphs (docs/mocks/session-header-share-more): a horizontal ⋯ and the
// tray-with-up-arrow share symbol the Apple clients use (square.and.arrow.up).
export function HeaderMoreIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.45" />
      <circle cx="8" cy="8" r="1.45" />
      <circle cx="13" cy="8" r="1.45" />
    </svg>
  );
}

export function HeaderShareIcon() {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5.6 6.2H4.6a1.1 1.1 0 0 0-1.1 1.1v5.6a1.1 1.1 0 0 0 1.1 1.1h6.8a1.1 1.1 0 0 0 1.1-1.1V7.3a1.1 1.1 0 0 0-1.1-1.1h-1" />
      <path d="M8 1.6v8.2" />
      <path d="M5.7 3.9 8 1.6l2.3 2.3" />
    </svg>
  );
}
