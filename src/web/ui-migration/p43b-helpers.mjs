// Steps and observations shared by the P4.3b specs (p43b.browser.mjs on real routes,
// p43b-cards.browser.mjs on the decision-card page): the same locators drive the replaced controls
// (same-commit reference tree) and the Orbit ones, and each step's observation is the same record on
// both, so the two runs' traces can be compared step by step.
export const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// A replaced button's icon names itself ("plus Add workspace"), and its loading icon can stay in the
// name ("loading Save"); Orbit buttons hide both from the name.
export const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const named = (name) => new RegExp(`^(?:loading |[a-z]+(?:-[a-z]+)* )?${escape(name)}$`);
export const button = (scope, name) => scope.getByRole('button', { name: named(name) });
// A floating popup (a popover, a tooltip, an anchored question) by the text it holds: the replaced
// popover is role=tooltip, the Orbit one role=dialog, so it is found by its words.
export const popup = (page, text) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"], .ant-popover, .ant-tooltip')
  .filter({ hasText: text }).filter({ visible: true }).last();
export const dialog = (page, title) => page.locator('[role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
export const notifications = (page) => page.getByRole('region', { name: 'Notifications', exact: true });

/** Wait out enter and leave animations (the replaced controls run theirs whatever motion is asked for),
 *  so an observation reads where a step ended up, not a frame of its transition. A replaced popup that
 *  has just been asked to open first sits in rc-motion's prepare step, its animation paused at opacity 0
 *  under the classes `<motion>-appear`/`-enter` (`-leave` while it closes), and is not running yet; Base
 *  UI marks its own transitions with data-starting-style and data-ending-style. */
export const settled = (page) => page.waitForFunction(
  () => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)
    && ![...document.querySelectorAll('[class*="-appear"], [class*="-enter"], [class*="-leave"]')]
      .some((el) => [...el.classList].some((name) => /-(appear|enter|leave)(-(prepare|start|active))?$/.test(name)))
    && !document.querySelector('[data-starting-style], [data-ending-style]'),
  null, { timeout: 3000 },
).catch(() => {});

export async function observe(page, fixtures, step) {
  await settled(page);
  const state = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0; };
    const words = (el) => el.textContent.trim().replace(/\s+/g, ' ').slice(0, 160);
    const text = (ids) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' | ');
    const name = (el) => el && (el.getAttribute('aria-label') || text(el.getAttribute('aria-labelledby')) || el.labels?.[0]?.textContent?.trim()
      || el.getAttribute('placeholder') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase());
    const active = document.activeElement;
    const notifications = document.querySelector('[role="region"][aria-label="Notifications"]');
    const modal = (el) => el.getAttribute('aria-modal') === 'true' || el.matches('.ant-modal-wrap *, .ant-modal-wrap');
    const surfaces = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="tooltip"]')].filter(visible);
    return {
      url: location.pathname + location.search,
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: name(active) } : 'body',
      // Modal dialogs, and the floating popups (popovers, tooltips, anchored questions) by their words.
      dialogs: surfaces.filter((el) => el.getAttribute('role') !== 'tooltip' && modal(el)).map(words),
      popups: surfaces.filter((el) => el.getAttribute('role') === 'tooltip' || !modal(el)).map(words).filter(Boolean),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map(words).filter(Boolean),
      notifications: notifications ? notifications.innerText.trim().replace(/\s+/g, ' ') : '',
    };
  });
  return { step, ...state, requests: fixtures.requests.splice(0).map(({ method, path, body }) => ({ method, path, body })) };
}

/** Type into a field the way a person does: once it has stopped moving, focus, select what is there,
 *  type. A replaced text area that has just appeared still animates its min-height (0.3s), and
 *  Playwright retries a click on a moving field, scrolling it to a different edge on each retry, so
 *  the dialog would end up scrolled by however many retries it took. */
export async function fill(locator, value) {
  await locator.waitFor();
  await frames(locator.page());
  await settled(locator.page());
  await locator.click();
  await locator.press('ControlOrMeta+a');
  if (value) await locator.pressSequentially(value);
  else await locator.press('Backspace');
}

export const attachTrace = (testInfo, trace) => testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
/** Bring a part of the page to the top of the view, the same way on both trees. */
export const top = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));
export const phone = (testInfo) => !!testInfo.project.use.isMobile;
