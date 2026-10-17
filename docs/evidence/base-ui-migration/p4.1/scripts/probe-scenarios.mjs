export const styleOf = (props) => (el) => {
  const s = getComputedStyle(el); const r = el.getBoundingClientRect();
  return { tag: el.tagName, cls: el.className?.baseVal ?? el.className, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, ...Object.fromEntries(props.map((p) => [p, s[p]])) };
};
export async function modeOpen({ page }) {
  await page.goto('/settings');
  await page.getByText('Default permission mode', { exact: true }).waitFor();
  await page.getByRole('combobox').first().click();
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const opt = [...document.querySelectorAll('.ant-select-item-option')].find((o) => o.textContent === 'Plan');
    const chain = [];
    for (let n = opt; n; n = n.parentElement) chain.push({ cls: n.className, opacity: getComputedStyle(n).opacity, anim: getComputedStyle(n).animationName });
    return chain.slice(0, 8);
  });
}

const PROPS = ['display', 'position', 'boxSizing', 'width', 'height', 'margin', 'padding', 'border', 'borderTop', 'borderBottom', 'borderRadius', 'background', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'gap', 'flexDirection', 'alignItems', 'justifyContent', 'boxShadow', 'outline', 'opacity', 'transition', 'animationName', 'textAlign', 'whiteSpace', 'verticalAlign', 'cursor', 'overflow', 'textOverflow', 'minHeight', 'zIndex', 'transform', 'insetInlineStart', 'top', 'left', 'right', 'bottom'];
export async function dumpTree(page, rootSelector, maxDepth = 12) {
  return page.evaluate(([sel, props, maxDepth]) => {
    const root = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!root) return { missing: sel };
    const out = [];
    const walk = (el, depth) => {
      const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) if (!['class', 'style', 'd', 'viewBox', 'focusable', 'data-icon', 'fill', 'width', 'height'].includes(a.name)) attrs[a.name] = a.value.slice(0, 60);
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 60);
      out.push({ depth, tag: el.tagName.toLowerCase(), cls: (el.className?.baseVal ?? el.className) || '', attrs, text: own, rect: [Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100], style: Object.fromEntries(props.map((p) => [p, s[p]])) });
      if (depth < maxDepth && el.tagName.toLowerCase() !== 'svg') for (const c of el.children) walk(c, depth + 1);
    };
    walk(root, 0);
    return out;
  }, [rootSelector, PROPS, maxDepth]);
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
export async function setupTree({ page, fx }) {
  fx.state.setupNeeded = true;
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Create account & sign in' }).waitFor();
  const initial = await dumpTree(page, '.ant-card');
  await page.getByRole('button', { name: 'Create account & sign in' }).click();
  await page.waitForTimeout(600);
  const required = await dumpTree(page, '.ant-card');
  for (const [label, v] of [['Email', 'not-an-email'], ['Password', 'abc'], ['Confirm password', 'abd']]) await page.getByLabel(label, { exact: true }).fill(v);
  await page.waitForTimeout(600);
  const invalid = await dumpTree(page, '.ant-card');
  for (const [label, v] of [['Email', 'a@b.co'], ['Password', 'abcdef'], ['Confirm password', 'abcdef']]) await page.getByLabel(label, { exact: true }).fill(v);
  await page.waitForTimeout(600);
  const valid = await dumpTree(page, '.ant-card');
  await page.getByLabel('Email', { exact: true }).focus();
  await settle(page);
  const focus = await dumpTree(page, '.ant-card');
  return { initial, required, invalid, valid, focus };
}
export async function setupLeave({ page, fx }) {
  fx.state.setupNeeded = true;
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Create account & sign in' }).click();
  await page.waitForTimeout(400);
  await page.getByLabel('Email', { exact: true }).fill('a@b.co');
  const samples = [];
  for (const ms of [50, 200, 400, 800, 1600, 3200]) {
    await page.waitForTimeout(ms - (samples.at(-1)?.ms ?? 0));
    samples.push({ ms, ...(await page.evaluate(() => {
      const ex = document.querySelector('#email_help');
      return ex ? { cls: ex.className, items: [...ex.children].map((c) => ({ cls: c.className, text: c.textContent, opacity: getComputedStyle(c).opacity, h: c.getBoundingClientRect().height })), opacity: getComputedStyle(ex).opacity, h: ex.getBoundingClientRect().height } : null;
    })) });
  }
  return samples;
}
export async function profileTree({ page, fx }) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile' }).waitFor();
  await page.waitForTimeout(300);
  const basic = await dumpTree(page, '.ant-card');
  const cards = await page.evaluate(() => [...document.querySelectorAll('.ant-card')].map((c) => c.getBoundingClientRect().toJSON()));
  const pwd = await page.evaluate(() => document.querySelectorAll('.ant-card')[1]?.outerHTML.length);
  const all = await dumpTree(page, 'main');
  return { cards, basic: basic.filter((e) => e.depth <= 9), changePassword: all.filter((e) => /checkbox|extra|ant-btn|form-item-label|ant-avatar/.test(e.cls) || e.tag === 'label') };
}
export async function settingsTree({ page }) {
  await page.goto('/settings');
  await page.getByText('Default permission mode', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  const all = await dumpTree(page, 'main');
  return all.filter((e) => /segmented|select|switch|ant-card|ant-btn/.test(e.cls) || e.depth <= 6);
}
export async function tokensTree({ page }) {
  await page.goto('/settings/access-tokens');
  await page.getByRole('row').filter({ hasText: 'CI pipeline' }).waitFor();
  await page.waitForTimeout(300);
  const table = await dumpTree(page, '.ant-table-wrapper', 14);
  await page.getByRole('row').filter({ hasText: 'CI pipeline' }).hover();
  await page.waitForTimeout(400);
  const hover = await page.evaluate(() => [...document.querySelectorAll('.ant-table-row')].map((r) => [...r.children].map((c) => getComputedStyle(c).backgroundColor)));
  await page.getByRole('button', { name: 'New token' }).click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(500);
  await page.getByRole('dialog').getByText('Never', { exact: true }).click();
  await page.waitForTimeout(300);
  const dialog = await dumpTree(page, '.ant-modal', 16);
  return { table, hover, dialog };
}
export async function cliTree({ page, fx }) {
  fx.state.cli = { ...fx.state.cli, expiresInDays: null, nameInUse: true };
  await page.goto('/cli-login?code=WXYZ4-8K2QP');
  await page.getByRole('button', { name: /Deny/ }).waitFor();
  await page.waitForTimeout(300);
  const pending = await dumpTree(page, '.ant-card', 16);
  fx.state.cli = { ...fx.state.cli, status: 'APPROVED' };
  await page.reload();
  await page.getByText('Login approved').waitFor();
  const approved = await dumpTree(page, '.ant-card', 16);
  fx.state.cliError = true;
  await page.reload();
  await page.getByText('Cannot approve this login').waitFor({ timeout: 15000 });
  const error = await dumpTree(page, '.ant-card', 16);
  fx.state.cliError = false; fx.state.cli = { ...fx.state.cli, status: 'DENIED' };
  await page.reload();
  await page.getByText('Login denied').waitFor();
  const denied = await dumpTree(page, '.ant-card', 16);
  return { pending, approved, error, denied };
}
export async function tablePseudo({ page, fx }) {
  await page.goto('/settings/access-tokens');
  await page.getByRole('row').filter({ hasText: 'CI pipeline' }).waitFor();
  const head = await page.evaluate(() => [...document.querySelectorAll('.ant-table-thead th')].map((th) => { const b = getComputedStyle(th, '::before'); return { content: b.content, w: b.width, h: b.height, bg: b.backgroundColor, top: b.top, right: b.insetInlineEnd, transform: b.transform, position: b.position }; }));
  const table = await page.evaluate(() => { const t = document.querySelector('.ant-table table'); return { style: t.getAttribute('style'), layout: getComputedStyle(t).tableLayout, collapse: getComputedStyle(t).borderCollapse, spacing: getComputedStyle(t).borderSpacing, w: t.getBoundingClientRect().width, cols: t.querySelector('colgroup')?.outerHTML ?? null, textAlign: getComputedStyle(t.querySelector('th')).textAlign, lastTd: getComputedStyle(t.querySelector('tbody tr.ant-table-row td:last-child')).textAlign }; });
  fx.state.tokens = [];
  await page.reload();
  await page.getByText('No active tokens', { exact: false }).waitFor();
  const empty = await page.evaluate(() => { const p = document.querySelector('.ant-table-placeholder'); const td = p.querySelector('td'); const s = getComputedStyle(td); return { html: p.outerHTML.slice(0, 600), td: { padding: s.padding, color: s.color, textAlign: s.textAlign, bg: s.backgroundColor, border: s.borderBottom, h: td.getBoundingClientRect().height } }; });
  return { head, table, empty };
}
export async function emptyTable({ page, fx }) {
  fx.state.tokens = [];
  await page.goto('/settings/access-tokens');
  await page.getByText('No active tokens', { exact: false }).waitFor();
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const t = document.querySelector('table');
    return { table: t.getBoundingClientRect().toJSON(), wrap: t.parentElement.getBoundingClientRect().toJSON(), wrapScroll: t.parentElement.scrollWidth,
      th: [...t.querySelectorAll('thead th')].map((th) => [Math.round(th.getBoundingClientRect().x * 100) / 100, Math.round(th.getBoundingClientRect().width * 100) / 100]),
      emptyTd: t.querySelector('tbody td:last-child')?.getBoundingClientRect().toJSON(),
      measure: [...t.querySelectorAll('tbody tr')].map((tr) => tr.className) };
  });
}
export async function pingShadow({ page }) {
  await page.goto('/settings/access-tokens?tab=ended');
  await page.getByRole('row').filter({ hasText: 'Old cron' }).waitFor();
  await page.waitForTimeout(300);
  const read = () => page.evaluate(() => {
    const t = document.querySelector('.ant-table');
    const c = t.querySelector('.ant-table-container');
    const content = t.querySelector('.ant-table-content');
    const pick = (el, pseudo) => { const s = getComputedStyle(el, pseudo); return { content: s.content, position: s.position, top: s.top, bottom: s.bottom, left: s.left, right: s.right, width: s.width, zIndex: s.zIndex, boxShadow: s.boxShadow, transition: s.transition, pointerEvents: s.pointerEvents }; };
    return { cls: t.className, wrapperCls: t.parentElement.className, scrollW: content.scrollWidth, clientW: content.clientWidth, scrollLeft: content.scrollLeft,
      before: pick(c, '::before'), after: pick(c, '::after'), containerPos: getComputedStyle(c).position,
      table: t.querySelector('table').getBoundingClientRect().width, thLastRadius: getComputedStyle(t.querySelector('thead th:last-child')).borderRadius,
      cells: [...t.querySelectorAll('thead th')].map((th) => [th.className, getComputedStyle(th).position, getComputedStyle(th).zIndex, th.getAttribute('style')]) };
  });
  const atStart = await read();
  await page.evaluate(() => { const el = document.querySelector('.ant-table-content'); el.scrollLeft = 40; });
  await page.waitForTimeout(500);
  const middle = await read();
  await page.evaluate(() => { const el = document.querySelector('.ant-table-content'); el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(500);
  const end = await read();
  return { atStart, middle, end };
}
export async function adminHover({ page }) {
  await page.goto('/admin');
  const user = page.getByRole('row').filter({ hasText: 'dev@example.test' });
  await user.getByRole('button', { name: /Access tokens/ }).click();
  const dialog = page.getByRole('dialog', { name: /Access tokens — / });
  const ci = dialog.getByRole('row').filter({ hasText: 'CI pipeline' });
  await ci.waitFor();
  const btn = ci.getByRole('button', { name: /Revoke$/ });
  const box = await btn.boundingBox();
  await btn.click();
  await page.waitForTimeout(600);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  return page.evaluate(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes('CI pipeline') && r.closest('[role="dialog"]'));
    return { hit: hit && (hit.tagName + '.' + hit.className + ' ' + (hit.textContent || '').slice(0, 30)), rowHover: row?.matches(':hover'), rowBg: row && getComputedStyle(row.cells[0]).backgroundColor,
      hovered: [...document.querySelectorAll(':hover')].map((e) => e.tagName + '.' + (e.className?.baseVal ?? e.className)).slice(-6) };
  }, [x, y]);
}
export async function adminHover2({ page }) {
  await page.goto('/admin');
  const user = page.getByRole('row').filter({ hasText: 'dev@example.test' });
  await user.getByRole('button', { name: /Access tokens/ }).click();
  const dialog = page.getByRole('dialog', { name: /Access tokens — / });
  const ci = dialog.getByRole('row').filter({ hasText: 'CI pipeline' });
  await ci.waitFor();
  const btn = ci.getByRole('button', { name: /Revoke$/ });
  await page.waitForTimeout(500);
  const before = await btn.boundingBox();
  await btn.click();
  await page.waitForTimeout(800);
  const after = await btn.boundingBox();
  const state = await page.evaluate(() => {
    const trig = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes('CI pipeline') && r.closest('[role="dialog"]'))?.querySelector('button');
    const pos = document.querySelector('.orbit-floating-positioner, .ant-popover');
    return { trigHover: trig?.matches(':hover'), rowHover: trig?.closest('tr').matches(':hover'), pos: pos?.getBoundingClientRect().toJSON(), posStyle: pos && { position: getComputedStyle(pos).position, inset: getComputedStyle(pos).inset },
      wrapScroll: [...document.querySelectorAll('.ant-modal-wrap, .ant-modal-body')].map((e) => [e.className.slice(0, 30), e.scrollTop]), docScroll: document.scrollingElement.scrollTop };
  });
  return { before, after, ...state };
}
export async function popFrames({ page }) {
  await page.goto('/admin');
  const user = page.getByRole('row').filter({ hasText: 'dev@example.test' });
  await user.getByRole('button', { name: /Access tokens/ }).click();
  const dialog = page.getByRole('dialog', { name: /Access tokens — / });
  const ci = dialog.getByRole('row').filter({ hasText: 'CI pipeline' });
  await ci.waitFor();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__frames = [];
    const sample = () => {
      const pos = document.querySelector('.orbit-floating-positioner, .ant-popover');
      const pop = document.querySelector('.orbit-popconfirm, .ant-popover');
      window.__frames.push(pos ? { r: pos.getBoundingClientRect().toJSON(), op: pop && getComputedStyle(pop).opacity, vis: getComputedStyle(pos).visibility, tf: getComputedStyle(pos).transform } : null);
      if (window.__frames.length < 12) requestAnimationFrame(sample);
    };
    document.addEventListener('click', () => requestAnimationFrame(sample), { capture: true, once: true });
    new MutationObserver((list, obs) => { if (document.querySelector('.orbit-floating-positioner, .ant-popover')) { const pos = document.querySelector('.orbit-floating-positioner, .ant-popover'); window.__first = { r: pos.getBoundingClientRect().toJSON(), tf: getComputedStyle(pos).transform, vis: getComputedStyle(pos).visibility }; obs.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
  });
  await ci.getByRole('button', { name: /Revoke$/ }).click();
  await page.waitForTimeout(800);
  return page.evaluate(() => ({ first: window.__first, frames: window.__frames.map((f) => f && [Math.round(f.r.x), Math.round(f.r.y), Math.round(f.r.width), Math.round(f.r.height), f.op, f.vis]) }));
}
export async function pingRadius({ page }) {
  await page.goto('/settings/access-tokens?tab=ended');
  await page.getByRole('row').filter({ hasText: 'Old cron' }).waitFor();
  return page.evaluate(() => {
    const c = document.querySelector('.ant-table-container');
    const a = getComputedStyle(c, '::after'), b = getComputedStyle(c, '::before');
    return { after: a.borderRadius, before: b.borderRadius, container: getComputedStyle(c).borderRadius, content: getComputedStyle(c.querySelector('.ant-table-content')).borderRadius, table: getComputedStyle(document.querySelector('.ant-table')).borderRadius };
  });
}
export async function scrollStyles({ page }) {
  await page.goto('/settings/access-tokens?tab=ended');
  await page.getByRole('row').filter({ hasText: 'Old cron' }).waitFor();
  return page.evaluate(() => {
    const el = document.querySelector('.ant-table-content, .orbit-table-content');
    const t = document.querySelector('.ant-table, .orbit-table-scroll');
    return { cls: el.className, scrollbarColor: getComputedStyle(t).scrollbarColor, contentScrollbarColor: getComputedStyle(el).scrollbarColor, scrollbarWidth: getComputedStyle(el).scrollbarWidth,
      offsetH: el.offsetHeight, clientH: el.clientHeight, scrollW: el.scrollWidth, clientW: el.clientWidth };
  });
}
export async function cliScroll({ page, fx }) {
  const out = [];
  const snap = async (step) => out.push({ step, ...(await page.evaluate(() => {
    const b = (name) => [...document.querySelectorAll('button')].find((x) => x.textContent.trim().endsWith(name))?.getBoundingClientRect();
    const card = document.querySelector('.ant-card, .orbit-card')?.getBoundingClientRect();
    return { sx: scrollX, sy: scrollY, docW: document.documentElement.scrollWidth, card: card && [card.x, card.width], deny: b('Deny') && [b('Deny').x, b('Deny').width], approve: b('Approve') && [b('Approve').x, b('Approve').width] };
  })) });
  fx.state.cliDecisionError = true;
  await page.goto('/cli-login?code=WXYZ4-8K2QP');
  await page.getByRole('button', { name: /Approve$/ }).waitFor();
  await snap('open');
  await page.getByRole('button', { name: /Approve$/ }).click();
  await page.waitForTimeout(500);
  await snap('after approve click');
  fx.state.cliDecisionError = false;
  await page.getByRole('button', { name: /Deny$/ }).click();
  await page.getByText('Login denied').waitFor();
  await page.waitForTimeout(300);
  await snap('after deny');
  return out;
}
export async function dialogHeights({ page }) {
  await page.goto('/settings/access-tokens');
  await page.getByRole('row').filter({ hasText: 'CI pipeline' }).waitFor();
  await page.getByRole('button', { name: /New token$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New access token' });
  await dialog.waitFor();
  await dialog.locator('label').filter({ hasText: /^Custom$/ }).click();
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const surface = document.querySelector('.ant-modal, .orbit-overlay.orbit-dialog');
    const scroller = document.querySelector('.ant-modal-wrap, .orbit-overlay-viewport');
    const r = (el) => el && [Math.round(el.getBoundingClientRect().y * 100) / 100, Math.round(el.getBoundingClientRect().height * 100) / 100];
    const parts = {};
    for (const [k, sel] of Object.entries({ body: '.ant-modal-body, .orbit-overlay-body', form: '.access-token-form', actions: '.access-token-actions', header: '.ant-modal-header, .orbit-overlay-header', content: '.ant-modal-content, .orbit-overlay' })) parts[k] = r(document.querySelector(sel));
    const fields = [...document.querySelectorAll('.access-token-field')].map(r);
    return { surface: r(surface), surfaceStyle: { pb: getComputedStyle(surface).paddingBottom, pt: getComputedStyle(surface).paddingTop, mb: getComputedStyle(surface).marginBottom }, scrollH: scroller.scrollHeight, clientH: scroller.clientHeight, scrollerPad: getComputedStyle(scroller).padding, parts, fields };
  });
}
export async function adminPhone({ page }) {
  await page.goto('/admin');
  const user = page.getByRole('row').filter({ hasText: 'dev@example.test' });
  await user.getByRole('button', { name: /Access tokens/ }).click();
  const dialog = page.getByRole('dialog', { name: /Access tokens — / });
  const ci = dialog.getByRole('row').filter({ hasText: 'CI pipeline' });
  await ci.waitFor();
  await page.waitForTimeout(500);
  await ci.getByRole('button', { name: /Revoke$/ }).click();
  await page.waitForTimeout(600);
  return page.evaluate(() => { const p = document.querySelector('.orbit-popconfirm, .ant-popover-content, .ant-popconfirm'); return p && p.getBoundingClientRect().toJSON(); });
}
export async function selectFrames({ page }) {
  await page.goto('/settings/access-tokens');
  await page.getByRole('row').filter({ hasText: 'CI pipeline' }).waitFor();
  await page.getByRole('button', { name: /New token$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New access token' });
  await dialog.waitFor();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__frames = [];
    const sample = () => {
      const pos = [...document.querySelectorAll('.orbit-choice-positioner, .ant-select-dropdown')].find((e) => e.getBoundingClientRect().width > 0);
      window.__frames.push(pos ? [Math.round(pos.getBoundingClientRect().x), Math.round(pos.getBoundingClientRect().y), getComputedStyle(pos).opacity, getComputedStyle(pos).position] : null);
      if (window.__frames.length < 8) requestAnimationFrame(sample);
    };
    document.addEventListener('pointerdown', () => requestAnimationFrame(sample), { capture: true, once: true });
  });
  await dialog.getByRole('combobox').click();
  await page.waitForTimeout(600);
  return page.evaluate(() => window.__frames);
}

// WebKit phone: the width the "Name saved" toast column is laid out against, and the page's overflow when it appears.
export async function toastWidth({ page }) {
  const geometry = (label) => page.evaluate((label) => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.x, b.width]; };
    const de = document.documentElement;
    return { label, scrollHeight: de.scrollHeight, clientHeight: de.clientHeight, innerHeight, clientWidth: de.clientWidth, scrollY,
      layer: r(document.querySelector('.toast-layer')), viewport: r(document.querySelector('.toast-viewport')), pill: r(document.querySelector('.toast')),
      styles: document.querySelectorAll('style').length };
  }, label);
  const out = [];
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  out.push(await geometry('loaded'));
  const name = page.locator('input[autocomplete="name"]');
  await name.fill('Baseline Reviewer Updated');
  out.push(await geometry('filled'));
  await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
  await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
  out.push(await geometry('toast'));
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await page.getByText('Enter a new password', { exact: true }).waitFor();
  out.push(await geometry('validation'));
  await page.evaluate(() => document.head.appendChild(document.createElement('style')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  out.push(await geometry('after-style-insert'));
  return out;
}

// Frame by frame from the Save click: the page's overflow against the toast layer, column and pill.
export async function toastFrames({ page }) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.locator('input[autocomplete="name"]').fill('Baseline Reviewer Updated');
  await page.evaluate(() => {
    const log = (window.__frames = []);
    const t0 = performance.now();
    const w = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return `${b.x}/${b.width}`; };
    let last = '';
    const sample = (why) => {
      const de = document.documentElement;
      const row = `${de.scrollHeight}|${w('.toast-layer')}|${w('.toast-viewport')}|${w('.toast')}|${document.querySelectorAll('[aria-live]').length}|${w('button[type="submit"], .ant-btn-loading')}`;
      if (row !== last) { log.push([Math.round(performance.now() - t0), why, row]); last = row; }
    };
    new MutationObserver(() => sample('mutation')).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const frame = () => { sample('frame'); if (performance.now() - t0 < 2000) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
  await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
  await page.waitForTimeout(1500);
  return page.evaluate(() => window.__frames);
}

// After the "Name saved" toast lays out at 390 over a 1px overflow: which change makes the toast layer re-resolve to 382?
export async function toastRelayout({ page }) {
  const experiments = {
    none: () => {},
    bodyClass: () => document.body.classList.add('probe-x'),
    rootVar: () => document.documentElement.style.setProperty('--probe-x', '1'),
    spinner: () => { const s = document.createElement('span'); s.className = 'anticon-spin'; s.style.cssText = 'display:inline-block;width:10px;height:10px;animation:loadingCircle 1s infinite linear'; document.querySelector('main, #root').prepend(s); },
    blur: () => document.activeElement?.blur(),
    layerStyle: () => { document.querySelector('.toast-layer').style.zIndex = '1'; },
    columnStyle: () => { document.querySelector('.toast-viewport').style.outline = '0 solid transparent'; },
    reflowRoot: () => { const r = document.querySelector('#root'); r.style.paddingBottom = '1px'; void r.offsetHeight; r.style.paddingBottom = ''; },
    scroll: () => window.scrollTo(0, 1),
  };
  const out = {};
  for (const [name, fn] of Object.entries(experiments)) {
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    await page.locator('input[autocomplete="name"]').fill(`Baseline Reviewer ${name}`);
    await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => document.querySelector('.toast-layer').getBoundingClientRect().width + '/' + document.querySelector('.toast-viewport').getBoundingClientRect().width);
    await page.evaluate(`(${fn.toString()})()`);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))));
    const after = await page.evaluate(() => document.querySelector('.toast-layer').getBoundingClientRect().width + '/' + document.querySelector('.toast-viewport').getBoundingClientRect().width);
    out[name] = `${before} -> ${after}`;
  }
  return out;
}

