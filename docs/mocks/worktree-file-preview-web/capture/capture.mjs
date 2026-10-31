// Frames for the worktree-file-preview board, shot from the real web app (today = HEAD, new = HEAD +
// the prototype in new/). One tree at a time:
//   unshare -n ./run-ns.sh /var/tmp/wt-preview-mock/today capture.mjs [scene…]
//   unshare -n ./run-ns.sh /var/tmp/wt-preview-mock/new   capture.mjs [scene…]
// Writes shots/<scene>.png (2x) and merges each scene's element boxes (css px) into marks.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { launch, open, settle, K } from './lib.mjs';
import { SESSION, SESSION_PATH } from '/var/tmp/wt-preview-mock/today/src/web/ui-migration/session-fixtures.mjs';

const TREE = (process.env.TREE ?? '').split('/').pop();
const only = process.argv.slice(2);
mkdirSync(`${K}/shots`, { recursive: true });
const marksFile = `${K}/marks.json`;
const marks = existsSync(marksFile) ? JSON.parse(readFileSync(marksFile, 'utf8')) : {};

// The owner's case: a mock board's files, as the session that drew them reported them.
const DIR = 'docs/mocks/first-workspace-in-conversation';
const FW = '/var/tmp/first-ws-mock/board';
const text = (path, additions, status = 'A') => ({ path, additions, deletions: 0, status });
const bin = (path, status = 'A') => ({ path, additions: -1, deletions: -1, status });
const FRAMES = [
  'e-home-633-135-615x614', 'e-missing-633-82-615x720', 'e-nogit-633-82-615x720', 'e-offline-633-113-615x658',
  'p-enroll-400-130-480x560', 'p-landing-0-0-1280x900', 'p-landing-631-104-619x677', 'p-machine-250-20-700x210',
  'p-machine-300-1035-650x200', 'p-progress-0-0-1280x900', 'p-progress-631-70-619x668', 'p-ready-629-305-623x273',
  'p-register-440-500-680x180', 'p-settings-500-850-700x110', 'p-side-existing-0-150-290x190', 'p-started-0-0-1280x900',
  't-draft-hidden-0-0-1280x900', 't-enroll-400-130-480x560', 't-form-307-922-632x572', 't-landing-0-0-1280x900',
  't-landing-tall-250-20-700x210', 't-landing-tall-300-915-650x140', 't-register-0-0-1280x900', 't-settings-0-0-1280x900',
  't-side-existing-0-0-1280x900',
];
const FILES = [
  ...[['capture.mjs', 254], ['data.mjs', 100], ['fonts.conf', 16], ['gen.py', 207], ['lib.mjs', 61],
    ['prototype.patch', 593], ['render.mjs', 16], ['run-ns.sh', 16], ['sheet.py', 20], ['vite.mjs', 15]]
    .map(([n, a]) => text(`${DIR}/capture/${n}`, a)),
  ...FRAMES.map((f) => bin(`${DIR}/frames/${f}.png`)),
  text(`${DIR}/01-web-flow.html`, 59), bin(`${DIR}/01-web-flow.png`),
  text(`${DIR}/02-web-entries.html`, 66), bin(`${DIR}/02-web-entries.png`),
  text(`${DIR}/03-iphone.html`, 263), bin(`${DIR}/03-iphone.png`),
  text(`${DIR}/04-rules.html`, 137), bin(`${DIR}/04-rules.png`),
  text(`${DIR}/board.css`, 47), text(`${DIR}/README.md`, 53),
];
// The other kinds of binary file a session changes, for the states.
const EXTRA = [
  bin('src/web/public/icon-192.png', 'M'),
  bin('src/web/public/fonts/Inter.woff2'),
  bin('src/web/public/old-logo.png', 'D'),
];
const BYTES = {
  [`${DIR}/01-web-flow.png`]: readFileSync(`${FW}/01-web-flow.png`),
  [`${DIR}/02-web-entries.png`]: readFileSync(`${FW}/02-web-entries.png`),
  [`${DIR}/03-iphone.png`]: readFileSync(`${FW}/03-iphone.png`),
  [`${DIR}/04-rules.png`]: readFileSync(`${FW}/04-rules.png`),
  'src/web/public/icon-192.png': readFileSync('/var/tmp/wt-preview-mock/today/src/web/public/icon-192.png'),
  'src/web/public/fonts/Inter.woff2': Buffer.alloc(110_000, 7),
};
for (const f of FRAMES) {
  const p = `${FW}/frames/${f}.png`;
  if (existsSync(p)) BYTES[`${DIR}/frames/${f}.png`] = readFileSync(p);
}
const PATCH = (f) => ({
  path: f.path,
  patch: `diff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${f.additions} @@\n` +
    Array.from({ length: Math.min(f.additions, 40) }, (_, i) => `+// line ${i + 1}`).join('\n'),
});

