// Proposal DOM: a "Resources" section under the header, the Disk row leaving Capacity.
export async function inject(page, v) {
  await page.evaluate((v) => {
    const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const series = (seed, base, amp, n = 60, end) => { const r = rnd(seed); let x = base; const out = []; for (let i = 0; i < n; i++) { x += (r() - 0.5) * amp; x = Math.max(base - amp * 2, Math.min(base + amp * 2, x)); out.push(Math.max(1, Math.min(99, x))); } if (end != null) out[n - 1] = end; return out; };
    const spark = (vals, color, gapFrom) => {
      const W = 240, H = 44, n = vals.length;
      const pts = vals.map((y, i) => [(i / (n - 1)) * W, H - (y / 100) * H]);
      const live = gapFrom ? pts.slice(0, gapFrom) : pts;
      const line = live.map((p) => p.join(',')).join(' ');
      const area = `0,${H} ${line} ${live[live.length - 1][0]},${H}`;
      return `<svg class="rr-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${H * 0.1}" y2="${H * 0.1}" stroke="currentColor" stroke-opacity=".12" stroke-dasharray="3 3"/><polygon points="${area}" fill="${color}" fill-opacity=".12"/><polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
    };
    const BLUE = '#2f6bf2', AMBER = '#d97706', GREY = '#9aa0a6';
    const off = v === 'offline', old = v === 'old', warn = v === 'warn';
    const tile = ({ label, pct, sub, vals, warnTile, note, update }) => {
      const color = off ? GREY : warnTile ? AMBER : BLUE;
      if (update) return `<div class="rr-tile"><div class="rr-label">${label}</div><div class="rr-update"><span class="rr-pill">Update runner</span></div><div class="rr-sub">This runner predates ${label === "CPU" ? "CPU" : "memory"} readings.</div></div>`;
      return `<div class="rr-tile${off ? ' off' : ''}${warnTile ? ' warn' : ''}"><div class="rr-label">${label}</div><div class="rr-value">${pct}<span>%</span></div><div class="rr-sub">${sub}</div>${spark(vals, color, off ? 46 : 0)}${note ? `<div class="rr-note">${note}</div>` : ''}</div>`;
    };
    const tiles = [
      tile({ label: 'CPU', pct: off ? 38 : warn ? 71 : 38, sub: warn ? '8 cores · load 5.7' : '8 cores · load 3.0', vals: series(7, warn ? 62 : 36, 9, 60, warn ? 71 : 38), update: old }),
      tile({ label: 'Memory', pct: off ? 68 : warn ? 94 : 68, sub: warn ? '30.1 of 32 GB used' : '21.6 of 32 GB used', vals: series(11, warn ? 88 : 66, 3, 60, warn ? 94 : 68), warnTile: warn, note: warn ? 'Nearly full — new sessions may be slow to start.' : '', update: old }),
      tile({ label: 'Disk', pct: warn ? 96 : 79, sub: warn ? '885 of 926 GB used · 41 GB free' : '728 of 926 GB used · 198 GB free', vals: series(3, warn ? 95 : 79, 0.25, 60, warn ? 96 : 79), warnTile: warn, note: '' }),
    ].join('');
    const head = off ? 'Offline · last reading 14 min ago' : old ? 'Disk is read from your workspaces' : 'Live · every 30 s · last hour';
    const sec = document.createElement('section');
    sec.className = 'settings-section machine-section-resources';
    sec.innerHTML = `<div class="settings-section-head"><h2 class="settings-section-title">Resources</h2><div class="settings-section-action"><span class="machine-section-note">${off ? '<span class="rr-dot off"></span>' : old ? '' : '<span class="rr-dot"></span>'}${head}</span></div></div><div class="rr-grid">${tiles}</div>`;
    const css = document.createElement('style');
    css.textContent = `
      .rr-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
      @media (max-width:700px){.rr-grid{grid-template-columns:1fr}}
      .rr-tile{border:1px solid var(--orbit-border, #e3e5e8);border-radius:12px;padding:14px 16px 12px;background:var(--orbit-surface,#fff);display:flex;flex-direction:column;min-height:150px}
      .rr-label{font-size:13px;color:#6b7280;font-weight:500}
      .rr-value{font-size:28px;font-weight:600;line-height:1.15;margin-top:4px;font-variant-numeric:tabular-nums;color:#111}
      .rr-value span{font-size:16px;font-weight:500;color:#6b7280;margin-left:1px}
      .rr-tile.warn .rr-value{color:#b45309}
      .rr-tile.off .rr-value{color:#9aa0a6}
      .rr-sub{font-size:13px;color:#6b7280;margin-top:2px}
      .rr-spark{width:100%;height:44px;margin-top:auto;padding-top:10px;color:#111;display:block}
      .rr-note{font-size:12px;color:#b45309;margin-top:6px}
      .rr-update{margin-top:10px}
      .rr-pill{display:inline-block;font-size:13px;padding:2px 8px;border-radius:6px;background:#fff4e5;color:#c2410c}
      .rr-tile:has(.rr-update) .rr-sub{margin-top:10px}
      .rr-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22a447;margin-right:6px;vertical-align:1px}
      .rr-dot.off{background:#9aa0a6}`;
    document.head.appendChild(css);
    const engines = document.querySelector('.machine-section-engines');
    engines.parentNode.insertBefore(sec, engines);
    // Disk leaves Capacity: it is a reading, Capacity keeps the two settings.
    const cap = document.querySelector('.machine-section-capacity');
    for (const row of cap.querySelectorAll('*')) if (row.querySelector?.('.machine-disk-bar') && row.parentElement?.classList.contains('settings-card')) { row.remove(); break; }
  }, v);
}
