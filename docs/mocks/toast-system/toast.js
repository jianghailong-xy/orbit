// Shared pieces for the toast-system boards: SF Symbols redrawn as SVG, the status bar, and the three
// screens the toasts are shown over (Wiki home, Sessions, a session's console). A `.screen` with
// `data-s="wiki|list|console"` gets that screen stamped in under whatever toast markup it already holds.

const SYMBOLS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="ok" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#34C759"/><path d="M7 12.4l3.3 3.2 6.9-7" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="err" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF3B30"/><path d="M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/></symbol>
  <symbol id="excl" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF3B30"/><path d="M12 6.4v7.2" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.45" fill="#fff"/></symbol>
  <symbol id="bell" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF9500"/><path d="M12 5.9c-2.4 0-4 1.8-4 4.2v2.7l-1.4 1.9h10.8L16 12.8v-2.7c0-2.4-1.6-4.2-4-4.2z" fill="#fff"/><path d="M10.2 16.1a1.9 1.9 0 0 0 3.6 0z" fill="#fff"/></symbol>
  <symbol id="info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#8E8E93"/><circle cx="12" cy="7.6" r="1.45" fill="#fff"/><path d="M12 11v6.2" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></symbol>
  <symbol id="trash" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#8E8E93"/><path d="M7.6 8.4h8.8M10.2 8.4V7.1h3.6v1.3M8.9 8.4l.6 8.4h5l.6-8.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="folder" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#007AFF"/><path d="M6.8 9.1c0-.7.5-1.2 1.2-1.2h2.6l1.3 1.4h4.2c.7 0 1.2.5 1.2 1.2v5c0 .7-.5 1.2-1.2 1.2H8c-.7 0-1.2-.5-1.2-1.2z" fill="#fff"/></symbol>
  <symbol id="spin" viewBox="0 0 24 24"><g stroke="#8E8E93" stroke-width="2.3" stroke-linecap="round">
    <line x1="12" y1="2.8" x2="12" y2="6.6"/>
    <line x1="12" y1="2.8" x2="12" y2="6.6" transform="rotate(45 12 12)" opacity=".88"/>
    <line x1="12" y1="2.8" x2="12" y2="6.6" transform="rotate(90 12 12)" opacity=".74"/>
    <line x1="12" y1="2.8" x2="12" y2="6.6" transform="rotate(135 12 12)" opacity=".6"/>
    <line x1="12" y1="2.8" x2="12" y2="6.6" transform="rotate(180 12 12)" opacity=".48"/>
    <line x1="12" y1="2.8" x2="12" y2="6.6" transform="rotate(225 12 12)" opacity=".38"/>
    <line x1="12" y1="2.8" x2="12" y2="6.6" transform="rotate(270 12 12)" opacity=".29"/>
    <line x1="12" y1="2.8" x2="12" y2="6.6" transform="rotate(315 12 12)" opacity=".2"/></g></symbol>
  <symbol id="xm" viewBox="0 0 16 16"><path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
  <symbol id="cr" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="cd" viewBox="0 0 16 16"><path d="M3.8 6 8 10.2 12.2 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="cl" viewBox="0 0 16 16"><path d="M10.5 3 5.5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="updown" viewBox="0 0 12 16"><path d="M3 6.2l3-3 3 3M3 9.8l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="burger" viewBox="0 0 24 24"><path d="M4.5 7h15M4.5 12h15M4.5 17h15" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
  <symbol id="listb" viewBox="0 0 24 24"><circle cx="5.2" cy="7" r="1.45" fill="currentColor"/><circle cx="5.2" cy="12" r="1.45" fill="currentColor"/><circle cx="5.2" cy="17" r="1.45" fill="currentColor"/><path d="M9.2 7h10.6M9.2 12h10.6M9.2 17h10.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
  <symbol id="gear" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M10.3 3h3.4l.5 2.4 1.7 1 2.3-.8 1.7 2.9-1.8 1.6v1.9l1.8 1.6-1.7 2.9-2.3-.8-1.7 1-.5 2.4h-3.4l-.5-2.4-1.7-1-2.3.8-1.7-2.9 1.8-1.6v-1.9L4.1 8.5l1.7-2.9 2.3.8 1.7-1z"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/></symbol>
  <symbol id="mag" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12.8 12.8l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="plus" viewBox="0 0 22 22"><path d="M11 4v14M4 11h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="share" viewBox="0 0 20 20"><path d="M10 12.5V2.8M6.6 6 10 2.6 13.4 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 8.5H5.6c-.9 0-1.6.7-1.6 1.6v6.3c0 .9.7 1.6 1.6 1.6h8.8c.9 0 1.6-.7 1.6-1.6v-6.3c0-.9-.7-1.6-1.6-1.6H13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
  <symbol id="sendup" viewBox="0 0 16 16"><path d="M8 13.2V3.4M3.9 7.4 8 3.3l4.1 4.1" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="branch" viewBox="0 0 16 16"><path d="M5 2.5v11M5 9c0-2.6 6-2 6-5.2V2.5M11 2.5l-2 2M11 2.5l2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="terminal" viewBox="0 0 16 16"><rect x="1.2" y="2.2" width="13.6" height="11.6" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.2 6.2 6.4 8 4.2 9.8M7.6 10.2h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="task" viewBox="0 0 16 16"><rect x="1.4" y="1.4" width="13.2" height="13.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.6 8.2 7 10.5l4.6-5.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="signal" viewBox="0 0 18 11"><rect x="0" y="7" width="3" height="4" rx=".8" fill="currentColor"/><rect x="5" y="5" width="3" height="6" rx=".8" fill="currentColor"/><rect x="10" y="2.5" width="3" height="8.5" rx=".8" fill="currentColor"/><rect x="15" y="0" width="3" height="11" rx=".8" fill="currentColor"/></symbol>
  <symbol id="wifi" viewBox="0 0 18 13"><path d="M9 12.4 6.5 9.7a3.5 3.5 0 0 1 5 0z" fill="currentColor"/><path d="M3.6 6.8a7.6 7.6 0 0 1 10.8 0l-1.6 1.7a5.3 5.3 0 0 0-7.6 0z" fill="currentColor"/><path d="M.8 3.9a11.6 11.6 0 0 1 16.4 0l-1.6 1.7a9.3 9.3 0 0 0-13.2 0z" fill="currentColor"/></symbol>
