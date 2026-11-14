// Scheduled tasks on web: session cards, Waiting on you and run sessions, revision 4. The real console (runner-res-mock dist +
// ui-migration fixtures) with the proposal injected.   unshare -n ./run-ns.sh dist <this> [scene…]
import { launch, open, settle } from '/mnt/data/tmp/runner-res-mock/lib.mjs';
import { CSS as CSS1, I, P } from './css.mjs';
const OUT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const only = process.argv.slice(2);

const CSS = CSS1 + `
.sx-nav-count { margin-left:auto; color:var(--warning-solid); font-weight:600; font-size:13px; }
.sx-doc { flex:1; overflow:auto; padding:28px 40px 40px; }
.sx-doc .page-head { display:flex; align-items:flex-start; gap:12px; }
.sx-doc h1 { font-size:24px; font-weight:600; margin:0; color:var(--text-1); }
.sx-doc .lead { color:var(--text-3); font-size:13px; margin-top:2px; }
.sx-l2 { grid-template-columns: minmax(0,2.1fr) 1.1fr 1.1fr 1.1fr 1.5fr 20px; }
.sx-ws { display:inline-flex; gap:6px; align-items:center; color:var(--text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sx-ask { margin-top:18px; border:1px dashed var(--border); border-radius:10px; padding:12px 16px; color:var(--text-2); font-size:13.5px; display:flex; gap:10px; align-items:center; }
.sx-ask code { background:var(--fill-muted); border-radius:4px; padding:1px 6px; font-size:12.5px; color:var(--text-1); }
.sx-empty { margin:90px auto 0; max-width:520px; text-align:center; }
.sx-empty .ic { width:52px; height:52px; border-radius:14px; background:var(--brand-tint); color:var(--brand); display:grid; place-items:center; margin:0 auto 14px; }
.sx-empty .ic .sx-ico { width:26px; height:26px; }
.sx-empty h2 { font-size:18px; margin:0 0 6px; font-weight:600; }
.sx-empty p { color:var(--text-2); margin:0 0 16px; }
.sx-ex { text-align:left; border:1px solid var(--border-subtle); border-radius:10px; overflow:hidden; }
.sx-ex div { padding:10px 14px; border-top:1px solid var(--border-subtle); font-size:13.5px; color:var(--text-1); }
.sx-ex div:first-child { border-top:0; }
.sx-ex div::before { content:'“'; color:var(--text-4); } .sx-ex div::after { content:'”'; color:var(--text-4); }
.sx-crumb { color:var(--text-3); font-size:13px; margin-bottom:4px; } .sx-crumb a { color:var(--brand); }
.sx-hx { grid-template-columns: 128px 104px minmax(0,1fr) 108px 64px; }
.sx-rev { background:var(--bg-subtle); }
.sx-rev .sx-c2 { color:var(--text-2); }
.sx-undo { color:var(--brand); font-size:13px; font-weight:500; }
.sx-line { display:flex; gap:8px; align-items:center; margin:10px 0 0 16px; padding:8px 12px; border-radius:8px; background:var(--bg-subtle); border:1px solid var(--border-subtle); font-size:13.5px; color:var(--text-2); max-width:640px; }
.sx-line b { color:var(--text-1); font-weight:600; }
.sx-line .r { margin-left:auto; display:flex; gap:12px; }
.sx-line a { color:var(--brand); text-decoration:none; font-weight:500; }
.sx-chatcard .ttl { padding:0 14px 2px; font-weight:600; font-size:14.5px; }
.sx-chatcard .rb { padding:2px 14px 6px; font-size:13.5px; line-height:21px; color:var(--text-1); }
.sx-cmd { display:block; font-family:var(--font-mono, ui-monospace, monospace); font-size:12.5px; background:var(--fill-muted); border-radius:6px; padding:6px 10px; margin:6px 0; color:var(--text-1); }
.sx-chatcard .note { padding:0 14px 10px; font-size:12.5px; color:var(--text-3); }
.sx-chatcard.widen { border-color:var(--warning-border); }
.sx-chatcard.widen .hd { color:#7a4500; }
.sx-diff { display:inline-flex; gap:6px; align-items:center; } .sx-diff s { color:var(--text-3); }
`;

