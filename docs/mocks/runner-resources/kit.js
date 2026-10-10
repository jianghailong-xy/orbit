// Mock kit for the runner-resources board: one sample day on the "HPC" runner, an SVG chart drawn
// the same way on every client, and the pieces injected into the real web pages (capture.mjs loads
// this file into the live page) or drawn into the phone frames (board.html).
//
// The day: 2026-10-09 12:05 → 2026-10-10 12:03 CST in 5-minute buckets. The figures at the right edge
// are the workstation-gpu host's real readings at 12:03 (24 cores, load 27.9, 14 GiB RAM with 2 GiB
// available, 22 of 43 GiB swap, / at 897 of 915 GB). The runner really was stopped by an OOM kill at
// 16:30 the day before and came back at 16:33 (OOMPolicy=stop). The rest of the curve is drawn to
// match: kills at 21:05, 09:15 and 11:42, a worktree clean-up at 03:00, the disk crossing Keep Free
// (20 GB) at 09:40. Session titles are samples — the repo is public.
(function () {
  const N = 288;
  const STEP = 5 * 60_000;
  const NOW = Date.parse('2026-10-10T04:03:20Z');
  const CST = 8 * 3600_000;
  const t = (i) => NOW - (N - 1 - i) * STEP;
  /** Bucket index of a CST wall-clock time: day 0 = Oct 9, day 1 = Oct 10. */
  const at = (day, hh, mm = 0) => {
    const ms = Date.UTC(2026, 9, 9 + day, hh, mm) - CST;
    return Math.round((ms - t(0)) / STEP);
  };

  // A seeded wobble so every render draws the same day.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  /** Piecewise-linear keyframes [index, value] plus noise, clamped. */
  function curve(keys, noise, lo, hi) {
    const out = new Array(N);
    for (let i = 0; i < N; i++) {
      let k = 0;
      while (k < keys.length - 2 && keys[k + 1][0] <= i) k++;
      const [i0, v0] = keys[k], [i1, v1] = keys[k + 1];
      const f = i1 === i0 ? 0 : Math.min(1, Math.max(0, (i - i0) / (i1 - i0)));
      out[i] = Math.min(hi, Math.max(lo, v0 + (v1 - v0) * f + rnd() * noise));
    }
    return out;
  }

  const GAP = [at(0, 16, 30), at(0, 16, 35)];
  const OOM = [at(0, 16, 30) - 1, at(0, 21, 5), at(1, 9, 15), at(1, 11, 42)];
  const cpu = curve([[0, 80], [at(0, 14), 90], [at(0, 16, 25), 95], [at(0, 16, 40), 40], [at(0, 18), 72], [at(0, 20), 78],
    [at(0, 22), 64], [at(1, 1), 52], [at(1, 3), 38], [at(1, 5), 45], [at(1, 8), 70], [at(1, 9, 30), 96], [at(1, 10), 99],
    [N - 2, 98], [N - 1, 97]], 6, 3, 100);
  const mem = curve([[0, 80], [at(0, 16, 25), 97], [at(0, 16, 40), 60], [at(0, 19), 82], [OOM[1], 96], [OOM[1] + 1, 84],
    [at(0, 23), 86], [at(1, 2), 79], [at(1, 6), 76], [at(1, 8), 85], [OOM[2], 98], [OOM[2] + 1, 86], [OOM[3], 98],
    [OOM[3] + 1, 85], [N - 1, 86]], 1.4, 30, 99.5);
  const swap = curve([[0, 14.5], [at(0, 16, 25), 19], [at(0, 16, 40), 12], [OOM[1], 18], [OOM[1] + 1, 17], [at(1, 6), 18.5],
    [OOM[3], 23], [N - 1, 22]], 0.3, 0, 43);
  const disk = curve([[0, 97.4], [at(0, 23), 98.6], [at(1, 3), 98.7], [at(1, 3) + 1, 97.3], [at(1, 9, 40), 97.85],
    [N - 1, 99.0]], 0.02, 90, 100);
  mem[OOM[0]] = 98.6; mem[OOM[1]] = 97.8; mem[OOM[2]] = 98.9; mem[OOM[3]] = 98.4;
  cpu[N - 1] = 97; mem[N - 1] = 86; disk[N - 1] = 99.0; swap[N - 1] = 22;
  for (let i = GAP[0]; i < GAP[1]; i++) cpu[i] = mem[i] = swap[i] = disk[i] = null;

  const KEEP_FREE_PCT = ((915 - 20) / 915) * 100;
  const DAY = { N, t, at, cpu, mem, swap, disk, GAP, OOM, KEEP_FREE_PCT };
  /** Where the hour labels fall: [index, text]. */
  DAY.ticks = [[at(0, 18), '18:00'], [at(1, 0), '00:00'], [at(1, 6), '06:00'], [at(1, 12), '12:00']];

  /**
   * One metric over the day, as SVG. `warn` paints the line and fill amber above that value (the
   * threshold the tile turns amber at); `limit` draws a dashed line with a label (Keep Free);
   * `marks` are the OOM kills: a red hairline and a cap; null values are the runner being offline:
   * a hatched band, the line broken around it. `hover` draws the crosshair at a bucket.
   */
  let uid = 0;
  function chart(values, { w = 400, h = 56, min = 0, max = 100, warn = null, limit = null, marks = [], line = 'var(--rsx-line)',
    amber = 'var(--rsx-amber)', red = 'var(--rsx-red)', grid = 'var(--rsx-grid)', hatch = 'var(--rsx-hatch)', hover = null,
    second = null, pad = 3, strokeW = 1.5, fillOpacity = 0.12, gapLabel = true } = {}) {
    const id = `rsx${++uid}`;
    const top = pad, bottom = h - 1;
    const x = (i) => (i / (values.length - 1)) * w;
    const y = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
    const runs = [];
    let cur = [];
    values.forEach((v, i) => {
      if (v == null) { if (cur.length) runs.push(cur); cur = []; } else cur.push([x(i), y(v)]);
    });
    if (cur.length) runs.push(cur);
    const path = (pts) => pts.map(([px, py], k) => `${k ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    const area = (pts) => `${path(pts)}L${pts[pts.length - 1][0].toFixed(1)},${bottom}L${pts[0][0].toFixed(1)},${bottom}Z`;
    const lines = runs.map(path).join('');
    const areas = runs.map(area).join('');
    const wy = warn != null ? y(warn) : null;
    const parts = [];
    parts.push(`<defs>
      <pattern id="${id}h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" fill="${hatch}"/></pattern>
      ${wy != null ? `<clipPath id="${id}a"><rect x="0" y="0" width="${w}" height="${wy.toFixed(1)}"/></clipPath>` : ''}
    </defs>`);
    for (const g of [0.5, 1]) {
      const gy = y(min + (max - min) * g);
      parts.push(`<line x1="0" x2="${w}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${grid}" stroke-width="1" stroke-dasharray="2 3"/>`);
    }
    parts.push(`<line x1="0" x2="${w}" y1="${bottom}" y2="${bottom}" stroke="${grid}" stroke-width="1"/>`);
    // offline bands
    let i0 = null;
    values.forEach((v, i) => {
      if (v == null && i0 == null) i0 = i;
      if ((v != null || i === values.length - 1) && i0 != null) {
        const x0 = x(Math.max(0, i0 - 0.5)), x1 = x(Math.min(values.length - 1, i - 0.5));
        parts.push(`<rect x="${x0.toFixed(1)}" y="${top}" width="${Math.max(3, x1 - x0).toFixed(1)}" height="${bottom - top}" fill="url(#${id}h)"/>`);
        i0 = null;
      }
    });
    if (second) parts.push(`<path d="${second.values.map((v, i) => v == null ? '' : `${second.values[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${(bottom - (v / second.max) * (bottom - top)).toFixed(1)}`).join('')}" fill="none" stroke="${second.color}" stroke-width="1.2" stroke-dasharray="${second.dash || '0'}" opacity=".9"/>`);
    parts.push(`<path d="${areas}" fill="${line}" opacity="${fillOpacity}"/>`);
    parts.push(`<path d="${lines}" fill="none" stroke="${line}" stroke-width="${strokeW}" stroke-linejoin="round"/>`);
    if (wy != null) {
      parts.push(`<g clip-path="url(#${id}a)"><path d="${areas}" fill="${amber}" opacity="${fillOpacity + 0.06}"/><path d="${lines}" fill="none" stroke="${amber}" stroke-width="${strokeW}" stroke-linejoin="round"/></g>`);
    }
    if (limit) {
      const ly = y(limit.value);
      parts.push(`<line x1="0" x2="${w}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${limit.color || amber}" stroke-width="1" stroke-dasharray="4 3"/>`);
      if (limit.label) parts.push(`<text x="${limit.x ?? 4}" y="${(ly + (limit.below ? 11 : -3)).toFixed(1)}" font-size="${limit.size || 10}" fill="${limit.color || amber}" stroke="${limit.halo || '#fff'}" stroke-width="3" paint-order="stroke" font-weight="500">${limit.label}</text>`);
    }
    for (const m of marks) {
      const mx = x(m);
      parts.push(`<line x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${top + 4}" y2="${bottom}" stroke="${red}" stroke-width="1" opacity=".55"/>`);
      parts.push(`<path d="M${(mx - 4).toFixed(1)},${top - 1}L${(mx + 4).toFixed(1)},${top - 1}L${mx.toFixed(1)},${top + 5}Z" fill="${red}"/>`);
    }
    if (hover != null) {
      const hx = x(hover);
      parts.push(`<line x1="${hx.toFixed(1)}" x2="${hx.toFixed(1)}" y1="0" y2="${h}" stroke="var(--rsx-cross)" stroke-width="1"/>`);
      const hv = values[hover];
      if (hv != null) parts.push(`<circle cx="${hx.toFixed(1)}" cy="${y(hv).toFixed(1)}" r="3.2" fill="#fff" stroke="${warn != null && hv >= warn ? amber : line}" stroke-width="1.6"/>`);
    }
    return `<svg class="rsx-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="visible">${parts.join('')}</svg>`;
  }

  /** The shared time axis under a stack of charts. */
  function axis(w, { labels = DAY.ticks, n = N, color = 'var(--text-3)', size = 11 } = {}) {
    return `<div class="rsx-axis" style="width:${w}px;height:16px;position:relative;color:${color};font-size:${size}px">${labels
      .map(([i, text]) => `<span style="position:absolute;left:${((i / (n - 1)) * w).toFixed(1)}px;transform:translateX(${i / (n - 1) > 0.96 ? '-88%' : '-50%'})">${text}</span>`)
      .join('')}</div>`;
  }

  window.RSX = { DAY, chart, axis };
})();
