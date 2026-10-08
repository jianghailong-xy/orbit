// 2026-10-08 · 落地会话 v3 · 图板部件（自含）。第 1 段抄自 project-merge-sessions-page/kit.js（10-06），
// 第 2 段抄自 landing-session/v2/landing.js（10-07），第 3 段起是 v3 新增。每块都返回 HTML 字符串。

// ── 1 · project-merge-sessions-page/kit.js ──
const IC = {
  merge: '<path d="M8 7l4-4 4 4"/><path d="M12 3v8"/><path d="M12 11c0 3.5-5 4.5-5 9.5"/><path d="M12 11c0 3.5 5 4.5 5 9.5"/>',
  ring: '<path d="M20 11a8 8 0 0 0-14.3-4.9"/><path d="M5.5 2.8v3.5H9"/><path d="M4 13a8 8 0 0 0 14.3 4.9"/><path d="M18.5 21.2v-3.5H15"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  chevr: '<path d="M9 5l7 7-7 7"/>', chevl: '<path d="M15 5l-7 7 7 7"/>',
  ham: '<path d="M4 7h16M4 12h16M4 17h16"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="12" cy="12" r="9.5"/><circle cx="7.6" cy="12" r=".9" fill="currentColor"/><circle cx="12" cy="12" r=".9" fill="currentColor"/><circle cx="16.4" cy="12" r=".9" fill="currentColor"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
  spin: '<path d="M12 3a9 9 0 1 0 9 9" />', orbit: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-25 12 12)"/>',
};
const ic = (n, s = 14, c = 'currentColor', w = 2) =>
  `<svg class="i" viewBox="0 0 24 24" style="width:${s}px;height:${s}px;color:${c};stroke-width:${w}">${IC[n]}</svg>`;
const chev = (c = 'var(--l3)', s = 13) => ic('chevr', s, c, 2.6);
const badge = (n) => `<span class="badge">${n}</span>`;
const mkRow = (html, n) => mk(html, n, 'border-radius:10px;margin:0 -6px;padding:0 6px');
const mk = (html, n, style = '') => `<div class="mk" style="${style}">${html}${n ? badge(n) : ''}</div>`;

// ── 外壳 ──────────────────────────────────────────────────
const statusBar = (t, batt = 72) => `<div class="status"><span>${t}</span><span class="r"><span class="bars"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:11px"></i></span>
<svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 11.6l2.3-2.7a3.4 3.4 0 0 0-4.6 0zM3.6 6.6a7.2 7.2 0 0 1 9.8 0l1.6-1.8a9.6 9.6 0 0 0-13 0zM.4 3.1a11.6 11.6 0 0 1 16.2 0" fill="#000"/></svg><span class="batt">${batt}</span></span></div>`;
const phone = (inner, cls = '') => `<div class="phone ${cls}">${inner}</div>`;
const PROJECT = 'DeepSeek Harness 原生接入（核心首版）';
const navProject = (sessions) => `<div class="nav"><div class="circ">${ic('ham', 21, '#000', 2.1)}</div>
<div class="ttl"><b>${PROJECT}</b><span>Project · ${sessions} sessions</span></div><div class="circ">${ic('dots', 25, '#000', 1.7)}</div></div>`;
const navChat = (sub) => `<div class="nav cnav"><div class="circ">${ic('chevl', 21, '#000', 2.4)}</div>
<div class="ttl"><div class="tl"><b>${PROJECT}</b><span class="cb">Coordinator</span></div><span>${sub}</span></div><div class="circ">${ic('dots', 25, '#000', 1.7)}</div></div>`;