const DETAIL = {
  ...SESSION,
  title: 'Draw the first-workspace boards',
  isolationStatus: 'worktree',
  branch: 'orbit/runner-orbit-austin-workspace-6b9cd9',
  worktreeBranch: 'orbit/runner-orbit-austin-workspace-6b9cd9',
  worktreeDirty: true,
  changedFiles: [...FILES, ...EXTRA],
};

/** file = the worktree-file answer: 'bytes' | 'pending' | a status number. */
function handler(file) {
  return async (req, url) => {
    const p = url.pathname;
    if (req.method() !== 'GET') return undefined;
    if (p === `/api${SESSION_PATH}`) return DETAIL;
    if (p === `/api${SESSION_PATH}/diff`) {
      return { patches: DETAIL.changedFiles.filter((f) => f.additions > 0).map(PATCH) };
    }
    if (p === `/api${SESSION_PATH}/worktree-file`) {
      const path = url.searchParams.get('path');
      if (file === 'pending') return new Promise(() => {});
      if (typeof file === 'number') {
        const message = { 404: 'File is no longer available.', 413: 'This file is too large to preview or download.',
          503: 'The runner is offline. Try again when it is online.', 504: 'The file request timed out. Please try again.' }[file];
        return { __status: file, json: { statusCode: file, message } };
      }
      const body = BYTES[path];
      if (!body) return { __status: 404, json: { statusCode: 404, message: 'File is no longer available.' } };
      return { __raw: body, __type: path.endsWith('.png') ? 'image/png' : 'application/octet-stream' };
    }
    return undefined;
  };
}

/** css-px boxes of the first match of each selector, for the board's numbered marks. */
async function boxes(page, sels) {
  return page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, sel]) => {
    const el = document.querySelector(sel);
    if (!el) return [k, null];
    const r = el.getBoundingClientRect();
    return [k, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }];
  })), sels);
}

const scenes = [];
const scene = (name, tree, fn) => scenes.push({ name, tree, fn });

/** The session page with the drawer open on `path` (maximized unless panel). */
async function drawer(b, { path, file = 'bytes', panel = false, theme = 'light', width = 1440, height = 900, shrink }) {
  const s = await open(b, {
    path: SESSION_PATH, theme, width, height, handler: handler(file),
    init: { fn: (max) => localStorage.setItem('wt-diff-max', max), arg: panel ? '0' : '1' },
  });
  await s.page.locator('.wt-row-toggle').click();
  await s.page.locator('.wt-diff-drawer').waitFor();
  const row = s.page.locator(`.wt-diff-list button[title="View diff · ${path}"]`);
  // Open every collapsed folder on the way to the file (binary-only folders start shut).
  for (let i = 0; i < 5 && !(await row.count()); i++) {
    const heads = s.page.locator('.wt-diff-group-head');
    const n = await heads.count();
    for (let j = 0; j < n; j++) {
      const h = heads.nth(j);
      const title = await h.getAttribute('title');
      if (path.startsWith(`${title}/`) && (await h.locator('.wt-diff-group-caret').textContent()) === '▸') {
        await h.click();
        break;
      }
    }
  }
  await row.click();
  // A smaller window once the drawer is open (the session page opens it at desktop size only).
  if (shrink) await s.page.setViewportSize(shrink);
  await settle(s.page);
  return s;
}

async function waitImage(page) {
  await page.locator('.wt-preview-img img').waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.wt-preview-img img');
    return img && img.complete && img.naturalWidth > 0;
  });
  await page.locator('.wt-preview-meta >> text=×').waitFor();
  await settle(page);
}

const HEAD = {
  head: '.wt-diff-pane-head', nav: '.wt-diff-nav-pos', meta: '.wt-preview-meta', dl: '.wt-diff-pane-head .orbit-button',
  body: '.wt-preview-body', img: '.wt-preview-img', state: '.wt-preview-state', empty: '.wt-diff-empty',
  list: '.wt-diff-list', pane: '.wt-diff-pane', active: '.wt-diff-list .session-file-btn.active',
  vbar: '.orbit-image-preview-actions', vclose: '.orbit-image-preview-close',
};

// ───────────────────────────── today ─────────────────────────────
scene('t-png', 'today', (b) => drawer(b, { path: `${DIR}/01-web-flow.png` }));
scene('t-panel', 'today', (b) => drawer(b, { path: `${DIR}/01-web-flow.png`, panel: true }));