const NAV = (count) => `<div class="tp-item active" role="link" tabindex="0" aria-current="page" data-mk="nav"><span class="tp-ico" style="color:var(--brand)">${I.cal.replace('sx-ico', 'sx-ico" style="width:17px;height:17px')}</span><span class="tp-label">Scheduled</span>${count ? `<span class="sx-nav-count">${count}</span>` : ''}</div>`;

const ROW = (name, sub, ws, rule, next, last, dim) => `<div class="sx-tr sx-l2 ${dim ? 'sx-dim' : ''}"><div><div class="sx-t1">${name}</div><div class="sx-sub">${sub}</div></div><span class="sx-ws">${ws}</span><span class="sx-c2">${rule}</span><span class="sx-c2">${next}</span><span>${last}</span><span class="sx-chev">›</span></div>`;
const HD = `<div class="sx-tr hd sx-l2"><span>Name</span><span>Workspace</span><span>Schedule</span><span>Next run</span><span>Last result</span><span></span></div>`;

const LIST = () => `<div class="sx-doc">
 <div class="page-head"><div><h1>Scheduled</h1><div class="lead">5 scheduled tasks in 3 workspaces · times in Asia/Shanghai</div></div></div>
 <h3>Needs attention</h3>
 <div class="sx-table" data-mk="att">${HD}
  ${ROW('Nightly pg spec sweep', 'Check only', 'apiserver', 'Daily 02:00', 'Tomorrow 02:00', P('sx-fail', I.warn + 'Failed 3 in a row'))}
  ${ROW('Weekly dependency audit', 'The agent "auditor" is disabled', 'web', 'Mon 09:00', '<span style="color:var(--text-4)">— held</span>', P('sx-held', 'Held'))}
 </div>
 <h3>Active</h3>
 <div class="sx-table">${HD}
  ${ROW('Codex stable check', 'Open a PR', 'apiserver', 'Daily 09:00', 'Tomorrow 09:00', `${P('sx-ok', 'Known: 0.49.0')} <span class="sx-sub" style="display:inline">today</span>`)}
  ${ROW('Claude CLI version check', 'Check only', 'apiserver', 'Daily 10:30', 'Tomorrow 10:30', `<span data-mk="last">${P('sx-new', 'New: 2.1.310')}</span> <span class="sx-sub" style="display:inline">today</span>`)}
 </div>
 <h3>Paused</h3>
 <div class="sx-table">${HD}
  ${ROW('Friday release notes draft', 'Paused Nov 7', 'Orbit baseline', 'Fri 17:00', '—', P('sx-pause', I.pause + 'Paused'), true)}
 </div>
 <div class="sx-ask" data-mk="ask"><span style="color:var(--brand)">${I.cal}</span><span>To add or change one, say it in any session — <code>every weekday at 9, summarise new issues</code></span></div>
</div>`;

const EMPTY = () => `<div class="sx-doc"><div class="page-head"><div><h1>Scheduled</h1></div></div>
 <div class="sx-empty" data-mk="empty"><div class="ic">${I.cal}</div><h2>Nothing scheduled yet</h2>
 <p>Tell any session what to do and when. It sets the schedule up and asks you once to confirm.</p>
 <div class="sx-ex"><div>Every day at 10:00, check the Codex stable release against our pinned version</div><div>Every Monday at 9, list dependencies with known vulnerabilities</div><div>At 17:00 on Fridays, draft release notes from this week's merges</div></div></div></div>`;