// ── 项目 sessions 页 ──────────────────────────────────────
const progCard = (done, total, run) => `<div class="pcard"><div class="prog"><span class="meter"><i style="width:${done / total * 100}%;background:var(--green)"></i><i style="width:${run / total * 100}%;background:var(--tint)"></i></span><span class="pmeta">${done}/${total} done · ${run} running</span><span class="proj">Project ${ic('chevr', 12, 'var(--tint)', 2.8)}</span></div></div>`;
const sh = (t) => `<div class="sh">${t}</div>`;
const spinner = (c = 'var(--l2)', s = 14) => `<svg class="i" viewBox="0 0 24 24" style="width:${s}px;height:${s}px;color:${c};stroke-width:2.4"><circle cx="12" cy="12" r="9" stroke-opacity=".22"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>`;
const sessRow = ({ t, tm, sub, run, amb, chip, dot, eye }) => `<div class="r"><div class="a"><span class="t">${t}</span>${dot ? '<span class="dot"></span>' : ''}${eye ? ic('eye', 19, '#6b6b70', 1.6) : ''}${run ? spinner() : ''}<span class="tm">${tm}</span></div>
<div class="b">${chip ? `<span class="chip">${chip}</span>` : ''}<span class="sub ${amb ? 'amb' : ''}">${sub}</span></div></div>`;
const coordRow = (o) => sessRow({ t: PROJECT, tm: o.tm || 'just now', chip: 'Coordinator', ...o });
const mergedRow = ({ tm, sha = '8d5a868', tasks = 2, who = 'by you' }) => `<div class="ms"><span class="mi">${ic('merge', 16, 'var(--green-ink)', 2.2)}</span>
<div class="mb"><div class="a"><b>Merged into main</b><span class="tm">${tm}</span></div><div class="bb"><span class="sha">${sha}</span> · ${tasks} tasks · ${who}</div></div></div>`;

// 这一轮合入的候选（真实数据：8d5a868 合入 main 的两项任务）
const TASKS = ['修复 D1：runner 声明 dsh 能力，打通 Harness 会话的创建→领取→运行', 'dsh 会话日志随模型请求上传 DeepSeek：查清内容并尽量默认关闭'];
const BRANCH = 'project/34ZurCP3bv9yLXGVyUGnx';
const CHECK = 'npm run build && npm test -w @orbit/shared && npm test -w @orbit/apiserver && npm test -w @orbit/web && (cd src/runner-go && go test ./...)';

// 合入卡的四种在途状态
const cardChecking = ({ elapsed = '7m 12s', usual = '~18m' } = {}) => `<div class="mc chk"><div class="mh">${ic('ring', 15, 'var(--tint)', 2.3)}<b>Merge check</b><span class="s">checking</span>${chev()}</div>
<div class="ref">project/34Zur…UGnx + main · 2 tasks</div>
<div class="ln"><span>Elapsed <b>${elapsed}</b> · usually ${usual}</span><span class="u">Updated just now</span></div>
<div class="note">Asks you when it passes.</div></div>`;
const cardAsk = ({ asked = '2m' } = {}) => `<div class="mc ask"><div class="mh"><span class="tile">${ic('merge', 17, 'var(--orange)', 2.3)}</span><b>Merge into main?</b><span class="nb">Needs you</span></div>
<div class="ref">project/34Zur…UGnx · 5 commits ahead of main</div>
<div class="hr"></div>
<div class="f1"><b>2 tasks</b> · 10 files</div>
<ul class="tk">${TASKS.map((t) => `<li>${t}</li>`).join('')}</ul>
<div class="ok">${ic('check', 14, 'var(--green-ink)', 2.8)}Checks passed · no conflicts</div>
<div class="cr">8 of 10 met on this branch — merging does not close the project</div>
<div class="acts"><span class="btn pri grow">Merge to main</span><span class="btn sec">Not now</span></div>
<div class="foot"><span>asked ${asked} ago</span><span class="lnk">Details ${ic('chevr', 11, 'var(--tint)', 2.8)}</span></div></div>`;
/* 头部与 asking 同一套：有色方块 + 静态合入图标，不是转圈（owner 10-07 决定；这张卡只有一个动的
   标记，就是下面落地行里的那个环）。改法见 05-spinner-options.html。 */
