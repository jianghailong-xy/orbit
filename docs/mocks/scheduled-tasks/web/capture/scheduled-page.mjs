// Scheduled tasks on web, revision 3 page with revision 4's inspector and create card: the Scheduled page modelled on macOS Reminders' Scheduled list.
// The real console (runner-res-mock dist + ui-migration fixtures) with the proposal injected.
//   unshare -n ./run-ns.sh dist <this> [scene…]
import { launch, open, settle } from '/mnt/data/tmp/runner-res-mock/lib.mjs';
import { CSS as CSS1, I, P } from './css.mjs';
const OUT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const only = process.argv.slice(2);

const CSS = CSS1 + `
.sx-nav-count { margin-left:auto; color:var(--warning-solid); font-weight:600; font-size:13px; }
.rm { flex:1; display:flex; min-height:0; height:100vh; }
.rm-list { flex:1; overflow:auto; padding:26px 44px 40px; min-width:0; }
.rm-head { display:flex; align-items:flex-end; gap:14px; }
.rm-head h1 { font-size:30px; font-weight:700; margin:0; color:var(--brand); letter-spacing:-.01em; }
.rm-head .n { margin-left:auto; font-size:30px; font-weight:600; color:var(--text-3); }
.rm-tools { display:flex; gap:10px; align-items:center; margin:8px 0 2px; color:var(--text-2); font-size:13px; }
.rm-chip { border:1px solid var(--border); border-radius:999px; padding:2px 10px; color:var(--text-1); background:#fff; }
.rm-tog { display:inline-flex; align-items:center; gap:6px; }
.rm-tog i { width:28px; height:16px; border-radius:8px; background:#d9dce1; position:relative; display:inline-block; }
.rm-tog i::after { content:''; position:absolute; left:2px; top:2px; width:12px; height:12px; border-radius:50%; background:#fff; }
.rm-tog.on i { background:var(--brand); } .rm-tog.on i::after { left:14px; }
.rm-sec { margin-top:20px; }
.rm-sec > h2 { font-size:16px; font-weight:700; margin:0 0 2px; padding-bottom:6px; border-bottom:1px solid var(--border-subtle); color:var(--text-1); display:flex; gap:8px; align-items:baseline; }
.rm-sec > h2 small { color:var(--text-3); font-weight:400; font-size:13px; }
.rm-sec.red > h2 { color:var(--error); }
.rm-sec.dim > h2 { color:var(--text-3); }
.rm-row { display:flex; gap:12px; align-items:flex-start; padding:9px 4px 0; cursor:default; border-radius:8px; }
.rm-row .body { flex:1; min-width:0; border-bottom:1px solid var(--border-subtle); padding-bottom:9px; display:flex; gap:10px; }
.rm-row .txt { flex:1; min-width:0; }
.rm-row .t { font-size:14.5px; color:var(--text-1); line-height:21px; }
.rm-row .s { font-size:12.5px; color:var(--text-3); line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rm-row .s .rep { color:var(--text-2); }
.rm-row .tm { font-size:13px; color:var(--text-2); white-space:nowrap; padding-top:1px; }
.rm-row.sel { background:var(--brand-tint); } .rm-row.sel .body { border-bottom-color:transparent; }
.rm-row.past .t { color:var(--text-3); }
.rm-row.draft .t { color:var(--text-2); font-style:italic; }
.rm-c { width:20px; height:20px; border-radius:50%; border:1.6px solid #c4c8ce; flex:none; margin-top:1px; display:grid; place-items:center; color:#fff; font:700 11px/1 sans-serif; }
.rm-c.ok { background:#b9bec6; border-color:#b9bec6; }
.rm-c.new { background:var(--success-solid); border-color:var(--success-solid); }
.rm-c.fail { background:var(--error); border-color:var(--error); }
.rm-c.held { border-color:var(--warning-solid); color:var(--warning-solid); }
.rm-c.run { border-color:var(--brand); border-right-color:transparent; }
.rm-c.draft { border-style:dashed; border-color:var(--brand); }
.rm-c.pause { border-color:#d9dce1; }
.rm-tag { font-size:12px; font-weight:600; white-space:nowrap; padding-top:2px; }
.rm-tag.new { color:var(--success); } .rm-tag.fail { color:var(--error); } .rm-tag.held { color:var(--warning); } .rm-tag.mute { color:var(--text-3); font-weight:500; }
.rm-add { display:flex; gap:12px; align-items:center; padding:12px 4px; margin-top:16px; color:var(--text-3); font-size:14.5px; }
.rm-add .plus { width:20px; height:20px; border-radius:50%; background:var(--brand); color:#fff; display:grid; place-items:center; font-weight:700; flex:none; }
.rm-add .in { flex:1; border-bottom:1px solid var(--border-subtle); padding-bottom:8px; }
.rm-add.on .in { color:var(--text-1); border-bottom-color:var(--brand); }
.rm-add .ws { border:1px solid var(--border); border-radius:999px; padding:1px 10px; font-size:12.5px; color:var(--text-2); white-space:nowrap; }
.rm-add .hint { font-size:12px; color:var(--text-3); white-space:nowrap; margin-right:14px; }
.rm-ex { margin:2px 0 0 32px; }
.rm-ex div { padding:8px 0; color:var(--text-2); font-size:13.5px; border-bottom:1px solid var(--border-subtle); }
.rm-ex div::before { content:'“'; color:var(--text-4); } .rm-ex div::after { content:'”'; color:var(--text-4); }
.rm-insp { width:400px; flex:none; border-left:1px solid var(--border); background:var(--bg-subtle); overflow:auto; padding:22px 22px 30px; }
.rm-insp h3x { display:block; }
.rm-insp .tt { font-size:19px; font-weight:700; color:var(--text-1); line-height:26px; }
.rm-insp .meta { font-size:12.5px; color:var(--text-3); margin-top:2px; }
.rm-insp .blk { background:#fff; border:1px solid var(--border-subtle); border-radius:10px; padding:11px 13px; margin-top:12px; font-size:13.5px; line-height:20px; }
.rm-insp .k { color:var(--text-3); font-size:12px; }
.rm-insp .big { font-size:18px; font-weight:700; color:var(--text-1); }
.rm-insp .btns { display:flex; gap:8px; margin-top:12px; } .rm-insp .btns .sx-btn { flex:1; text-align:center; padding:5px 0; }
.rm-insp .hl { font-size:12px; font-weight:600; color:var(--text-3); margin:16px 0 4px; }
.rm-insp .hr { display:flex; gap:8px; font-size:13px; padding:6px 0; border-top:1px solid var(--border-subtle); color:var(--text-2); }
.rm-insp .hr:first-of-type { border-top:0; }
.rm-insp .hr .w { width:86px; flex:none; color:var(--text-3); }
.rm-insp .hr .x { flex:1; min-width:0; }
.rm-insp .hr .u { color:var(--brand); font-weight:500; }
.rm-insp .card2 { background:#fff; border:1px solid var(--brand-border); border-radius:10px; margin-top:12px; overflow:hidden; }
.rm-insp .card2 .hd { padding:10px 13px 2px; font-weight:600; display:flex; gap:8px; align-items:center; }
.rm-insp .card2 .kv { display:grid; grid-template-columns:70px 1fr; gap:3px 10px; padding:6px 13px 10px; font-size:13px; }
.rm-insp .card2 .kv .k { color:var(--text-3); font-size:13px; }
.rm-insp .card2 .rb { padding:4px 13px 4px; font-size:13.5px; line-height:20px; color:var(--text-1); }
.rm-who { font-size:11px; font-weight:600; border-radius:999px; padding:1px 7px; background:var(--fill-muted); color:var(--text-2); white-space:nowrap; align-self:flex-start; }
.rm-who.run { background:var(--brand-tint); color:var(--brand); } .rm-who.you { background:var(--success-tint, #e3f5ea); color:var(--success, #17683b); }
.rm-insp .card2 .nt { padding:0 13px 10px; font-size:12px; color:var(--text-3); }
.rm-insp .card2 .ft { display:flex; gap:8px; justify-content:flex-end; padding:10px 13px; border-top:1px solid var(--border-subtle); background:var(--bg-subtle); }
`;