// From the Save click: scroll events (window and any element), focus moves and the layer width.
export async function toastScrolls({ page }) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.locator('input[autocomplete="name"]').fill('Baseline Reviewer Scrolls');
  await page.evaluate(() => {
    const log = (window.__events = []);
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const layer = () => document.querySelector('.toast-layer')?.getBoundingClientRect().width;
    const who = (n) => n === document ? 'document' : n === window ? 'window' : `${n.tagName?.toLowerCase()}.${String(n.className?.baseVal ?? n.className).split(' ')[0]}`;
    document.addEventListener('scroll', (e) => log.push([at(), 'scroll', who(e.target), scrollY, document.scrollingElement.scrollTop, layer()]), true);
    window.addEventListener('scroll', () => log.push([at(), 'window-scroll', scrollY, layer()]));
    document.addEventListener('focusin', (e) => log.push([at(), 'focusin', who(e.target), layer()]), true);
    document.addEventListener('focusout', (e) => log.push([at(), 'focusout', who(e.target), layer()]), true);
    new MutationObserver((records) => log.push([at(), 'mutation', document.documentElement.scrollHeight, scrollY, layer(), records.map((r) => `${who(r.target)}:+${[...r.addedNodes].map((n) => n.nodeType === 1 ? who(n) : '#text').join(',')}-${[...r.removedNodes].map((n) => n.nodeType === 1 ? who(n) : '#text').join(',')}`).join(' ').slice(0, 400)])).observe(document.body, { subtree: true, childList: true });
    const origScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...a) { log.push([at(), 'scrollIntoView', who(this), JSON.stringify(a)]); return origScrollIntoView.apply(this, a); };
    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...a) { log.push([at(), 'focus()', who(this), JSON.stringify(a)]); return origFocus.apply(this, a); };
  });
  await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
  await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
  await page.waitForTimeout(800);
  return page.evaluate(() => window.__events);
}

