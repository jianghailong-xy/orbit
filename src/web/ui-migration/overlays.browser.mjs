import { test, expect } from '@playwright/test';

const fixture = '/ui-migration/overlays.html';
const errors = new WeakMap();
test.beforeEach(async ({ page }, info) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
  await page.goto(fixture);
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
    .toEqual({ width: info.project.use.viewport.width, dpr: 1, scale: 1 });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function settled(dialog) {
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => {
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.opacity !== '1' || s.transform !== 'none' || (s.scale !== 'none' && s.scale !== '1')) return false;
    }
    return true;
  })).toBe(true);
  await dialog.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function trapped(page, dialog, count = 8) {
  const contains = () => dialog.evaluate((el) => el.contains(document.activeElement));
  await expect.poll(contains).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < count; i++) {
    await page.keyboard.press(key);
    await expect.poll(contains, { message: `${key} remains in the active overlay` }).toBe(true);
  }
}
async function topmost(dialog) {
  expect(await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 100)));
  })).toBe(true);
}
async function outside(page, info) {
  if (info.project.use.hasTouch) await page.touchscreen.tap(4, 60);
  else await page.mouse.click(4, 60);
}
async function attach(info, name, value) {
  await info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}
async function shot(page, info, name, locator) {
  await info.attach(name, { body: await (locator ?? page).screenshot({ animations: 'disabled' }), contentType: 'image/png' });
}
const pageScroll = (page) => page.evaluate(() => ({ x: scrollX, y: scrollY,
  html: document.documentElement.style.cssText, body: document.body.style.cssText }));
async function locked(page) {
  expect(await page.evaluate(() => [document.documentElement, document.body].some((el) => /hidden|clip/.test(getComputedStyle(el).overflowY)))).toBe(true);
}