const NAV = (count) => `<div class="tp-item active" role="link" tabindex="0" aria-current="page" data-mk="nav"><span class="tp-ico" style="color:var(--brand)">${I.cal.replace('sx-ico', 'sx-ico" style="width:17px;height:17px')}</span><span class="tp-label">Scheduled</span>${count ? `<span class="sx-nav-count">${count}</span>` : ''}</div>`;

// circle kinds: '', ok, new, fail, held, run, draft, pause
const ROW = ({ c = '', ci = '', t, s, tm = '', tag = '', cls = '', mk = '' }) => `<div class="rm-row ${cls}" ${mk ? `data-mk="${mk}"` : ''}><span class="rm-c ${c}">${ci}</span><div class="body"><div class="txt"><div class="t">${t}</div><div class="s">${s}</div></div>${tag}<span class="tm">${tm}</span></div></div>`;
const REP = (r) => `<span class="rep">↻ ${r}</span>`;
const TAG = (k, t) => `<span class="rm-tag ${k}">${t}</span>`;

const HEAD = (past) => `<div class="rm-head"><h1>Scheduled</h1><span class="n">7</span></div>
 <div class="rm-tools"><span class="rm-chip" data-mk="filter">All workspaces ▾</span><span style="margin-left:auto" class="rm-tog ${past ? 'on' : ''}" data-mk="past"><i></i>Show past runs</span></div>`;