// Delivery: does inserting an element like AntD's wave holder at the click make the toast layer resolve to 382?
export async function toastWaveHolder({ page }) {
  const variants = {
    control: null,
    absInButton: 'button',
    staticInButton: 'button-static',
    absInBody: 'body',
    fixedInBody: 'body-fixed',
  };
  const out = {};
  for (const [name, where] of Object.entries(variants)) {
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    await page.locator('input[autocomplete="name"]').fill(`Baseline Reviewer ${name}`);
    await page.evaluate((where) => {
      if (!where) return;
      document.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (!button) return;
        const holder = document.createElement('div');
        if (where === 'button') { holder.style.position = 'absolute'; holder.style.left = '0px'; holder.style.top = '0px'; button.insertBefore(holder, button.firstChild); }
        if (where === 'button-static') button.insertBefore(holder, button.firstChild);
        if (where === 'body') { holder.style.cssText = 'position:absolute;left:0;top:0'; document.body.appendChild(holder); }
        if (where === 'body-fixed') { holder.style.cssText = 'position:fixed;left:0;top:0'; document.body.appendChild(holder); }
      }, { capture: true, once: true });
    }, where);
    await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    out[name] = await page.evaluate(() => `${document.documentElement.scrollHeight} ${document.querySelector('.toast-layer').getBoundingClientRect().width}/${document.querySelector('.toast-viewport').getBoundingClientRect().width}`);
  }
  return out;
}

