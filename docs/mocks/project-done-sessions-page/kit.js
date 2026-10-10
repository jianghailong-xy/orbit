// 2026-10-10 · 项目结束卡画进项目 sessions 页 · 图板共用部件。每块都返回 HTML 字符串。
// 页面数据取自所有者截图里的那个项目（Session Recap 会话摘要，10 个会话，已被平台记为 DONE）。
const IC = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevr: '<path d="M9 5l7 7-7 7"/>', chevl: '<path d="M15 5l-7 7 7 7"/>',
  ham: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6"/>' +
        '<rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6"/>',
  merge: '<path d="M8 7l4-4 4 4"/><path d="M12 3v8"/><path d="M12 11c0 3.5-5 4.5-5 9.5"/><path d="M12 11c0 3.5 5 4.5 5 9.5"/>',
  dots: '<circle cx="12" cy="12" r="9.5"/><circle cx="7.6" cy="12" r=".9" fill="currentColor"/>' +
        '<circle cx="12" cy="12" r=".9" fill="currentColor"/><circle cx="16.4" cy="12" r=".9" fill="currentColor"/>',
};
const ic = (n, s = 14, c = 'currentColor', w = 2) =>
  `<svg class="i" viewBox="0 0 24 24" style="width:${s}px;height:${s}px;color:${c};stroke-width:${w}">${IC[n]}</svg>`;
// checkmark.circle.fill：绿色实心圆 + 白勾
const checkFill = (s = 16, c = 'var(--green)') => `<svg viewBox="0 0 24 24" style="width:${s}px;height:${s}px;display:block">
<circle cx="12" cy="12" r="10" fill="${c}"/><path d="M7.3 12.5l3.1 3.1 6.3-6.5" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const badge = (n) => `<span class="badge">${n}</span>`;
const mkRow = (html, n) => mk(html, n, 'border-radius:12px;margin:0 -7px;padding:0 7px');
const mk = (html, n, style = '') => `<div class="mk" style="${style}">${html}${n ? badge(n) : ''}</div>`;

// ── 外壳 ──────────────────────────────────────────────────
const statusBar = (t, batt = 72) => `<div class="status"><span>${t}</span><span class="r"><span class="bars"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:11px"></i></span>
<svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 11.6l2.3-2.7a3.4 3.4 0 0 0-4.6 0zM3.6 6.6a7.2 7.2 0 0 1 9.8 0l1.6-1.8a9.6 9.6 0 0 0-13 0zM.4 3.1a11.6 11.6 0 0 1 16.2 0" fill="#000"/></svg><span class="batt">${batt}</span></span></div>`;
const phone = (inner, cls = '') => `<div class="phone ${cls}">${inner}</div>`;
const PROJECT = 'Session Recap 会话摘要';
const navProjectPushed = (sessions) => `<div class="nav"><div class="circ">${ic('chevl', 21, '#000', 2.4)}</div>
<div class="ttl"><b>${PROJECT}</b><span>Project · ${sessions} sessions</span></div><div class="circ">${ic('grid', 19, '#000', 1.9)}</div></div>`;

// ── 项目 sessions 页 ──────────────────────────────────────
const sh = (t) => `<div class="sh">${t}</div>`;
// 现在这一页顶部那张灰卡：只有状态的“Done”
const statusCard = (word = 'Done') => `<div class="pcard"><div class="prog"><span class="pmeta">${word}</span></div></div>`;

const TALLY = '6 criteria · 5 on main · 1 no code to land';
// 结束卡（approvalChrome .green；和协调会话里那张一字不差）
const doneCard = ({ by = 'recorded by Orbit', tally = TALLY, style = '' } = {}) => `<div class="dcard" style="${style}">
<div class="dh"><span class="tileg">${checkFill(16)}</span><b>This project is done</b><span class="prov">${by}</span></div>
<div class="tl">${tally}</div></div>`;
// 方案 C：并进灰卡里的同一张卡
const doneRowIn = ({ by = 'recorded by Orbit', tally = TALLY } = {}) => `<div class="drow">
<div class="dh"><span class="tileg">${checkFill(16)}</span><b>This project is done</b><span class="prov">${by}</span></div>
<div class="tl">${tally}</div></div>`;

