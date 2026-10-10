// The proposed web pieces, put into the live Infrastructure and runner pages by capture.mjs (after
// kit.js and web.css). Copy is the product's: English. Numbers: see kit.js.
(function () {
  const { DAY, chart, axis } = window.RSX;
  const OOM_TIMES = '16:30, 21:05, 09:15 and 11:42';

  const seg = (options, on) => `<div class="orbit-segmented" role="radiogroup" aria-label="Range"><div class="orbit-segmented-group">${options
    .map((o) => `<span class="orbit-segmented-item"${o === on ? ' data-checked' : ''}><span class="orbit-segmented-label">${o}</span></span>`)
    .join('')}</div></div>`;

  const MEM_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"/><rect x="6" y="6" width="4" height="4" rx=".6" fill="currentColor" stroke="none"/></svg>';

  /** CPU / Mem / Disk on a machine's head: [{k, v, pct, tone}]. */
  function vitals(list, off = false) {
    return `<div class="rsx-vitals${off ? ' off' : ''}">${list
      .map((m) => `<div class="rsx-vital"><div class="rsx-vital-top"><span class="rsx-vital-k">${m.k}</span><span class="rsx-vital-v ${m.tone || ''}">${m.v}</span></div><div class="rsx-vital-bar ${m.tone || ''}"><i style="width:${m.pct}%"></i></div></div>`)
      .join('')}</div>`;
  }

  function injectInfra() {
    const cards = [...document.querySelectorAll('.re-runner-card')];
    const byName = (n) => cards.find((c) => c.querySelector('.re-runner')?.textContent.trim() === n);
    const put = (name, html) => {
      const head = byName(name)?.querySelector('.re-head');
      const toggle = head?.querySelector('.re-toggle');
      if (toggle) toggle.insertAdjacentHTML('afterend', html);
    };
    put('HPC', vitals([{ k: 'CPU', v: '97%', pct: 97, tone: 'warn' }, { k: 'Mem', v: '86%', pct: 86, tone: 'bad' }, { k: 'Disk', v: '99%', pct: 99, tone: 'warn' }]));
    put('Mac Studio', vitals([{ k: 'CPU', v: '18%', pct: 18 }, { k: 'Mem', v: '52%', pct: 52 }, { k: 'Disk', v: '55%', pct: 55 }]));
    put('ThinkPad', vitals([{ k: 'CPU', v: '—', pct: 0 }, { k: 'Mem', v: '—', pct: 0 }, { k: 'Disk', v: '74%', pct: 74 }], true));
    const line = byName('HPC')?.querySelector('.runner-attention');
    if (line) {
      line.classList.remove('warn');
      line.classList.add('bad');
      line.lastElementChild.textContent = 'Out of memory 4× in 24 h · Disk 99% full';
    }
  }

  function resources(width, hover) {
    const chartW = width - 2 - 28 - 168 - 16;
    const h = 54;
    const at = hover != null ? hover : null;
    const row = (k, v, tone, subs, svg, extra = '') => `<div class="rsx-row">
        <div><div class="rsx-k"><span>${k}</span><b class="${tone}">${v}</b></div>${subs.map((s) => `<div class="rsx-s${s.bad ? ' bad' : ''}">${s.html || s}</div>`).join('')}</div>
        <div>${svg}</div>${extra}</div>`;
    const swap = { values: DAY.swap, max: 43, color: 'var(--text-3)', dash: '3 2' };
    const rows = [
      row('CPU', '97%', 'warn', ['Load 27.9 · 24 cores'], chart(DAY.cpu, { w: chartW, h, warn: 90, hover: at })),
      row('Memory', '86%', 'bad', ['12.1 of 14 GB used', { html: '<i class="sw"></i>Swap 22 of 43 GB' }, { bad: true, html: '▲ 4 out-of-memory kills' }],
        chart(DAY.mem, { w: chartW, h: h + 10, warn: 90, marks: DAY.OOM, second: swap, hover: at })),
      row('Disk <em>/</em>', '99%', 'warn', ['9.2 GB free of 915 GB'],
        chart(DAY.disk, { w: chartW, h, min: 95, max: 100, warn: DAY.KEEP_FREE_PCT, limit: { value: DAY.KEEP_FREE_PCT, label: 'Keep Free 20 GB', below: true }, hover: at }),
        '<span class="rsx-scale">95–100%</span>'),
    ];
    const tip = at == null ? '' : `<div class="rsx-tip" style="left:${(14 + 168 + 16 + (at / (DAY.N - 1)) * chartW - 228).toFixed(0)}px;top:58px">
        <div class="rsx-tip-t">Oct 10, 11:42</div>
        <div class="rsx-tip-r">CPU<b class="warn">100%</b></div>
        <div class="rsx-tip-r">Memory<b class="bad">98%</b></div>
        <div class="rsx-tip-r">Swap<b>23 GB</b></div>
        <div class="rsx-tip-r">Disk /<b class="warn">98.9%</b></div>
        <div class="rsx-tip-n">▲ Out of memory · 1 process killed</div>
      </div>`;
    return `<section class="rd-section rsx-resources">
      <div class="rd-section-head"><div class="rd-section-title">Resources</div>
        <div class="rsx-head-right"><span class="rsx-updated">Updated 20s ago</span>${seg(['1h', '24h', '7d'], '24h')}</div></div>
      <div class="rsx-box" style="position:relative">${rows.join('')}
        <div class="rsx-axis-row">${axis(chartW, { size: 11 })}</div>
        <div class="rsx-legend"><span><i class="tri"></i>Out of memory</span><span><i class="hat"></i>Runner offline</span><span><i class="amb"></i>Over 90% · under Keep Free</span></div>
        ${tip}
      </div>
      <div class="rd-hint">The whole machine, not just Orbit: the runner reads it every 5 s and sends it with each check-in. Orbit keeps 7 days.</div>
    </section>`;
  }

  function using() {
    const cores = 24, gb = 14;
    const r = (title, meta, cpu, mem, { muted = false, go = true } = {}) => `<div class="rsx-use${muted ? ' muted' : ''}">
        <div style="min-width:0"><div class="rsx-use-t">${title}</div><div class="rsx-use-m">${meta}</div></div>
        <div class="rsx-use-n">${cpu.toFixed(1)} cores<i style="width:${Math.max(3, (cpu / cores) * 84).toFixed(0)}px"></i></div>
        <div class="rsx-use-n">${mem.toFixed(1)} GB<i style="width:${Math.max(3, (mem / gb) * 72).toFixed(0)}px"></i></div>
        <span class="rsx-go">${go ? '›' : ''}</span></div>`;
    return `<section class="rd-section rsx-using">
      <div class="rd-section-head"><div class="rd-section-title">Using It Now</div><span class="rsx-use-sum">6 sessions · 13.5 of 24 cores · 5.4 GB</span></div>
      <div class="rsx-use-head"><span>Session</span><span>CPU</span><span>Memory</span><span></span></div>
      <div class="rsx-box">
        ${r('Android gate on the project line', 'orbit-develop · background job', 6.2, 1.9)}
        ${r('Web suite for the main red', 'orbit-develop', 4.0, 1.1)}
        ${r('Fix flaky upload test', 'orbit-develop', 2.4, 1.2)}
        ${r('Review evidence for the runner card', 'orbit-develop', 0.3, 0.6)}
        ${r('2 more sessions', 'orbit-develop', 0.6, 0.6, { muted: true })}
        ${r('Other processes', 'qemu-system-x86_64 · dockerd · java', 8.9, 2.6, { muted: true, go: false })}
      </div>
      <div class="rd-hint">A session counts its engine, the commands it runs and its background jobs. Other processes are what Orbit didn't start.</div>
    </section>`;
  }

  function disks() {
    const keep = ((915 - 20) / 915) * 100;
    return `<section class="rd-section rsx-disks">
      <div class="rd-section-head"><div class="rd-section-title">Disks</div></div>
      <div class="rsx-box">
        <div class="rsx-disk"><div class="rsx-disk-top"><b>/</b><span class="warn">99%</span></div>
          <div class="rsx-disk-bar warn"><i style="width:99%"></i><u style="left:${keep.toFixed(1)}%" title="Keep Free"></u></div>
          <div class="rsx-disk-s">897 of 915 GB · 9.2 GB free</div>
          <div class="rsx-disk-r"><b>Worktrees</b> · Repos · Home · Temp · orbit-develop</div></div>
        <div class="rsx-disk"><div class="rsx-disk-top"><b>/mnt/data</b><span>3%</span></div>
          <div class="rsx-disk-bar"><i style="width:3%"></i></div>
          <div class="rsx-disk-s">326 GB of 15 TB · 14 TB free</div>
          <div class="rsx-disk-r">orbit-data</div></div>
      </div>
      <div class="rd-hint">The disks this runner writes to. Isolated sessions work in Worktrees, whatever disk their workspace is on.</div>
    </section>`;
  }

  function injectRunner({ hover = null } = {}) {
    // Needs Attention: the out-of-memory card ahead of the disk one, built from the disk card.
    const diskCard = document.querySelector('.rd-attention .rd-attention-card');
    if (diskCard) {
      const card = diskCard.cloneNode(true);
      card.className = 'rd-attention-card bad';
      card.querySelector('.rd-attention-icon').innerHTML = MEM_ICON;
      card.querySelector('.rd-attention-title').textContent = 'Out of memory 4 times in 24 hours';
      card.querySelector('.rd-attention-detail').textContent = `Memory ran out at ${OOM_TIMES}, and the system killed a process each time; the runner itself was down 16:30–16:33. Now 12.1 of 14 GB in use, 22 GB swapped.`;
      const btn = card.querySelector('.rd-attention-action button');
      if (btn) btn.lastChild.textContent = 'Lower Max Concurrent';
      diskCard.before(card);
    }
    const main = document.querySelector('.rd-col-main');
    const engines = main.querySelector('.rd-engines');
    engines.insertAdjacentHTML('beforebegin', resources(main.clientWidth, hover) + using());
    // Capacity keeps its two settings; its Disk row becomes the Disks section under it.
    document.querySelector('.rd-capacity .rd-disk')?.remove();
    document.querySelector('.rd-capacity').insertAdjacentHTML('afterend', disks());
  }

  window.RSX.web = { injectInfra, injectRunner, vitals };
})();