const cardMerging = () => `<div class="mc run"><div class="mh"><span class="tile" style="background:rgba(62,105,246,.16);color:var(--tint)">${ic('merge', 17, 'var(--tint)', 2.3)}</span><b>Re-checking before merging…</b><span class="clk">3m 50s</span></div>
<div class="st">main moved 2 commits since the check — re-checking the combined tree</div>
<div class="bud"><i style="width:21%"></i><u style="left:30%"></u></div>
<div class="ln"><span>Merge check <b>3m 50s</b> of 60m</span><span class="u">usually ~18m</span></div>
<div class="note">Nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t.</div>
<div class="foot" style="margin-top:10px"><span>Confirmed by you · 11:34</span><span class="btn sec sm" style="margin-left:auto">Cancel</span></div></div>`;
const cardBlocked = () => `<div class="mc blk"><div class="mh">${ic('warn', 17, 'var(--orange)', 2.1)}<b>Can’t merge into main yet</b>${chev('var(--l3)')}</div>
<div class="st"><b style="color:var(--red-ink);font-weight:650">2 files conflict</b> with main after syncing:</div>
<div class="files">src/runner-go/session_pool.go<br>src/apiserver/prisma/schema.prisma</div>
<div class="press">${spinner('rgba(60,60,67,.6)', 15)}Coordinator is resolving it · 4m</div>
<div class="foot"><span>Goes to you if untouched for 2h</span><span class="lnk">Open coordinator ${ic('chevr', 11, 'var(--tint)', 2.8)}</span></div></div>`;

// ── 各时刻的会话行（真实任务名；时间按画面时刻推算） ─────────
const ROWS = {
  '11:20': [
    { t: '执行任务：P6：验收端到端行为、故障语义与旧版本兼容', tm: 'just now', run: true, sub: '正在跑端到端回归：12 个场景已过 7 个…' },
    { t: '执行任务：dsh 会话日志随模型请求上传 DeepSeek：查清内容并尽量默认关闭', tm: '8m ago', sub: '已完成：会话日志默认不再随模型请求上传，证据已提交。' },
    { t: '执行任务：修复 D1：runner 声明 dsh 能力，打通 Harness 会话的创建→领取→运行', tm: '30m ago', sub: 'D1 已完成并提交（bc89fd5），随后合入了最新 main。' },
    { t: '执行任务：修复 D2/F1：真实 401 识别为无效 Key；dsh 缺失用量不发送 0', tm: '1h ago', sub: 'D2/F1 已完成：401 判为无效 Key，未知用量显示为不可用。' },
    { t: '执行任务：P5：接通 Web、macOS 和 iOS 的 DeepSeek Harness 操作链', tm: '1h ago', sub: 'Ended' },
  ],
  '11:33': [
    { t: '执行任务：P6：验收端到端行为、故障语义与旧版本兼容', tm: 'just now', run: true, sub: '正在跑端到端回归：12 个场景已过 9 个…' },
    { t: '执行任务：dsh 会话日志随模型请求上传 DeepSeek：查清内容并尽量默认关闭', tm: '21m ago', sub: '已完成：会话日志默认不再随模型请求上传，证据已提交。' },
    { t: '执行任务：修复 D1：runner 声明 dsh 能力，打通 Harness 会话的创建→领取→运行', tm: '43m ago', sub: 'D1 已完成并提交（bc89fd5），随后合入了最新 main。' },
    { t: '执行任务：修复 D2/F1：真实 401 识别为无效 Key；dsh 缺失用量不发送 0', tm: '1h ago', sub: 'D2/F1 已完成：401 判为无效 Key，未知用量显示为不可用。' },
    { t: '执行任务：P5：接通 Web、macOS 和 iOS 的 DeepSeek Harness 操作链', tm: '2h ago', sub: 'Ended' },
  ],
  '11:38': [
    { t: '执行任务：P6：验收端到端行为、故障语义与旧版本兼容', tm: 'just now', run: true, sub: '正在跑端到端回归：12 个场景已过 10 个…' },
    { t: '执行任务：dsh 会话日志随模型请求上传 DeepSeek：查清内容并尽量默认关闭', tm: '26m ago', sub: '已完成：会话日志默认不再随模型请求上传，证据已提交。' },
    { t: '执行任务：修复 D1：runner 声明 dsh 能力，打通 Harness 会话的创建→领取→运行', tm: '48m ago', sub: 'D1 已完成并提交（bc89fd5），随后合入了最新 main。' },
    { t: '执行任务：修复 D2/F1：真实 401 识别为无效 Key；dsh 缺失用量不发送 0', tm: '1h ago', sub: 'D2/F1 已完成：401 判为无效 Key，未知用量显示为不可用。' },
    { t: '执行任务：P5：接通 Web、macOS 和 iOS 的 DeepSeek Harness 操作链', tm: '2h ago', sub: 'Ended' },
  ],
  '12:01': [
    { t: '执行任务：dsh：runner 只在已安装固定版本时才声明 provider:dsh，或在派发前拒绝', tm: 'just now', run: true, sub: '正在核对未装固定版本时的能力声明…' },
    { t: '执行任务：修复 D3：DeepSeek Harness 会话上的 EXECUTABLE 验收命令无法执行', tm: '4m ago', run: true, sub: 'D3 已定位：验收命令在 dsh 会话里拿不到 shell 环境…' },
    { t: '执行任务：P6：验收端到端行为、故障语义与旧版本兼容', tm: '16m ago', sub: 'P6 证据已提交：12 个场景、旧 runner 隔离和续聊均有记录。' },
    'MERGED',
    { t: '执行任务：dsh 会话日志随模型请求上传 DeepSeek：查清内容并尽量默认关闭', tm: '49m ago', sub: '已完成：会话日志默认不再随模型请求上传，证据已提交。' },
    { t: '执行任务：修复 D1：runner 声明 dsh 能力，打通 Harness 会话的创建→领取→运行', tm: '1h ago', sub: 'D1 已完成并提交（bc89fd5），随后合入了最新 main。' },
    { t: '执行任务：修复 D2/F1：真实 401 识别为无效 Key；dsh 缺失用量不发送 0', tm: '1h ago', sub: 'D2/F1 已完成：401 判为无效 Key，未知用量显示为不可用。' },
  ],
};
const todayRows = (at, merged = (h) => h) => ROWS[at].map((r) => (r === 'MERGED' ? merged(mergedRow({ tm: '19m ago' })) : sessRow(r))).join('');

