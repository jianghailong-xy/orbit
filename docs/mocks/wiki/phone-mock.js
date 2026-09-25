/* Orbit Wiki — phone sheets 06–09. SF-Symbols-like line glyphs (redrawn on a 24pt grid) for the iOS
   drawings, placeholder expansion (<i data-sf>, <i data-ant>, <div data-ios="status">), and a probe that
   writes the sheet height into <title> and an overflow / truncation report into <pre id="probe">. */
document.write('<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">' + [
  ['menu', '<path d="M4 7h16M4 12h16M4 17h16"/>'],
  ['back', '<path d="M15 4.5 7.5 12 15 19.5" stroke-width="2.4"/>'],
  ['chev-r', '<path d="M9.5 5.5 16 12l-6.5 6.5"/>'],
  ['chev-d', '<path d="M5.5 9.5 12 16l6.5-6.5"/>'],
  ['chev-ud', '<path d="M7.5 9.5 12 5l4.5 4.5M7.5 14.5 12 19l4.5-4.5"/>'],
  ['dots', '<circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/>'],
  ['plus', '<path d="M12 4.5v15M4.5 12h15" stroke-width="2.1"/>'],
  ['search', '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>'],
  ['grid', '<rect x="4" y="4" width="7" height="7" rx="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.8"/><rect x="13" y="13" width="7" height="7" rx="1.8"/>'],
  ['checklist', '<path d="M10.5 6.5h9.5M10.5 12h9.5M10.5 17.5h9.5"/><path d="m3.6 6.4 1.7 1.7 2.8-3.2M3.6 11.9l1.7 1.7 2.8-3.2M3.6 17.4l1.7 1.7 2.8-3.2"/>'],
  ['book', '<path d="M6.9 3.2h11.6a.8.8 0 0 1 .8.8v13.4H6.9a2 2 0 0 0-2 2V5.2a2 2 0 0 1 2-2z"/><path d="M4.9 19.4a1.9 1.9 0 0 0 1.9 1.9h12.5v-3.9"/><path d="M8.7 3.3v14"/>'],
  ['folder', '<path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7h4.4l1.9 2h7.3a1.7 1.7 0 0 1 1.7 1.7v8.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z"/>'],
  ['gear', '<path d="M18.55 9.53 L21.02 10.17 L21.02 13.83 L18.55 14.47 L18.38 14.89 L19.67 17.08 L17.08 19.67 L14.89 18.38 L14.47 18.55 L13.83 21.02 L10.17 21.02 L9.53 18.55 L9.11 18.38 L6.92 19.67 L4.33 17.08 L5.62 14.89 L5.45 14.47 L2.98 13.83 L2.98 10.17 L5.45 9.53 L5.62 9.11 L4.33 6.92 L6.92 4.33 L9.11 5.62 L9.53 5.45 L10.17 2.98 L13.83 2.98 L14.47 5.45 L14.89 5.62 L17.08 4.33 L19.67 6.92 L18.38 9.11 Z"/><circle cx="12" cy="12" r="3.2"/>'],
  ['compose', '<path d="M10.8 4.6H6.3a1.8 1.8 0 0 0-1.8 1.8v11.3a1.8 1.8 0 0 0 1.8 1.8h11.3a1.8 1.8 0 0 0 1.8-1.8v-4.5"/><path d="m17.7 3.9 2.4 2.4-8.4 8.4-3.2.8.8-3.2z"/>'],
  ['warn', '<path d="M12 4.3 20.7 19.4a.9.9 0 0 1-.8 1.3H4.1a.9.9 0 0 1-.8-1.3z"/><path d="M12 10v4.3"/><circle cx="12" cy="17.2" r=".4" fill="currentColor"/>'],
  ['bubble', '<path d="M6.3 5h11.4a2.8 2.8 0 0 1 2.8 2.8v6.1a2.8 2.8 0 0 1-2.8 2.8h-6.6L6.6 20.3v-3.6h-.3a2.8 2.8 0 0 1-2.8-2.8V7.8A2.8 2.8 0 0 1 6.3 5z"/>'],
  ['task', '<rect x="4" y="4" width="16" height="16" rx="3.6"/><path d="m8.3 12.2 2.6 2.6 4.9-5.5"/>'],
  ['commit', '<circle cx="12" cy="12" r="3.4"/><path d="M3 12h5.6M15.4 12H21"/>'],
  ['doc', '<path d="M7.5 3.5h6.4l4.6 4.6v11a1.4 1.4 0 0 1-1.4 1.4H7.5a1.4 1.4 0 0 1-1.4-1.4V4.9a1.4 1.4 0 0 1 1.4-1.4z"/><path d="M13.6 3.7v4.7h4.7M9 12.6h6M9 16h6"/>'],
  ['pin', '<path d="M9.2 3.5h5.6l-.8 5.3 3.3 3.1v1.4H6.7v-1.4L10 8.8z" fill="currentColor"/><path d="M12 13.3v7.2"/>'],
  ['copy', '<rect x="8.5" y="8.5" width="11" height="12" rx="2.2"/><path d="M15.5 8.4V6.2a2 2 0 0 0-2-2H6.7a2 2 0 0 0-2 2v8.8a2 2 0 0 0 2 2h1.7"/>'],
  ['link', '<path d="M10.3 13.7a3.6 3.6 0 0 0 5.1 0l3.1-3.1a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"/><path d="M13.7 10.3a3.6 3.6 0 0 0-5.1 0l-3.1 3.1a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>'],
  ['archive', '<rect x="3.5" y="4.5" width="17" height="4.2" rx="1.2"/><path d="M5 8.7v9.6a1.6 1.6 0 0 0 1.6 1.6h10.8a1.6 1.6 0 0 0 1.6-1.6V8.7M10 12.6h4"/>'],
  ['swap', '<path d="M7.5 4.5 4 8l3.5 3.5M4 8h12.5M16.5 12.5 20 16l-3.5 3.5M20 16H7.5"/>'],
  ['globe', '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5s1.2-5.9 3.6-8.5z"/>'],
  ['x', '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'],
  ['check', '<path d="m5 12.6 4.4 4.4L19 7.4"/>'],
  ['checkc', '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="m7.8 12.3 2.9 2.9 5.6-6.1" stroke="#fff" stroke-width="2.2"/>'],
  ['clock', '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.3V12l3.2 2"/>'],
  ['pencil', '<path d="m16.3 4.6 3.1 3.1L8.6 18.5l-4 .9.9-4z"/>'],
  ['thumbdown', '<path d="M8 4.5h8.6a2 2 0 0 1 1.9 1.4l1.4 5.5a2 2 0 0 1-1.9 2.5h-4.4l.7 3.4a1.7 1.7 0 0 1-1.7 2l-4.1-6.1V4.5zM8 4.5H4.5v9.1H8"/>'],
  ['sparkle', '<path d="M12 3.5 13.7 10.3 20.5 12l-6.8 1.7L12 20.5l-1.7-6.8L3.5 12l6.8-1.7z"/>'],
  ['bolt', '<path d="M13.2 3.5 5.5 13.4h6l-1.2 7.1 7.7-9.9h-6z"/>'],
  ['seal', '<path d="M12 3.2l2.2 1.6 2.7-.2.8 2.6 2.3 1.5-.9 2.6.9 2.6-2.3 1.5-.8 2.6-2.7-.2L12 20.8l-2.2-1.6-2.7.2-.8-2.6L4 15.3l.9-2.6L4 10.1l2.3-1.5.8-2.6 2.7.2z"/><path d="m8.8 12.2 2.2 2.2 4.3-4.6"/>'],
  ['decision', '<path d="M12 20.5V13M12 13 6.5 7.5M12 13l5.5-5.5M6.5 7.5V11M6.5 7.5H10M17.5 7.5V11M17.5 7.5H14"/>'],
  ['scope', '<circle cx="12" cy="12" r="6.6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2.6v4M12 17.4v4M2.6 12h4M17.4 12h4"/>'],
  ['merge', '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="12" r="2"/><path d="M6.5 7.5v9M6.5 9c0 2.6 3.4 3 9 3"/>'],
  ['share', '<path d="M12 3.5v11.5M8 7.5l4-4 4 4"/><path d="M8.6 10.5H6.9a1.8 1.8 0 0 0-1.8 1.8v6.4a1.8 1.8 0 0 0 1.8 1.8h10.2a1.8 1.8 0 0 0 1.8-1.8v-6.4a1.8 1.8 0 0 0-1.8-1.8h-1.7"/>'],
].map(([id, body]) => `<symbol id="sf-${id}" viewBox="0 0 24 24">${body}</symbol>`).join('') +
  // Two Ant Design icons the desktop sprite does not carry: MenuOutlined (the phone top bar's toggle) and LeftOutlined.
  '<symbol id="i-menu" viewBox="64 64 896 896"><path d="M904 160H120c-4.4 0-8 3.6-8 8v64c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-64c0-4.4-3.6-8-8-8zm0 624H120c-4.4 0-8 3.6-8 8v64c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-64c0-4.4-3.6-8-8-8zm0-312H120c-4.4 0-8 3.6-8 8v64c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-64c0-4.4-3.6-8-8-8z"/></symbol>' +
  '<symbol id="i-left" viewBox="64 64 896 896"><path d="M724 218.3V141c0-6.7-7.7-10.4-12.9-6.3L260.3 486.8a31.86 31.86 0 000 50.3l450.8 352.1c5.3 4.1 12.9.4 12.9-6.3v-77.3c0-4.9-2.3-9.6-6.1-12.6l-360-281 360-281.1c3.8-3 6.1-7.7 6.1-12.6z"/></symbol>' +
  '</svg>');

