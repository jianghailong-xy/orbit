// 2026-11-10 · AGENT_PUSH（交付方式）· 图板部件。依赖 ../project-done-sessions-page/kit.js（phone、statusBar、mk、fig…）。
// 场景：MAIN 线项目，main = feature/v1.1.1，Automatic 开，交付方式还是默认的 PLATFORM（Orbit lands it）。
const MAIN = 'feature/v1.1.1';
const PRJ = 'v1.1.1 release';
const TASK_BRANCH = 'orbit/fix-export-3f2a1c';

const navPrj = () => `<div class="nav"><div class="circ">${ic('chevl', 21, '#000', 2.4)}</div>
<div class="ttl"><b>${PRJ}</b><span>Project · 7 sessions</span></div><div class="circ">${ic('grid', 19, '#000', 1.9)}</div></div>`;

// 合并卡：和 OwnerItemCards.swift 的 title/branchLine/checksLine/upstreamLine 同一骨架
const mergeCard = ({ why } = {}) => `<div class="ac m">
<div class="h"><span class="tile">${ic('merge', 17, 'var(--orange)', 2.3)}</span><b>Merge ${TASK_BRANCH} into ${MAIN}?</b></div>
<div class="prov">${PRJ} · 1 task</div>
<div class="lbl">Branch</div><div class="val"><code>${TASK_BRANCH}</code> · 2 commits ahead of ${MAIN}</div>
<div class="lbl">Checks</div><div class="val g">✓ Passed on the combined tree · <code>npm test</code> · 4m 10s</div>
<div class="lbl">${MAIN}</div><div class="val">no conflicts</div>
${why ?? ''}
<div class="btns"><span class="btn2 p">Merge</span><span class="btn2 s">Not now</span></div></div>`;

const prjPage = (top) => phone(`${statusBar('9:41')}${navPrj()}
<div class="list">${top}${sh('Coordinator')}${sessRow({ t: PRJ, tm: '2m ago', chip: 'Coordinator', sub: 'Fix export 已完成，合并检查通过，等你确认合入 main。' })}
${sh('Today')}${sessRow({ t: '执行任务：Fix export', tm: '6m ago', sub: 'Task complete. 2 commits on orbit/fix-export-3f2a1c…' })}
${sessRow({ t: '执行任务：Login copy', tm: '40m ago', sub: 'Waiting for Fix export to land on feature/v1.1.1.' })}</div>`);

// How it runs sheet。rows: [{lab, v, hint, tick, dis, sw, cmd, off, chg, n}]
const cell = (c) => (c.n ? (h) => mk(h, c.n) : (h) => h)(`<div class="cell ${c.dis ? 'dis' : ''} ${c.chg ? 'chg' : ''}">
<div class="lab">${c.lab}${c.v ? `<span class="v">${c.v}</span>` : ''}${c.tick ? '<span class="tick">✓</span>' : ''}${c.sw ? '<span class="sw"></span>' : ''}</div>
${c.cmd ? `<div class="cmd ${c.off ? 'off' : ''}"><code>${c.cmd}</code></div>` : ''}
${c.hint ? `<div class="hint">${c.hint}</div>` : ''}</div>`);
const group = (head, cells, foot) => `${head ? `<div class="gh">${head}</div>` : ''}<div class="grp">${cells.map(cell).join('')}</div>${foot ? `<div class="foot">${foot}</div>` : ''}`;
const runSheet = (groups, over = '') => phone(`${statusBar('9:41')}<div class="dimbg" style="background:rgba(0,0,0,.18)"></div>
<div class="sheet"><div class="grab"></div><div class="sbar"><span>Cancel</span><b>How it runs</b><span class="r">Save</span></div>
${groups.join('')}</div>${over}`);

// 现在三端共有的文案（projectStart.ts / ProjectRunSettings.swift）
const T = {
  lineMain: `Directly into ${MAIN}`,
  lineMainHint: `For a single task or an urgent fix. Every merge into ${MAIN} asks you.`,
  platform: 'Orbit lands it',
  platformHint: `The agent doesn’t push to ${MAIN}: Orbit lands its branch once the work is accepted.`,
  push: 'The agent pushes it',
  pushHint: `The agent pushes to ${MAIN} itself, and Orbit checks the commits are there.`,
  autoMain: `The coordinator runs it for you: it decides when each task is done and handles conflicts and failed checks. Merging into ${MAIN} always asks you — a project that lands directly on ${MAIN} never merges by itself. The criteria and anything irreversible stay yours.`,
  checkHint: `Runs on the combined tree before anything lands — on the project branch and again before ${MAIN}.`,
};