const DETAIL = () => `<div class="sx-doc">
 <div class="sx-crumb"><a>Scheduled</a> ›</div>
 <div class="page-head"><div style="flex:1"><h1>Codex stable check</h1><div class="lead">apiserver · Codex agent · Daily at 09:00 · Asia/Shanghai · Open a PR</div></div>
  <div style="display:flex;gap:8px" data-mk="acts"><button class="sx-btn pri">Run now</button><button class="sx-btn">Pause</button><button class="sx-btn" data-mk="change">Change…</button><button class="sx-btn" style="padding:5px 10px">⋯</button></div></div>
 <div class="sx-cards">
  <div class="sx-card"><div class="k">Next run</div><div class="n">Tomorrow 09:00</div><div class="z">in 20 h 41 min</div></div>
  <div class="sx-card"><div class="k">Last result · Nov 14, started 10:00</div>
   <div style="display:flex;gap:8px;align-items:center;margin:4px 0 2px">${P('sx-ok', 'Known')}<span class="sx-t1">Codex 0.49.0 again · already reported</span></div>
   <div class="z" style="color:var(--text-2)">Linked <a>PR #831 Bump Codex to 0.49.0</a> · not notified · <a>Open session</a></div></div>
 </div>
 <h3>What it does</h3>
 <div class="sx-card" style="font-size:14px;line-height:22px;color:var(--text-1)" data-mk="prompt">Check the latest stable Codex release and compare it with the version the apiserver pins. If it is newer, report the version and its release notes, and open a PR that bumps it.<div class="z" style="margin-top:6px">Written by the agent from your words in <a class="sx-link">Codex release watch</a>, Nov 3.</div></div>
 <h3>History</h3>
 <div class="sx-table" data-mk="hist">
  <div class="sx-tr hd sx-hx"><span>When</span><span>Started</span><span>What happened</span><span>Result</span><span></span></div>
  <div class="sx-tr sx-hx sx-rev" data-mk="rev"><span>Today 12:19</span><span class="sx-c2">—</span><span class="sx-c2 sx-diff">Time <s>10:00</s> → 09:00, by <a class="sx-link">Codex release watch</a></span><span>${P('sx-ok', 'Changed')}</span><span class="sx-undo">Undo</span></div>
  <div class="sx-tr sx-hx sx-rev"><span>Today 12:19</span><span class="sx-c2">—</span><span class="sx-c2 sx-diff">Access Check only → Open a PR, you allowed it</span><span>${P('sx-run', 'Allowed')}</span><span></span></div>
  <div class="sx-tr sx-hx"><span>Nov 14 10:00</span><span class="sx-c2">10:00</span><span class="sx-c2">0.49.0 again · linked PR #831</span><span>${P('sx-ok', 'Known')}</span><a class="sx-link">Session</a></div>
  <div class="sx-tr sx-hx"><span>Nov 13 10:00</span><span class="sx-c2">10:01</span><span class="sx-c2">New 0.49.0 · reported</span><span>${P('sx-new', 'Changed')}</span><a class="sx-link">Session</a></div>
  <div class="sx-tr sx-hx"><span>Nov 12 10:00</span><span class="sx-c2" style="color:var(--warning)">13:47 · late</span><span class="sx-c2">Runner was offline until 13:46</span><span>${P('sx-ok', 'No change')}</span><a class="sx-link">Session</a></div>
  <div class="sx-tr sx-hx sx-dim"><span style="color:var(--text-3)">Nov 11 10:00</span><span class="sx-c2" style="color:var(--text-4)">—</span><span class="sx-c2" style="color:var(--text-3)">Runner offline; covered by the next run</span><span>${P('sx-mute', 'Missed')}</span><span></span></div>
 </div>
</div>`;

const WAITCARD = (title, kind, why, actions, age) => `<section class="owner-request-card"><header class="owner-request-head"><span class="owner-request-dot" aria-hidden="true"></span><span class="owner-request-waiting">Waiting on you</span><span class="owner-request-age">${age}</span></header>
 <div class="owner-request-body"><div class="owner-request-title-row"><h3 class="owner-request-title">${title}</h3><span class="owner-request-kind">${kind}</span></div>
 <div class="owner-request-why md"><p>${why}</p></div>
 <div class="card-actions owner-request-actions">${actions}</div></div></section>`;