</svg>`;

const STATUS = (time = '10:24', batt = '53') => `
  <div class="abs sb-time">${time}</div>
  <div class="abs sb-island"></div>
  <div class="abs sb-right"><svg width="18" height="11"><use href="#signal"/></svg><svg width="17" height="12"><use href="#wifi"/></svg><span class="sb-batt">${batt}</span></div>`;

const SCREENS = {
  wiki: () => `
  <div class="gbtn" style="left:15px"><svg class="i22"><use href="#burger"/></svg></div>
  <div class="gcap" style="left:269px;width:108px"><svg class="i22"><use href="#listb"/></svg><svg class="i22"><use href="#gear"/></svg></div>
  <div class="abs wk-title" style="left:20px;top:128px">Wiki</div>
  <div class="abs wk-space" style="right:16px;top:137px">orbit-engineering-handbook<svg width="11" height="14"><use href="#updown"/></svg></div>
  <div class="abs wk-status" style="left:20px;right:26px;top:179px">9,430 entries · Maintaining now · started 4m ago · 788 to catch up</div>
  <div class="abs wk-search" style="left:16px;right:16px;top:232px"><svg width="17" height="17"><use href="#mag"/></svg>Search the wiki</div>
  <div class="abs wk-banner" style="left:0;right:0;top:284px"><i></i><span>12 proposals to review</span><svg width="14" height="14"><use href="#cr"/></svg></div>
  <div class="abs wk-sec" style="left:20px;top:346px">Principles <span class="cnt">6</span><span class="own">Owner</span></div>
  <div class="abs" style="left:20px;right:16px;top:376px">
    <div class="wk-row"><div class="t1"><b>协调会话间只交换可复核一手证据</b><span>9/6</span></div><div class="t2">会话之间只交换结论会拿到过期世界模型；应交换提交号、日期、库内…</div></div>
    <div class="wk-row"><div class="t1"><b>改夹具前先确认它描述活库还是历史模型</b><span>9/19</span></div><div class="t2">仓库有过夹具不再描述真实数据库的坑，改前必须先判断它指向哪一…</div></div>
    <div class="wk-row"><div class="t1"><b>修复飘红时不得改生产击杀逻辑，只修测试</b><span>9/5</span></div><div class="t2">terminateSessionProcessTree 是生产代码，生产里 400ms 宽限期不是…</div></div>
    <div class="wk-row" style="border:0"><div class="t1"><b>以实测证据推翻任务里错误的根因假设再动手</b><span>8/31</span></div><div class="t2">修复前先实测定位真实根因；本例任务断言是慢启动，但容器日志证明…</div></div>
    <div class="wk-sec" style="margin:18px 0 4px">Recent decisions <span class="cnt">6</span></div>
    <div class="wk-row"><div class="t1"><b>wiki 读会话与编译走 vLLM，脚本用 Claude</b><span>9/26</span></div><div class="t2"><span style="color:#248A3D;font-weight:600">Active</span> · 演示/产品管线中读取 session 并编译 wiki…</div></div>
    <div class="wk-row"><div class="t1"><b>Tasks 列表不展示项目内任务与项目清单</b><span>9/26</span></div><div class="t2"><span style="color:#248A3D;font-weight:600">Active</span> · iOS/Web 任务列表只列项目外任务；项目内…</div></div>
    <div class="wk-row" style="border:0"><div class="t1"><b>wiki 对所有账号开放并发 iOS beta</b><span>9/26</span></div><div class="t2"><span style="color:#248A3D;font-weight:600">Active</span> · T11 部署批准后，owner 决定 wiki 对所有账号…</div></div>
  </div>`,

  list: () => `
  <div class="gbtn" style="left:16px"><svg class="i22"><use href="#burger"/></svg></div>
  <div class="abs ls-title" style="left:0;right:0;top:69px">orbit<svg width="13" height="13"><use href="#cd"/></svg></div>
  <div class="gbtn" style="left:332px"><svg class="i20"><use href="#plus"/></svg></div>
  <div class="abs ls-search" style="left:16px;right:16px;top:114px"><svg width="17" height="17"><use href="#mag"/></svg>Search sessions</div>
  <div class="abs ls-sec" style="left:20px;top:172px">Today</div>
  <div class="abs" style="left:0;right:0;top:194px">
    <div class="ls-row"><div class="t1"><b>执行任务：会话间请求与回复：修复 P1 回执丢失</b><span><svg width="14" height="14"><use href="#spin"/></svg>4m</span></div><div class="t2 run">Running Bash…</div></div>
    <div class="ls-row"><div class="t1"><b>滚动到底按钮显示逻辑</b><span>12m ago</span></div><div class="t2">The iOS/macOS fix is still only on this session's branch.</div></div>
    <div class="ls-row"><div class="t1"><b>排队区的 watch 唤醒卡片</b><span>1h ago</span></div><div class="t2">改好了：排队区的唤醒卡和送达后是同一个组件，原文默…</div></div>
    <div class="ls-row"><div class="t1"><b>P1 修复的合并确认</b><span><i class="odot"></i>2h ago</span></div><div class="t2 wait">Waiting for approval</div></div>
    <div class="ls-row"><div class="t1"><b>部署 0.1.204</b><span>3h ago</span></div><div class="t2">已部署：apiserver 迁移已应用，runner 自更新完成。</div></div>
    <div class="ls-row"><div class="t1"><b>侧栏工作区排序</b><span>4h ago</span></div><div class="t2">收到，做 B。先摸清现有代码再动手。</div></div>
    <div class="ls-row"><div class="t1"><b>分享链接的过期时间</b><span>5h ago</span></div><div class="t2">默认 7 天，可以改成永不过期。</div></div>
    <div class="ls-row"><div class="t1"><b>会话重命名入口</b><span>6h ago</span></div><div class="t2">点标题改名，行菜单也能改。</div></div>
    <div class="ls-row"><div class="t1"><b>Codex 账号池配额</b><span>8h ago</span></div><div class="t2">两个窗口都显示了，卡住的那一个标红。</div></div>
  </div>`,

  console: (el) => {
    const bar = el.dataset.bar || 'merge';
    const state = {
      merge:    '<span class="st" style="color:#007AFF">Merge</span>',
      conflict: '<span class="st rd">Conflict</span>',
      merged:   '<span class="st gr">✓ Merged</span>',
    }[bar];
    return `
  <div class="abs navbg"></div>
  <div class="gbtn" style="left:16px"><svg class="i20"><use href="#cl"/></svg></div>
  <div class="gbtn" style="left:332px"><svg class="i20"><use href="#share"/></svg></div>
  <div class="abs navtitle"><b>滚动到底按钮显示逻辑</b><span>Waiting for your reply · Open · 1m ago</span></div>
  <div class="abs chat">
    <p>The web half landed:</p>
    <ul>
      <li>Task <i>web：跳到底部按钮只在离底部超过一屏时出现</i> is Done.</li>
      <li>Its branch was merged into <code>main</code> as <code>5c2e8a1d4</code>.</li>
      <li>CI on <code>main</code> at that commit: web unit and e2e are green.</li>
    </ul>
    <p>So the web side is in <code>main</code> and was pushed to <code>origin/main</code>.</p>
    <p>The iOS/macOS fix (<code>371031ca9</code>) is still only on this session's branch. Click Merge on this session to land it.</p>
  </div>
  <div class="abs band" style="top:604px"><svg class="i14 dim"><use href="#terminal"/></svg><b>Background processes</b><span class="meta">5 total</span><span class="grow"></span><svg class="i14 dim"><use href="#cr"/></svg></div>
  <div class="abs band" style="top:642px"><svg class="i14 dim"><use href="#task"/></svg><b>Tasks created here</b><span class="grow" style="color:#2E6AFF;font-size:11.5px">web: 跳到底部按钮只在离底部超…</span><svg class="i14 dim"><use href="#cr"/></svg></div>
  <div class="abs band" style="top:680px"><span class="bp mono dim"><svg width="11" height="11"><use href="#branch"/></svg>orbit…9bab9</span><span class="mono gr">+65</span><span class="mono rd">−8</span><span class="meta mono">· 2 files</span><span class="grow"></span>${state}</div>
  <div class="abs composer"><div class="field">Message...</div><div class="tb"><span class="plus"><svg width="20" height="20"><use href="#plus"/></svg></span><span class="mode">Auto</span><span class="sp"></span><span class="model"><b>Opus 5.5</b><i>Max</i></span><span class="send"><svg width="16" height="16"><use href="#sendup"/></svg></span></div></div>`;
  },
};

document.body.insertAdjacentHTML('afterbegin', SYMBOLS);
for (const el of document.querySelectorAll('.screen[data-s]')) {
  el.insertAdjacentHTML('afterbegin', STATUS(el.dataset.time, el.dataset.batt) + SCREENS[el.dataset.s](el));
  el.insertAdjacentHTML('beforeend', '<div class="abs home-ind"></div>');
}
