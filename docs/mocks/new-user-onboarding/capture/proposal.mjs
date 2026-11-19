// Proposal frames: today's real pages with the welcome card injected (built from the shipped .msc / .rsi classes).
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const only = process.argv.slice(2);
const marksFile = `${K}/marks.json`;
const marks = existsSync(marksFile) ? JSON.parse(readFileSync(marksFile, 'utf8')) : {};

const CHIPS = [
  'Build a one-page site that shows today’s weather for a city',
  'Read github.com/owner/repo and explain how it is put together',
  'Write a script that renames my photos by the date they were taken',
];
const chips = (picked) => `<div class="ob-chips">${CHIPS.map((c, i) => `<button type="button" class="ob-chip${picked === i ? ' on' : ''}">${c}</button>`).join('')}</div>`;
const check = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const icon = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';
const head = (sub) => `<div class="msc-head"><span class="msc-head-icon">${icon}</span><div><div class="msc-title">Welcome to Orbit, Mia</div><div class="msc-sub">${sub}</div></div></div>`;
const step = (n, title, help, body, done) => done
  ? `<div class="msc-step ob-done" data-step="s${n}"><span class="msc-num done">${check}</span><div><div class="msc-done-line"><b>${title}</b> <span class="ob-grey">${help}</span> <button class="msc-change" type="button">Change</button></div></div></div>`
  : `<div class="msc-step" data-step="s${n}"><span class="msc-num">${n}</span><div><div class="msc-step-title">${title}</div><div class="msc-step-help">${help}</div>${body}</div></div>`;
const signIn = `<div class="rsi"><div class="rsi-actions"><button class="rsi-btn" type="button">Sign in to Claude Code</button><button class="rsi-btn-alt" type="button">Use an API key instead</button></div></div><div class="msc-alt"><span><button class="msc-change" type="button">Use Codex instead</button></span></div>`;
const SUB = 'Orbit gives a coding agent a computer and a task, and keeps the conversation and its results here — on the web and on your phone.';