const ADD = (on, text, mk = 'add') => `<div class="rm-add ${on ? 'on' : ''}" data-mk="${mk}"><span class="plus">+</span><span class="in">${text}</span><span class="ws">apiserver ▾</span>${on ? '<span class="hint">↵ to ask</span>' : ''}</div>`;

const LIST = ({ past = false, sel = '', draft = false, typed = '' } = {}) => `<div class="rm-list">${HEAD(past)}
 <div class="rm-sec red" data-mk="needs"><h2>Needs you <small>2</small></h2>
  ${ROW({ c: 'fail', ci: '!', t: 'Nightly pg spec sweep', s: `${REP('Every day at 02:00')} · apiserver · Check only`, tag: TAG('fail', 'Failed 3 in a row'), tm: 'Today 02:00' })}
  ${ROW({ c: 'held', ci: '!', t: 'Weekly dependency audit', s: `${REP('Every Monday at 09:00')} · web · the agent "auditor" is disabled`, tag: TAG('held', 'Held'), tm: '' })}
 </div>
 <div class="rm-sec"><h2>Today <small>Fri, Nov 14</small></h2>
  ${past ? ROW({ c: 'fail', ci: '!', cls: 'past', t: 'Nightly pg spec sweep', s: 'Ended without a report', tag: TAG('fail', 'Failed'), tm: '02:00' }) : ''}
  ${past ? ROW({ c: 'ok', ci: '✓', cls: 'past' + (sel === 'codex-past' ? ' sel' : ''), t: 'Codex stable check', s: '0.49.0 again · linked PR #831 · not notified', tag: TAG('mute', 'Known'), tm: '10:00' }) : ''}
  ${past ? ROW({ c: 'new', ci: '✓', cls: 'past', t: 'Claude CLI version check', s: '2.1.310 is out · you were notified', tag: TAG('new', 'New'), tm: '10:30', mk: 'pastrow' }) : ''}
  ${ROW({ c: 'run', t: 'Docs link check', s: `${REP('Every day at 12:00')} · web · Check only · running for 21 min`, tm: '12:00', mk: 'running' })}
  ${ROW({ t: 'Release notes draft', s: `${REP('Every Friday at 17:00')} · Orbit baseline · Open a PR`, tm: '17:00' })}
  ${ROW({ t: 'Deploy health check', s: 'Once · apiserver · Check only', tm: '18:00', mk: 'once' })}
 </div>
 <div class="rm-sec"><h2>Tomorrow <small>Sat, Nov 15</small></h2>
  ${ROW({ t: 'Nightly pg spec sweep', s: `${REP('Every day at 02:00')} · apiserver · Check only`, tm: '02:00' })}
  ${ROW({ cls: sel === 'codex' ? 'sel' : '', mk: 'codex', t: 'Codex stable check', s: `${REP('Every day at 09:00')} · apiserver · Open a PR`, tm: '09:00' })}
  ${ROW({ t: 'Claude CLI version check', s: `${REP('Every day at 10:30')} · apiserver · Check only`, tm: '10:30' })}
  ${ROW({ t: 'Docs link check', s: `${REP('Every day at 12:00')} · web · Check only`, tm: '12:00' })}
 </div>
 <div class="rm-sec"><h2>Monday <small>Nov 17</small></h2>
  ${draft ? ROW({ c: 'draft', cls: 'draft sel', mk: 'draft', t: 'Weekday issue summary', s: `${REP('Weekdays at 09:00')} · apiserver · Check only · draft, waiting for you`, tm: '09:00' }) : ''}
  ${ROW({ t: 'Weekly cost report', s: `${REP('Every Monday at 10:00')} · Orbit baseline · Check only`, tm: '10:00' })}
 </div>
 <div class="rm-sec dim"><h2>Paused <small>1</small></h2>
  ${ROW({ c: 'pause', t: '<span style="color:var(--text-3)">Gateway CSP report digest</span>', s: `${REP('Every day at 08:00')} · web · paused Nov 7`, tm: '' })}
 </div>
 ${ADD(!!typed, typed || 'Describe a scheduled task…')}
</div>`;