test('dialog and drawers match current surfaces, geometry, typography and actions', async ({ page }, info) => {
  const measurements = {};
  const settleState = (locator) => locator.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})));
  });
  const inputState = (input) => input.evaluate((el) => {
    const style = getComputedStyle(el);
    return { hovered: el.matches(':hover'), focused: el.matches(':focus'), focusVisible: el.matches(':focus-visible'),
      borderColor: style.borderColor, borderWidth: style.borderWidth, borderStyle: style.borderStyle, boxShadow: style.boxShadow };
  });
  const measure = async (system, kind) => {
    await page.getByRole('button', { name: `${system} ${kind}`, exact: true }).click();
    const overlay = page.getByRole(system === 'Orbit' && kind === 'confirm' ? 'alertdialog' : 'dialog');
    await settled(overlay);
    // Sample the same neutral state. Opening buttons can leave the pointer over
    // a newly positioned input, and the two libraries choose different autofocus.
    await page.mouse.move(0, 0);
    const focusRoot = system === 'AntD' && kind.includes('drawer') ? page.locator('.reference-drawer-root').filter({ has: overlay }) : overlay;
    await focusRoot.focus();
    await expect(focusRoot).toBeFocused();
    await settleState(overlay);
    const root = system === 'Orbit' ? overlay : page.locator('.reference-surface:visible');
    const result = await root.evaluate((el) => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      const keys = ['fontFamily', 'fontSize', 'lineHeight', 'color', 'backgroundColor', 'borderRadius', 'padding', 'boxShadow'];
      const text = [...el.querySelectorAll('button, input')].map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { name: node.getAttribute('aria-label') ?? node.textContent, x: rect.x - r.x, y: rect.y - r.y, width: rect.width, height: rect.height,
          hovered: node.matches(':hover'), focused: node.matches(':focus'), focusVisible: node.matches(':focus-visible'),
          ...(node.tagName === 'INPUT' ? { borderColor: style.borderColor, borderWidth: style.borderWidth, borderStyle: style.borderStyle, boxShadow: style.boxShadow } : {}) };
      });
      return { x: r.x, y: r.y, width: r.width, height: r.height, ...Object.fromEntries(keys.map((key) => [key, s[key]])), controls: text };
    });
    if (system === 'AntD' && kind.includes('drawer')) {
      result.boxShadow = await page.locator('.reference-drawer-wrapper:visible').evaluate((el) => getComputedStyle(el).boxShadow);
    }
    if (kind.includes('drawer')) {
      result.separators = {};
      for (const [part, edge] of [['header', 'Bottom'], ['footer', 'Top']]) {
        const region = root.locator(system === 'AntD' ? `.reference-${part}` : `:scope > .orbit-overlay-${part}`);
        result.separators[part] = await region.evaluate((el, edge) => {
          const style = getComputedStyle(el);
          return { color: style[`border${edge}Color`], width: style[`border${edge}Width`], style: style[`border${edge}Style`] };
        }, edge);
      }
    }
    for (const control of result.controls) {
      expect(control.hovered, `${system} ${kind}: ${control.name} is not hovered`).toBe(false);
      expect(control.focused, `${system} ${kind}: ${control.name} is not focused`).toBe(false);
      expect(control.focusVisible, `${system} ${kind}: ${control.name} has no focus ring`).toBe(false);
    }
    await shot(page, info, `${system}-${kind}`, root);
    if (kind === 'bottom drawer') {
      const input = overlay.getByRole('textbox', { name: 'Workspace name' });
      await input.hover();
      await settleState(input);
      const hover = await inputState(input);
      expect(hover.hovered).toBe(true);
      expect(hover.focused).toBe(false);
      await shot(page, info, `${system}-${kind}-input-hover`, root);
      await page.mouse.move(0, 0);
      await input.focus();
      await expect(input).toBeFocused();
      await settleState(input);
      const focus = await inputState(input);
      expect(focus.hovered).toBe(false);
      expect(focus.focusVisible).toBe(true);
      await shot(page, info, `${system}-${kind}-input-focus`, root);
      result.inputStates = { hover, focus };
    }
    await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(overlay).not.toBeVisible();
    return result;
  };
  for (const kind of ['dialog', 'right drawer', 'bottom drawer', 'confirm']) {
    const ant = await measure('AntD', kind);
    const orbit = await measure('Orbit', kind);
    measurements[kind] = { ant, orbit };
  }
  await attach(info, 'appearance', measurements);
  for (const [kind, { ant, orbit }] of Object.entries(measurements)) expect(orbit, kind).toEqual(ant);
});

