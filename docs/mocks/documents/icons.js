// Replaces <i data-ic="name" class="..."></i> with an inline SVG icon. Shared by every board page.
const P = {
  folder: '<path d="M2 6.5A2.5 2.5 0 0 1 4.5 4h4l2 2.2h9A2.5 2.5 0 0 1 22 8.7v9.8A2.5 2.5 0 0 1 19.5 21h-15A2.5 2.5 0 0 1 2 18.5z" fill="#5b8def"/><path d="M2 9h20v9.5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5z" fill="#7aa5f5"/>',
  file: '<path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="#fff" stroke="#9a9aa2" stroke-width="1.3"/><path d="M14 2.5v5h5" fill="none" stroke="#9a9aa2" stroke-width="1.3"/>',
  md: '<path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="#fff" stroke="#9a9aa2" stroke-width="1.3"/><path d="M14 2.5v5h5" fill="none" stroke="#9a9aa2" stroke-width="1.3"/><text x="12" y="18" font-size="6.5" font-weight="700" text-anchor="middle" fill="#3E69F6" font-family="Inter">MD</text>',
  img: '<rect x="3" y="4" width="18" height="16" rx="2.5" fill="#fff" stroke="#9a9aa2" stroke-width="1.3"/><circle cx="8.5" cy="9" r="1.8" fill="#e5a43a"/><path d="M4 18l5-5 3.5 3.5L15 14l5 4.5" fill="none" stroke="#23a15a" stroke-width="1.6"/>',
  zip: '<path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="#fff" stroke="#9a9aa2" stroke-width="1.3"/><path d="M11 4v2h2v2h-2v2h2v2h-2" stroke="#9a9aa2" stroke-width="1.3" fill="none"/><rect x="10" y="13" width="4" height="4" rx="1" fill="#9a9aa2"/>',
  csv: '<path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" fill="#fff" stroke="#9a9aa2" stroke-width="1.3"/><path d="M14 2.5v5h5" fill="none" stroke="#9a9aa2" stroke-width="1.3"/><path d="M8 12h8M8 15h8M8 18h8M11 11v8" stroke="#23a15a" stroke-width="1.1"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5" fill="#fff" stroke="#9a9aa2" stroke-width="1.3"/><path d="M10 9v6l5-3z" fill="#e0453a"/>',
  // line icons (stroke currentColor)
  menu: '<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  projects: '<rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  tasks: '<path d="M4 7l1.5 1.5L8 6M4 13l1.5 1.5L8 12M11 7.5h9M11 13.5h9M11 19h9M4 19h4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 10h16M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6"/>',
  hand: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-1V5a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.5L4.5 14a1.5 1.5 0 0 1 2.6-1.5L8 14" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  book: '<path d="M5 4.5h10a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z M5 18a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  drive: '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  ws: '<rect x="4" y="5" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9 20h6" stroke="currentColor" stroke-width="1.6"/>',
  gear: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="1.6"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  up: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  more: '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<path d="M12 3.5L2.5 20h19z" fill="#f2a93b"/><path d="M12 10v4.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.2" fill="#fff"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  pause: '<path d="M9 6v12M15 6v12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  search: '<circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  clip: '<path d="M16.5 8.5l-7 7a2.1 2.1 0 0 1-3-3l7.5-7.5a3.5 3.5 0 0 1 5 5L11 18a5 5 0 0 1-7-7l6.5-6.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.8 4.8 0 0 1-.5 9.5z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  move: '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9 14h6M13 11.5l2.5 2.5-2.5 2.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
  newfolder: '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 11v6M9 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  chart: '<path d="M5 20V10M12 20V4M19 20v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  logo: '<circle cx="12" cy="12" r="9" fill="#3E69F6"/><ellipse cx="12" cy="12" rx="10.5" ry="4" fill="none" stroke="#fff" stroke-width="1.4" transform="rotate(-25 12 12)"/><circle cx="12" cy="12" r="3" fill="#fff"/>',
};
for (const el of document.querySelectorAll('i[data-ic]')) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ' + (el.className || ''));
  if (el.style.cssText) s.style.cssText = el.style.cssText;
  s.innerHTML = P[el.dataset.ic] || '';
  el.replaceWith(s);
}
