// Builds the three board pages and renders them to PNG. Usage: node build.mjs <path to playwright-core/index.mjs>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const here = path.dirname(new URL(import.meta.url).pathname);
const { chromium } = await import(pathToFileURL(process.argv[2]).href);

const CSS = `
:root{--bg:#fff;--sub:#fafbfc;--sunk:#f7f8fa;--hov:#f5f6f7;--bd:#dee0e3;--bds:#eceef1;--t1:#1f2329;--t2:#646a73;--t3:#8f959e;--brand:#3370ff;--bt:#eaf1ff;--bb:#bcd3ff;--ok:#1a7f37;--okb:#e8f6ec;--okbd:#b6e7c4;--er:#cf3b35;--erb:#fdeceb;--erbd:#ffccc7;--wa:#c2710c;--wab:#fff4e6;--wabd:#ffd591;--inv:#1f2329}
.dark{--bg:#202023;--sub:#252528;--sunk:#17171a;--hov:#343437;--bd:#424246;--bds:#343437;--t1:#c9ced5;--t2:#a7adb6;--t3:#80858e;--brand:#6d9bff;--bt:#1d2a47;--bb:#2f4a80;--ok:#5ec27a;--okb:#16301f;--okbd:#245a35;--er:#ff7b72;--erb:#3a1c1b;--erbd:#6b2b28;--wa:#f0a050;--wab:#3a2a14;--wabd:#6b4a1c;--inv:#c9ced5}
*{box-sizing:border-box;margin:0}
body{font:14px/1.5 Inter,-apple-system,"Helvetica Neue",Arial,sans-serif;background:#e9ebef;color:#1f2329;padding:32px}
.board{width:1700px}
h1{font-size:26px}h2{font-size:18px;margin:34px 0 6px}h3{font-size:14px;margin:0 0 6px}
.lead{color:#646a73;margin:4px 0 16px;max-width:1100px}
.row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.frame{background:#fff;border:1px solid #cfd3da;border-radius:10px;padding:14px}
.frame>.cap{font-size:12px;font-weight:600;margin-bottom:10px;display:flex;gap:8px;align-items:center}
.tag{font-size:11px;padding:1px 8px;border-radius:10px;background:#e8f6ec;color:#1a7f37;border:1px solid #b6e7c4}
.tag.alt{background:#f1f1f4;color:#646a73;border-color:#dee0e3}
.note{font-size:12px;color:#646a73;margin-top:10px;max-width:640px}
.rec{background:#fff;border-left:4px solid #3370ff;padding:10px 14px;margin:10px 0;max-width:1100px;font-size:13px}
.theme{background:var(--bg);color:var(--t1);border-radius:8px;border:1px solid var(--bd)}
.page{padding:18px 20px;width:640px}
.sec{border:1px solid var(--bd);border-radius:8px;background:var(--bg);margin-bottom:14px}
.sec-h{padding:10px 14px;font-weight:600;border-bottom:1px solid var(--bds)}
.sec-s{font-size:12px;color:var(--t2);padding:8px 14px 0}
.opt{display:flex;gap:10px;padding:12px 14px;border-top:1px solid var(--bds)}
.sec-s+.opt{border-top:0}
.radio{flex:none;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--t3);margin-top:3px;position:relative}
.radio.on{border-color:var(--brand)}.radio.on:after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--brand)}
.radio.dis{opacity:.4}
.ot{font-weight:600;display:flex;gap:8px;align-items:center}
.od{font-size:12.5px;color:var(--t2);margin-top:2px}
.badge{font-size:11px;font-weight:500;padding:0 7px;border-radius:9px;background:var(--bt);color:var(--brand);border:1px solid var(--bb)}
.badge.f{background:var(--sunk);color:var(--t2);border-color:var(--bd)}
.warn{margin:0 14px 12px;padding:10px 12px;border-radius:6px;background:var(--wab);border:1px solid var(--wabd);color:var(--wa);font-size:12.5px}
.link{color:var(--brand)}
.sel{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bd);border-radius:6px;padding:5px 10px;min-width:170px;background:var(--bg)}
.kv{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 14px;border-top:1px solid var(--bds)}
.kv .od{max-width:340px}
.sd{opacity:.5}
/* landing card */
.lc{border:1px solid var(--bd);border-radius:8px;background:var(--bg);padding:12px 14px;width:560px}
.lh{display:flex;align-items:center;gap:8px;font-weight:600}
.ic{width:18px;height:18px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#fff;background:var(--brand)}
.ic.ok{background:var(--ok)}.ic.er{background:var(--er)}.ic.wa{background:var(--wa)}.ic.run{background:transparent;border:2px solid var(--brand);border-top-color:transparent}
.cnt{margin-left:auto;font-weight:500;font-size:12px;color:var(--t2)}
.pill{font-size:11px;font-weight:500;padding:0 8px;border-radius:9px}
.pill.wa{background:var(--wab);color:var(--wa);border:1px solid var(--wabd)}
.ld{font-size:12.5px;color:var(--t2);margin:6px 0 0 26px}
.acts{display:flex;gap:14px;margin:8px 0 0 26px;font-size:12.5px}
.bar{display:flex;gap:3px;margin:8px 0 0 26px}.bar i{height:4px;flex:1;border-radius:2px;background:var(--bds)}.bar i.g{background:var(--ok)}.bar i.r{background:var(--er)}.bar i.b{background:var(--brand)}
.tip{margin:10px 0 0 26px;padding:7px 10px;border-radius:6px;background:var(--bt);border:1px solid var(--bb);font-size:12.5px;color:var(--t1);display:flex;gap:8px;align-items:flex-start}
.tip .x{margin-left:auto;color:var(--t3)}
.cell{display:flex;flex-direction:column;gap:8px}
.cell .l{font-size:11px;font-weight:600;color:#646a73;text-transform:uppercase;letter-spacing:.04em}
.grid{display:grid;grid-template-columns:repeat(2,auto);gap:18px 24px}
/* phones */
.phone{width:393px;height:852px;border-radius:38px;border:1px solid #aab;background:var(--bg);color:var(--t1);overflow:hidden;position:relative;font-size:15px}
.phone.and{border-radius:26px;font-family:Roboto,Inter,Arial,sans-serif}
.sb{height:46px;display:flex;justify-content:space-between;padding:16px 28px 0;font-size:13px;font-weight:600}
.nav{padding:6px 16px 10px;font-size:20px;font-weight:700;display:flex;justify-content:space-between;align-items:center}
.nav small{font-size:15px;font-weight:400;color:var(--brand)}
.pg{background:var(--sunk);position:absolute;inset:92px 0 0 0;padding:14px 14px;overflow:hidden}
.pg .sec{margin-bottom:12px}
.pg .opt{padding:12px 12px}
.pcard{border:1px solid var(--bd);border-radius:12px;background:var(--bg);padding:12px;margin-bottom:12px}
.pcard .ld,.pcard .acts,.pcard .bar,.pcard .tip{margin-left:0}
.pcard .lh{font-size:15px}
.pcard .acts{gap:18px;font-size:14px}
.pcard .ld{font-size:13.5px}
.lbl{font-size:12px;font-weight:600;color:var(--t3);text-transform:uppercase;margin:4px 4px 8px}
.and .sec{border-radius:12px}
.btn{display:inline-block;padding:6px 12px;border-radius:6px;border:1px solid var(--bd);font-size:13px;background:var(--bg)}
.sw{width:34px;height:20px;border-radius:10px;background:var(--bd);position:relative;flex:none}.sw.on{background:var(--brand)}.sw:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff}.sw.on:after{left:16px}
`;
const sh = (t,body,cls='')=>`<!doctype html><meta charset=utf-8><style>${CSS}</style><body><div class="board">${body}</div></body>`;