// 项目 sessions 页：进度卡 + （合入卡）+ Coordinator + Today
const projectPage = ({ at, sessions, done, run, card = '', coord, merged }) => phone(`${statusBar(at)}${navProject(sessions)}
<div class="list">${progCard(done, 20, run)}${card}${sh('Coordinator')}${coord}${sh('Today')}${todayRows(at, merged)}</div>`);

// ── 协调会话 ───────────────────────────────────────────────
const abub = (h) => `<div class="abub">${h}</div>`;
const ubub = (h) => `<div class="ubub">${h}</div>`;
const stamp = (t) => `<div class="stamp">${t}</div>`;
const composer = () => `<div class="composer">Message the coordinator…</div>`;
const sysLine = (inner, cls = '') => `<div class="sys ${cls}">${inner}</div>`;
const chatPage = ({ at, sub = 'Watching · Open · now', body, extra = '' }) => phone(`${statusBar(at)}${navChat(sub)}${extra}<div class="tx">${body}</div>${composer()}`);

// 现在的两张卡（approvalChrome .orange，与 iOS 现状一致）
const oldAskCard = () => `<div class="ac"><div class="h"><span class="tile">${ic('merge', 18, 'var(--orange)', 2.3)}</span><b style="color:#000">Merge to main</b><span class="nb">Needs you</span></div>
<div class="sm m" style="margin-top:8px">${BRANCH}</div><div class="sm">5 commits · 2 tasks</div>
<div class="sm g">✓ Checks passed · no conflicts</div><div class="sm m" style="font-size:12.5px">8 of 10 met on this branch — merging does not close the project</div>
<div class="div"></div><div class="cta">View details &amp; act ${ic('chevr', 13, 'var(--tint)', 2.6)}</div></div>`;
const oldReceiptCard = () => `<div class="ac"><div class="h"><span class="tile">${ic('merge', 18, 'var(--orange)', 2.3)}</span><b>✓ Merged into main</b></div>
<div class="prov">FROM ORBIT</div><div class="lbl">Commit</div><div class="val">8d5a868 · merge of project/ 34ZurCP3bv9yLXGVyUGnx · by you · 19m</div>
<div class="lbl">Now on main</div><div class="val">2 landed on the branch</div></div>`;

