import fs from 'node:fs';
const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height }; }, sel);
async function clip(page, K, name, sel, pad = 16, extra = {}) {
  const b = await box(page, sel);
  const c = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2, ...extra };
  await page.screenshot({ path: `${K}/shots/${name}.png`, clip: c, fullPage: true });
  console.log(name, JSON.stringify(c));
}
const HEAD = '.project-detail-identity';
const headClip = async (page, K, name) => {
  const b = await page.evaluate(() => { const a = document.querySelector('.project-detail-identity').getBoundingClientRect(); const z = document.querySelector('.project-integration').getBoundingClientRect(); return { x: a.x - 16, y: a.y - 40, width: a.width + 32, height: z.bottom - a.y + 56 }; });
  await page.screenshot({ path: `${K}/shots/${name}.png`, clip: b, fullPage: true }); console.log(name, JSON.stringify(b));
};
// ---------- non-code proposal DOM, in the console's own classes ----------
function injectNonCode(page, { who }) {
  return page.evaluate(({ who }) => {
    const meta = document.querySelector('.project-detail-meta');
    const open = meta.querySelector('.orbit-badge');
    const b = document.createElement('span'); b.className = 'orbit-badge orbit-badge-default'; b.innerHTML = '<span>Non-code</span>'; b.id = 'mk-badge';
    open.after(b);
    const line = document.querySelector('.project-integration-facts');
    line.innerHTML = `<span id="mk-line">Non-code project · Orbit checks the criteria only, not where work landed</span>`;
    const runs = document.querySelector('.project-run-settings');
    runs.querySelector('.project-run-settings-summary div span').textContent = 'Non-code · 3 tasks at a time';
    const groups = runs.querySelectorAll('.project-run-settings-group');
    const exec = groups[0];
    const settings = [...exec.querySelectorAll(':scope > .project-integration-setting')];
    const tasksLand = settings[0], delivery = settings[1];
    const row = document.createElement('div'); row.className = 'project-integration-setting'; row.id = 'mk-delivers';
    row.innerHTML = `<div class="project-integration-setting-label">Delivers</div><div><div role="radiogroup" class="orbit-radio-group project-run-lines">
      <label class="orbit-choice orbit-radio-button"><span data-unchecked="" role="radio" class="orbit-radio"></span><span class="orbit-choice-label"><b>Code</b><div class="project-integration-setting-hint">Tasks land on a branch, and the done card checks the work reached main.</div></span></label>
      <label class="orbit-choice orbit-radio-button"><span data-checked="" role="radio" class="orbit-radio"></span><span class="orbit-choice-label"><b>Not code</b><div class="project-integration-setting-hint">Documents, accounts, approvals. Orbit checks the criteria only; nothing lands.</div></span></label></div>
      <div class="project-integration-setting-hint" id="mk-who" style="margin-top:6px;color:var(--orbit-color-text,#1f1f1f)">${who}</div></div>`;
    exec.insertBefore(row, tasksLand);
    tasksLand.remove(); delivery.remove();
    const integ = groups[1];
    const merge = integ.querySelector('.project-integration-setting');
    const gone = document.createElement('div'); gone.className = 'project-integration-setting'; gone.id = 'mk-gone';
    gone.innerHTML = `<div class="project-integration-setting-label">Landing</div><div><div class="project-integration-setting-hint" style="margin-top:0">Off for a non-code project: Tasks land on, Delivery and Merge check don't apply. Switch Delivers to Code to bring them back.</div></div>`;
    merge.replaceWith(gone);
  }, { who });
}
export async function web1({ open, K }) {
  { const { page, context } = await open({});
    await headClip(page, K, 'w-head-today');
    await clip(page, K, 'w-runs-today', '.project-run-settings');
    await context.close(); }
  { const { page, context } = await open({});
    await injectNonCode(page, { who: 'Marked non-code by the coordinator · Nov 11, 18:20 — “All work is documents and vendor accounts; no repository.”' });
    await page.waitForTimeout(200);
    await headClip(page, K, 'w-head-noncode');
    await clip(page, K, 'w-runs-noncode-coord', '.project-run-settings');
    await page.evaluate(() => { document.getElementById('mk-who').textContent = 'Marked non-code by you · just now'; const s = document.querySelector('.project-integration-setting-actions .orbit-button-primary'); s.removeAttribute('disabled'); s.removeAttribute('data-disabled'); });
    await clip(page, K, 'w-runs-noncode-owner', '.project-run-settings');
    await context.close(); }
}
export async function web3({ open, K }) {
  const { page, context } = await open({});
  await clip(page, K, 'w-acc-today', '.acceptance-card');
  await context.close();
}
function injectConfirm(page, { menu = false } = {}) {
  return page.evaluate(({ menu }) => {
    const card = document.querySelector('.acceptance-card');
    card.querySelector('.acceptance-standing').textContent = '8 criteria stated. 2 are met by their tasks; 6 by a confirmation — from you, the coordinator, or an Agent check.';
    card.querySelector('.acceptance-note-wide').textContent = 'A criterion met by its tasks is read off the work filed under it. A criterion met by confirmation says who confirmed it, when, and what they checked; it goes back to not met when its wording changes or the confirmation is withdrawn.';
    const rows = [...card.querySelectorAll('.acceptance-row')];
    const btn = (t, primary) => `<button type="button" class="orbit-button ${primary ? 'orbit-button-default' : 'orbit-button-text'} orbit-button-small"><span>${t}</span></button>`;
    const link = (t) => `<a class="acceptance-held-up-title" href="#">${t}</a>`;
    const note = (t) => `<div class="acceptance-unmet-clause" style="margin-top:4px">${t}</div>`;
    const acts = (...b) => `<div style="display:flex;gap:6px;margin-top:6px">${b.join('')}</div>`;
    const set = (i, html, met) => {
      const r = rows[i]; const w = r.querySelector('.acceptance-work');
      w.outerHTML = `<div class="acceptance-work" id="mk-r${i + 1}">${html}</div>`;
      r.querySelector('.acceptance-unmet')?.remove();
      r.querySelector('.acceptance-row-no').className = `acceptance-row-no ${met ? 'is-met' : 'is-unmet'}`;
    };
    const state = (t, met) => `<span class="acceptance-work-state ${met ? 'is-met' : 'is-unmet'}">${t}</span>`;
    const tail = (t) => `<span class="acceptance-landing">${t}</span>`;
    set(2, `${state('Met · confirmed by you', true)}${tail('Nov 10, 16:02 · ')}${link('Withdraw')}</div>${note('“Aliyun SMS template SMS_4821 shows Approved.” · ' + link('1 screenshot'))}<div>`, true);
    set(3, `${state('Met · confirmed by the coordinator', true)}${tail('Nov 11, 10:42 · ')}${link('Withdraw')}</div>${note('“AppID wx3f… shows Approved on open.weixin.qq.com (owner forwarded the email).”')}<div>`, true);
    set(4, `${state('Met · Agent check passed', true)}${tail('Nov 11, 14:05 · ')}${link('View run')}</div>${note('PASS — merchant 1650…22 is Active on the payment console.')}<div>`, true);
    set(5, `${state('Not met · Agent check failed', false)}${tail('Nov 11, 15:30 · ')}${link('View run')}</div>${note('FAIL — no filing number for cbai.example.cn on beian.miit.gov.cn.')}${acts(btn('Confirm…', true), btn('Run the check again'))}<div>`, false);
    set(6, `${state('Waiting · Agent check running', false)}${tail('started 2 min ago · ')}${link('View run')}</div>${acts(btn('Confirm…', true))}<div>`, false);
    set(7, `${state('Not met · confirmed for an earlier wording', false)}</div>${note('You confirmed revision 1 on Nov 9. The wording changed on Nov 11 (revision 2: “…and names the SMS vendor”).')}${acts(btn('Confirm again…', true), btn('Run a check'), btn('Compare wording'))}<div>`, false);
    // mode selector under each row
    rows.forEach((r, i) => {
      const m = r.querySelector('.acceptance-method');
      const s = document.createElement('span'); s.className = 'mk-mode';
      s.style.cssText = 'margin-left:14px;font-size:12px;color:var(--orbit-color-text-secondary,#666)';
      s.innerHTML = i < 2 ? 'Met by: <b>its tasks</b> ▾' : 'Met by: <b>confirmation</b> ▾';
      m.querySelector('button').after(s); m.style.display = 'flex'; m.style.alignItems = 'baseline';
    });
    if (menu) {
      const s = rows[6].querySelector('.mk-mode'); s.style.position = 'relative'; s.id = 'mk-menu-anchor';
      s.innerHTML = 'Met by: <b>its tasks</b> ▾';
      { const rt = rows[6].querySelector('.acceptance-row-text'); let n = rows[6].querySelector('.acceptance-work').nextElementSibling; while (n && !n.classList.contains('acceptance-method')) { const x = n.nextElementSibling; n.remove(); n = x; } }
      rows[6].querySelector('.acceptance-work').outerHTML = `<div class="acceptance-work">${state('Not met by its work', false)}</div><div class="acceptance-unmet"><div class="acceptance-unmet-reason"><div class="acceptance-unmet-clause">No task says it serves this criterion.</div></div></div>`;
      const pop = document.createElement('div'); pop.id = 'mk-menu';
      pop.style.cssText = 'position:absolute;left:0;top:22px;z-index:20;background:#fff;border:1px solid #e5e5ea;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.14);padding:6px;width:330px;font-size:13px;color:#1f1f1f';
      pop.innerHTML = `<div style="padding:7px 10px;border-radius:6px;background:#f2f4f7"><b>✓ Its tasks</b><div style="color:#777;font-size:12px">Met when the work filed under it is done.</div></div>
        <div style="padding:7px 10px"><b>&nbsp;&nbsp;&nbsp;Confirmation</b><div style="color:#777;font-size:12px">Met when you, the coordinator or an Agent check confirms it. For facts outside the code: filings, approvals, accounts.</div></div>`;
      s.appendChild(pop);
    }
  }, { menu });
}
export async function web3b({ open, K }) {
  const D = await import(`${K}/data.mjs`);
  for (const menu of [false, true]) {
    const { page, context } = await open({ height: 3800, projectOver: { acceptanceCriteriaItems: D.confirmCriteria() } });
    await injectConfirm(page, { menu });
    await page.waitForTimeout(200);
    await clip(page, K, menu ? 'w-acc-mode-menu' : 'w-acc-confirmers', '.acceptance-card', 16, menu ? {} : {});
    await context.close();
  }
}