// Save by Enter in the name field (no click, so no AntD wave) against Save by click.
export async function toastByEnter({ page }) {
  const out = {};
  for (const how of ['click', 'enter', 'click2', 'enter2']) {
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    const name = page.locator('input[autocomplete="name"]');
    await name.fill(`Baseline Reviewer ${how}`);
    if (how.startsWith('click')) await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
    else await name.press('Enter');
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    out[how] = await page.evaluate(() => `${document.documentElement.scrollHeight} ${document.querySelector('.toast-layer').getBoundingClientRect().width}/${document.querySelector('.toast-viewport').getBoundingClientRect().width}`);
  }
  return out;
}

// Reference: any scroll API call, scrollTop write, window/visualViewport resize or scroll around the save.
export async function toastHooks({ page }) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  const name = page.locator('input[autocomplete="name"]');
  await name.fill('Baseline Reviewer Hooks');
  await page.evaluate(() => {
    const log = (window.__events = []);
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const layer = () => document.querySelector('.toast-layer')?.getBoundingClientRect().width;
    const who = (n) => n === document ? 'document' : n === window ? 'window' : `${n.tagName?.toLowerCase()}.${String(n.className?.baseVal ?? n.className).split(' ')[0]}`;
    for (const [obj, label] of [[window, 'window'], [Element.prototype, 'element']]) {
      for (const fn of ['scrollTo', 'scroll', 'scrollBy']) {
        const orig = obj[fn];
        obj[fn] = function (...a) { log.push([at(), `${label}.${fn}`, who(this), JSON.stringify(a), new Error().stack.split('\n').slice(1, 4).join(' | ')]); return orig.apply(this, a); };
      }
    }
    for (const prop of ['scrollTop', 'scrollLeft']) {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      Object.defineProperty(Element.prototype, prop, { get: d.get, set(v) { log.push([at(), `set ${prop}`, who(this), v, new Error().stack.split('\n').slice(1, 4).join(' | ')]); d.set.call(this, v); }, configurable: true });
    }
    window.addEventListener('resize', () => log.push([at(), 'resize', innerWidth, layer()]));
    visualViewport?.addEventListener('resize', () => log.push([at(), 'vv-resize', visualViewport.width, visualViewport.scale, layer()]));
    visualViewport?.addEventListener('scroll', () => log.push([at(), 'vv-scroll', visualViewport.offsetTop, layer()]));
    new MutationObserver((records) => log.push([at(), 'mutation', document.documentElement.scrollHeight, layer(), records.length])).observe(document.body, { subtree: true, childList: true, attributes: true });
    const ro = new ResizeObserver((entries) => log.push([at(), 'ro', entries.map((e) => who(e.target) + ':' + e.contentRect.width).join(',')]));
    ro.observe(document.documentElement); ro.observe(document.body);
  });
  await name.press('Enter');
  await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  return page.evaluate(() => window.__events);
}