const WHO = (k, t) => `<span class="rm-who ${k}">${t}</span>`;
const INSP_CODEX = `<aside class="rm-insp" data-mk="insp">
 <div class="tt">Codex stable check</div>
 <div class="meta">↻ Every day at 09:00 · Asia/Shanghai · apiserver · Codex agent · Open a PR</div>
 <div class="blk"><div class="k">Next run</div><div class="big">Tomorrow 09:00</div>
  <div style="margin-top:6px"><span class="k">Last</span> · Today 10:00 · Known 0.49.0, linked <a class="sx-link">PR #831</a> · not notified</div></div>
 <div class="btns" data-mk="btns"><button class="sx-btn pri">Run now</button><button class="sx-btn">Pause</button><button class="sx-btn">Change…</button><button class="sx-btn" style="flex:0 0 34px">⋯</button></div>
 <div class="hl">WHAT IT DOES</div>
 <div class="blk" style="margin-top:0">Every day at 09:00 Beijing time I check the latest stable Codex against the version the apiserver pins. When there is a new one I tell you and open a PR that bumps it.</div>
 <div class="hl">WHAT WAS ASKED</div>
 <div class="blk" style="margin-top:0" data-mk="asked">每天北京时间 10 点检查 Codex 官方稳定版，和 apiserver 固定的版本比一下。没变化就别吵我，有新版告诉我版本号和发布说明。<div class="k" style="margin-top:6px">Your words in <a class="sx-link">Codex release watch</a>, Nov 3</div></div>
 <div class="hl">NOTES FOR THE NEXT RUN</div>
 <div class="blk" style="margin-top:0" data-mk="note">Release notes moved to github.com/openai/codex/releases. The old changelog URL is 404.<div class="k" style="margin-top:6px">Left by the run of Nov 12</div></div>
 <div class="hl">THIS MONTH</div>
 <div class="blk" style="margin-top:0" data-mk="use"><b>14 runs · 41 min</b><div class="k" style="margin-top:2px">Allowed: up to 7 runs a week, 30 min each</div></div>
 <div class="hl">HISTORY</div>
 <div class="blk" style="margin-top:0;padding:4px 13px" data-mk="hist">
  <div class="hr"><span class="w">Today 12:19</span><span class="x">Time 10:00 → 09:00</span>${WHO('', 'Session')}<span class="u">Undo</span></div>
  <div class="hr"><span class="w">Today 12:19</span><span class="x">Access → Open a PR</span>${WHO('you', 'You allowed')}</div>
  <div class="hr"><span class="w">Today 10:00</span><span class="x">Known 0.49.0 · <a class="sx-link">session</a></span></div>
  <div class="hr"><span class="w">Nov 13 10:01</span><span class="x" style="color:var(--success)">New 0.49.0 · <a class="sx-link">session</a></span></div>
  <div class="hr"><span class="w">Nov 12 13:50</span><span class="x">Prompt: check the releases page, not the changelog</span>${WHO('run', 'Run')}<span class="u">Undo</span></div>
  <div class="hr"><span class="w">Nov 12 13:47</span><span class="x">No change · late, runner offline</span></div>
 </div>
</aside>`;

