// Builds 01-board.html from the real Settings.css, index.css's light :root tokens and the real
// Ant Design icon paths. Run from the repo root: node docs/mocks/settings-nav-add-hover/build.cjs
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const { renderIconDefinitionToSVGElement } = require(path.join(root, 'node_modules/@ant-design/icons-svg/lib/helpers'));
const icon = (name) =>
  `<span class="anticon">${renderIconDefinitionToSVGElement(
    require(path.join(root, `node_modules/@ant-design/icons-svg/lib/asn/${name}`)).default,
    { extraSVGAttrs: { width: '1em', height: '1em', fill: 'currentColor' } },
  )}</span>`;
const indexCss = fs.readFileSync(path.join(root, 'src/web/src/index.css'), 'utf8');
const tokens = indexCss.slice(indexCss.indexOf(':root {'), indexCss.indexOf('\n}', indexCss.indexOf(':root {')) + 2);
const settingsCss = fs.readFileSync(path.join(root, 'src/web/src/components/settings/Settings.css'), 'utf8');

const heading = (title, add) =>
  `<div class="settings-nav-heading"><span>${title}</span><button type="button" class="settings-nav-add" aria-label="${add}">${icon('PlusOutlined')}</button></div>`;
const row = (ic, label, trailing = '') =>
  `<a class="settings-nav-row" href="#"><span class="settings-nav-icon">${icon(ic)}</span><span class="settings-nav-label">${label}</span>${trailing}</a>`;
const dot = (s) => `<span class="settings-dot settings-dot--${s}"></span>`;
const meta = (t) => `<span class="settings-nav-meta">${t}</span>`;
const group = (title, add, rows, empty) =>
  `<div class="settings-nav-group${empty ? ' settings-nav-group--empty' : ''}" role="group" aria-label="${title}">${heading(title, add)}${rows}</div>`;

const machines = [
  ['HPC', 'attention'], ['wikova', 'online'], ['workstation', 'attention'],
  ['longdeMac-mini.local', 'attention'], ['orbit@austin', 'attention'],
].map(([n, s]) => `<div class="settings-nav-sortable">${row('HddOutlined', n, dot(s))}<button type="button" class="settings-nav-grip">${icon('HolderOutlined')}</button></div>`).join('');
const providers = row('CloudOutlined', 'API keys', meta(8)) + row('BlockOutlined', 'Account pools', meta(1));
const workspaces = row('FolderOutlined', 'HPC', meta('HPC')) + row('FolderOutlined', 'orbit-develop', meta('HPC'));

const nav = ({ noWorkspaces, noProviders } = {}) => `<nav class="settings-nav"><div class="settings-nav-groups">
  ${group('Machines', 'Register a machine', machines)}
  ${noProviders
    ? group('Providers', 'Connect a provider', row('PlusOutlined', 'Connect a provider'), true)
    : group('Providers', 'Connect a provider', providers)}
  ${noWorkspaces ? group('Workspaces', 'New workspace', '', true) : group('Workspaces', 'New workspace', workspaces)}
</div></nav>`;

const panel = (id, tag, title, note, body, cls = '') =>
  `<section class="panel ${cls}" id="${id}"><div class="tag">${tag}</div><h2>${title}</h2><p class="note">${note}</p><div class="frame">${body}</div></section>`;

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(/mnt/data/pe-mock/fonts/Inter.ttf); }
@font-face { font-family: NotoSC; src: url(/mnt/data/pe-mock/fonts/NotoSansSC.ttf); }
${tokens}
${settingsCss}
.anticon { display: inline-flex; align-items: center; line-height: 0; }
body { margin: 0; padding: 32px; background: #f2f3f5; font-family: Inter, NotoSC, sans-serif; color: #1f2329; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: #646a73; font-size: 14px; margin: 0 0 24px; max-width: 1500px; line-height: 1.6; }
.row { display: flex; gap: 20px; align-items: flex-start; }
.panel { width: 300px; }
.tag { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #e3e6eb; color: #646a73; }
.panel.after .tag { background: #eaf1ff; color: #3370ff; }
.panel.choice .tag { background: #fff3e0; color: #c2710c; }
h2 { font-size: 15px; margin: 8px 0 4px; }
.note { font-size: 12.5px; color: #646a73; line-height: 1.55; margin: 0 0 10px; min-height: 58px; }
.frame { background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow: hidden; position: relative; }
.frame .settings-nav { flex: none; width: 272px; padding: 12px 14px 16px; border-right: 0; }
/* Board only: "before" draws every + as main draws it today. */
.before .settings-nav-add { opacity: 1 !important; }
/* Board only: choice B hides the + on Providers while its only row is "Connect a provider". */
.choice-b .settings-nav-group[aria-label="Providers"] .settings-nav-add { opacity: 0; }
.choice-b .settings-nav-group[aria-label="Providers"]:hover .settings-nav-add { opacity: 1; }
.cursor { position: absolute; width: 16px; pointer-events: none; z-index: 5; }
.foot { margin-top: 22px; font-size: 12.5px; color: #8f959e; line-height: 1.6; }
.rec { color: #1a7f37; font-weight: 600; }
</style></head><body>
<h1>Settings 侧栏：组标题的 + 只在需要时出现</h1>
<p class="sub">Machines / Providers / Workspaces 三个组。改后：鼠标在这一组上（标题或任意一行）才出现 +；组里一个都没有时一直显示；Tab 到它时显示；触屏设备没有悬停，保持一直显示。+ 隐藏时仍占位，出现时标题不跳动。</p>
<div class="row">
${panel('p1', '现在', '+ 一直在', '三个组标题右侧的 + 始终可见（你截图里的样子）。', nav(), 'before')}
${panel('p2', '改后', '鼠标不在侧栏上', '三个组都有内容，+ 全部隐藏。', nav(), 'after')}
${panel('p3', '改后', '鼠标在 Machines 组上', '指向 Machines 组里任何位置（这里是 wikova 一行），只有 Machines 的 + 出现。拖动手柄是原有的行悬停效果。', nav(), 'after hover-machines')}
${panel('p4', '改后', '还没有工作区', 'Workspaces 组是空的，它的 + 不用悬停就一直显示；其他组照常隐藏。', nav({ noWorkspaces: true }), 'after')}
</div>
<div class="row" style="margin-top:28px">
${panel('p5', '待定 · A <span class="rec">（建议）</span>', '没有 Provider：+ 也显示', '空组一律显示 +，规则统一。这里同时有一行 “Connect a provider”，两者去同一个页面。（已提交的代码就是 A）', nav({ noProviders: true }), 'after choice')}
${panel('p6', '待定 · B', '没有 Provider：只留那一行', 'Providers 空时本来就有 “Connect a provider” 一行，+ 就不另外显示，悬停时才出现。', nav({ noProviders: true }), 'after choice choice-b')}
</div>
<p class="foot">画法：组件 DOM 按 SettingsLayout.tsx 的真实 class 手写，样式直接内联本分支的 Settings.css 和 index.css 浅色 token，图标是 Ant Design 真实路径。悬停面板由 Playwright 真实移动鼠标得到，不是伪造的 :hover。“现在”一栏用一条只在本图生效的规则把 + 全部显出，等同 main 当前的样子。</p>
</body></html>`;
fs.writeFileSync(path.join(__dirname, '01-board.html'), html);