test('dialog traps Tab, ignores drag release, closes on Esc or outside press and restores focus', async ({ page }, info) => {
  const trigger = page.getByRole('button', { name: 'Open Dialog', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Workspace dialog', exact: true });
  await settled(dialog);
  await expect(dialog).toBeFocused();
  await expect(dialog).toHaveAttribute('aria-describedby', /.+/);
  await trapped(page, dialog, 10);
  await locked(page);
  await dialog.getByRole('textbox', { name: 'Parent name' }).fill('Draft survives');
  const rect = await dialog.boundingBox();
  await page.mouse.move(rect.x + 10, rect.y + 10);
  await page.mouse.down();
  await page.mouse.move(4, 60);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await settled(dialog);
  await outside(page, info);
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await settled(dialog);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await attach(info, 'dismissal', { tabBothDirections: true, dragReleaseIgnored: true, escape: true, outside: info.project.use.hasTouch ? 'touch' : 'mouse', closeButton: true, restored: true });
});

test('nested dialog and imperative confirmation close only the top layer', async ({ page }, info) => {
  const before = await pageScroll(page);
  const trigger = page.getByRole('button', { name: 'Open Drawer', exact: true });
  await trigger.click();
  const parent = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
  await settled(parent);
  const childTrigger = parent.getByRole('button', { name: 'Open nested dialog' });
  await childTrigger.click();
  const child = page.getByRole('dialog', { name: 'Nested dialog', exact: true });
  await settled(child);
  await topmost(child);
  await expect(child.locator(':scope > .orbit-overlay-header')).toHaveCSS('padding', '0px');
  await expect(child.locator(':scope > .orbit-overlay-body')).toHaveCSS('padding', '0px');
  await expect(child.getByRole('button', { name: 'Close', exact: true })).toHaveCSS('position', 'absolute');
  await trapped(page, child, 4);
  await locked(page);
  await shot(page, info, 'drawer-with-dialog');
  await page.keyboard.press('Escape');
  await expect(child).not.toBeVisible();
  await expect(parent).toBeVisible();
  await expect(childTrigger).toBeFocused();
  await locked(page);
  const confirmTrigger = parent.getByRole('button', { name: 'Discard draft' });
  await confirmTrigger.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard draft?' });
  await settled(confirmation);
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await trapped(page, confirmation, 3);
  await outside(page, info);
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmTrigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(parent).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect.poll(() => pageScroll(page)).toEqual(before);
  await attach(info, 'nested-focus-and-scroll', { before, after: await pageScroll(page), parentPreserved: true, restoredEachLayer: true });
});

for (const kind of ['Dialog', 'Drawer']) test(`actual legacy modal, Popconfirm and Select work inside Orbit ${kind.toLowerCase()}`, async ({ page }, info) => {
  await page.getByRole('button', { name: `Open ${kind}`, exact: true }).click();
  const parent = page.getByRole('dialog', { name: `Workspace ${kind.toLowerCase()}`, exact: true });
  await settled(parent);
  const trigger = parent.getByRole('button', { name: 'Open legacy child' });
  await trigger.click();
  const child = page.getByRole('dialog', { name: 'Legacy child', exact: true });
  await settled(child);
  await topmost(child);
  await child.getByRole('textbox', { name: 'Legacy name' }).fill('Nested draft');
  await trapped(page, child, 5);
  await shot(page, info, 'legacy-inside-orbit');
  await page.keyboard.press('Escape');
  await expect(child).not.toBeVisible();
  await expect(parent).toBeVisible();
  await expect(trigger).toBeFocused();
  await locked(page);
  await parent.getByRole('button', { name: 'Turn off link', exact: true }).click();
  const popup = page.getByRole('tooltip', { name: /Turn off this link/ });
  await settled(popup);
  await topmost(popup);
  await popup.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(parent).toBeVisible();
  const select = parent.getByRole('combobox', { name: 'Expires' });
  await select.click();
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(parent.getByRole('status', { name: 'Expiry' })).toHaveText('7 days');
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await select.click();
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await expect(parent).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(parent).not.toBeVisible();
  await attach(info, 'legacy-children', { modal: true, popconfirm: true, select: true, parentPreserved: true });
});

for (const kind of ['parent', 'drawer']) test(`Orbit dialog and nested confirmation work inside a legacy ${kind === 'parent' ? 'modal' : 'drawer'}`, async ({ page }, info) => {
  const before = await pageScroll(page);
  const trigger = page.getByRole('button', { name: `Open Legacy ${kind}` });
  await trigger.click();
  const parent = page.getByRole('dialog', { name: `Legacy ${kind}`, exact: true });
  await settled(parent);
  await parent.getByRole('textbox', { name: 'Legacy parent name' }).fill('Blur still reaches the form');
  await page.keyboard.press('Tab');
  await expect(parent.getByRole('status', { name: 'Legacy field blurred' })).toHaveText('true');
  const childTrigger = parent.getByRole('button', { name: 'Open Orbit child' });
  await childTrigger.click();
  const child = page.getByRole('dialog', { name: 'Orbit child', exact: true });
  await settled(child);
  await topmost(child);
  await trapped(page, child, 10);
  await shot(page, info, 'orbit-inside-legacy');
  const confirmTrigger = child.getByRole('button', { name: 'Discard draft' });
  await confirmTrigger.click();
  const confirmation = page.getByRole('alertdialog');
  await settled(confirmation);
  await trapped(page, confirmation, 3);
  await page.keyboard.press('Escape');
  await expect(confirmation).not.toBeVisible();
  await expect(confirmTrigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(child).not.toBeVisible();
  await expect(parent).toBeVisible();
  await expect(childTrigger).toBeFocused();
  await locked(page);
  await parent.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(parent).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect.poll(() => pageScroll(page)).toEqual(before);
  await attach(info, 'legacy-parent', { focusAtEveryLayer: true, scrollRestored: true });
});

test('async confirmation prevents duplicate submits, retains failures and permits retry or cancellation', async ({ page }, info) => {
  const replies = [];
  await page.route('**/__overlay-confirm?*', (route) => { replies.push(route); });
  const trigger = page.getByRole('button', { name: 'Delete runner', exact: true });
  await trigger.click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete runner?' });
  await settled(dialog);
  await expect(page.getByRole('alertdialog')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => replies.length).toBe(1);
  const submit = dialog.getByRole('button', { name: 'Delete', exact: true });
  await expect(submit).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  const rect = await submit.boundingBox();
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { clickCount: 2 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await outside(page, info);
  await expect(dialog).toBeVisible();
  expect(replies).toHaveLength(1);
  await shot(page, info, 'confirm-pending');
  await replies[0].fulfill({ status: 409, body: 'busy' });
  await expect(dialog.getByRole('alert')).toHaveText('Runner is busy. Try again.');
  await expect(submit).not.toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await shot(page, info, 'confirm-error');
  await submit.click();
  await expect.poll(() => replies.length).toBe(2);
  await replies[1].fulfill({ status: 200, body: 'ok' });
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('status', { name: 'Result', exact: true })).toHaveText('confirmed');
  await expect(page.getByRole('status', { name: 'Attempts' })).toHaveText('2');
  await trigger.click();
  await settled(dialog);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('status', { name: 'Result', exact: true })).toHaveText('cancelled');
  expect(replies).toHaveLength(2);
  await attach(info, 'async-confirm', { attempts: 2, pendingBlocksDismissal: true, duplicatesBlocked: true, failedThenRetried: true, result: 'confirmed then cancelled' });
});

test('dismissal controls, retained form values, long content and bottom sheet remain usable', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Open Protected' }).click();
  const protectedDialog = page.getByRole('dialog', { name: 'Protected dialog' });
  await settled(protectedDialog);
  await expect(protectedDialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await outside(page, info);
  await expect(protectedDialog).toBeVisible();
  await protectedDialog.getByRole('button', { name: 'Done protected' }).click();
  const retainedTrigger = page.getByRole('button', { name: 'Open Retained' });
  await retainedTrigger.click();
  const retained = page.getByRole('dialog', { name: 'Retained dialog' });
  await settled(retained);
  await retained.getByRole('textbox').fill('Keep draft');
  await page.keyboard.press('Escape');
  await expect(retained).not.toBeVisible();
  await retainedTrigger.click();
  await expect(retained.getByRole('textbox')).toHaveValue('Keep draft');
  await page.keyboard.press('Escape');
  const sheetTrigger = page.getByRole('button', { name: 'Open Bottom sheet' });
  if (info.project.use.hasTouch) await sheetTrigger.tap(); else await sheetTrigger.click();
  const sheet = page.getByRole('dialog', { name: 'Footnote' });
  await settled(sheet);
  await trapped(page, sheet, 3);
  expect(await sheet.evaluate((el) => Math.round(el.getBoundingClientRect().bottom))).toBe(info.project.use.viewport.height);
  await shot(page, info, 'bottom-sheet');
  await outside(page, info);
  await expect(sheet).not.toBeVisible();
  await expect(sheetTrigger).toBeFocused();
  await page.getByRole('button', { name: 'Open Long dialog' }).click();
  const long = page.getByRole('dialog', { name: 'Long dialog' });
  await settled(long);
  await locked(page);
  await long.getByRole('button', { name: 'Done long' }).click();
  await expect(long).not.toBeVisible();
  await attach(info, 'sizing-and-controls', { escapeAndOutsideOptOut: true, retainedDraft: true, bottomSheet: true, longFooterReachable: true });
});

test('open portals inherit live theme changes and composing Escape preserves the dialog', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Open Dialog', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace dialog' });
  await settled(dialog);
  const initial = info.project.use.colorScheme;
  const color = (theme) => theme === 'dark' ? 'rgb(52, 52, 55)' : 'rgb(255, 255, 255)';
  await expect(dialog).toHaveCSS('background-color', color(initial));
  await dialog.getByRole('button', { name: 'Switch theme' }).click();
  await expect(dialog).toHaveCSS('background-color', color(initial === 'dark' ? 'light' : 'dark'));
  await dialog.getByRole('button', { name: 'Open nested dialog' }).click();
  const nested = page.getByRole('dialog', { name: 'Nested dialog', exact: true });
  await settled(nested);
  await expect(nested).toHaveCSS('background-color', color(initial === 'dark' ? 'light' : 'dark'));
  const input = nested.getByRole('textbox');
  await input.focus();
  await input.dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  await expect(nested).toBeVisible();
  await input.dispatchEvent('compositionend');
  // Safari reports compositionend before its final keydown. Wait for the next
  // painted frame rather than issuing another Escape inside that same IME turn.
  await input.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await input.fill('Composition finished');
  await page.keyboard.press('Escape');
  await expect(nested).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await attach(info, 'theme-and-composition', { initial, liveThemeInherited: true, composingEscapeIgnored: true });
});