// The rename answered after a delay (as a network would), against the fixtures' immediate answer.
export async function toastDelayed({ page }) {
  const out = {};
  let delay = 0;
  await page.route('**/api/users/me', async (route) => {
    if (route.request().method() !== 'GET' && delay) await new Promise((r) => setTimeout(r, delay));
    await route.fallback();
  });
  for (const d of [0, 20, 50, 100, 0]) {
    delay = d;
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    const name = page.locator('input[autocomplete="name"]');
    await name.fill(`Baseline Reviewer d${delay}`);
    await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    out[`delay ${delay} ${Object.keys(out).length}`] = await page.evaluate(() => `${document.documentElement.scrollHeight} ${document.querySelector('.toast-layer').getBoundingClientRect().width}/${document.querySelector('.toast-viewport').getBoundingClientRect().width}`);
  }
  return out;
}

// Elements with layout-affecting specials on the profile page: positioned, clipped/scrolling, transformed, animated, contained.
export async function profileSpecials({ page }) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      const flags = [];
      if (s.position !== 'static') flags.push(s.position);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') flags.push(`overflow:${s.overflowX}/${s.overflowY}`);
      if (s.transform !== 'none') flags.push('transform');
      if (s.willChange !== 'auto') flags.push(`will-change:${s.willChange}`);
      if (s.animationName !== 'none') flags.push(`anim:${s.animationName}`);
      if (s.contain !== 'none') flags.push(`contain:${s.contain}`);
      if (s.filter !== 'none' || s.backdropFilter !== 'none') flags.push('filter');
      if (/vw|vh|vmin|vmax|svh|dvh|lvh/.test(el.getAttribute('style') || '')) flags.push('inline-viewport-unit');
      if (s.scrollbarGutter && s.scrollbarGutter !== 'auto') flags.push(`gutter:${s.scrollbarGutter}`);
      if (flags.length && !['HTML'].includes(el.tagName)) {
        const r = el.getBoundingClientRect();
        out.push(`${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ').slice(0, 2).join('.')} [${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}] ${flags.join(' ')}`);
      }
    }
    return out;
  });
}

