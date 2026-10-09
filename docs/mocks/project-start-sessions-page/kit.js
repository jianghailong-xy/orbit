// 2026-10-06 · 未启动的项目：项目 sessions 页的启动行 · 图板共用部件。每块都返回 HTML 字符串。
// 数据取自截图里的真实项目「Runners 与 Providers 合并为 Infrastructure」：5 个任务、5 条判据、
// startedAt 为空、协调者还没发启动请求，项目并发上限 3，没配 merge check。
const IC = {
  chevl: '<path d="M15 5l-7 7 7 7"/>', chevr: '<path d="M9 5l7 7-7 7"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.7"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.7"/>',
  updown: '<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>',
};
const ic = (n, s = 14, c = 'currentColor', w = 2) =>
  `<svg class="i" viewBox="0 0 24 24" style="width:${s}px;height:${s}px;color:${c};stroke-width:${w}">${IC[n]}</svg>`;
const badge = (n) => `<span class="badge">${n}</span>`;
const mk = (html, n, style = '') => `<div class="mk" style="${style}">${html}${n ? badge(n) : ''}</div>`;
const spinner = (c = 'var(--l2)', s = 14) => `<svg class="i" viewBox="0 0 24 24" style="width:${s}px;height:${s}px;color:${c};stroke-width:2.4"><circle cx="12" cy="12" r="9" stroke-opacity=".22"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>`;

// ── 外壳 ──────────────────────────────────────────────────
const statusBar = (t, batt = 25) => `<div class="status"><span>${t}</span><span class="r"><span class="bars"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:11px"></i></span>
<svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 11.6l2.3-2.7a3.4 3.4 0 0 0-4.6 0zM3.6 6.6a7.2 7.2 0 0 1 9.8 0l1.6-1.8a9.6 9.6 0 0 0-13 0zM.4 3.1a11.6 11.6 0 0 1 16.2 0" fill="#000"/></svg><span class="batt">${batt}</span></span></div>`;
const phone = (inner) => `<div class="phone">${inner}</div>`;
const PROJECT = 'Runners 与 Providers 合并为 Infrastructure';
const nav = (sessions) => `<div class="nav"><div class="circ">${ic('chevl', 21, '#000', 2.4)}</div>
<div class="ttl"><b>${PROJECT}</b><span>Project · ${sessions} sessions</span></div><div class="circ">${ic('grid', 23, '#000', 1.8)}</div></div>`;

// ── 进度卡与启动行 ────────────────────────────────────────
const meter = (done, run, total) => `<span class="meter"><i style="width:${done / total * 100}%;background:var(--green)"></i><i style="width:${run / total * 100}%;background:var(--tint)"></i></span>`;
const progLine = (text, { done = 0, run = 0, total = 5 } = {}) => `<div class="prog">${meter(done, run, total)}<span class="pmeta">${text}</span></div>`;
const pcard = (inner, start = '') => `<div class="pcard${start ? ' has-start' : ''}">${inner}${start}</div>`;
// 协调者已请求：谁在等、建议怎么跑、实心按钮。
const SUGGESTED = 'Project branch · Automatic on · 2 at a time';
const askLine = (ago = '2m ago') => `<div class="ask"><span class="d on"></span><b>Ready to start</b><span class="ago">asked ${ago}</span></div><div class="sug">${SUGGESTED}</div>`;
const startAsked = () => `<div class="start">${askLine()}<div class="go pri">Review and start</div></div>`;
// 还没请求：灰点一句话、浅蓝按钮。
const ownLine = () => `<div class="ask"><span class="d off"></span><span class="q">The coordinator hasn’t asked yet</span></div>`;
const startOwn = () => `<div class="start">${ownLine()}<div class="go tin">Start…</div></div>`;

// ── 列表 ──────────────────────────────────────────────────
const sh = (t) => `<div class="sh">${t}</div>`;
const COORD_SUB = 'The plan is now in Orbit: project Runners 与 Providers 合并为 Infrastructure with five tasks.';
const coordRow = ({ tm = '15h ago', sub = COORD_SUB, amb = false, dot = false } = {}) => `<div class="r"><div class="a"><span class="t">${PROJECT}</span>${dot ? '<span class="dot"></span>' : ''}<span class="tm">${tm}</span></div>
<div class="b"><span class="chip">Coordinator</span><span class="ltag o">项目架构</span><span class="ltag y">交互设计</span><span class="sub ${amb ? 'amb' : ''}">${sub}</span></div></div>`;
const sessRow = ({ t, tm, sub, run }) => `<div class="r"><div class="a"><span class="t">${t}</span>${run ? spinner() : ''}<span class="tm">${tm}</span></div>
<div class="b"><span class="sub">${sub}</span></div></div>`;

// ── 起始卡 sheet：现有的 StartProjectCard，协调者没请求时按默认规则填 ──────────
const CRITERIA = [
  'Web 侧边栏只有一个 Infrastructure 入口；该页包含需要处理、引擎概览、Machines、API keys、Account pools 五部分，原 Runners 页与 Providers 页能做的操作都能在新页或其子页完成。',
  '旧地址 /runners、/providers、/providers?runner=&lt;id&gt;&amp;engine=&lt;engine&gt; 都落到 Infrastructure 页，带 runner/engine 参数时对应机器卡片展开并定位到该引擎。',
  'web 源码中不再有页面主动导航到 /providers?runner=，也不再有提示用户「去 Providers 页」的文案；机器详情页可直接登录引擎，无需跳页。',
  'iOS 设置里「Machines &amp; models」组只有一行 Infrastructure；macOS 侧边栏的 Runners 改为 Infrastructure；两端该页包含需要处理、引擎概览、机器、账号池、API key。',
  '旧组件 ProvidersPage、RunnersPage、RunnerEnginesSection 已删除，没有残留引用。',
];
// planOrderLine 对这 5 个任务的输出，用的是这次修好的编号规则：标题以「P1 」开头，认作编号 P1。
const ORDER = 'P1 starts now · P2, P3 after P1 · P4 after P1 and P3 · P5 after P2, P3 and P4';
const startSheet = () => `<div class="dimbg"></div><div class="sheet"><div class="grab"></div>
<div class="sn"><span class="cx">Cancel</span>Start this project?</div>
<div class="sb">
<div class="meta">${PROJECT} · seal 9d2c41b07e3a</div>
<div class="shd">Done when · 5 criteria</div>
${CRITERIA.map((t, i) => `<div class="crit"><i>${i + 1}</i><p>${t}</p></div>`).join('')}
<div class="lnk">Read all 5 in full</div>
<div class="shd">Plan · 5 tasks</div>
<div class="panel2"><div class="pr"><div class="s" style="font-size:14px;margin:0">${ORDER}</div><div class="lnk" style="margin-top:6px">View tasks ›</div></div></div>
<div class="shd">How it runs</div>
<div class="panel2"><div class="pr"><div class="h">Tasks land on<span class="v">A project branch ${ic('updown', 13, 'var(--tint)', 2.2)}</span></div><div class="mono">project/34aithLozDanSv6nq0IAi</div></div></div>
</div>
<div class="bar"><div class="cap pri">Start the project</div></div></div>`;

// ── 图注 ──────────────────────────────────────────────────
const fig = (tag, label, ph, cap) => `<figure><span class="tag ${tag}">${label}</span>${ph}<figcaption>${cap}</figcaption></figure>`;
const n = (k) => `<span class="num">${k}</span>`;