// ───────────────────────────── proposal ─────────────────────────────
scene('p-png', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/01-web-flow.png` });
  await waitImage(s.page);
  return s;
});
scene('p-png-dark', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/02-web-entries.png`, theme: 'dark' });
  await waitImage(s.page);
  return s;
});
scene('p-panel', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/03-iphone.png`, panel: true });
  await waitImage(s.page);
  return s;
});
scene('p-viewer', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/frames/p-landing-631-104-619x677.png` });
  await waitImage(s.page);
  await s.page.locator('.wt-preview-img').click();
  await s.page.locator('.orbit-image-preview, [class*="image-preview"]').first().waitFor().catch(() => {});
  await s.page.waitForTimeout(600);
  return s;
});
scene('p-frame', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/frames/p-landing-631-104-619x677.png` });
  await waitImage(s.page);
  return s;
});
scene('p-next', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/capture/vite.mjs` });
  await s.page.getByRole('button', { name: 'Next file' }).click();
  await waitImage(s.page);
  return s;
});
scene('p-small', 'new', async (b) => {
  const s = await drawer(b, { path: 'src/web/public/icon-192.png' });
  await waitImage(s.page);
  return s;
});
scene('p-loading', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/04-rules.png`, file: 'pending' });
  await s.page.getByText('Loading file…').waitFor();
  return s;
});
scene('p-other', 'new', async (b) => {
  const s = await drawer(b, { path: 'src/web/public/fonts/Inter.woff2' });
  await s.page.getByText('No preview available').waitFor();
  return s;
});
scene('p-deleted', 'new', async (b) => {
  const s = await drawer(b, { path: 'src/web/public/old-logo.png' });
  await s.page.getByText('File deleted').waitFor();
  return s;
});
scene('p-offline', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/04-rules.png`, file: 503 });
  await s.page.getByText('Runner unavailable').waitFor();
  return s;
});
scene('p-large', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/04-rules.png`, file: 413 });
  await s.page.getByText('File too large').waitFor();
  return s;
});
scene('p-timeout', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/04-rules.png`, file: 504 });
  await s.page.getByText('File request timed out').waitFor();
  return s;
});

// The states again in a smaller window, so the board can show them larger.
const SMALL = { shrink: { width: 1000, height: 560 } };
scene('s-loading', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/04-rules.png`, file: 'pending', ...SMALL });
  await s.page.getByText('Loading file…').waitFor();
  return s;
});
scene('s-small', 'new', async (b) => {
  const s = await drawer(b, { path: 'src/web/public/icon-192.png', ...SMALL });
  await waitImage(s.page);
  return s;
});
scene('s-other', 'new', async (b) => {
  const s = await drawer(b, { path: 'src/web/public/fonts/Inter.woff2', ...SMALL });
  await s.page.getByText('No preview available').waitFor();
  return s;
});
scene('s-deleted', 'new', async (b) => {
  const s = await drawer(b, { path: 'src/web/public/old-logo.png', ...SMALL });
  await s.page.getByText('File deleted').waitFor();
  return s;
});
scene('s-offline', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/04-rules.png`, file: 503, ...SMALL });
  await s.page.getByText('Runner unavailable').waitFor();
  return s;
});
scene('s-large', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/04-rules.png`, file: 413, ...SMALL });
  await s.page.getByText('File too large').waitFor();
  return s;
});

// Narrow panes: a phone, and the side panel dragged to its minimum width.
scene('v-phone', 'new', async (b) => {
  const s = await drawer(b, { path: `${DIR}/01-web-flow.png`, shrink: { width: 390, height: 844 } });
  await waitImage(s.page);
  return s;
});
scene('v-narrow', 'new', async (b) => {
  const s = await open(b, {
    path: SESSION_PATH, width: 1440, height: 900, handler: handler('bytes'),
    init: { fn: () => { localStorage.setItem('wt-diff-max', '0'); localStorage.setItem('wt-diff-width', '560'); } },
  });
  await s.page.locator('.wt-row-toggle').click();
  await s.page.locator('.wt-diff-drawer').waitFor();
  await s.page.locator(`.wt-diff-list button[title="View diff · ${DIR}/01-web-flow.png"]`).click();
  await waitImage(s.page);
  return s;
});

const browser = await launch();
try {
  for (const sc of scenes) {
    if (sc.tree !== TREE) continue;
    if (only.length && !only.includes(sc.name)) continue;
    const t0 = Date.now();
    const s = await sc.fn(browser);
    await s.page.screenshot({ path: `${K}/shots/${sc.name}.png` });
    marks[sc.name] = { boxes: await boxes(s.page, HEAD), viewport: s.page.viewportSize() };
    writeFileSync(marksFile, JSON.stringify(marks, null, 1));
    if (s.errors.length) console.log(sc.name, 'errors:', s.errors.slice(0, 3));
    console.log(sc.name, `${Date.now() - t0}ms`);
    await s.context.close();
  }
} finally {
  await browser.close();
}