// Does a fixed element laid out before the overflow (like Base UI's hidden checkbox input) keep the toast layer at 390?
export async function toastFixedSibling({ page }) {
  const out = {};
  const variants = {
    asIs: () => {},
    hiddenInputAbsolute: () => { for (const i of document.querySelectorAll('input')) if (getComputedStyle(i).position === 'fixed') i.style.position = 'absolute'; },
    addFixed: () => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:-1px;left:-1px;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'; document.body.appendChild(d); },
  };
  for (const [name, fn] of Object.entries(variants)) {
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    await page.evaluate(`(${fn.toString()})()`);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const name2 = page.locator('input[autocomplete="name"]');
    await name2.fill(`Baseline Reviewer ${name}`);
    await name2.press('Enter');
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    out[name] = await page.evaluate(() => `${document.documentElement.scrollHeight} ${document.querySelector('.toast-layer').getBoundingClientRect().width}/${document.querySelector('.toast-viewport').getBoundingClientRect().width} fixed-inputs:${[...document.querySelectorAll('input')].filter((i) => getComputedStyle(i).position === 'fixed').length}`);
  }
  return out;
}

// Reference bisect: replace a part of the profile page with a same-size spacer, then save by Enter.
export async function toastBisect({ page }) {
  const out = {};
  const parts = {
    none: [],
    passwordCard: ['.app-view .ant-card:nth-of-type(2)'],
    cardAvatar: ['.app-view .ant-card .ant-avatar'],
    navAvatar: ['.app-nav .ant-avatar'],
    bothAvatars: ['.app-view .ant-card .ant-avatar', '.app-nav .ant-avatar'],
    photoButton: ['.app-view .ant-card .ant-btn:not(.ant-btn-primary)'],
  };
  for (const [label, selectors] of Object.entries(parts)) {
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    await page.waitForTimeout(200);
    const replaced = await page.evaluate((selectors) => selectors.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return `${sel}: missing`;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const spacer = document.createElement(s.display.startsWith('inline') ? 'span' : 'div');
      spacer.style.cssText = `display:${s.display === 'block' ? 'block' : 'inline-block'};width:${r.width}px;height:${r.height}px;margin:${s.margin};vertical-align:${s.verticalAlign}`;
      el.parentNode.insertBefore(spacer, el);
      el.style.setProperty('display', 'none', 'important');
      return `${sel}: ${Math.round(r.width)}x${Math.round(r.height)}`;
    }), selectors);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const before = await page.evaluate(() => document.documentElement.scrollHeight);
    const name = page.locator('input[autocomplete="name"]');
    await name.fill(`Baseline Reviewer ${label}`);
    await name.press('Enter');
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    out[label] = `${replaced.join('; ')} | before ${before} | ` + await page.evaluate(() => `${document.documentElement.scrollHeight} ${document.querySelector('.toast-layer').getBoundingClientRect().width}/${document.querySelector('.toast-viewport').getBoundingClientRect().width}`);
  }
  return out;
}

