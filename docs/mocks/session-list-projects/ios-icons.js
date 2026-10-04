// Tiny stand-ins for the SF Symbols the screens use. <i data-ic="name" data-s="20" data-c="#fff"></i>
const P = {
  ham: '<path d="M4 7h16M4 12h16M4 17h16" stroke-width="2" stroke-linecap="round"/>',
  chevd: '<path d="M7 10l5 5 5-5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevr: '<path d="M9 5l7 7-7 7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevl: '<path d="M15 4l-8 8 8 8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  filter: '<path d="M4 7h16M7 12h10M10 17h4" stroke-width="2" stroke-linecap="round"/>',
  compose: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" stroke-width="1.9" fill="none" stroke-linecap="round"/><path d="M18.5 3.5l2 2L12 14l-3 1 1-3z" stroke-width="1.9" fill="none" stroke-linejoin="round"/>',
  search: '<circle cx="10.5" cy="10.5" r="6" stroke-width="2.1" fill="none"/><path d="M15 15l5 5" stroke-width="2.3" stroke-linecap="round"/>',
  sharef: '<path d="M12 3.5v10" stroke-width="2.3" stroke-linecap="round"/><path d="M8.2 7.2L12 3.4l3.8 3.8" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M8.8 10.2H7.4a2.1 2.1 0 0 0-2.1 2.1v6.3a2.1 2.1 0 0 0 2.1 2.1h9.2a2.1 2.1 0 0 0 2.1-2.1v-6.3a2.1 2.1 0 0 0-2.1-2.1h-1.4" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  folderf: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6c.6 0 1.1.2 1.5.6L12 7h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" stroke-width="0" fill="currentColor"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.4c.5 0 1 .2 1.3.5L11.8 7.6h6.7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M3.5 10h17" stroke-width="1.6"/>',
  trashf: '<path d="M9 4h6M4.5 6.5h15" stroke-width="2.2" stroke-linecap="round"/><path d="M6.5 8.5h11l-.8 10.2a2 2 0 0 1-2 1.8H9.3a2 2 0 0 1-2-1.8z" stroke-width="0" fill="currentColor"/>',
  trash: '<path d="M9 4h6M4.5 6.5h15" stroke-width="1.8" stroke-linecap="round"/><path d="M6.5 8.5h11l-.8 10.2a2 2 0 0 1-2 1.8H9.3a2 2 0 0 1-2-1.8z" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  tray: '<path d="M4 13l2.2-6.6A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.4L20 13v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M4 13h4.5l1 2h5l1-2H20" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
  folderplus: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.4c.5 0 1 .2 1.3.5L11.8 7.6h6.7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M12 10.5v6M9 13.5h6" stroke-width="1.9" stroke-linecap="round"/>',
  pin: '<path d="M9 3h6l-1 6 3 3H7l3-3z" stroke-width="0" fill="currentColor"/><path d="M12 12v8" stroke-width="1.8" stroke-linecap="round"/>',
  spin: '<path d="M12 4a8 8 0 1 0 8 8" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
  pencil: '<path d="M16.5 4.5l3 3L9 18H6v-3z" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
  ellipsis: '<circle cx="6" cy="12" r="1.8" stroke-width="0" fill="currentColor"/><circle cx="12" cy="12" r="1.8" stroke-width="0" fill="currentColor"/><circle cx="18" cy="12" r="1.8" stroke-width="0" fill="currentColor"/>',
  arrowmove: '<path d="M4 12h13" stroke-width="2" stroke-linecap="round"/><path d="M13 7l5 5-5 5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  globe: '<circle cx="12" cy="12" r="8" stroke-width="1.7" fill="none"/><path d="M4 12h16M12 4c2.5 2.6 2.5 13.4 0 16M12 4c-2.5 2.6-2.5 13.4 0 16" stroke-width="1.5" fill="none"/>',
  branch: '<circle cx="7" cy="6" r="2.2" stroke-width="1.7" fill="none"/><circle cx="7" cy="18" r="2.2" stroke-width="1.7" fill="none"/><circle cx="17" cy="8" r="2.2" stroke-width="1.7" fill="none"/><path d="M7 8.2v7.6M17 10.2c0 4-6 3-9.2 6" stroke-width="1.7" fill="none"/>',
  xmark: '<path d="M6 6l12 12M18 6L6 18" stroke-width="2.3" stroke-linecap="round"/>',
  grid: '<rect x="3" y="3" width="7.6" height="7.6" rx="2" stroke-width="1.9" fill="none"/><rect x="13.4" y="3" width="7.6" height="7.6" rx="2" stroke-width="1.9" fill="none"/><rect x="3" y="13.4" width="7.6" height="7.6" rx="2" stroke-width="1.9" fill="none"/><rect x="13.4" y="13.4" width="7.6" height="7.6" rx="2" stroke-width="1.9" fill="none"/>',
  bubble: '<path d="M12 4.5c4.7 0 8.5 3 8.5 6.8s-3.8 6.8-8.5 6.8c-.9 0-1.8-.1-2.6-.3L5 19.5l1.2-3.6C4.5 14.7 3.5 13.1 3.5 11.3 3.5 7.5 7.3 4.5 12 4.5z" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
  list: '<circle cx="5" cy="6.5" r="1.4" stroke-width="0" fill="currentColor"/><circle cx="5" cy="12" r="1.4" stroke-width="0" fill="currentColor"/><circle cx="5" cy="17.5" r="1.4" stroke-width="0" fill="currentColor"/><path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" stroke-width="1.9" stroke-linecap="round"/>',
  pausec: '<circle cx="12" cy="12" r="8.3" stroke-width="1.9" fill="none"/><path d="M10 9v6M14 9v6" stroke-width="2" stroke-linecap="round"/>',
  xcircf: '<circle cx="12" cy="12" r="9" stroke-width="0" fill="currentColor"/><path d="M9 9l6 6M15 9l-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  dotsc: '<circle cx="12" cy="12" r="8.3" stroke-width="1.7" fill="none"/><circle cx="8.4" cy="12" r="1.15" stroke-width="0" fill="currentColor"/><circle cx="12" cy="12" r="1.15" stroke-width="0" fill="currentColor"/><circle cx="15.6" cy="12" r="1.15" stroke-width="0" fill="currentColor"/>',
  extl: '<path d="M13.5 4.5h6v6M19.5 4.5l-8.5 8.5" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M18 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
  pinslash: '<path d="M9 3h6l-1 6 3 3H7l3-3z" stroke-width="0" fill="currentColor"/><path d="M12 12v8" stroke-width="1.8" stroke-linecap="round"/><path d="M4 4l16 16" stroke-width="1.8" stroke-linecap="round"/>',
};
function paintIcons() {
  document.querySelectorAll('i[data-ic]').forEach((el) => {
    const s = el.dataset.s || 20, c = el.dataset.c || 'currentColor';
    el.innerHTML = `<svg width="${s}" height="${s}" viewBox="0 0 24 24" stroke="${c}" style="color:${c};display:block">${P[el.dataset.ic] || ''}</svg>`;
    el.style.display = el.style.display || 'inline-flex';
  });
  const r = document.body.getBoundingClientRect();
  document.title = `SIZE ${Math.ceil(r.width)}x${Math.ceil(r.height)}`;
  const m = document.createElement('meta'); m.name = 'sz'; m.content = `SIZE ${Math.ceil(r.width)}x${Math.ceil(r.height)}`;
  document.head.appendChild(m);
}
document.addEventListener('DOMContentLoaded', paintIcons);