const INSP_DRAFT = `<aside class="rm-insp" data-mk="insp">
 <div class="tt" style="color:var(--text-2)">Weekday issue summary</div>
 <div class="meta">Draft · set up by the agent in apiserver from what you typed</div>
 <div class="blk" style="color:var(--text-2)">“every weekday at 9, summarise new GitHub issues in orbit and tell me only if there are any”</div>
 <div class="card2" data-mk="card">
  <div class="hd"><span style="color:var(--brand)">${I.cal}</span>Create scheduled task?</div>
  <div class="rb">Every weekday at 09:00 I list the issues opened in orbit since the last run, grouped by label, and tell you only when there are any.</div>
  <div class="kv"><span class="k">When</span><span>Weekdays at 09:00 · Asia/Shanghai<br><span style="color:var(--text-3)">First run Monday</span></span>
  <span class="k">Runs in</span><span>apiserver · Claude agent</span>
  <span class="k">May</span><span><b>Check only</b> · reads and reports, edits nothing</span>
  <span class="k">Costs</span><span data-mk="costs">Up to <b>5 runs a week</b>, 30 min each</span>
  <span class="k">Today</span><span data-mk="today">12 issues are open now. The first run reports what comes after.</span></div>
  <div class="nt">You'll hear about new issues and failures only.</div>
  <div class="ft"><a class="sx-link" style="margin-right:auto;align-self:center;font-size:13px" data-mk="conv">Open conversation</a><button class="sx-btn">Not now</button><button class="sx-btn pri">Create</button></div>
 </div>
</aside>`;

const EMPTY = () => `<div class="rm-list"><div class="rm-head"><h1>Scheduled</h1><span class="n">0</span></div>
 <div style="color:var(--text-2);margin:22px 0 4px;font-size:14px">Nothing scheduled. Say what should happen and when; an agent sets it up and asks you once.</div>
 ${ADD(false, 'Describe a scheduled task…', 'add')}
 <div class="rm-ex" data-mk="ex"><div>Every day at 10:00, check the Codex stable release against our pinned version</div><div>Every Monday at 9, list dependencies with known vulnerabilities</div><div>At 18:00 today, check that the deploy is healthy and tell me</div></div></div>`;