// Dump the profile page's <style> elements (text) for transplant.
export async function dumpStyles({ page }) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.waitForTimeout(300);
  return page.evaluate(() => [...document.querySelectorAll('style')].map((s) => ({ attrs: [...s.attributes].map((a) => `${a.name}=${a.value}`).join(' '), text: s.textContent })));
}
// Delivery: inject styles (STYLES_FILE json, optional STYLE_PICK "i,j,k") before saving.
export async function toastWithStyles({ page }) {
  const { readFileSync } = await import('node:fs');
  const all = JSON.parse(readFileSync(process.env.STYLES_FILE, 'utf8'));
  const picks = (process.env.STYLE_PICKS ?? 'all').split(' ');
  const out = {};
  for (const pick of picks) {
    const chosen = pick === 'all' ? all : pick === 'none' ? [] : pick.split(',').map(Number).map((i) => all[i]);
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    await page.evaluate((texts) => { for (const t of texts) { const s = document.createElement('style'); s.textContent = t; document.head.appendChild(s); } }, chosen.map((s) => s.text));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const name = page.locator('input[autocomplete="name"]');
    await name.fill(`Baseline Reviewer ${pick}`.slice(0, 70));
    await name.press('Enter');
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    out[pick] = await page.evaluate(() => `${document.documentElement.scrollHeight} ${document.querySelector('.toast-layer').getBoundingClientRect().width}/${document.querySelector('.toast-viewport').getBoundingClientRect().width}`);
  }
  return out;
}

// Delivery: force one synchronous layout right after lib/toast appends its screen-reader region (before the column renders).
export async function toastForcedLayout({ page }) {
  const out = {};
  for (const force of ['no', 'yes']) {
    await page.goto('/settings/profile');
    await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
    if (force === 'yes') await page.evaluate(() => {
      const append = Node.prototype.appendChild;
      Node.prototype.appendChild = function (child) {
        const result = append.call(this, child);
        if (this === document.body && child.classList?.contains('sr-only')) window.__forced = document.documentElement.scrollHeight + '/' + !!document.querySelector('.toast-viewport');
        return result;
      };
    });
    const name = page.locator('input[autocomplete="name"]');
    await name.fill(`Baseline Reviewer forced ${force}`);
    await name.press('Enter');
    await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    out[force] = await page.evaluate(() => `forced-read:${window.__forced} | ${document.documentElement.scrollHeight} ${document.querySelector('.toast-layer').getBoundingClientRect().width}/${document.querySelector('.toast-viewport').getBoundingClientRect().width}`);
  }
  return out;
}

// Reference: which code reads layout between lib/toast's region append and the toast column's insertion?
export async function toastWindowReads({ page }) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.evaluate(() => {
    const log = (window.__reads = []);
    let open = false;
    const stack = () => new Error().stack.split('\n').slice(2, 9).map((l) => l.trim().replace(/https?:\/\/[^/]+\//, '')).join(' < ');
    const wrap = (proto, names) => {
      for (const name of names) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (!d) continue;
        if (d.get) Object.defineProperty(proto, name, { ...d, get() { if (open) log.push(`${name} on ${this.tagName?.toLowerCase()}.${String(this.className?.baseVal ?? this.className).split(' ')[0]} :: ${stack()}`); return d.get.call(this); } });
        else if (typeof d.value === 'function') { const f = d.value; proto[name] = function (...a) { if (open) log.push(`${name}() on ${this.tagName?.toLowerCase?.()}.${String(this.className?.baseVal ?? this.className ?? '').split(' ')[0]} :: ${stack()}`); return f.apply(this, a); }; }
      }
    };
    wrap(HTMLElement.prototype, ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent', 'innerText']);
    wrap(Element.prototype, ['scrollWidth', 'scrollHeight', 'scrollTop', 'clientWidth', 'clientHeight', 'getBoundingClientRect', 'getClientRects']);
    const gcs = window.getComputedStyle;
    window.getComputedStyle = function (...a) { if (open) log.push(`getComputedStyle(${a[0]?.tagName?.toLowerCase()}.${String(a[0]?.className?.baseVal ?? a[0]?.className).split(' ')[0]}) :: ${stack()}`); return gcs.apply(this, a); };
    for (const method of ['appendChild', 'insertBefore']) {
      const f = Node.prototype[method];
      Node.prototype[method] = function (child, ...rest) {
        const result = f.call(this, child, ...rest);
        if (this === document.body && child.classList?.contains('sr-only')) { open = true; log.push('== region appended'); }
        if (child.classList?.contains('toast-viewport')) { log.push('== column inserted'); open = false; }
        return result;
      };
    }
  });
  const name = page.locator('input[autocomplete="name"]');
  await name.fill('Baseline Reviewer Reads');
  await name.press('Enter');
  await page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__reads);
}

