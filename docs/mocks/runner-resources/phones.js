// iPhone and Android frames for the runner-resources board. iPhone frames use phone()/section()/ICON
// from ../antigravity-accounts/kit.js; charts and the day's numbers come from kit.js here.
(function () {
  const { DAY, chart, axis } = window.RSX;
  const IOS = { line: '#3e69f6', amber: '#f09242', red: '#e5372b', grid: '#e5e5ea', hatch: 'rgba(142,142,147,.35)' };
  const AND = { line: '#0066be', amber: '#b06a00', red: '#b3261e', grid: '#dfe0e3', hatch: 'rgba(116,119,127,.35)' };
  const SWAP = (color) => ({ values: DAY.swap, max: 43, color, dash: '3 2' });
  const spark = (values, c, o = {}) => chart(values, { w: 96, h: 30, pad: 2, strokeW: 1.3, fillOpacity: 0.14, grid: 'transparent',
    line: c.line, amber: c.amber, red: c.red, hatch: c.hatch, ...o });
  const big = (values, c, w, h, o = {}) => chart(values, { w, h, line: c.line, amber: c.amber, red: c.red, grid: c.grid, hatch: c.hatch, ...o });

  const WARN = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 .8 11.4 10.6H.6z" fill="currentColor"/><path d="M6 4.3v3" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/><circle cx="6" cy="8.9" r=".75" fill="#fff"/></svg>';
  const CHIP = '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"/></svg>';
  const DRIVE = '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.8" y="4" width="12.4" height="8" rx="2"/><circle cx="11.2" cy="8" r=".9" fill="currentColor" stroke="none"/><path d="M4.2 8h3.6"/></svg>';
  const MACHINE = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#6c6c70" stroke-width="1.6"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';

  // ── shared rows ──
  const HPC_METERS = [['CPU', '97%', 97, 'warn'], ['Mem', '86%', 86, 'bad'], ['Disk', '99%', 99, 'warn']];
  const MAC_METERS = [['CPU', '18%', 18, ''], ['Mem', '52%', 52, ''], ['Disk', '55%', 55, '']];
  const TP_METERS = [['CPU', '—', 0, ''], ['Mem', '—', 0, ''], ['Disk', '74%', 74, '']];
  const SESSIONS = [
    ['Android gate on the project line', 'orbit-develop · background job', 6.2, 1.9],
    ['Web suite for the main red', 'orbit-develop', 4.0, 1.1],
    ['Fix flaky upload test', 'orbit-develop', 2.4, 1.2],
    ['Review evidence for the runner card', 'orbit-develop', 0.3, 0.6],
    ['2 more sessions', 'orbit-develop', 0.6, 0.6, true],
    ['Other processes', 'qemu-system-x86_64 · dockerd · java', 8.9, 2.6, true, true],
  ];

  // ── iPhone ──
  const ix = {
    meters: (list, off) => `<div class="ix-meters${off ? ' off' : ''}">${list.map(([k, v, p, t]) => `<div class="ix-m"><div class="ix-m-t"><span>${k}</span><b class="${t}">${v}</b></div><div class="ix-m-b ${t}"><i style="width:${p}%"></i></div></div>`).join('')}</div>`,
    machine: ({ name, slot, off, l2, meters, att, id }) => `<div class="ix-row" ${id ? `id="${id}"` : ''}>
      <div class="ix-l1"><span class="ix-dot${off ? ' off' : ''}"></span><span class="ix-name">${name}</span>${off ? '<span class="ix-off">Offline</span>' : `<span class="ix-slot"><i style="width:${slot}%"></i></span>`}${ICON.chev}</div>
      <div class="ix-l2">${l2}</div>${meters}${att ? `<div class="ix-att">${WARN}<span>${att}</span></div>` : ''}</div>`,
    res: (name, sub, svg, v, tone, id) => `<div class="ix-res" ${id ? `id="${id}"` : ''}><div style="min-width:0"><div class="ix-res-n">${name}</div><div class="ix-res-s">${sub}</div></div><div>${svg}</div><div class="ix-res-v ${tone}">${v}</div>${ICON.chev}</div>`,
  };

  function iosInfrastructure() {
    const body = section({ header: 'Machines', trailing: '3 machines · 7 / 12 slots busy', id: 'ix-machines', rows: [
      ix.machine({ id: 'ix-hpc', name: 'HPC', slot: 75, l2: '6 / 8 running · All signed in', meters: ix.meters(HPC_METERS), att: 'Out of memory 4× in 24 h · Disk 99% full' }),
      ix.machine({ name: 'Mac Studio', slot: 25, l2: '1 / 4 running · All signed in', meters: ix.meters(MAC_METERS) }),
      ix.machine({ id: 'ix-tp', name: 'ThinkPad', off: true, l2: '1 of 3 signed in', meters: ix.meters(TP_METERS, true) }),
    ], footer: '<p>Subscriptions signed in here are spent only by sessions on that machine.</p>' })
      + section({ rows: [btnRow('Add Runner')], footer: '<p>Run one command on the new machine — it installs Orbit, then asks you to confirm it’s yours.</p>' })
      + section({ header: 'Account pools', rows: ['<div class="r txt">Claude keys<span style="float:right;color:#8a8a8e">1 of 2 available</span></div>'] });
    return phone({ title: 'Infrastructure', body, status: { time: '12:03', net: '5G', batt: '80' } });
  }

  function iosMachine() {
    const head = `<div class="ix-head"><span class="ix-tile">${MACHINE}</span><div><div class="ix-hn">HPC</div>
      <div class="ix-hs"><span class="ok">Online</span> · 6 of 8 running</div><div class="ix-hs">workstation-gpu · v0.1.228</div></div></div>`;
    const att = section({ header: 'Needs Attention', id: 'ix-att', rows: [
      `<div class="ix-at"><span class="ix-at-ic bad">${CHIP}</span><div><div class="ix-at-t">Out of memory 4 times in 24 hours</div>
        <div class="ix-at-d">Memory ran out at 16:30, 21:05, 09:15 and 11:42, and the system killed a process each time; the runner itself was down 16:30–16:33. Now 12.1 of 14 GB in use, 22 GB swapped.</div><span class="bb">Lower Max Concurrent</span></div></div>`,
      `<div class="ix-at"><span class="ix-at-ic warn">${DRIVE}</span><div><div class="ix-at-t">Disk 99% full</div>
        <div class="ix-at-d">9.2 GB free of 915 GB, under the 20 GB it keeps free — task runs stop being sent here until space frees up.</div><span class="bb">Set a Reserve…</span></div></div>`,
    ] });
    const res = section({ header: 'Resources', trailing: 'Last 24 hours', id: 'ix-resources', rows: [
      ix.res('CPU', 'Load 27.9 · 24 cores', spark(DAY.cpu, IOS, { warn: 90 }), '97%', 'warn'),
      ix.res('Memory', '12.1 of 14 GB · <span class="bad">▲ 4 kills</span>', spark(DAY.mem, IOS, { warn: 90, marks: DAY.OOM }), '86%', 'bad'),
      ix.res('Disk', '/ · 9.2 GB free', spark(DAY.disk, IOS, { min: 95, max: 100, warn: DAY.KEEP_FREE_PCT }), '99%', 'warn'),
      `<div class="ix-use" id="ix-using">Using It Now<span>6 sessions</span>${ICON.chev}</div>`,
    ], footer: '<p>The whole machine, read by the runner every 5 s.</p>' });
    const cap = section({ header: 'Capacity', id: 'ix-cap', rows: [
      '<div class="ix-kv">Max Concurrent<span class="v">8<span class="ix-step"><span>−</span><span>+</span></span></span></div>',
      '<div class="ix-kv">Keep Free<span class="v ix-pick">20 GB ⌃⌄</span></div>',
    ] });
    return phone({ title: 'HPC', body: head + att + res + cap, status: { time: '12:03', net: '5G', batt: '80' } });
  }

  const W = 329;
  function iosResources() {
    const at = DAY.OOM[3];
    const card = (id, n, v, tone, subs, svg, extra = '') => `<div class="s-gap"></div><div class="s-card" id="${id}"><div class="ix-chart">
      <div class="ix-chart-h"><span class="n">${n}</span><span class="v ${tone}">${v}</span></div>
      <div class="ix-chart-s">${subs}</div>${svg}${axis(W, { color: '#8a8a8e', size: 11 })}${extra}</div></div>`;
    const bubX = 16 + (at / (DAY.N - 1)) * W;
    const body = `<div class="ix-seg"><span>1 Hour</span><span class="on">24 Hours</span><span>7 Days</span></div>`
      + card('ix-c-cpu', 'CPU', '97%', 'warn', 'Load 27.9 · 24 cores', big(DAY.cpu, IOS, W, 84, { warn: 90 }))
      + card('ix-c-mem', 'Memory', '86%', 'bad', '12.1 of 14 GB · <span class="sw"></span>Swap 22 of 43 GB<br><span class="bad">▲ 4 out-of-memory kills</span>',
        big(DAY.mem, IOS, W, 96, { warn: 90, marks: DAY.OOM, second: SWAP('#8a8a8e'), hover: at }),
        `<div class="ix-bub" style="left:${(bubX - 178).toFixed(0)}px;top:104px"><b>Oct 10, 11:42</b><br>Memory <b class="bad">98%</b> · Swap 23 GB<br><span class="bad">▲ 1 process killed</span></div>`)
      + card('ix-c-disk', 'Disk /', '99%', 'warn', '9.2 GB free of 915 GB',
        big(DAY.disk, IOS, W, 70, { min: 95, max: 100, warn: DAY.KEEP_FREE_PCT, limit: { value: DAY.KEEP_FREE_PCT, label: 'Keep Free 20 GB', below: true, size: 11 } }),
        '<span class="ix-scale">95–100%</span>');
    return phone({ title: 'Resources', body, status: { time: '12:03', net: '5G', batt: '80' } });
  }

  function iosResourcesLower() {
    const keep = ((915 - 20) / 915) * 100;
    const disks = section({ header: 'Disks', id: 'ix-disks', rows: [
      `<div class="ix-disk"><div class="ix-disk-t"><span>/</span><b class="warn">99%</b></div><div class="ix-disk-b warn"><i style="width:99%"></i><u style="left:${keep.toFixed(1)}%"></u></div>
        <div class="ix-disk-s">897 of 915 GB · 9.2 GB free</div><div class="ix-disk-s"><b>Worktrees</b> · Repos · Home · Temp · orbit-develop</div></div>`,
      `<div class="ix-disk"><div class="ix-disk-t"><span>/mnt/data</span><b>3%</b></div><div class="ix-disk-b"><i style="width:3%"></i></div>
        <div class="ix-disk-s">326 GB of 15 TB · 14 TB free</div><div class="ix-disk-s">orbit-data</div></div>`,
    ], footer: '<p>Isolated sessions work in Worktrees, whatever disk their workspace is on.</p>' });
    const using = section({ header: 'Using It Now', trailing: '13.5 of 24 cores', id: 'ix-use', rows: SESSIONS.map(([t, m, c, g, muted, nogo]) => `<div class="ix-u${muted ? ' muted' : ''}">
        <div style="min-width:0"><div class="ix-u-t">${t}</div><div class="ix-u-m">${m}</div></div>
        <div class="ix-u-n">${c.toFixed(1)} cores<small>${g.toFixed(1)} GB</small></div>${nogo ? '<span></span>' : ICON.chev}</div>`),
    footer: '<p>A session counts its engine, the commands it runs and its background jobs. Tap one to open it.</p>' });
    const tail = `<div class="s-gap"></div><div class="s-card"><div class="ix-chart" style="padding-bottom:12px">
      ${big(DAY.disk, IOS, W, 70, { min: 95, max: 100, warn: DAY.KEEP_FREE_PCT, limit: { value: DAY.KEEP_FREE_PCT, label: 'Keep Free 20 GB', below: true, size: 11 } })}${axis(W, { color: '#8a8a8e', size: 11 })}</div></div>`;
    return phone({ title: 'Resources', body: tail + disks + using, status: { time: '12:03', net: '5G', batt: '80' } });
  }

  // ── Android ──
  const ANDROID_SB = '<div class="and-sb">12:03<span class="r"><svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.5 15.5 3A11 11 0 0 0 .5 3z" fill="#1b1b1f"/></svg><svg width="13" height="12" viewBox="0 0 13 12"><path d="M12.5.5v11H1z" fill="#1b1b1f"/></svg><svg width="8" height="13" viewBox="0 0 8 13"><rect x=".5" y="1.5" width="7" height="11" rx="1.3" fill="none" stroke="#1b1b1f"/><rect x="2" y="5" width="4" height="6" fill="#1b1b1f"/></svg></span></div>';
  const BACK = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" fill="#1b1b1f"/></svg>';
  const MENU = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18" stroke="#44474e" stroke-width="2"/></svg>';
  const REFRESH = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M17.6 6.4A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4z" fill="#44474e"/></svg>';
  function android({ title, body, actions = true }) {
    return `<div class="and">${ANDROID_SB}<div class="and-bar">${BACK}<span class="t">${title}</span>${actions ? MENU + REFRESH : ''}</div>
      <div class="and-body"><div class="and-scroll">${body}</div></div><div class="and-nav"></div></div>`;
  }
  const am = {
    meters: (list, off) => `<div class="and-meters${off ? ' off' : ''}">${list.map(([k, v, p, t]) => `<div class="and-m"><div class="and-m-t"><span>${k}</span><b class="${t}">${v}</b></div><div class="and-m-b ${t}"><i style="width:${p}%"></i></div></div>`).join('')}</div>`,
    sec: (h, rows, { tr = '', foot = '', id = '' } = {}) => `<div class="and-h">${h}${tr ? `<span class="tr">${tr}</span>` : ''}</div><div class="and-card" ${id ? `id="${id}"` : ''}>${rows.join('')}</div>${foot ? `<div class="and-f">${foot}</div>` : ''}`,
    res: (name, sub, svg, v, tone) => `<div class="and-res"><div style="min-width:0"><div class="and-res-n">${name}</div><div class="and-res-s">${sub}</div></div><div>${svg}</div><div class="and-res-v ${tone}">${v}</div><span class="and-chev">›</span></div>`,
  };

  function androidList() {
    const row = ({ name, slots, slot, off, l2, meters, att, id }) => `<div class="and-row" ${id ? `id="${id}"` : ''}><div class="and-l1"><span class="and-dot${off ? ' off' : ''}"></span><span class="and-name">${name}</span>
      ${off ? '' : `<span class="and-slots">${slots}</span><span class="and-gauge"><i style="width:${slot}%"></i></span>`}<span class="and-chev">⋮</span></div>
      <div class="and-l2">${l2}</div>${meters}${att ? `<div class="and-att">⚠ ${att}</div>` : ''}</div>`;
    const body = am.sec('Runners', [
      row({ id: 'and-hpc', name: 'HPC', slots: '6/8', slot: 75, l2: 'workstation-gpu · v0.1.228', meters: am.meters(HPC_METERS), att: 'Out of memory 4× in 24 h · Disk 99% full' }),
      row({ name: 'Mac Studio', slots: '1/4', slot: 25, l2: 'mac-studio.local · v0.1.228', meters: am.meters(MAC_METERS) }),
      row({ name: 'ThinkPad', off: true, l2: 'Offline · last seen 19h ago · v0.1.226', meters: am.meters(TP_METERS, true) }),
    ]) + am.sec('', ['<div class="and-row" style="color:#0066be;font-size:16px;font-weight:600">Add Runner</div>'],
      { foot: 'Run one command on the new machine — it installs Orbit, then asks you to confirm it’s yours.' });
    return android({ title: 'Runners', body, actions: false });
  }

  function androidRunner() {
    const head = `<div class="and-head"><span class="and-tile">▣</span><div><div class="and-hn">HPC</div>
      <div class="and-hs"><span class="ok">Online</span> · 6 of 8 running</div><div class="and-hs">workstation-gpu · v0.1.228</div></div></div>`;
    const att = am.sec('Needs Attention', [
      `<div class="and-at"><span class="and-at-ic bad">!</span><div><div class="and-at-t">Out of memory 4 times in 24 hours</div>
        <div class="and-at-d">Memory ran out at 16:30, 21:05, 09:15 and 11:42, and the system killed a process each time; the runner itself was down 16:30–16:33. Now 12.1 of 14 GB in use, 22 GB swapped.</div><span class="and-btn">Lower Max Concurrent</span></div></div>`,
      `<div class="and-at"><span class="and-at-ic warn">!</span><div><div class="and-at-t">Disk 99% full</div>
        <div class="and-at-d">9.2 GB free of 915 GB, under the 20 GB it keeps free — task runs stop being sent here until space frees up.</div></div></div>`,
    ]);
    const res = am.sec('Resources', [
      am.res('CPU', 'Load 27.9 · 24 cores', spark(DAY.cpu, AND, { warn: 90 }), '97%', 'warn'),
      am.res('Memory', '12.1 of 14 GB · <span class="bad">▲ 4 kills</span>', spark(DAY.mem, AND, { warn: 90, marks: DAY.OOM }), '86%', 'bad'),
      am.res('Disk', '/ · 9.2 GB free', spark(DAY.disk, AND, { min: 95, max: 100, warn: DAY.KEEP_FREE_PCT }), '99%', 'warn'),
      '<div class="and-row" style="display:flex;font-size:17px">Using It Now<span style="margin-left:auto;color:#5d5f66;margin-right:10px">6 sessions</span><span class="and-chev">›</span></div>',
    ], { tr: 'Last 24 hours', foot: 'The whole machine, read by the runner every 5 s.', id: 'and-resources' });
    const cap = am.sec('Capacity', ['<div class="and-kv">Max Concurrent<span class="v">8<span class="pm">−</span><span class="pm">+</span></span></div>',
      '<div class="and-kv">Keep Free<span class="v">20 GB</span></div>']);
    return android({ title: 'HPC', body: head + att + res + cap });
  }

  function androidResources() {
    const AW = 332;
    const c = (n, v, tone, subs, svg) => `<div class="and-chart"><div class="and-chart-h"><span class="n">${n}</span><span class="v ${tone}">${v}</span></div>
      <div class="and-chart-s">${subs}</div>${svg}${axis(AW, { color: '#5d5f66', size: 11 })}</div>`;
    const charts = `<div style="height:12px"></div><div class="and-card" id="and-charts">${[
      c('CPU', '97%', 'warn', 'Load 27.9 · 24 cores', big(DAY.cpu, AND, AW, 70, { warn: 90 })),
      c('Memory', '86%', 'bad', '12.1 of 14 GB · Swap 22 of 43 GB · <span class="bad">▲ 4 kills</span>', big(DAY.mem, AND, AW, 80, { warn: 90, marks: DAY.OOM, second: SWAP('#5d5f66') })),
      c('Disk /', '99%', 'warn', '9.2 GB free of 915 GB · 95–100%', big(DAY.disk, AND, AW, 60, { min: 95, max: 100, warn: DAY.KEEP_FREE_PCT, limit: { value: DAY.KEEP_FREE_PCT, label: 'Keep Free 20 GB', below: true, size: 11 } })),
    ].join('<div style="height:1px;background:#d5d6db;margin:0 20px"></div>')}</div>`;
    const using = am.sec('Using It Now', SESSIONS.slice(0, 4).concat([SESSIONS[5]]).map(([t, m, cpu, g, muted]) => `<div class="and-u"><div style="min-width:0"><div class="and-u-t"${muted ? ' style="color:#5d5f66"' : ''}>${t}</div><div class="and-u-m">${m}</div></div>
      <div class="and-u-n">${cpu.toFixed(1)} cores<small>${g.toFixed(1)} GB</small></div></div>`), { tr: '13.5 of 24 cores', id: 'and-use' });
    const body = '<div class="and-segs"><span>1h</span><span class="on">✓ 24h</span><span>7d</span></div>' + charts + using;
    return android({ title: 'Resources', body, actions: false });
  }

  window.RSX.phones = { iosInfrastructure, iosMachine, iosResources, iosResourcesLower, androidList, androidRunner, androidResources };
})();