async function base(page, { navCount = 2 } = {}) {
  await page.evaluate(({ CSS, NAVHTML }) => {
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (n.textContent.includes('Baseline Reviewer')) n.textContent = 'Mia Chen'; }
    const items = [...document.querySelectorAll('.tp-section .tp-item')];
    items.find((e) => e.textContent.includes('Tasks')).insertAdjacentHTML('afterend', NAVHTML);
    for (const e of document.querySelectorAll('.tp-item')) { if (e.dataset.mk === 'nav') continue; e.classList.remove('active'); e.removeAttribute('aria-current'); }
  }, { CSS, NAVHTML: NAV(navCount) });
}
async function main(page, html) {
  await page.evaluate((html) => { const v = document.querySelector('.app-view'); for (const c of v.children) c.style.display = 'none';
    const d = document.createElement('div'); d.id = 'sx-main'; d.className = 'rm'; d.innerHTML = html; v.append(d); }, html);
}
async function marks(page, list) { await page.evaluate((list) => { window.__mk = list; }, list); }
async function placeMarks(page) {
  await page.evaluate(() => {
    (window.__mk || []).forEach(([sel, n, dx = 0, dy = 0]) => {
      const el = document.querySelector(sel); if (!el) { console.error('no mark target ' + sel); return; }
      const r = el.getBoundingClientRect(); const m = document.createElement('div');
      m.className = 'sx-mk'; m.textContent = n;
      m.style.left = (r.right - 12 + dx) + 'px'; m.style.top = (r.top - 10 + dy) + 'px';
      document.body.append(m);
    });
  });
}

const scenes = {
  timeline: async (p) => { await base(p); await main(p, LIST()); await marks(p, [['[data-mk=nav]', 1], ['[data-mk=needs] h2', 2, -900], ['[data-mk=running] .rm-c', 3, 4], ['[data-mk=past]', 4], ['[data-mk=add] .ws', 5], ['[data-mk=once] .rm-c', 6, 4]]); },
  inspector: async (p) => { await base(p); await main(p, LIST({ past: true, sel: 'codex' }) + INSP_CODEX); await marks(p, [['[data-mk=pastrow] .rm-c', 1, 4], ['[data-mk=codex] .rm-c', 2, 4], ['[data-mk=btns]', 3], ['[data-mk=asked]', 4], ['[data-mk=note]', 5], ['[data-mk=use]', 6], ['[data-mk=hist]', 7]]); },
  quickadd: async (p) => { await base(p); await main(p, LIST({ draft: true, typed: '' }) + INSP_DRAFT); await marks(p, [['[data-mk=draft] .rm-c', 1, 4], ['[data-mk=card]', 2], ['[data-mk=costs]', 3, 30], ['[data-mk=today]', 4, 14], ['[data-mk=conv]', 5, 6, -2]]); },
  typing: async (p) => { await base(p); await main(p, LIST({ typed: 'every weekday at 9, summarise new GitHub issues in orbit and tell me only if there are any' })); await marks(p, [['[data-mk=add] .hint', 1, 4]]); },
  empty: async (p) => { await base(p, { navCount: 0 }); await main(p, EMPTY()); await marks(p, [['[data-mk=add] .ws', 1], ['[data-mk=ex]', 2, -200]]); },
};

const b = await launch();
for (const [name, fn] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const s = await open(b, { path: '/tasks', width: 1440, height: { inspector: 1200, quickadd: 1020 }[name] ?? 900 });
  await s.page.waitForTimeout(1200);
  await fn(s.page); await settle(s.page); await s.page.waitForTimeout(500);
  await s.page.evaluate(() => { const v = document.querySelector('.app-view'); const me = document.getElementById('sx-main');
    if (me) for (const c of v.children) if (c !== me) c.style.display = 'none'; });
  if (name === 'typing') await s.page.evaluate(() => { const l = document.querySelector('.rm-list'); l.scrollTop = l.scrollHeight; });
  await settle(s.page); await placeMarks(s.page);
  await s.page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, s.errors.filter((e) => !e.includes('501')).slice(0, 2).join(' | ').slice(0, 300));
  await s.context.close();
}
await b.close();