// The profile photo avatar: computed styles of the avatar box and its image.
export async function photoStyles({ page, fx, p41 }) {
  fx.state.account.avatarUpdatedAt = '2026-10-01T00:00:00.000Z';
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const img = document.querySelector('main img, .app-view img');
    if (!img) return 'no img';
    const pick = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { tag: el.tagName, cls: el.className, inline: el.getAttribute('style'), rect: [r.x, r.y, r.width, r.height], background: s.backgroundColor, border: s.border, radius: s.borderRadius, overflow: s.overflow, display: s.display, objectFit: s.objectFit, verticalAlign: s.verticalAlign, transform: s.transform, boxSizing: s.boxSizing, clipPath: s.clipPath, isolation: s.isolation, willChange: s.willChange }; };
    return [pick(img.parentElement), pick(img)];
  });
}

export async function photoMarkup({ page, fx }) {
  fx.state.account.avatarUpdatedAt = '2026-10-01T00:00:00.000Z';
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const img = document.querySelector('.app-view img');
    const s = getComputedStyle(img);
    const props = ['imageRendering', 'imageOrientation', 'objectPosition', 'opacity', 'mixBlendMode', 'filter', 'contentVisibility', 'backfaceVisibility', 'transformStyle', 'zIndex', 'position', 'contain', 'decoding', 'colorScheme', 'forcedColorAdjust', 'userSelect', 'pointerEvents', 'maxWidth', 'maxHeight', 'aspectRatio'];
    return { html: img.parentElement.outerHTML.replace(/blob:[^"]+/, 'blob:…').replace(/data:[^"]{40,}/, 'data:…'), styles: Object.fromEntries(props.map((p) => [p, s[p]])), parentStyles: Object.fromEntries(['opacity', 'mixBlendMode', 'filter', 'zIndex', 'position', 'isolation', 'contain', 'color', 'fontSize', 'lineHeight', 'textAlign', 'alignItems', 'justifyContent', 'whiteSpace', 'cursor'].map((p) => [p, getComputedStyle(img.parentElement)[p]])) };
  });
}

// Screenshot the photo avatar as is, and with the img's alt toggled; return sha256 of each clip.
export async function photoAlt({ page, fx }) {
  const { createHash } = await import('node:crypto');
  const { writeFileSync } = await import('node:fs');
  fx.state.account.avatarUpdatedAt = '2026-10-01T00:00:00.000Z';
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.waitForTimeout(800);
  const box = await page.locator('.app-view img').evaluate((img) => { const r = img.parentElement.getBoundingClientRect(); return { x: Math.floor(r.x) - 2, y: Math.floor(r.y) - 2, width: 68, height: 68 }; });
  const shot = async (label) => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const png = await page.screenshot({ clip: box, animations: 'disabled', caret: 'hide' });
    writeFileSync(`/var/tmp/p4.1-293463/scratch/crops/alt-${process.env.TAG}-${label}.png`, png);
    return createHash('sha256').update(png).digest('hex').slice(0, 12);
  };
  const out = { asIs: await shot('asis') };
  await page.locator('.app-view img').evaluate((img) => (img.hasAttribute('alt') ? img.removeAttribute('alt') : img.setAttribute('alt', '')));
  out.toggled = await shot('toggled');
  await page.locator('.app-view img').evaluate((img) => (img.hasAttribute('alt') ? img.removeAttribute('alt') : img.setAttribute('alt', '')));
  out.back = await shot('back');
  return out;
}

// As the P4.1 photo test: choose the PNG, wait for the photo, screenshot the avatar; report the img src kind and size.
export async function photoUpload({ page, fx, p41 }) {
  const { createHash } = await import('node:crypto');
  const { writeFileSync } = await import('node:fs');
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose photo/ }).click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: p41.UPLOAD_PNG });
  await page.getByRole('button', { name: /Remove photo/ }).waitFor();
  const img = page.locator('.app-view img');
  await img.waitFor();
  await page.waitForFunction(() => { const i = document.querySelector('.app-view img'); return i && i.complete && i.naturalWidth > 0; });
  const out = {};
  for (const wait of [0, 300, 1500]) {
    await page.waitForTimeout(wait);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const box = await img.evaluate((i) => { const r = i.parentElement.getBoundingClientRect(); return { x: Math.floor(r.x) - 2, y: Math.floor(r.y) - 2, width: 68, height: 68 }; });
    const png = await page.screenshot({ clip: box, animations: 'disabled', caret: 'hide' });
    writeFileSync(`/var/tmp/p4.1-293463/scratch/crops/upload-${process.env.TAG}-${wait}.png`, png);
    out[`after ${wait}ms`] = createHash('sha256').update(png).digest('hex').slice(0, 12);
  }
  out.src = await img.evaluate((i) => `${i.src.slice(0, 30)}… len ${i.src.length} natural ${i.naturalWidth}x${i.naturalHeight}`);
  out.requests = (fx.requests ?? []).map((r) => (typeof r === 'string' ? r : `${r.method} ${r.path ?? r.url}`)).filter((r) => r.includes('avatar'));
  return out;
}