// ---- shared bits
const COPY = {
  prTitle:'Pull request', prBadge:'Default',
  prDesc:'Orbit pushes to main when GitHub allows it. When main requires a pull request, Orbit opens one and merges it once the branch’s rules pass: required checks, and a review if one is required.',
  pmTitle:'Push as me', pmBadge:'Faster',
  pmDesc:'Orbit pushes to main with your GitHub account, so a landing doesn’t wait for a pull request where you may push past main’s rules. Needs the right to push to main. If GitHub refuses, Orbit opens a pull request instead.',
  refusal:'GitHub refused your last push to main on acme/api: “Changes must be made through a pull request.” Landings here open a pull request until GitHub accepts your push. Connect GitHub again if your rights have changed.',
};
const radio=(on,dis)=>`<span class="radio ${on?'on':''} ${dis?'dis':''}"></span>`;
const optA=(sel,extra='',dis=false)=>`
 <div class="sec"><div class="sec-h">Landing</div><div class="sec-s">How finished work reaches main on GitHub.</div>
  <div class="opt">${radio(sel==='pr')}<div><div class="ot">${COPY.prTitle}<span class="badge">${COPY.prBadge}</span></div><div class="od">${COPY.prDesc}</div></div></div>
  <div class="opt ${dis?'sd':''}">${radio(sel==='pm',dis)}<div><div class="ot">${COPY.pmTitle}<span class="badge f">${COPY.pmBadge}</span></div><div class="od">${COPY.pmDesc}</div>${dis?'<div class="od" style="color:var(--t1);opacity:2">Connect GitHub to push as yourself. <span class="link">Connect GitHub ›</span></div>':''}</div></div>
  ${extra}</div>`;
