// P4.1, P0 profile-validation on WebKit phone: why the "Name saved" pill sits 4px further right on the
// delivery than on the same-commit reference. Each export is one probe; run.mjs drives it against a
// served tree with that tree's P0 fixtures, in the P0 WebKit phone context (390×844, isMobile, DPR 1).

const NAME = 'input[autocomplete="name"]';
const notice = (page) => page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Name saved', { exact: true });

async function openProfile(page) {
  await page.goto('/settings/profile');
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
}

/** What the toast layer, its column and the pill are laid out against: document height, and the x/width of each. */
const geometry = (page, label) => page.evaluate((label) => {
  const at = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return [r.x, r.width]; };
  const root = document.documentElement;
  return { label, scrollHeight: root.scrollHeight, innerHeight, clientWidth: root.clientWidth, layer: at('.toast-layer'), column: at('.toast-viewport'), pill: at('.toast') };
}, label);

/** The P0 profile steps up to the notice, with the geometry after each. */
export async function steps({ page }) {
  await openProfile(page);
  const out = [await geometry(page, 'loaded')];
  await page.locator(NAME).fill('Baseline Reviewer Updated');
  out.push(await geometry(page, 'name typed'));
  await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
  await notice(page).waitFor();
  out.push(await geometry(page, 'Name saved shown'));
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await page.getByText('Enter a new password', { exact: true }).waitFor();
  out.push(await geometry(page, 'password errors shown'));
  return out;
}

/** Every layout read (offset*, scroll*, client*, getBoundingClientRect, getComputedStyle) made between
 *  lib/toast appending its body-level screen-reader region and the toast column being inserted, with
 *  the reading code's stack. Saved by Enter in the name field, so no button click is involved. */
export async function readsBetween({ page }) {
  await openProfile(page);
  await page.evaluate(() => {
    const log = (window.__reads = []);
    let open = false;
    const stack = () => new Error().stack.split('\n').slice(2, 6).map((l) => l.trim().replace(/https?:\/\/[^/]+\//, '')).join(' < ');
    const named = (el) => `${el?.tagName?.toLowerCase()}.${String(el?.className?.baseVal ?? el?.className ?? '').split(' ')[0]}`;
    const wrap = (proto, names) => {
      for (const name of names) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (d?.get) Object.defineProperty(proto, name, { ...d, get() { if (open) log.push(`${name} on ${named(this)} :: ${stack()}`); return d.get.call(this); } });
        else if (typeof d?.value === 'function') { const f = d.value; proto[name] = function (...a) { if (open) log.push(`${name}() on ${named(this)} :: ${stack()}`); return f.apply(this, a); }; }
      }
    };
    wrap(HTMLElement.prototype, ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent']);
    wrap(Element.prototype, ['scrollWidth', 'scrollHeight', 'scrollTop', 'clientWidth', 'clientHeight', 'getBoundingClientRect', 'getClientRects']);
    const computed = window.getComputedStyle;
    window.getComputedStyle = function (...a) { if (open) log.push(`getComputedStyle(${named(a[0])}) :: ${stack()}`); return computed.apply(this, a); };
    for (const method of ['appendChild', 'insertBefore']) {
      const f = Node.prototype[method];
      Node.prototype[method] = function (child, ...rest) {
        const result = f.call(this, child, ...rest);
        if (this === document.body && child.classList?.contains('sr-only')) { open = true; log.push('== screen-reader region appended'); }
        if (child.classList?.contains('toast-viewport')) { log.push('== toast column inserted'); open = false; }
        return result;
      };
    }
  });
  const name = page.locator(NAME);
  await name.fill('Baseline Reviewer Reads');
  await name.press('Enter');
  await notice(page).waitFor();
  await page.waitForTimeout(300);
  return { reads: await page.evaluate(() => window.__reads), after: await geometry(page, 'after') };
}

/** The same save with, and without, one synchronous layout (reading scrollHeight) right after lib/toast
 *  appends its screen-reader region, before the toast column renders. */
export async function forcedRead({ page }) {
  const out = {};
  for (const force of [false, true]) {
    await openProfile(page);
    if (force) await page.evaluate(() => {
      const append = Node.prototype.appendChild;
      Node.prototype.appendChild = function (child) {
        const result = append.call(this, child);
        if (this === document.body && child instanceof Element && child.classList.contains('sr-only')) void document.documentElement.scrollHeight;
        return result;
      };
    });
    const name = page.locator(NAME);
    await name.fill(`Baseline Reviewer forced ${force}`);
    await name.press('Enter');
    await notice(page).waitFor();
    await page.waitForTimeout(300);
    out[force ? 'with one forced read' : 'as is'] = await geometry(page, 'Name saved shown');
  }
  return out;
}

/** The rename answered 0, 20, 50 and 100ms late: the result does not depend on response timing. */
export async function delayed({ page }) {
  let delay = 0;
  await page.route('**/api/users/me', async (route) => {
    if (route.request().method() !== 'GET' && delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fallback();
  });
  const out = {};
  for (const ms of [0, 20, 50, 100]) {
    delay = ms;
    await openProfile(page);
    await page.locator(NAME).fill(`Baseline Reviewer d${ms}`);
    await page.getByRole('button', { name: /^(?:loading )?Save$/ }).click();
    await notice(page).waitFor();
    await page.waitForTimeout(300);
    out[`${ms}ms`] = await geometry(page, 'Name saved shown');
  }
  return out;
}