// ── sheet ─────────────────────────────────────────────────
const kv = (k, v, cls = '') => `<div class="kvr"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
const sheet = ({ title, body, bar = '' }) => `<div class="dimbg"></div><div class="sheet"><div class="grab"></div>
<div class="sn">${title}<span class="x">${ic('x', 15, 'rgba(60,60,67,.75)', 2.6)}</span></div><div class="sb">${body}</div>${bar ? `<div class="bar">${bar}</div>` : ''}</div>`;

// ── 图注 ──────────────────────────────────────────────────
const fig = (tag, label, ph, cap) => `<figure><span class="tag ${tag}">${label}</span>${ph}<figcaption>${cap}</figcaption></figure>`;
const n = (k) => `<span class="num">${k}</span>`;

// ── 2 · landing-session/v2/landing.js ──
Object.assign(IC, {
  term: '<path d="M4 6l6 6-6 6M12 18h8"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bubble: '<path d="M4 5h16v11H9l-5 4z"/>', grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/>', person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>', arrowr: '<path d="M5 12h14M13 6l6 6-6 6"/>', dashc: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
  task: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>', play: '<path d="M7 5l12 7-12 7z"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.4 2.4-2.6-.6-.6-2.6z"/>',
});
const kchip = (t = 'Landing') => `<span class="kchip">${ic('ring', 10, '#5b4bd6', 2.6)}${t}</span>`;
const navLanding = (title, sub) => `<div class="nav"><div class="circ">${ic('chevl', 21, '#000', 2.4)}</div>
<div class="ttl"><div class="tl" style="display:flex;align-items:center;justify-content:center;gap:6px"><b style="max-width:200px">${title}</b>${kchip()}</div><span>${sub}</span></div><div class="circ">${ic('dots', 25, '#000', 1.7)}</div></div>`;
const ev = (tm, gl, tx, cls = '') => `<div class="ev ${cls}"><span class="tm2">${tm}</span><span class="gl">${gl}</span><span class="tx2">${tx}</span></div>`;
const OK = ic('check', 15, 'var(--green-ink)', 2.6), X = ic('x', 15, 'var(--red-ink)', 2.6), UP = ic('up', 15, '#8e8e93', 2),
      RING = ic('ring', 15, 'var(--tint)', 2.2), STOP = ic('stop', 14, 'var(--amber-ink)', 2), ARR = ic('arrowr', 15, '#7a5af5', 2);
const rnd = (t, ink) => `<div class="rnd"${ink ? ' style="color:var(--tint)"' : ''}>${t}</div>`;
const lfoot = (h) => `<div class="lfoot">${h}</div>`;
const FOOT = lfoot('Orbit runs this landing — <b>nothing to type here.</b><br>Decisions: coordinator (Automatic on) · <a>Open ›</a>');
const tlw = (top, inner, bottom = 84) => `<div class="tlw" style="top:${top}px;bottom:${bottom}px"><div class="tl">${inner}</div></div>`;
const toolBlock = (title, state, clock, term, color = 'var(--tint)') => `<div class="tool"><div class="th">${ic('term', 14, color, 2)}<b>${title}</b><span class="mut">· ${state}</span><span class="r3">${clock}</span></div>${term}</div>`;
// 进度卡（带落地行）
const progWithLanding = (done, total, run, line) => `<div class="pcard"><div class="prog"><span class="meter"><i style="width:${done / total * 100}%;background:var(--green)"></i><i style="width:${run / total * 100}%;background:var(--tint)"></i></span><span class="pmeta">${done}/${total} done · ${run} running</span><span class="proj">Project ${ic('chevr', 12, 'var(--tint)', 2.8)}</span></div>${line}</div>`;
const landingLine = ({ word = 'Landing', state = 'checking', what, step, usual, bar = 0, tick = 0, live, grey, extra = '' }) => `<div class="lline ${grey ? 'grey' : ''}">
<div class="a">${grey ? ic('dashc', 14, '#8e8e93', 2) : ic('ring', 14, 'var(--tint)', 2.3)}<b class="${grey ? '' : 'ink'}">${word}</b><span class="s ${grey ? '' : 'ink'}">${state}</span>${chev()}</div>
${what ? `<div class="w">${what}</div>` : ''}
${step ? `<div class="ln">${step}${usual ? `<span class="u">${usual}</span>` : ''}</div><div class="bud ${grey ? 'grey' : ''}"><i style="width:${bar}%"></i>${tick ? `<u style="left:${tick}%"></u>` : ''}</div>` : ''}
<div class="ln"><span class="live ${grey ? 'off' : ''}"></span>${live}</div>${extra}</div>`;
const lrow = ({ t, tm, sub, cls = 'mut', icon }) => `<div class="lrow"><div class="a"><span class="t">${t}</span>${icon || ''}<span class="tm">${tm}</span></div><div class="b">${kchip()}<span class="sub ${cls}">${sub}</span></div></div>`;

// ── 3 · v3 新增（iOS） ─────────────────────────────────────────────────────
Object.assign(IC, {
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.7"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.7"/>',
  ext: '<path d="M9 5h10v10"/><path d="M19 5L6 18"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
});
// iOS 的 exclamationmark.triangle.fill：超时的落地行、合入卡 D 的头
const triFill = (s = 14, c = 'var(--amber-ink)') => `<svg class="i" viewBox="0 0 24 24" style="width:${s}px;height:${s}px"><path d="M12 2.8 22.6 21H1.4z" fill="${c}" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9.3v5.4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.9" r="1.35" fill="#fff" stroke="none"/></svg>`;
const PROP = '<span class="prop">方案</span>';
const TBD = '<span class="tbd-i">待定</span>';
const RUNNER = 'workstation-gpu';
const D3 = '修复 D3：DeepSeek Harness 会话上的 EXECUTABLE 验收命令无法执行';
const D2 = '修复 D2/F1：真实 401 识别为无效 Key；dsh 缺失用量不发送 0';
const DSH = 'dsh：runner 只在已安装固定版本时才声明 provider:dsh';
const D1 = '修复 D1：runner 声明 dsh 能力，打通 Harness 会话的创建→领取→运行';