const optB=(extra='')=>`
 <div class="sec"><div class="sec-h">Sessions</div>
  <div class="kv" style="border-top:0"><div><div class="ot">Max concurrent sessions</div><div class="od">How many sessions this machine runs at once.</div></div><div class="sel">4 <span>⌄</span></div></div>
  <div class="kv"><div><div class="ot">Land work by</div><div class="od">Pull request waits for the branch’s rules. Push as me can be faster because it doesn’t wait for a pull request, and needs the right to push to main.</div></div><div class="sel">Pull request <span>⌄</span></div></div>${extra}</div>`;
const optC=()=>`
 <div class="sec"><div class="sec-h">Landing</div>
  <div class="kv" style="border-top:0"><div><div class="ot">Push as me <span class="badge f">Faster</span></div><div class="od">Land straight on main with your GitHub account, without waiting for a pull request. Needs the right to push to main. If GitHub refuses, Orbit opens a pull request instead.</div></div><span class="sw"></span></div>
  <div class="sec-s" style="padding-bottom:12px">Off: Orbit pushes when GitHub allows it, and otherwise opens a pull request and merges it once the branch’s rules pass.</div></div>`;
const side=(inner,dark)=>`<div class="theme ${dark?'dark':''} page"><div style="font-size:12px;color:var(--t3);margin-bottom:10px">Workspace settings › acme/api</div>${inner}</div>`;
const fr=(cap,html,tag)=>`<div class="frame"><div class="cap">${cap}${tag?`<span class="tag ${tag==='Recommended'?'':'alt'}">${tag}</span>`:''}</div>${html}</div>`;