const B = (t, tone = 'secondary') => `<button type="button" class="card-action card-action--${tone}">${t}</button>`;

const CHAT_CREATE = ({ I }) => {
  document.querySelector('.workspace-name').textContent = 'Codex release watch';
  document.querySelector('.session-row.active .session-title').textContent = 'Codex release watch';
  document.querySelector('.session-row.active .session-preview').textContent = 'Waiting for you to confirm';
  document.querySelector('.workspace-sub').textContent = 'Waiting for you to confirm · Open · just now';
  document.querySelector('.chat-user .md').innerHTML = '<p>每天北京时间 10 点检查 Codex 官方稳定版，和 apiserver 固定的版本比一下。没变化就别吵我，有新版告诉我版本号和发布说明。</p>';
  const a = document.querySelector('.chat-assistant .md');
  a.innerHTML = `<p data-mk="ans">I checked just now: the latest stable Codex is 0.48.0 and the apiserver pins 0.48.0, so there is nothing to report today. I can do this every morning; closing this chat won't stop it.</p>`;
  a.parentElement.insertAdjacentHTML('afterend', `<div class="sx-chatcard" data-mk="card"><div class="hd"><span style="color:var(--brand)">${I.cal}</span>Create scheduled task?</div>
    <div class="ttl">Codex stable check</div>
    <div class="rb" data-mk="rb">Every day at 10:00 Beijing time I check the latest stable Codex against the version the apiserver pins, and tell you only when there is a new one.</div>
    <div class="kv"><span class="k">When</span><span>Daily 10:00 · Asia/Shanghai · first run tomorrow</span>
    <span class="k">Runs in</span><span>apiserver · Codex agent</span>
    <span class="k">May</span><span data-mk="may"><b>Check only</b> · reads and reports, edits nothing</span>
    <span class="k">Costs</span><span data-mk="costs">Up to <b>7 runs a week</b>, 30 min each</span>
    <span class="k">Today</span><span data-mk="today">Codex 0.48.0, same as pinned. Nothing to report.</span></div>
    <div class="note">You'll hear about new versions and failures only.</div>
    <div class="ft"><button class="sx-btn">Not now</button><button class="sx-btn pri">Create</button></div></div>`);
};

const CHAT_BUDGET = ({ I }) => {
  document.querySelector('.workspace-name').textContent = 'Codex release watch';
  document.querySelector('.session-row.active .session-title').textContent = 'Codex release watch';
  document.querySelector('.session-row.active .session-preview').textContent = 'Waiting for you to allow';
  document.querySelector('.workspace-sub').textContent = 'Waiting for you to allow · Open · just now';
  const u = document.querySelector('.chat-user .md').closest('.chat-user');
  u.querySelector('.md').innerHTML = '<p>这个一周查一次就够了，周一早上。</p>';
  const u2 = u.cloneNode(true); u2.querySelector('.md').innerHTML = '<p>算了，还是每天查吧。</p>';
  u.insertAdjacentHTML('afterend', `<div class="sx-line" data-mk="line" style="margin-bottom:14px"><span style="color:var(--brand)">${I.cal}</span><span>Changed <b>Codex stable check</b>: <s style="color:var(--text-3)">Daily</s> → Mondays 10:00</span><span class="r"><a>Undo</a><a>Open</a></span></div>`);
  u.nextElementSibling.after(u2);
  const a = document.querySelector('.chat-assistant .md');
  a.innerHTML = `<p>You cut this down to once a week, so going back to daily is more than it is allowed now. One press:</p>`;
  a.parentElement.insertAdjacentHTML('afterend', `<div class="sx-chatcard widen" data-mk="widen"><div class="hd"><span style="color:var(--warning)">${I.warn.replace('width:12px;height:12px', 'width:15px;height:15px')}</span>Let Codex stable check run more often?</div>
    <div class="kv"><span class="k">Now</span><span>Mondays 10:00 · up to 1 run a week</span><span class="k">Asked</span><span><b>Daily 10:00</b> · up to 7 runs a week, 30 min each</span></div>
    <div class="note">Applies from the next run.</div>
    <div class="ft"><button class="sx-btn">Keep weekly</button><button class="sx-btn pri">Allow</button></div></div>`);
};

