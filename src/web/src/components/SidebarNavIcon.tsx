// Web counterparts of the iOS navigation symbols in OrbitKit's AppSection and SettingsHome.
const glyphs = {
  // square.grid.2x2
  projects: (
    <>
      <rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="14" y="2.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="2.5" y="14" width="7.5" height="7.5" rx="1.8" />
      <rect x="14" y="14" width="7.5" height="7.5" rx="1.8" />
    </>
  ),
  // checklist — the check is a cutout, so it also works on dark and selected backgrounds.
  tasks: (
    <>
      <path
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
        d="M8.5 6.8a3.7 3.7 0 1 1-7.4 0 3.7 3.7 0 0 1 7.4 0ZM2.5 6.9l1.8 1.8 2.9-3.2-.9-.8-2 2.2-.9-.9Z"
      />
      <circle cx="4.8" cy="17.2" r="3.1" />
      <path d="M11.5 6.8h10M11.5 17.2h10" />
    </>
  ),
  // book.closed
  wiki: (
    <>
      <path d="M6 2.5h12a1.5 1.5 0 0 1 1.5 1.5v13.5H6a2 2 0 0 0 0 4h13.5M6 2.5a2 2 0 0 0-2 2v15M7.5 2.5v15" />
      <path d="M18.5 17.5v4" />
    </>
  ),
  // desktopcomputer
  runners: (
    <>
      <rect x="1.5" y="3.5" width="21" height="14" rx="1.8" />
      <path d="M1.5 14.5h21M12 17.5v4M7.5 21.5h9" />
    </>
  ),
  // powerplug
  providers: (
    <>
      <path d="M8 2.5v5M16 2.5v5M5.5 7.5h13v3a6.5 6.5 0 0 1-13 0ZM12 17v4.5" />
    </>
  ),
};

export function SidebarNavIcon({ name }: { name: keyof typeof glyphs }) {
  return (
    <svg
      className={`sidebar-nav-icon sidebar-nav-icon-${name}`}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[name]}
    </svg>
  );
}