// ---- Board 1: setting (web)
const b1 = `<h1>Landing setting — web</h1>
<p class="lead">Workspace settings gain one way to choose how finished work reaches the target branch. “main” stands for the workspace’s target branch, whatever it is called. Source: docs/design/protected-branch-landing.md §11.1.</p>
<div class="rec"><b>Recommendation: A.</b> Both choices stay visible with what each costs, so the owner sees “faster” and “needs the right to push” side by side. B hides the trade-off behind a menu; C reads as a feature switch and loses the default’s explanation.</div>
<div class="row">
 ${fr('A · Landing section, two choices',side(optA('pr')),'Recommended')}
 ${fr('B · One “Land work by” row under Sessions',side(optB()),'Alternative')}
 ${fr('C · One switch, “Push as me”',side(optC()),'Alternative')}
</div>
<h2>Option A in its other states</h2>
<p class="lead">Push as me selected; GitHub not connected; after a refused push; a workspace not cloned from GitHub; dark mode.</p>
<div class="row">
 ${fr('A · Push as me selected',side(optA('pm')))}
 ${fr('A · GitHub not connected',side(optA('pr','',true)))}
 ${fr('A · After a refusal (amber notice)',side(optA('pm',`<div class="warn"><b>Push refused.</b> ${COPY.refusal} <span class="link">Connect GitHub again ›</span></div>`)))}
</div>
<div class="row" style="margin-top:20px">
 ${fr('A · Dark',side(optA('pr'),true))}
 ${fr('A · Not a GitHub workspace',side(`<div class="sec"><div class="sec-h">Landing</div><div class="od" style="padding:12px 14px">Landings push with this machine’s Git credential.</div></div>`))}
 ${fr('A · Installation has not accepted the new permissions',side(optA('pr',`<div class="warn">Landing through pull requests starts once <b>acme</b> accepts Orbit’s updated GitHub permissions. <span class="link">Review on GitHub ↗</span></div>`)))}
</div>
<h2>Label</h2>
<p class="lead">The design doc asks the board to settle the name of the default. Pull request mode now pushes directly when GitHub accepts the push, so a label that promises a pull request every time would be wrong.</p>
<div class="rec"><b>Recommendation: keep “Pull request” with the Default badge.</b> The description right under it says Orbit pushes when GitHub allows it. Alternatives: “Follow branch rules” (accurate, but says nothing to someone who has never met branch protection) or “Pull request if required” (accurate, long).</div>`;