test('confirmation owner unmount and immediate sequential prompts do not reuse stale state', async ({ page }, info) => {
  let reply;
  await page.route('**/__overlay-confirm?*', (route) => { reply = route; });
  const trigger = page.getByRole('button', { name: 'Delete runner', exact: true });
  await trigger.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => Boolean(reply)).toBe(true);
  // Model a route/owner removal while its request is in flight. This is a
  // programmatic lifecycle change, not a claim that the modal permits outside clicks.
  await page.getByRole('button', { name: 'Toggle confirmation host', includeHidden: true }).evaluate((el) => el.click());
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Last confirmation result' })).toHaveText('cancelled');
  await page.getByRole('button', { name: 'Toggle confirmation host' }).click();
  await trigger.click();
  const reopened = page.getByRole('alertdialog', { name: 'Delete runner?' });
  await settled(reopened);
  await reply.fulfill({ status: 200, body: 'old request finished' });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(reopened).toBeVisible();
  await expect(reopened.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await reopened.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Sequential confirmations' }).click();
  await page.getByRole('alertdialog', { name: 'First confirmation' }).getByRole('button', { name: 'OK', exact: true }).click();
  const second = page.getByRole('alertdialog', { name: 'Second confirmation' });
  await settled(second);
  await expect(second.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await second.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(second.getByRole('alert')).toHaveText('Second action failed');
  await second.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await attach(info, 'confirmation-lifecycle', { unmountSettlesFalse: true, staleCompletionIgnored: true, sequentialFreshState: true, synchronousFailureVisible: true });
});

test('explicit focus, native form validation, motion and document scroll restore correctly', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const trigger = page.getByRole('button', { name: 'Edit name', exact: true });
  if (info.project.use.hasTouch) await trigger.tap(); else await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Edit name', exact: true });
  await settled(dialog);
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Save name' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toBeFocused();
  const before = await pageScroll(page);
  const scrollMethod = info.project.use.browserName === 'webkit' && info.project.use.isMobile ? 'PageDown' : 'wheel';
  const scrollPage = async () => {
    // Playwright mobile WebKit has no mouse.wheel implementation. Its native
    // keyboard scrolling is supported; touch dismissal is tested separately.
    if (scrollMethod === 'PageDown') await page.keyboard.press('PageDown');
    else { await page.mouse.move(4, 60); await page.mouse.wheel(0, 300); }
  };
  await scrollPage();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await pageScroll(page)).y).toBe(before.y);
  await dialog.getByRole('textbox').fill('Valid name');
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await scrollPage();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before.y);
  await attach(info, 'focus-form-motion-scroll', { explicitFocus: true, requiredValidation: true, nativeEnter: true, motionCompleted: true, scrollMethod, scrollLockedUntilClose: true });
});
