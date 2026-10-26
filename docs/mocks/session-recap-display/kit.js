// 2026-10-21 · Recap 展示优化 · 图板部件（自含）。坐标都是 pt（= CSS px），按 owner 6:15 的 Pro Max 截图量。

// ── 图形（24×24 描边，近似 SF Symbols）──────────────────
const P = {
  chevl: '<path d="M15 4.5L7.5 12l7.5 7.5"/>',
  chevr: '<path d="M9 5l7 7-7 7"/>',
  ham: '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/>',
  filter: '<path d="M3.5 6.5h17M6.5 12h11M9.5 17.5h5"/>',
  pen: '<path d="M11 4.5H7a3 3 0 0 0-3 3v9.5a3 3 0 0 0 3 3h9.5a3 3 0 0 0 3-3V13"/><path d="M18.2 3.4a1.9 1.9 0 0 1 2.7 2.7l-8.4 8.4-3.6.9.9-3.6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 18.5V6M6.5 11.5L12 6l5.5 5.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5"/><path d="M19.6 3.6v4.4h-4.4"/>',
  align: '<path d="M4 6h16M4 10.5h11M4 15h16M4 19.5h9"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.2 1.2"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.2-1.2"/>',
  pencil: '<path d="M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5z"/><path d="M14 7l3 3"/>',
  pin: '<path d="M9 3.5h6M10 3.5v5.5l-3 3.5h10l-3-3.5V3.5M12 12.5v8"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  tag: '<path d="M3.5 12.4V4.5a1 1 0 0 1 1-1h7.9l8.1 8.1a1.4 1.4 0 0 1 0 2l-6.9 6.9a1.4 1.4 0 0 1-2 0z"/><circle cx="8" cy="8" r="1.3"/>',
  out: '<path d="M8 16L16.5 7.5M9.5 7.5h7v7"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.2l2.5 2.5 5-5"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13"/>',
  term: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/>',
};
const ic = (name, size = 16, color = 'currentColor', sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:none">${P[name]}</svg>`;
const dots = (c = 'var(--l1)') => `<svg width="22" height="22" viewBox="0 0 24 24" style="display:block"><circle cx="5" cy="12" r="2" fill="${c}"/><circle cx="12" cy="12" r="2" fill="${c}"/><circle cx="19" cy="12" r="2" fill="${c}"/></svg>`;
const bed = `<svg width="25" height="17" viewBox="0 0 24 17" style="display:block"><path fill="currentColor" d="M1.5 15.5V2.5h2.2v7.3h7.6V4.6h7.2a4 4 0 0 1 4 4v6.9h-2.2v-2.3H3.7v2.3z"/><circle cx="7.2" cy="6.8" r="2.3" fill="currentColor"/></svg>`;
const wifi = `<svg width="19" height="14" viewBox="0 0 19 14" style="display:block"><path fill="currentColor" d="M9.5 2.2c2.9 0 5.6 1.1 7.6 3l1.4-1.5A13 13 0 0 0 9.5.2 13 13 0 0 0 .5 3.7l1.4 1.5a11 11 0 0 1 7.6-3zm0 4c1.8 0 3.5.7 4.8 1.9l1.4-1.5A9 9 0 0 0 9.5 4.2a9 9 0 0 0-6.2 2.4l1.4 1.5a7 7 0 0 1 4.8-1.9zm0 4c.8 0 1.5.3 2 .8L9.5 13l-2-2c.5-.5 1.2-.8 2-.8z"/></svg>`;
const bars = `<div class="bars"><i style="height:4.5px"></i><i style="height:7px"></i><i style="height:9.5px"></i><i class="off" style="height:12px"></i></div>`;

// ── 手机 ─────────────────────────────────────────────────
const statusBar = (time = '6:15', batt = 40) => `<div class="status"><div class="tm">${time}${bed}</div><div class="rt">${bars}${wifi}<div class="batt" style="background:linear-gradient(to right, var(--l1) ${batt}%, rgba(142,142,147,.75) ${batt}%)">${batt}</div></div></div>`;
// window: { h, off } → 只画手机 y ∈ [off, off+h] 这一段
const phone = (mode, body, { h = 956, off = 0, cls = '' } = {}) =>
  `<div class="ph ${mode} ${cls}" style="height:${h}px"><div style="position:absolute;left:0;right:0;top:${-off}px;height:956px">${body}</div></div>`;
const mk = (x, y, w, h, cls = '') => `<div class="mk ${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`;
const num = (n, x, y, cls = '') => `<div class="num ${cls}" style="left:${x}px;top:${y}px">${n}</div>`;

// ── 标签（量出来 / 照 TagChipColor 算出来的颜色）───────────────
const HEX = { red: '#FF3B30', orange: '#FF9500', yellow: '#FFCC00', green: '#34C759', blue: '#007AFF', purple: '#AF52DE', gray: '#8E8E93' };
const RGB = { red: '255,59,48', orange: '255,149,0', yellow: '255,204,0', green: '52,199,89', blue: '0,122,255', purple: '175,82,222', gray: '142,142,147' };
const LABEL = {
  dark: { red: 'rgb(255,98,89)', orange: 'rgb(255,149,0)', yellow: 'rgb(255,204,0)', green: 'rgb(52,199,89)', blue: 'rgb(61,154,255)', purple: 'rgb(194,124,230)', gray: 'rgb(158,158,162)' },
  light: { red: 'rgb(199,46,37)', orange: 'rgb(163,95,0)', yellow: 'rgb(138,110,0)', green: 'rgb(33,127,57)', blue: 'rgb(0,102,214)', purple: 'rgb(150,71,191)', gray: 'rgb(108,108,112)' },
};
const TAG = { 硬件诊断: 'blue', 性能问题: 'purple', 功能扩展: 'green', 交互设计: 'yellow', 功能咨询: 'purple', 会话调试: 'red',
  功能缺陷: 'blue', 行业调研: 'orange', 产品分析: 'yellow', 前端问题: 'orange' };
const chip = (mode, name) => {
  const c = TAG[name];
  return `<span class="chip" style="background:rgba(${RGB[c]},${mode === 'dark' ? .22 : .13});color:${LABEL[mode][c]}">${name}</span>`;
};
const chips = (mode, tags) => tags.map((t) => chip(mode, t)).join('');
const tagDots = (tags) => `<span class="tdots">${tags.map((t) => `<i style="background:${HEX[TAG[t]]}"></i>`).join('')}</span>`;
const pchip = (done, total) => `<span class="pchip"><span class="bar"><i style="width:${Math.round(100 * done / total)}%"></i></span><span class="cnt">${done}/${total}</span></span>`;
const dchip = () => '<span class="dchip">Done</span>';

// ── 真实数据（owner 10-21 6:15 截图的那一屏，2–7 days ago）───────────
// 标题、标签、时间、recap 的时间和开头都照截图；recap 的后半句按各会话最后一条回复补写（示意）。
const RECAP = {
  disk: '已删10个旧模型仓库，释放258G，剩余319G；保留的3个模型和vLLM服务复核正常，下一步清164个worktree。',
  watch: 'Main CI only shows two old reds; both tasks landed, the board awaits a merge.',
  wikijump: 'main CI 的两项红在合并前就有；项目行跨 workspace 的改动已合入，iPad 验收标准等你确认。',
  plan: 'Codex Plan 模式改用 never 策略加只读沙箱，读命令能跑、不再误报 rejected by user；Default 模式待你定。',
  research: '调研其他可接入的 Coding Agent，四路并行查用量、订阅额度和无头接口，正在汇总结论。',
  researchNew: '调研结论：先接 GitHub Copilot CLI，第二档 Droid、CodeBuddy、Qoder；待你定是否建实测任务和公共 ACP 层。',
  avatar: 'Deploy 7e237cb47 is live with Admin photos; a slow session list needs your call.',
  reopen: '已独立复现重开会话时逐条回放很慢；修复在任务分支待合入 main，等你定是否建任务、是否 session_merge。',
};
const LIST = [
  { kind: 'proj', title: 'macOS 签名与公证接入', rel: '1d ago', meter: [18, 22], line: 'E1 的 macOS 手动步骤已转给你，先别点，等签名证书就位后我再发 Merge；其余 17 项已完成。' },
  { kind: 'proj', title: 'Wiki 服务端执行与 System model', rel: '1d ago', done: true, line: 'Watching any 1 of 12 tasks · 12/12 done' },
  { kind: 'proj', title: 'Cursor CLI 原生接入（ACP 引擎 + 多账号 + 额度）', rel: '1d ago', meter: [31, 34], line: 'P8 真 CLI 复核通过：撤回审批卡显示 Not run 已修；剩 3 项等 macOS runner 恢复后补跑。' },
  { title: '磁盘空间不足排查', rel: '1d ago', fail: true, tags: ['硬件诊断', '性能问题'], label: 'Recap · Mon, Oct 19, 7:31 PM', recap: RECAP.disk },
  { title: 'Watching 会话合并入 Tasks 停车条设计', rel: '3d ago', tags: ['功能扩展', '交互设计'], label: 'Recap · Sat, Oct 17, 4:05 PM', recap: RECAP.watch },
  { title: 'Wiki 服务端跳转 Workspace 预期确认', rel: '3d ago', tags: ['交互设计', '功能咨询'], label: 'Recap · Sat, Oct 17, 1:56 PM', recap: RECAP.wikijump },
  { title: 'Plan 模式工具调用误报拒绝', rel: '3d ago', tags: ['会话调试', '功能缺陷'], label: 'Recap · Sat, Oct 17, 1:52 PM', recap: RECAP.plan },
  { title: '调研其他可接入的 Coding Agent', rel: '3d ago', tags: ['行业调研', '产品分析'], label: 'Recap · Sat, Oct 17, 1:20 PM', recap: RECAP.research },
  { title: '头像显示问题排查', rel: '3d ago', tags: ['前端问题', '功能缺陷'], label: 'Recap · Sat, Oct 17, 1:32 PM', recap: RECAP.avatar },
  { title: 'Session 首次与再次打开的加载逻辑', rel: '3d ago', tags: ['会话调试', '性能问题'], label: 'Recap · Sat, Oct 17, 1:20 PM', recap: RECAP.reopen },
  { kind: 'proj', title: 'Orbit Android 客户端：Kotlin + Compose 原生', rel: '3d ago', meter: [46, 56], line: 'A05f 证据核对中，生产 FCM 实为空需服务账号密钥，等你放 key 后补发推送证据。' },
  { title: '会话列表滑动操作对齐', rel: '4d ago', tags: ['交互设计', '前端问题'], label: 'Recap · Fri, Oct 16, 9:12 PM', recap: 'Swipe 的完成 / 置顶 / 移动和 web 菜单对齐；iOS、Android 都已合入，等下个版本发出去。' },
];

// ── 列表行：今天 / A / B / C ─────────────────────────────────
const lead = (mode, r) => r.kind === 'proj' ? (r.done ? dchip() : pchip(...r.meter)) : (r.tags ? chips(mode, r.tags) : '');
const t1 = (r, { dotsAfterTitle = false } = {}) =>
  `<div class="t1"><b>${r.title}</b>${dotsAfterTitle && r.tags ? tagDots(r.tags) : ''}<span class="sp"></span>${r.spin ? '<span class="spinner"></span>' : ''}${r.needs ? '<span class="ndot"></span>' : ''}${r.fail ? '<span class="fd"></span>' : ''}${r.rel ? `<span class="rel">${r.rel}</span>` : ''}</div>`;
// 今天：标签领头，然后「Recap · 时间」灰标签 + recap，一行尾截
const rowToday = (mode, r) => {
  const text = r.kind === 'proj' ? `<span class="rt">${r.line}</span>`
    : r.now ? `${r.now}` : `<span class="lb">${r.label} </span><span class="rt">${r.recap}</span>`;
  return `${t1(r)}<div class="t2"><span class="chips">${lead(mode, r)}</span><span class="pv${r.tone ? ' ' + r.tone : ''}">${text}</span></div>`;
};
// B：一行，去掉标签（Recap · 时间）
const rowB = (mode, r) => {
  const text = r.kind === 'proj' ? r.line : (r.now || r.recap);
  return `${t1(r)}<div class="t2"><span class="chips">${lead(mode, r)}</span><span class="pv${r.tone ? ' ' + r.tone : ''}"><span class="rt">${text}</span></span></div>`;
};
// A：两行块，标签内联领头、字绕到第二行；在做事的行：第一行说现在，第二行接 recap
const rowA = (mode, r) => {
  if (r.now) {
    return `${t1(r)}<div class="blk solo"><span class="now ${r.tone || ''}"><span class="ic">${lead(mode, r)}</span>${r.now}</span>${r.recap ? `<span class="rc1"><span class="rt">${r.recap}</span></span>` : ''}</div>`;
  }
  const text = r.kind === 'proj' ? r.line : r.recap;
  return `${t1(r)}<div class="blk"><span class="ic">${lead(mode, r)}</span><span class="rt">${text}</span></div>`;
};
// C：两行块，标签缩成标题后的色点；项目行的进度块留着（那是状态，不是归档）
const rowC = (mode, r) => {
  if (r.now) {
    return `${t1(r, { dotsAfterTitle: true })}<div class="blk solo"><span class="now ${r.tone || ''}">${r.now}</span>${r.recap ? `<span class="rc1"><span class="rt">${r.recap}</span></span>` : ''}</div>`;
  }
  const text = r.kind === 'proj' ? r.line : r.recap;
  const pre = r.kind === 'proj' ? `<span class="ic">${lead(mode, r)}</span>` : '';
  return `${t1(r, { dotsAfterTitle: true })}<div class="blk">${pre}<span class="rt">${text}</span></div>`;
};
// 定稿（owner 10-22）：一行；标签胶囊和「Recap · 时间」都不要，整行给那一句。项目行的进度块 / Done 不是标签，留着。
const rowD = (mode, r) => {
  const text = r.kind === 'proj' ? r.line : (r.now || r.recap);
  const pre = r.kind === 'proj' ? `<span class="chips">${lead(mode, r)}</span>` : '';
  return `${t1(r)}<div class="t2">${pre}<span class="pv${r.tone ? ' ' + r.tone : ''}"><span class="rt">${text}</span></span></div>`;
};
const ROW = { today: rowToday, A: rowA, B: rowB, C: rowC, D: rowD };
const PITCH = { today: 75.333, A: 95.333, B: 75.333, C: 95.333, D: 75.333 };

// 列表页：顶部（状态栏 + 导航 + 「2–7 days ago」吸顶头）+ 行。first = 第一条（被吸顶头压住的那条）分隔线以上的 y
const listTop = (mode, title = 'orbit-develop') => `${statusBar()}
<div class="nav"><div class="gc l">${ic('ham', 23, 'var(--l1)', 2)}</div><div class="navtitle">${title}</div>
<div class="gc" style="right:21px;width:105px;justify-content:flex-start"><span style="position:absolute;left:12px;top:10px">${ic('filter', 24, 'var(--l1)', 2)}</span><span style="position:absolute;right:10px;top:10px">${ic('pen', 24, 'var(--l1)', 2)}</span></div></div>
<div class="lhead"><div class="inset"></div><div class="sec">2–7 days ago</div><div class="hl"></div></div>`;
const listRows = (mode, variant, rows, firstSep) => {
  const pitch = PITCH[variant];
  let html = '';
  rows.forEach((r, i) => {
    const top = firstSep - pitch + i * pitch; // 这条的上沿（上一条分隔线）
    html += `<div class="lr" data-i="${i}"${r.kind === 'proj' ? '' : ' data-s="1"'} style="top:${top + 17.6}px">${ROW[variant](mode, r)}</div>`;
    html += `<div class="sep" style="top:${top + pitch - 0.5}px"></div>`;
  });
  return html;
};
const listPhone = (mode, variant, { rows = LIST, firstSep = 197, extra = '', h = 956, cls = '' } = {}) =>
  phone(mode, `${listTop(mode)}${listRows(mode, variant, rows, firstSep)}${extra}`, { h, cls });

// ── 会话页 ───────────────────────────────────────────────
const sessionNav = ({ centre = '' } = {}) => `${statusBar()}<div class="nav"><div class="gc l">${ic('chevl', 22, 'var(--l1)', 2.6)}</div>${centre}<div class="gc r">${dots()}</div></div>`;
const edge = (mode, solidTo = 108, fadeTo = 128) => {
  const c = mode === 'dark' ? '0,0,0' : '255,255,255';
  return `<div class="edge" style="height:${fadeTo}px;background:linear-gradient(to bottom, rgba(${c},1) 0, rgba(${c},1) ${solidTo}px, rgba(${c},0) ${fadeTo}px)"></div>`;
};
// 「调研其他可接入的 Coding Agent」最后一条回复的尾巴（原文）
const RESEARCH_TAIL = `
<h4>接入方式</h4>
<ul>
<li><b>建议先抽一个公共 ACP 层。</b>现在 3 个 ACP 引擎各写了一套 JSON-RPC 客户端：<code>kimi_acp.go</code> 2309 行、<code>cursor_acp.go</code> 1359 行、<code>dsh_acp.go</code> 980 行，彼此不共用代码。Cursor 项目一个引擎就是 24 个任务、12 条验收标准。ACP 官方注册表现有 42 个 agent，上面推荐的五个都支持 ACP。</li>
<li><b>之后每接一个 agent，只需写一份配置：</b>安装和版本固定、凭据环境变量、权限模式映射、错误文本识别，额度读取可选。</li>
<li><b>每个 agent 仍要先实测。</b>比如 Cursor 的协议实测就发现它的 plan 和 ask 模式其实不是只读，这类问题公共层兜不住。</li>
<li><b>ACP v2 草案要预留兼容。</b>草案里 prompt 的返回只表示收到、不再表示这一轮结束，去掉了会话模式，还新增了远程传输。</li>
</ul>
<p>另外有个趋势值得注意：agent 厂商正在做自托管控制面，往 Orbit 的位置走。比如 Cursor Cloud Agents 能跑在客户自己的机器池上，Anthropic Managed Agents 支持自托管沙箱，Amp 的 runner 和 OpenHands Agent Canvas 也在做类似的事。</p>
<p>关键几条我核对过原始页面：Copilot 的 ACP 文档、Gemini CLI 的迁移公告、ACP 注册表、Stack Overflow 调查、Droid 的协议文档。其余数据来自 4 路调研读到的官方文档、npm 和 GitHub API，截至今天。要点已记进记忆，以后的会话可以直接接着用。</p>
<p class="last"><b>下一步：</b>要不要我照 Cursor 的做法，先给 Copilot CLI 建一个协议实测任务？公共 ACP 层要不要先出设计，也请你定。建任务之前我会先说明要建什么。</p>`;
// 转录贴底：bottom = 离手机底多少
const transcript = (html, bottom) => `<div class="tx" style="bottom:${bottom}px">${html}</div>`;
const COMP_TOP = 836;
const composer = ({ running = false } = {}) => `<div class="comp" style="top:${COMP_TOP}px"><div class="ph1">Message…</div><div class="bt">${ic('plus', 22, 'var(--l2)', 2)}<span class="auto">Auto</span><span class="mdl">Opus 5.5</span><span class="eff">Max</span>${running ? '<span class="stopb"><i></i></span>' : `<span class="send">${ic('up', 17, 'rgba(0,0,0,.75)', 2.6)}</span>`}</div></div><div class="home"></div>`;
// 方案 A 的卡：头一行 = 今天行上那个 label（recapLabel，原词）+ 右边刷新；正文 = recap 全文
const recapCard = (o) => `<div class="rcard${o.busy ? ' busy' : ''}" style="${o.top != null ? `top:${o.top}px;` : ''}${o.bottom != null ? `bottom:${o.bottom}px;` : ''}${o.style || ''}">
<div class="hd">${ic('align', 15, 'var(--l2)', 2.1)}<span class="w">Recap</span><span>· ${o.when}</span><span class="rf">${o.busy ? '<span class="spinner" style="width:15px;height:15px"></span>' : ic('refresh', 17, 'var(--l2)', 2.1)}</span></div>
<div class="bd">${o.text}</div></div>`;

// ── 数字：每一屏能读到多少 recap 字 ───────────────────────────
// 逐字取版面矩形：落在行框里、最后一行不压省略号的才算「看得见」。只数 .rt 里的字（recap / 项目行的那句）。
function visibleChars(el) {
  const rt = el.querySelector('.rt');
  if (!rt) return null;
  const clip = rt.closest('.blk, .pv, .rc1');
  const node = rt.firstChild;
  const of = node.textContent.length;
  // 没被截断：整句都看得见
  const cut = clip.classList.contains('blk') ? clip.scrollHeight > clip.clientHeight + 6 : clip.scrollWidth > clip.clientWidth + 1;
  if (!cut) return { n: of, of };
  const box = clip.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(clip).lineHeight) || 20;
  const range = document.createRange();
  let n = 0;
  for (let i = 0; i < of; i++) {
    range.setStart(node, i); range.setEnd(node, i + 1);
    const r = range.getClientRects()[0];
    if (!r) continue;
    const lastLine = r.bottom > box.bottom - lh + 1;
    if (r.top >= box.top - 3 && r.bottom <= box.bottom + 3 && r.right <= box.right - (lastLine ? 14 : 0) + .5) n++;
  }
  return { n, of };
}
// 一部手机里、露在屏上的行（不含被吸顶头压住的、出了屏底的）；recap 只数会话行
function phoneStats(ph) {
  const phBox = ph.getBoundingClientRect();
  const per = [];
  let rows = 0;
  ph.querySelectorAll('.lr').forEach((lr) => {
    const b = lr.getBoundingClientRect();
    if (b.top < phBox.top + 156 || b.bottom > phBox.bottom) return;
    rows++;
    if (lr.dataset.s) {
      const v = visibleChars(lr);
      if (v) per.push(v);
    }
  });
  const pct = per.length ? Math.round(100 * per.reduce((a, v) => a + v.n / v.of, 0) / per.length) : 0;
  const full = per.filter((v) => v.n >= v.of).length;
  return { rows, pct, full, recaps: per.length };
}