// 项目 sessions 页的页头：返回、标题、右边是 main 的网格按钮（Open Project），不是 ⋯
const navP = (sessions = 32, title = PROJECT) => `<div class="nav"><div class="circ">${ic('chevl', 21, '#000', 2.4)}</div>
<div class="ttl"><b>${title}</b><span>Project · ${sessions} sessions</span></div><div class="circ">${ic('grid', 22, '#000', 1.7)}</div></div>`;

// main 的落地行。tone：idle（灰环，排队）| run（蓝环，在跑）| warn（琥珀三角，超时）| grey（读不到服务端）
// v6：改后的读法——当前步骤对比预算（step/clock/budget），进度条，活性一行（live），次要一行（sub）
const lr = ({ tone = 'idle', word, state, what, label, clock, right = '', chevron = true, extra = '',
  v6 = null }) => {
  const glyph = tone === 'warn' ? triFill(14) : ic('ring', 14, tone === 'run' ? 'var(--tint)' : 'var(--l2)', 2.3);
  let meta = '';
  if (v6) {
    meta = `<div class="l3"><span>${v6.step}</span><b>${v6.clock}</b>${v6.budget ? `<span>/ ${v6.budget}</span>` : ''}<span class="u">${v6.usual || ''}</span></div>`
      + (v6.bar != null ? `<div class="bud${tone === 'run' ? '' : ' grey'}"><i style="width:${v6.bar}%"></i>${v6.tick ? `<u style="left:${v6.tick}%"></u>` : ''}</div>` : '')
      + (v6.live ? `<div class="lv"><span class="live${v6.off ? ' off' : ''}"></span>${v6.live}</div>` : '')
      + (v6.sub ? `<div class="lv" style="color:var(--l3)">${v6.sub}</div>` : '');
  } else if (label != null) {
    meta = `<div class="l3"><span>${label}</span><b>${clock}</b><span class="u">${right}</span></div>`;
  }
  return `<div class="lr ${tone}"><div class="lb"><div class="l1">${glyph}<b>${word}</b><span class="st">${state}</span></div>
${what ? `<div class="w">${what}</div>` : ''}${meta}${extra}</div>
${chevron === true ? chev('var(--l3)', 13) : chevron === 'gap' ? '<span class="nochev"></span>' : ''}</div>`;
};
const mki = (html, n, style = '') => `<div class="mk in" style="${style}">${html}${n ? badge(n) : ''}</div>`;
const xline = (t, cls = '') => `<div class="x ${cls}">${t}</div>`;
const retryBtn = (cls = 'bord') => `<span class="btn ${cls}">Retry</span>`;
const openL = (t = 'Open landing') => `<span class="open">${t} ${ic('chevr', 11, 'var(--tint)', 2.8)}</span>`;
const openOff = (why) => `<span class="open off">${why}</span>`;