const sessRow = ({ t, tm, sub, chip, tags, run, amb }) => `
<div class="r"><div class="a"><span class="t">${t}</span>${chip ? `<span class="chip">${chip}</span>` : ''}<span class="tm">${tm}</span></div>
<div class="b">${(tags ?? []).map(([w, c]) => `<span class="${c}">${w}</span>`).join('')}<span class="sub ${amb ? 'amb' : ''}">${sub}</span></div></div>`;
const mergedRow = ({ tm, sha, tasks, who }) => `<div class="ms"><span class="mi">${ic('merge', 16, 'var(--green-ink)', 2.2)}</span>
<div class="mb"><div class="a"><b>Merged into main</b><span class="tm">${tm}</span></div><div class="bb"><span class="sha">${sha}</span> · ${tasks} ${tasks === 1 ? 'task' : 'tasks'} · ${who}</div></div></div>`;

// 这个项目的真实行（截图里的那些）：协调者 + Today
const coordRow = () => sessRow({ t: PROJECT, tm: 'just now', chip: 'Coordinator', tags: [['功能扩展', 'tagg'], ['项目架构', 'taga']],
  sub: '项目已被平台记为 DONE，6 条判据里 5 条已经落到 main 上。' });
const todayRows = () => [
  mergedRow({ tm: '1m ago', sha: '46e28aa', tasks: 1, who: 'by you' }),
  sessRow({ t: '判断：Session Recap 会话摘要', tm: '1h ago', sub: '判断完成。结论与动作如下。逐条核对（以 git 为准）…' }),
  sessRow({ t: '执行任务：Phase 2：macOS / iOS / Android 三端推进', tm: '1h ago', sub: 'Task complete. Final summary: 交付内容 服务端 —— …' }),
  mergedRow({ tm: '2h ago', sha: 'd23062a', tasks: 5, who: 'automatically' }),
  sessRow({ t: '执行任务：Phase 2：settle 推送通知…', tm: '2h ago', sub: "That's a duplicate wake for the apiserver suite I alr…" }),
  sessRow({ t: '执行任务：端到端验收：settle → 生成证据…', tm: '3h ago', sub: '任务已判定完成。最终结果 证据提交：revision 1（7…' }),
].join('');

// 三个方案：A 替换灰卡 · B 灰卡下面加一张 · C 并进灰卡里
const pageNow = () => phone(`${statusBar('8:23')}${navProjectPushed(10)}
<div class="list">${mk(statusCard(), 1)}${sh('Coordinator')}${mkRow(coordRow(), 2)}${sh('Today')}${todayRows()}</div>`);
const pageA = ({ by = 'recorded by Orbit', tally = TALLY } = {}) => phone(`${statusBar('8:23')}${navProjectPushed(10)}
<div class="list">${mk(doneCard({ by, tally }), 1)}${sh('Coordinator')}${coordRow()}${sh('Today')}${todayRows()}</div>`);
const pageB = () => phone(`${statusBar('8:23')}${navProjectPushed(10)}
<div class="list">${statusCard()}${mk(doneCard({ style: 'margin-top:10px' }), 1)}${sh('Coordinator')}${coordRow()}${sh('Today')}${todayRows()}</div>`);
const pageC = () => phone(`${statusBar('8:23')}${navProjectPushed(10)}
<div class="list">${mk(`<div class="pcard"><div class="prog"><span class="pmeta">Done</span></div>${doneRowIn()}</div>`, 1)}${sh('Coordinator')}${coordRow()}${sh('Today')}${todayRows()}</div>`);

// ── 图注 ──────────────────────────────────────────────────
const fig = (tag, label, ph, cap) => `<figure><span class="tag ${tag}">${label}</span>${ph}<figcaption>${cap}</figcaption></figure>`;
const n = (k) => `<span class="num">${k}</span>`;
