// UI helpers: sign in through the web's own login form, open a page, take shots.
import { accounts, browser, note, sleep, WEB } from './lib.mjs';

export async function signedIn({ origin = WEB, width = 1440, height = 1000 } = {}) {
  const ctx = await browser({ origin, width, height });
  const { page } = ctx;
  const a = accounts().owner;
  // A vite dev server bundles its dependencies on the first visit and answers 504 "Outdated Optimize Dep" while
  // it does: reload until the login form is there.
  for (let attempt = 1; ; attempt++) {
    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('input[type=email]').waitFor({ timeout: 30_000 });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      note(`login form not shown on ${origin} (attempt ${attempt}); reloading`);
    }
  }
  await page.locator('input[type=email]').fill(a.email);
  await page.locator('label.login-field input:not([type=email])').first().fill(a.password);
  await page.locator('button.login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
  await sleep(500);
  note(`signed in on ${origin} as ${a.email}`);
  return ctx;
}

export async function shot(page, file, opts = {}) {
  await sleep(opts.settle ?? 600);
  // The app shell is 100vh and scrolls inside it, so what is below the fold is in no screenshot: for a clip that
  // reaches past the viewport, the viewport grows to hold it (the page flows from the top, so nothing above moves).
  const clip = opts.clip;
  const view = page.viewportSize();
  if (clip && clip.y + clip.height > view.height) {
    await page.setViewportSize({ width: view.width, height: Math.min(4000, Math.ceil(clip.y + clip.height + 24)) });
    await sleep(500);
  }
  await page.screenshot({ path: file, fullPage: false, ...(clip ? { clip: { ...clip, x: Math.max(0, clip.x), y: Math.max(0, clip.y) } } : {}) });
  if (clip && page.viewportSize().height !== view.height) await page.setViewportSize(view);
  note(`shot ${file}`);
}