// ---- Board 2: landing card web
const card=({icon,cls,head,cnt,pill,detail,acts,bar,tip})=>`<div class="lc"><div class="lh"><span class="ic ${cls}">${icon}</span>${head}${pill?`<span class="pill wa">${pill}</span>`:''}<span class="cnt">${cnt||''}</span></div>${bar?`<div class="bar">${bar}</div>`:''}<div class="ld">${detail}</div><div class="acts">${acts}</div>${tip||''}</div>`;
const bar=(g,r,b,n=6)=>Array.from({length:n},(_,i)=>`<i class="${i<g?'g':i<g+r?'r':i<g+r+b?'b':''}"></i>`).join('');
const TIP=`<div class="tip"><span>⚡</span><span>Faster next time: with Push as me, landings go straight to main when you may push there, without waiting for a pull request. <span class="link">Landing settings ›</span></span><span class="x">✕</span></div>`;
const STATES=(tip)=>({
 a:['a · Opened, checks running',card({icon:'',cls:'run',head:'Pull request open',cnt:'2 of 6',bar:bar(2,0,2),detail:'main requires a pull request. Waiting for the required checks.',acts:'<span class="link">View on GitHub ↗</span>'})],
 b:['b · Waiting for review',card({icon:'●',cls:'',head:'Waiting for review',cnt:'6 of 6 ✓',bar:bar(6,0,0),detail:'Checks passed. main requires an approving review.',acts:'<span class="link">Review on GitHub ↗</span>',tip})],
 c:['c · A required check failed',card({icon:'✕',cls:'er',head:'<span style="color:var(--er)">Check failed: PostgreSQL specs</span>',bar:bar(5,1,0),detail:'Sent back to the session with the log. Fixes update this pull request.',acts:'<span class="link">Open session</span><span class="link">View log ↗</span>'})],
 d:['d · main moved meanwhile',card({icon:'',cls:'run',head:'Catching up with main',cnt:'0 of 6',bar:bar(0,0,1),detail:'main moved since the pull request opened. Orbit is checking the branch again on the new main.',acts:'<span class="link">View on GitHub ↗</span>'})],
 e:['e · Merged',card({icon:'✓',cls:'ok',head:'Landed by pull request #214',cnt:'1 min ago',detail:'Merged into main · 3a9f1c2',acts:'<span class="link">View on GitHub ↗</span>'})],
 f:['f · Push as me refused, fell back to a pull request',card({icon:'!',cls:'wa',head:'Opened a pull request instead',pill:'Push refused',detail:'GitHub refused the push to main: “Changes must be made through a pull request.” Landing through pull request #214.',acts:'<span class="link">View on GitHub ↗</span><span class="link">Landing settings</span>'})],
 g:['Closed on GitHub',card({icon:'✕',cls:'er',head:'<span style="color:var(--er)">Pull request closed</span>',detail:'@sam closed pull request #214 without merging it.',acts:'<span class="link">Retry</span><span class="link">View on GitHub ↗</span>'})],
 h:['Direct push, Push as me',card({icon:'✓',cls:'ok',head:'Landed',cnt:'1 min ago',detail:'Pushed as you, past main’s rules · 3a9f1c2',acts:'<span class="link">View on GitHub ↗</span>'})],
});
const S=STATES(TIP), cellOf=([l,h],dark)=>`<div class="cell"><div class="l">${l}</div><div class="theme ${dark?'dark':''}" style="padding:10px">${h}</div></div>`;
const b2=`<h1>Landing card in each pull request state — web</h1>
<p class="lead">Drawn on the existing project landing card (head, count, detail, actions). A direct push GitHub accepts reads as a landing does today. Source: §11.2.</p>
<div class="row">
 ${['a','b','c','d','e','f'].map(k=>cellOf(S[k])).join('')}
</div>
<h2>Also drawn</h2>
<div class="row">${cellOf(S.g)}${cellOf(S.h)}</div>
<h2>Where the “Faster” tip lives (state b)</h2>
<div class="rec"><b>Recommendation: 1.</b> The review wait is the one moment the owner is actually paying for the pull request, and the tip is dismissible and never shown once Push as me is on. Option 2 keeps the card quiet but nobody opening the setting is waiting on a review. Option 3 is the quietest and the least discoverable.</div>
<div class="row">
 ${fr('1 · Tip inside the card, dismissible',`<div class="theme" style="padding:10px">${S.b[1]}</div>`,'Recommended')}
 ${fr('2 · No tip; the setting’s own copy only',`<div class="theme" style="padding:10px">${STATES('').b[1]}</div>`,'Alternative')}
 ${fr('3 · A quiet link “Landing settings ›” in the actions, no sentence',`<div class="theme" style="padding:10px">${card({icon:'●',cls:'',head:'Waiting for review',cnt:'6 of 6 ✓',bar:bar(6,0,0),detail:'Checks passed. main requires an approving review.',acts:'<span class="link">Review on GitHub ↗</span><span class="link">Landing settings ›</span>'})}</div>`,'Alternative')}
</div>
<h2>Dark mode</h2>
<div class="row">${['a','b','c','f'].map(k=>cellOf(S[k],true)).join('')}</div>
<h2>The Push as me fallback notice</h2>
<p class="lead">State f is the card. The same refusal also appears as the amber notice in the setting (board 1, “After a refusal”) and sends one push notification the first time it happens on a workspace. In Pull request mode a refused direct push is not shown as a failure: it is the reason the pull request exists, and state a says so.</p>`;

