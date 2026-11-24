// Puts a numbered red mark on the top-left corner of every element with data-mk, inside its frame (.win, .mac, .ph or .ad).
for (const el of document.querySelectorAll('[data-mk]')) {
  const f = el.closest('.win, .mac, .ph, .ad');
  const r = el.getBoundingClientRect(), fr = f.getBoundingClientRect();
  const m = document.createElement('span');
  m.className = 'mk abs';
  m.textContent = el.dataset.mk;
  m.style.left = Math.max(2, r.left - fr.left - 9) + 'px';
  m.style.top = Math.max(2, r.top - fr.top - 9) + 'px';
  f.appendChild(m);
}