const CARDS = {
  managed: () => head(SUB)
    + step(1, 'A computer to work on', 'Orbit is starting one for you. You do not need to install anything.',
      `<div class="msc-verdict wait ob-verdict"><span class="ob-spin"></span>Starting managed-mia… usually under a minute</div><div class="msc-alt"><span><button class="msc-change" type="button">Use my own computer instead</button></span></div>`)
    + step(2, 'A model to think with', 'Sign in with your Claude or ChatGPT subscription, or paste an API key. It stays on that computer.', signIn)
    + step(3, 'Your first message', 'Pick one to try, or write your own below.', chips())
    + `<div class="msc-foot">You can send now — it starts as soon as steps 1 and 2 are done.</div>`,
  ready: () => head(SUB)
    + step(1, 'Computer', 'managed-mia is ready', '', true)
    + step(2, 'Model', 'Claude Code signed in · Mia’s Pro plan', '', true)
    + step(3, 'Your first message', 'Pick one to try, or write your own below.', chips(0))
    + `<div class="msc-foot ready">All set. Send it and the agent starts right away.</div>`,
  own: () => head(SUB)
    + step(1, 'A computer to work on', 'Connect the computer you want the agent to work on. Run this there:',
      `<div class="ob-cmd"><span class="ob-dollar">$</span> curl -fsSL https://orbit.example.com/install.sh | bash<button class="ob-copy" type="button">Copy</button></div><div class="msc-verdict wait ob-verdict"><span class="ob-spin"></span>Waiting for it to connect… this page moves on by itself</div><div class="msc-alt"><span><button class="msc-change" type="button">macOS</button> · <button class="msc-change" type="button">Linux</button> · <button class="msc-change" type="button">Windows</button> · <button class="msc-change" type="button">Having trouble?</button></span></div>`)
    + step(2, 'A model to think with', 'Once it is connected, sign in a coding CLI on it, or use an API key.', '<div class="ob-later">Opens after step 1</div>')
    + step(3, 'Your first message', 'Pick one to try, or write your own below.', chips())
    + `<div class="msc-foot">You can send now — it starts as soon as steps 1 and 2 are done.</div>`,
};
const CSS = `
.ob-card{margin:0 auto 14px;max-width:760px;width:100%}
.ob-chips{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.ob-chip{all:unset;cursor:pointer;font-size:13px;line-height:18px;padding:7px 12px;border:1px solid var(--orbit-border,#e4e4e7);border-radius:8px;color:var(--orbit-text,#1f2328);background:var(--orbit-surface,#fff)}
.ob-chip.on{border-color:#3b82f6;background:#eef4ff;color:#1d4ed8}
.ob-grey{color:#6b7280;font-weight:400}
.ob-verdict{display:flex;align-items:center;gap:8px;margin-top:8px}
.ob-spin{width:12px;height:12px;border-radius:50%;border:2px solid #bfd3fb;border-top-color:#3b82f6;display:inline-block}
.ob-cmd{position:relative;margin-top:8px;font:12.5px/1 "JetBrains Mono",monospace;background:#f4f5f7;border:1px solid #e4e4e7;border-radius:8px;padding:11px 12px}
.ob-dollar{color:#9ca3af;margin-right:6px}
.ob-copy{all:unset;cursor:pointer;position:absolute;right:6px;top:5px;font:12px Inter,sans-serif;border:1px solid #e4e4e7;background:#fff;border-radius:6px;padding:4px 10px}
.ob-later{margin-top:6px;font-size:12.5px;color:#9ca3af}
.ob-done .msc-done-line{display:flex;gap:6px;align-items:baseline}
`;
async function inject(page, kind, { composer, removeRegister } = {}) {
  await page.locator('textarea').first().waitFor();
  await page.addStyleTag({ content: CSS });
  await page.evaluate(({ html, composer }) => {
    const card = document.createElement('div');
    card.className = 'msc ob-card';
    card.innerHTML = html;
    const notice = document.querySelector('.managed-runner-notice');
    const field = document.querySelector('.composer-field') || document.querySelector('textarea');
    if (notice) notice.replaceWith(card);
    else {
      let box = field; while (box && box.parentElement && !box.parentElement.contains(document.querySelector('.msc, .chat-scroll'))) box = box.parentElement;
      (field.closest('form') || field.parentElement).before(card);
    }
    const ta = document.querySelector('textarea');
    if (ta) { ta.placeholder = 'Describe a task for the agent…'; if (composer) { ta.value = composer; ta.style.color = 'inherit'; } }
  }, { html: CARDS[kind](), composer });
}
async function boxes(page, sels) {
  return page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, s]) => {
    const el = document.querySelector(s); if (!el) return [k, null];
    const r = el.getBoundingClientRect(); return [k, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }];
  })), sels);
}
const SELS = { card: '.ob-card', s1: '[data-step="s1"]', s2: '[data-step="s2"]', s3: '[data-step="s3"]', foot: '.ob-card .msc-foot', composer: '.composer-field', side: '.tp-group, nav' };
const scenes = {
  'p-managed': async (b) => { const s = await open(b, { path: '/', routes: D.fleetRoutes({ runners: [D.R_OFF], workspaces: [D.WS(D.R_OFF)], managed: D.MR.preparing }) }); await s.page.waitForTimeout(1200); await inject(s.page, 'managed'); return s; },
  'p-ready': async (b) => { const s = await open(b, { path: '/', routes: D.fleetRoutes({ runners: [D.R_IN], workspaces: [D.WS(D.R_IN)], managed: D.MR.available }) }); await s.page.waitForTimeout(1200); await inject(s.page, 'ready'); await s.page.locator('textarea').fill('Build a one-page site that shows today’s weather for a city'); await s.page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (n.textContent.includes('Send a task to get started')) { let e = n.parentElement; while (e.parentElement && !e.parentElement.querySelector('.ob-card')) e = e.parentElement; e.style.visibility = 'hidden'; break; } } }); return s; },
  'p-own': async (b) => { const s = await open(b, { path: `/runners/${D.RID}/new`, routes: D.fleetRoutes({ runners: [{ ...D.R_OFF, name: 'mia-macbook' }], workspaces: [] }) }); await s.page.waitForTimeout(1500);
    await s.page.evaluate(() => { document.querySelector('.msc')?.remove(); });
    await inject(s.page, 'own'); return s; },
};
const fix = (page, own) => page.evaluate((own) => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode;
    if (n.textContent.includes('Baseline Reviewer')) n.textContent = n.textContent.replace('Baseline Reviewer', 'Mia Chen');
    if (own && n.parentElement && !n.parentElement.closest('.ob-card') && n.textContent.includes('mia-macbook')) n.textContent = n.textContent.replace('mia-macbook', 'Get started');
  }
}, own);
const b = await launch();
for (const [name, fn] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const s = await fn(b);
  await fix(s.page, name === 'p-own');
  await settle(s.page);
  marks[name] = await boxes(s.page, SELS);
  await s.page.screenshot({ path: `${K}/shots/${name}.png` });
  console.log(name, s.page.url().replace(/^https?:\/\/[^/]+/, ''), JSON.stringify(marks[name]));
  await s.context.close();
}
writeFileSync(marksFile, JSON.stringify(marks, null, 1));
await b.close();
