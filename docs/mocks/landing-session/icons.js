// Inline icons for the landing-session boards: <i data-ic="name" data-s="14" data-c="#3E69F6"></i>
const IC = {
  ring: '<path d="M20 11a8 8 0 0 0-14.3-4.9"/><path d="M5.5 2.8v3.5H9"/><path d="M4 13a8 8 0 0 0 14.3 4.9"/><path d="M18.5 21.2v-3.5H15"/>',
  chevr: '<path d="M9 5l7 7-7 7"/>', chevl: '<path d="M15 5l-7 7 7 7"/>', chevd: '<path d="M6 9l6 6 6-6"/>',
  dots: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  circ: '<circle cx="12" cy="12" r="8"/>', dashc: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>', term: '<path d="M4 6l6 6-6 6M12 18h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bubble: '<path d="M4 5h16v11H9l-5 4z"/>', grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  task: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>', card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>', pause: '<path d="M9 6v12M15 6v12"/>',
  bin: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>', person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  arrowr: '<path d="M5 12h14M13 6l6 6-6 6"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
  ham: '<path d="M4 7h16M4 12h16M4 17h16"/>', compose: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v7h14v-7"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V4h12"/>',
  play: '<path d="M7 5l12 7-12 7z"/>', merge: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M6 9c0 6 12 4 12 8"/>',
};
function drawIcons() {
  document.querySelectorAll('i[data-ic]').forEach((el) => {
    const s = el.dataset.s || 14, c = el.dataset.c || 'currentColor', w = el.dataset.w || 2;
    el.outerHTML = `<svg class="i" viewBox="0 0 24 24" style="width:${s}px;height:${s}px;color:${c};stroke-width:${w}">${IC[el.dataset.ic] || ''}</svg>`;
  });
}
document.addEventListener('DOMContentLoaded', drawIcons);