// ---- Board 3: phones
const phone=(title,body,dark,and)=>`<div class="phone ${dark?'dark':''} ${and?'and':''}"><div class="sb"><span>9:41</span><span>${and?'▲ ▮▮':'●●● ▮'}</span></div><div class="nav"><small>${and?'←':'‹ Back'}</small><span>${title}</span><small>&nbsp;</small></div><div class="pg">${body}</div></div>`;
const pcard=(o)=>card(o).replace('class="lc"','class="pcard"');
const phoneSet=(and,dark)=>phone('Landing',`<div class="lbl">Workspace · acme/api</div>${optA('pr')}`,dark,and);
const phoneSetPm=(and)=>phone('Landing',`<div class="lbl">Workspace · acme/api</div>${optA('pm',`<div class="warn"><b>Push refused.</b> GitHub refused your last push to main: “Changes must be made through a pull request.” Landings here open a pull request until GitHub accepts your push.</div>`)}`,false,and);
const phoneCards=(and,dark)=>phone('Landing',`<div class="lbl">Pull request states</div>${pcard({icon:'',cls:'run',head:'Pull request open',cnt:'2 of 6',bar:bar(2,0,2),detail:'main requires a pull request. Waiting for the required checks.',acts:'<span class="link">View on GitHub ↗</span>'})}${pcard({icon:'●',cls:'',head:'Waiting for review',cnt:'6 of 6 ✓',bar:bar(6,0,0),detail:'Checks passed. main requires an approving review.',acts:'<span class="link">Review on GitHub ↗</span>',tip:TIP})}${pcard({icon:'✕',cls:'er',head:'<span style="color:var(--er)">Check failed: PostgreSQL specs</span>',bar:bar(5,1,0),detail:'Sent back to the session with the log. Fixes update this pull request.',acts:'<span class="link">Open session</span><span class="link">View log ↗</span>'})}`,dark,and);
const phoneCards2=(and,dark)=>phone('Landing',`<div class="lbl">Pull request states</div>${pcard({icon:'✓',cls:'ok',head:'Landed by pull request #214',cnt:'1 min ago',detail:'Merged into main · 3a9f1c2',acts:'<span class="link">View on GitHub ↗</span>'})}${pcard({icon:'!',cls:'wa',head:'Opened a pull request instead',pill:'Push refused',detail:'GitHub refused the push to main: “Changes must be made through a pull request.” Landing through pull request #214.',acts:'<span class="link">View on GitHub ↗</span><span class="link">Landing settings</span>'})}${pcard({icon:'',cls:'run',head:'Catching up with main',cnt:'0 of 6',bar:bar(0,0,1),detail:'main moved since the pull request opened. Orbit is checking the branch again on the new main.',acts:'<span class="link">View on GitHub ↗</span>'})}`,dark,and);
const b3=`<h1>Phone layouts — iOS and Android</h1>
<p class="lead">iOS is the reference; Android follows its layout with Material spacing and a back arrow. The setting is the workspace’s settings sheet (iOS: agent settings form; Android: WorkspaceSettings). The same option A is drawn; B and C collapse to one row each in a list and need no separate phone drawing. The card’s actions wrap under the detail instead of sitting in one line.</p>
<div class="rec"><b>Recommendation:</b> same recommendations as web (setting A, tip in the review state). On a phone, option A’s two radio rows become two full-width tappable rows, which is easier to hit than a menu row.</div>
<h2>iOS</h2>
<div class="row">${phoneSet(false)}${phoneSetPm(false)}${phoneCards(false)}${phoneCards2(false)}</div>
<h2>Android</h2>
<div class="row">${phoneSet(true)}${phoneSetPm(true)}${phoneCards(true)}${phoneCards2(true)}</div>
<h2>Dark</h2>
<div class="row">${phoneSet(false,true)}${phoneCards(false,true)}${phoneSet(true,true)}${phoneCards(true,true)}</div>`;

const pages={'01-setting-web':b1,'02-landing-card-web':b2,'03-phones':b3};
const br=await chromium.launch();
for(const [n,b] of Object.entries(pages)){
  fs.writeFileSync(path.join(here,n+'.html'),sh(n,b));
  const p=await br.newPage({deviceScaleFactor:1.5,viewport:{width:1600,height:900}});
  await p.goto('file://'+path.join(here,n+'.html'));
  await p.evaluate(()=>document.fonts.ready);
  await p.locator('.board').screenshot({path:path.join(here,n+'.png')});
  await p.close();
}
await br.close();
