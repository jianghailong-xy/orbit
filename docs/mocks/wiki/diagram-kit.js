// Draws orthogonal connectors between absolutely positioned nodes once fonts and layout settle.
// edge: {from, to, fs, ts (sides: right|left|top|bottom), color, dash, label, lx, ly, mx, my, fo, too, noArrow}
(function () {
  const COLORS = { gray: '#8c959f', blue: '#0969da', red: '#cf222e', green: '#1a7f37', purple: '#8250df', amber: '#bf8700' };
  function anchor(el, side, base) {
    const r = el.getBoundingClientRect();
    const x = r.left - base.left, y = r.top - base.top;
    if (side === 'right') return [x + r.width, y + r.height / 2];
    if (side === 'left') return [x, y + r.height / 2];
    if (side === 'top') return [x + r.width / 2, y];
    return [x + r.width / 2, y + r.height];
  }
  function draw(canvas, edges) {
    const base = canvas.getBoundingClientRect();
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'wires');
    svg.setAttribute('width', canvas.scrollWidth);
    svg.setAttribute('height', canvas.scrollHeight);
    const defs = document.createElementNS(NS, 'defs');
    for (const [name, c] of Object.entries(COLORS)) {
      const m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', 'arrow-' + name); m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('refX', '9'); m.setAttribute('refY', '5');
      m.setAttribute('markerWidth', '7'); m.setAttribute('markerHeight', '7'); m.setAttribute('orient', 'auto-start-reverse');
      const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M0,0 L10,5 L0,10 z'); p.setAttribute('fill', c);
      m.appendChild(p); defs.appendChild(m);
    }
    svg.appendChild(defs);
    for (const e of edges) {
      const a = document.getElementById(e.from), b = document.getElementById(e.to);
      if (!a || !b) { console.error('missing node', e.from, e.to); continue; }
      const fs = e.fs || 'right', ts = e.ts || 'left';
      let [x1, y1] = anchor(a, fs, base), [x2, y2] = anchor(b, ts, base);
      if (e.fo) { if (fs === 'left' || fs === 'right') y1 += e.fo; else x1 += e.fo; }
      if (e.too) { if (ts === 'left' || ts === 'right') y2 += e.too; else x2 += e.too; }
      const hf = fs === 'left' || fs === 'right', ht = ts === 'left' || ts === 'right';
      let pts;
      if (hf && ht) { const mx = e.mx != null ? x1 + e.mx : (x1 + x2) / 2; pts = [[x1, y1], [mx, y1], [mx, y2], [x2, y2]]; }
      else if (!hf && !ht) { const my = e.my != null ? y1 + e.my : (y1 + y2) / 2; pts = [[x1, y1], [x1, my], [x2, my], [x2, y2]]; }
      else if (hf && !ht) pts = [[x1, y1], [x2, y1], [x2, y2]];
      else pts = [[x1, y1], [x1, y2], [x2, y2]];
      pts = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
      const color = e.color || 'gray';
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M' + pts.map((p) => p.join(',')).join(' L'));
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', COLORS[color]);
      path.setAttribute('stroke-width', e.width || 2.2); path.setAttribute('stroke-linejoin', 'round');
      if (e.dash) path.setAttribute('stroke-dasharray', '7 6');
      if (!e.noArrow) path.setAttribute('marker-end', 'url(#arrow-' + color + ')');
      svg.appendChild(path);
      if (e.label) {
        let best = 0, seg = [pts[0], pts[1]];
        for (let i = 1; i < pts.length; i++) {
          const L = Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
          if (L > best) { best = L; seg = [pts[i - 1], pts[i]]; }
        }
        const lab = document.createElement('div');
        lab.className = 'wlabel'; lab.innerHTML = e.label;
        lab.style.left = ((seg[0][0] + seg[1][0]) / 2 + (e.lx || 0)) + 'px';
        lab.style.top = ((seg[0][1] + seg[1][1]) / 2 + (e.ly || 0)) + 'px';
        lab.style.color = COLORS[color];
        canvas.appendChild(lab);
      }
    }
    canvas.appendChild(svg);
  }
  window.drawWires = function (edges) {
    document.fonts.ready.then(() => requestAnimationFrame(() => {
      draw(document.querySelector('.canvas'), edges);
      document.body.setAttribute('data-ready', '1');
    }));
  };
})();
