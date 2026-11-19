// 2026-11-10 · 项目 DONE 由谁确认 · 图板部件。依赖 ../project-done-sessions-page/kit.js（phone、statusBar、doneCard…）。
const bellIc = '<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:#fff"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0z"/></svg>';
const pushBanner = (title, body, when = 'now') => `<div class="push"><span class="app">${bellIc}</span>
<div class="pc"><div class="pt">${title}<span>${when}</span></div><div class="pb">${body}</div></div></div>`;

// "Is this project done?" 卡（approvalChrome .orange，和项目页上现在那张同一个骨架）
const askCard = ({ meta, call, checked, gaps, warn, buttons, note }) => `<div class="ac q">
<div class="h"><span class="tile">${ic('check', 18, 'var(--orange)', 2.6)}</span><b>Is this project done?</b></div>
<div class="prov">${meta}</div>
${call ? `<div class="lbl">Coordinator’s call</div><div class="val">${call}</div>` : ''}
<div class="lbl">Orbit checked</div><div class="val sm2">${checked}</div>
${gaps ? `<div class="lbl">What Orbit can’t prove</div>${gaps}` : ''}
${warn ? `<div class="warnbox">${warn}</div>` : ''}
${note ? `<div class="expl">${note}</div>` : ''}
<div class="btns">${buttons.map(([w, k]) => `<span class="btn2 ${k}">${w}</span>`).join('')}</div></div>`;

const receiptCard = ({ by, tally, line, reopen = true }) => `<div class="dcard">
<div class="dh"><span class="tileg">${checkFill(16)}</span><b>This project is done</b><span class="prov">${by}</span></div>
<div class="tl">${tally}</div>${line ? `<div class="tl2">${line}</div>` : ''}
${reopen ? `<div class="rlink">Reopen project</div>` : ''}</div>`;

const infoRow = (html, tone = '') => `<div class="info ${tone}">${html}</div>`;

// 工作区会话列表里的项目行
const listRow = ({ t, badge, sub, tm }) => `<div class="r"><div class="a"><span class="t">${t}</span>${badge ? `<span class="rtc">${badge}</span>` : ''}<span class="tm">${tm}</span></div>
<div class="b"><span class="sub">${sub}</span></div></div>`;
const listPage = (rows) => phone(`${statusBar('9:41')}<div class="nav"><div class="circ">${ic('ham', 20, '#000', 2.2)}</div></div>
<div class="big">Sessions</div><div class="list">${sh('Projects')}${rows}</div>`);

const projPage = (top, { coordSub } = {}) => phone(`${statusBar('9:41')}${navProjectPushed(10)}
<div class="list">${top}${sh('Coordinator')}${sessRow({ t: PROJECT, tm: 'just now', chip: 'Coordinator', tags: [['功能扩展', 'tagg']], sub: coordSub ?? '6 条判据都已满足并落到 main。' })}${sh('Today')}${todayRows()}</div>`);