// 进度卡（main：进度线；有落地时下面一条细线和落地行；没有 Project › 链接）
const pc3 = ({ done, total, run, failed = 0, landing = '', start = '' }) => `<div class="pcard3"><div class="prog"><span class="meter"><i style="width:${done / total * 100}%;background:var(--green)"></i><i style="width:${run / total * 100}%;background:var(--tint)"></i>${failed ? `<i style="width:${failed / total * 100}%;background:var(--red)"></i>` : ''}</span><span class="pmeta">${done}/${total} done · ${run} running</span></div>${start}${landing ? `<div class="pdiv"></div>${landing}` : ''}</div>`;

// iOS 的作业清单（ProjectLandingJobsSheet）：标题居中，右边圆形 ✕；每个作业一行，行就是落地行
const jsheet = ({ title, rows, top = 300 }) => `<div class="dimbg"></div><div class="jsheet" style="top:${top}px"><div class="grab"></div>
<div class="sn">${title}<span class="x"><i>${ic('x', 13, 'rgba(60,60,67,.62)', 2.8)}</i></span></div><div class="jl">${rows.join('<div class="jdiv"></div>')}</div></div>`;
const jrow = (lrHtml, under = '') => `<div class="jr">${lrHtml}${under ? `<div class="under">${under}</div>` : ''}</div>`;

// 合入卡（main 的四种形态 + v3 的 Watch）
const watchRow = (left = '') => `<div class="watchrow"><span>${left}</span><span class="lnk">Watch ${ic('chevr', 11, 'var(--tint)', 2.8)}</span></div>`;
const mcCheck = (lrHtml, watch = '') => `<div class="mc chk" style="padding:4px 2px 6px">${lrHtml}${watch ? `<div style="padding:0 12px 4px">${watch}</div>` : ''}</div>`;
const mcMerging = ({ title, status, lrHtml = '', note = PAGE_NOTE, cancel = true, cancelOff = false, extra = '', watch = false, left = '', cls = 'run' }) => `<div class="mc ${cls}"><div class="mh"><span class="tile blue">${ic('merge', 16, 'var(--tint)', 2.3)}</span><b>${title}</b></div>
<div class="s1">${status}</div>${lrHtml ? `<div class="lrin">${lrHtml}</div>` : ''}${extra}
${note ? `<div class="note">${note}</div>` : ''}
<div class="foot" style="margin-top:9px">${watch ? `<span class="lnk">Watch ${ic('chevr', 11, 'var(--tint)', 2.8)}</span>` : `<span>${left}</span>`}${cancel ? `<span class="btn sec sm" style="margin-left:auto${cancelOff ? ';opacity:.4' : ''}">Cancel</span>` : ''}</div></div>`;
const PAGE_NOTE = 'Nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t.';
const mcBlocked = ({ status, extra = '', press = 'Coordinator is resolving it · 2m', foot = '' }) => `<div class="mc blk"><div class="mh"><span class="tile" style="background:rgba(255,149,0,.16)">${triFill(15, 'var(--orange)')}</span><b>Can’t merge into main yet</b></div>
<div class="st">${status}</div>${extra}
<div class="press">${spinner('rgba(60,60,67,.6)', 15)}${press}</div>
<div class="foot" style="justify-content:flex-end">${foot || `<span class="lnk">Open Coordinator ${ic('chevr', 11, 'var(--tint)', 2.8)}</span>`}</div></div>`;

// Landings 组：只列待决定的、最近结案的（24 小时内）；更早的折成一行
const lgroup = (rows, fold) => `${sh('Landings')}${rows.join('')}${fold ? `<div class="fold">${ic('check', 14, 'var(--green-ink)', 2.6)}${fold}<span class="chev">${chev()}</span></div>` : ''}`;

// 图板：一行一组，带一条组名
const band = (tag, cls, text) => `<div class="band"><span class="tag ${cls}">${tag}</span>${text}</div>`;
