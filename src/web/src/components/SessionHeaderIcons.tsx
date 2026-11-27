// The wide session header's two glyphs (docs/mocks/session-header-share-more): a horizontal ⋯ and the
// share symbol: an open tray with an up arrow (docs/mocks/session-header-share-tray).
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
      <path d="M2 8.5v2.7a2.6 2.6 0 0 0 2.6 2.6h6.8a2.6 2.6 0 0 0 2.6-2.6V8.5" />
      <path d="M8 1.8v8" />
      <path d="M4.45 5.35 8 1.8l3.55 3.55" />
    </svg>
  );
}