const CHAT_CHANGE = ({ I }) => {
  document.querySelector('.workspace-name').textContent = 'Codex release watch';
  document.querySelector('.session-row.active .session-title').textContent = 'Codex release watch';
  document.querySelector('.session-row.active .session-preview').textContent = 'Waiting for you to allow';
  document.querySelector('.workspace-sub').textContent = 'Waiting for you to allow · Open · just now';
  document.querySelector('.chat-user .md').innerHTML = '<p>改成早上 9 点。另外有新版的话直接开个升级 PR。</p>';
  const a = document.querySelector('.chat-assistant .md');
  a.innerHTML = `<p>Done: it now runs at 09:00. Opening a PR needs more access than it has, so that part waits for you.</p>`;
  a.parentElement.insertAdjacentHTML('afterend', `<div class="sx-line" data-mk="line"><span style="color:var(--brand)">${I.cal}</span><span>Changed <b>Codex stable check</b>: time <s style="color:var(--text-3)">10:00</s> → 09:00</span><span class="r"><a>Undo</a><a>Open</a></span></div>
    <div class="sx-chatcard widen" data-mk="widen"><div class="hd"><span style="color:var(--warning)">${I.warn.replace('width:12px;height:12px', 'width:15px;height:15px')}</span>Let Codex stable check open PRs?</div>
    <div class="kv"><span class="k">Now</span><span>Check only — reads and reports</span><span class="k">Asked</span><span><b>Open a PR</b> — edits in its own worktree and opens a PR. It can't merge or deploy.</span></div>
    <div class="note">Applies from the next run. Each run checks this again before it starts.</div>
    <div class="ft"><button class="sx-btn">Keep check only</button><button class="sx-btn pri">Allow</button></div></div>`);
};

const RUN = ({ I, end }) => {
  document.querySelector('.workspace-name').textContent = end ? 'Release 2.0 freeze watch · Nov 14' : 'Codex stable check · Nov 13';
  document.querySelector('.watch-badges')?.remove();
  document.querySelector('.workspace-sub').textContent = 'Open · Codex agent · 4 min';
  document.querySelector('.workspace-header-main').insertAdjacentHTML('afterbegin', `<div class="sx-crumb" data-mk="crumb"><a>Scheduled</a> › <a>Codex stable check</a> › run of Nov 13</div>`);
  const list = document.querySelector('.workspace-view .workspace-sessions');
  list.innerHTML = `<div class="sx-strip"><span style="color:var(--brand)">${I.cal}</span><span>Scheduled run · planned 10:00, started 10:01 · access Check only · this session is not in your session list</span></div>
    <div class="chat-turn-head">Worked for 3m 48s</div>
    <div class="chat-msg chat-assistant"><div class="md"><p>The latest stable Codex is <strong>0.49.0</strong>, released Nov 12. The apiserver pins <strong>0.48.0</strong>.</p>
    <ul><li>Turn steering now covers tool calls</li><li>Fixes the sandbox path bug on macOS</li><li>No breaking flag changes</li></ul></div></div>
    <div class="sx-report" data-mk="report"><div class="h"><span style="color:var(--success-solid)">${I.check}</span>Reported: Changed · codex@0.49.0 · you were notified</div>
    Codex 0.49.0 is out (pinned 0.48.0). <a class="sx-link">Release notes</a></div>`;
  if (end) {
    document.querySelector('[data-mk=crumb]').innerHTML = '<a>Scheduled</a> › <a>Release 2.0 freeze watch</a> › run of Nov 14';
    document.querySelector('.workspace-sub').textContent = 'Open · Claude agent · 2 min';
    list.innerHTML = `<div class="sx-strip"><span style="color:var(--brand)">${I.cal}</span><span>Scheduled run · planned 10:00, started 10:00 · access Check only · this session is not in your session list</span></div>
    <div class="chat-turn-head">Worked for 1m 52s</div>
    <div class="chat-msg chat-assistant"><div class="md"><p>Tag <strong>v2.0.0</strong> was published yesterday and no open PR carries the <code>freeze-exception</code> label any more. The reason for this schedule is gone, so I am ending it.</p></div></div>
    <div class="sx-report"><div class="h"><span style="color:var(--success-solid)">${I.check}</span>Reported: Changed · released@2.0.0 · you were notified</div>
    2.0 shipped; no freeze exceptions are open.</div>
    <div class="sx-line" data-mk="ended"><span style="color:var(--brand)">${I.cal}</span><span>Ended <b>Release 2.0 freeze watch</b>: goal reached · by this run</span><span class="r"><a>Undo</a><a>Open</a></span></div>`;
  }
  document.querySelector('aside.session-col').style.display = 'none';
};