(function () {
  const STATUS = `
    <div class="io-time">9:41</div><div class="io-island"></div>
    <div class="io-sys">
      <svg width="19" height="12" viewBox="0 0 19 12"><rect x="0" y="7.5" width="3.2" height="4.5" rx="1"/><rect x="5.2" y="5.2" width="3.2" height="6.8" rx="1"/><rect x="10.4" y="2.7" width="3.2" height="9.3" rx="1"/><rect x="15.6" y="0" width="3.2" height="12" rx="1"/></svg>
      <svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 11.6 6 9.1a3.5 3.5 0 0 1 5 0zM3.6 6.6a6.9 6.9 0 0 1 9.8 0l-1.3 1.3a5.1 5.1 0 0 0-7.2 0zM1.2 4.2a10.3 10.3 0 0 1 14.6 0l-1.3 1.3a8.5 8.5 0 0 0-12 0z"/></svg>
      <svg width="28" height="13" viewBox="0 0 28 13"><rect x=".5" y=".5" width="24" height="12" rx="3.8" fill="none" stroke="#000" stroke-opacity=".38"/><rect x="2" y="2" width="16.5" height="9" rx="2.4"/><path d="M26 4.5v4c.8-.3 1.3-1 1.3-2s-.5-1.7-1.3-2z" fill-opacity=".4"/></svg>
    </div>`;
  function expand() {
    for (const el of document.querySelectorAll('i[data-sf]')) {
      const [id, ...cls] = el.dataset.sf.split(' ');
      el.outerHTML = `<svg class="sf ${cls.join(' ')} ${el.className}" style="${el.getAttribute('style') || ''}"><use href="#sf-${id}"/></svg>`;
    }
    for (const el of document.querySelectorAll('i[data-ant]')) {
      const [id, ...cls] = el.dataset.ant.split(' ');
      el.outerHTML = `<svg class="ic ${cls.join(' ')} ${el.className}" style="${el.getAttribute('style') || ''}"><use href="#i-${id}"/></svg>`;
    }
    for (const el of document.querySelectorAll('[data-ios="status"]')) {
      el.classList.add('io-status');
      el.innerHTML = STATUS;
    }
  }
  function probe() {
    const out = { h: 0, overflow: [], clipped: [], ellipsis: [] };
    const sheet = document.querySelector('.pb-sheet');
    out.h = Math.ceil(sheet.getBoundingClientRect().height + 2 * 0);
    for (const frame of document.querySelectorAll('.pb-web, .pb-ios')) {
      const fr = frame.getBoundingClientRect();
      for (const el of frame.querySelectorAll('*')) {
        if (el.closest('[data-clip]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > fr.right + 0.6 || r.left < fr.left - 0.6) {
          out.overflow.push(`${frame.dataset.name || '?'} :: ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} [${Math.round(r.left - fr.left)}..${Math.round(r.right - fr.left)} / ${Math.round(fr.width)}] ${(el.textContent || '').trim().slice(0, 40)}`);
        }
        if (el.children.length === 0 || getComputedStyle(el).textOverflow === 'ellipsis') {
          const cs = getComputedStyle(el);
          if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible') {
            const t = `${frame.dataset.name || '?'} :: ${(el.textContent || '').trim().slice(0, 60)}`;
            (cs.textOverflow === 'ellipsis' ? out.ellipsis : out.clipped).push(t);
          }
        }
      }
    }
    // Notes and labels outside the frames must never be cut either.
    for (const el of document.querySelectorAll('.pb-note *, .pb-band, .pb-colhead')) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.clipped.push('note :: ' + el.textContent.trim().slice(0, 50));
    }
    document.title = `H=${out.h};OVF=${out.overflow.length};CLIP=${out.clipped.length};ELL=${out.ellipsis.length}`;
    const pre = document.createElement('pre');
    pre.id = 'probe';
    pre.style.display = 'none';
    pre.textContent = 'PROBE>>' + JSON.stringify(out) + '<<PROBE';
    document.body.appendChild(pre);
  }
  // A drawing split over several bands is one scroll: mark each piece data-flow="<name>", the first
  // one also data-fold="<screen height>", and the fold line lands where the first screen ends.
  function folds() {
    const flows = new Map();
    for (const el of document.querySelectorAll('[data-flow]')) {
      if (!flows.has(el.dataset.flow)) flows.set(el.dataset.flow, []);
      flows.get(el.dataset.flow).push(el);
    }
    for (const [, parts] of flows) {
      const fold = Number(parts[0].dataset.fold || 0);
      if (!fold) continue;
      let acc = 0;
      for (const part of parts) {
        const h = part.getBoundingClientRect().height;
        if (acc + h > fold) {
          const line = document.createElement('div');
          line.className = 'pb-fold';
          line.style.top = `${fold - acc}px`;
          part.appendChild(line);
          // The label sits in the gutter to the right of the drawing, so it never covers a row.
          const grid = part.closest('.pb-grid');
          const g = grid.getBoundingClientRect();
          const r = part.getBoundingClientRect();
          const tag = document.createElement('div');
          tag.className = 'pb-foldtag';
          tag.innerHTML = parts[0].dataset.foldLabel || '首屏';
          tag.style.left = `${r.right - g.left + 3}px`;
          tag.style.top = `${r.top - g.top + fold - acc - 13}px`;
          grid.appendChild(tag);
          break;
        }
        acc += h;
      }
    }
  }
  document.addEventListener('DOMContentLoaded', expand);
  addEventListener('load', folds);
  addEventListener('load', () => setTimeout(probe, 50));
})();