async function base(page, { navCount = 2, navActive = true, hideTasksActive = true } = {}) {
  await page.evaluate(({ CSS, NAVHTML, navActive }) => {
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (n.textContent.includes('Baseline Reviewer')) n.textContent = 'Mia Chen'; }
    const items = [...document.querySelectorAll('.tp-section .tp-item')];
    const tasks = items.find((e) => e.textContent.includes('Tasks'));
    tasks.insertAdjacentHTML('afterend', NAVHTML);
    if (navActive) for (const e of document.querySelectorAll('.tp-item')) { if (e.dataset.mk === 'nav') continue; e.classList.remove('active'); e.removeAttribute('aria-current'); }
    else document.querySelector('[data-mk=nav]').classList.remove('active');
  }, { CSS, NAVHTML: NAV(navCount), navActive });
}
async function main(page, html) {
  await page.evaluate((html) => { const v = document.querySelector('.app-view'); for (const c of v.children) c.style.display = 'none';
    const d = document.createElement('div'); d.id = 'sx-main'; d.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;flex:1'; d.innerHTML = html; v.append(d); }, html);
}
async function marks(page, list) { await page.evaluate((list) => { window.__mk = list; }, list); }
async function placeMarks(page) {
  await page.evaluate(() => {
    (window.__mk || []).forEach(([sel, n, dx = 0, dy = 0]) => {
      const el = document.querySelector(sel); if (!el) { console.error('no mark target ' + sel); return; }
      const r = el.getBoundingClientRect(); const m = document.createElement('div');
      const row = el.classList.contains('sx-tr');
      m.className = 'sx-mk'; m.textContent = n;
      m.style.left = ((row ? r.right + 6 : r.right - 12) + dx) + 'px'; m.style.top = ((row ? r.top + r.height / 2 - 11 : r.top - 10) + dy) + 'px';
      document.body.append(m);
    });
  });
}

const scenes = {
  list: ['/tasks', async (p) => { await base(p); await main(p, LIST()); await marks(p, [['[data-mk=nav]', 1], ['[data-mk=att]', 2], ['[data-mk=last]', 3, 8, -8], ['[data-mk=ask]', 4]]); }],
  empty: ['/tasks', async (p) => { await base(p, { navCount: 0 }); await main(p, EMPTY()); await marks(p, [['[data-mk=empty] .sx-ex', 1]]); }],
  detail: ['/tasks', async (p) => { await base(p); await main(p, DETAIL()); await marks(p, [['[data-mk=acts]', 1], ['[data-mk=prompt]', 2], ['[data-mk=rev]', 3]]); }],
  create: ['/', async (p) => { await base(p, { navActive: false }); await p.evaluate(CHAT_CREATE, { I }); await marks(p, [['[data-mk=ans]', 1, 20], ['[data-mk=rb]', 2], ['[data-mk=may]', 3, 30], ['[data-mk=costs]', 4, 30], ['[data-mk=today]', 5, 30]]); }],
  budget: ['/', async (p) => { await base(p, { navActive: false }); await p.evaluate(CHAT_BUDGET, { I }); await marks(p, [['[data-mk=line]', 1], ['[data-mk=widen]', 2]]); }],
  change: ['/', async (p) => { await base(p, { navActive: false }); await p.evaluate(CHAT_CHANGE, { I }); await marks(p, [['[data-mk=line]', 1], ['[data-mk=widen]', 2]]); }],
  waiting: ['/waiting', async (p) => {
    await base(p, { navActive: false });
    await p.evaluate(({ cards }) => { document.querySelector('.owner-inbox-empty').outerHTML = `<div data-mk="cards">${cards}</div>`;
      const items = [...document.querySelectorAll('.tp-section .tp-item')]; for (const e of items) e.classList.toggle('active', e.textContent.includes('Waiting'));
      const w = items.find((e) => e.textContent.includes('Waiting')); w.insertAdjacentHTML('beforeend', '<span class="sx-nav-count">3</span>'); }, {
      cards: WAITCARD('Nightly pg spec sweep failed 3 runs in a row', 'Scheduled', 'The last run ended without a report (Nov 14, 02:00). It keeps running on schedule until you pause it. Open the run to see where it stopped, or ask a session to fix the prompt.', B('Open run', 'primary') + B('Pause schedule'), 'Today 02:41')
        + WAITCARD('Weekly dependency audit is held', 'Scheduled', 'It could not start on Monday 09:00: the agent "auditor" in workspace web is disabled. Nothing runs until it is enabled and you resume.', B('Open agent settings', 'primary') + B('Resume'), 'Nov 10, 09:00')
        + `<div data-mk="appr">` + WAITCARD('Nightly pg spec sweep wants to run a command', 'Scheduled run', '<span class="sx-cmd">psql -h 127.0.0.1 -p 55490 -c "select 1"</span>If nobody answers by 04:00 this run fails; the next one starts tomorrow. <b>Always allow</b> covers <code>psql:*</code> in apiserver: later runs won\'t ask for this.', B('Always allow', 'primary') + B('Allow once') + B('Deny'), 'Today 02:03') + `</div>`
        + `<div data-mk="widenrun">` + WAITCARD('Let Codex stable check open PRs?', 'Scheduled', 'Its run of Nov 13 found 0.49.0 and asks to open the upgrade PR itself from now on. Now: Check only. Asked: <b>Open a PR</b> · edits in its own worktree and opens a PR. It can\'t merge or deploy.', B('Allow', 'primary') + B('Keep check only'), 'Nov 13, 10:04') + `</div>` });
    await p.evaluate(() => { const w = [...document.querySelectorAll('.sx-nav-count')].pop(); w.textContent = '4'; });
    await marks(p, [['[data-mk=cards]', 1], ['[data-mk=appr]', 2, 0, 8], ['[data-mk=widenrun]', 3, 0, 8]]); }],
  selfend: ['/', async (p) => { await base(p); await p.evaluate(RUN, { I, end: true }); await marks(p, [['[data-mk=ended]', 1]]); }],
  run: ['/', async (p) => { await base(p); await p.evaluate(RUN, { I }); await marks(p, [['[data-mk=crumb]', 1], ['[data-mk=report]', 2]]); }],
};

const b = await launch();
for (const [name, [path, fn]] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const s = await open(b, { path, width: 1440, height: name === 'waiting' ? 1100 : 900 });
  await s.page.waitForTimeout(1200);
  await fn(s.page); await settle(s.page); await s.page.waitForTimeout(500);
  await s.page.evaluate(() => { const v = document.querySelector('.app-view'); const me = document.getElementById('sx-main');
    if (me) for (const c of v.children) if (c !== me) c.style.display = 'none'; });
  await settle(s.page); await placeMarks(s.page);
  await s.page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, s.errors.filter((e) => !e.includes('501')).slice(0, 2).join(' | ').slice(0, 300));
  await s.context.close();
}
await b.close();
