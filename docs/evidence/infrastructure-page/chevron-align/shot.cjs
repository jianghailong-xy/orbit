// Screenshot the Machines section of /infrastructure and measure where a machine card's fold chevron
// sits against the engine icons in the rows under it, then draw that onto the shot.
// Usage: node shot.cjs <webDir> <baseUrl> <outDir> <label>
//   webDir: src/web of the checkout (Playwright is resolved from there); baseUrl: a running
//   `npx vite` of it. Writes into outDir <label>-{desktop,desktop-hover,desktop-focus,tablet,phone}.png
//   (the annotated boards), <label>-<scene>-head.png (the first card's head and first engine row, cut
//   out of the board), <label>-measure.json, and raw/<label>-<scene>.png (the bare screenshots). The
//   API is faked in the browser (page.route on /api/**), with the machines of ../p3/shot.cjs: Mac
//   Studio open, HPC folded, ThinkPad offline.
const fs = require('node:fs');
const path = require('node:path');
const [webDir, base, outDir, label] = process.argv.slice(2);
const { chromium } = require(require.resolve('@playwright/test', { paths: [webDir] }));

// Public ids as the app holds them (base62 of a UUID), without importing the shared TS source.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const id = (n) => {
  let v = BigInt('0x' + `0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`.replace(/-/g, ''));
  let s = '';
  while (v > 0n) { s = ALPHABET[Number(v % 62n)] + s; v /= 62n; }
  return s;
};
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MAC = id(31), HPC = id(32), THINKPAD = id(33), USER = id(40);
const google = { supported: true, installed: false, version: null, envKeyAvailable: false, authSource: null, googleLogin: 'available' };
const runners = [
  { id: MAC, name: 'Mac Studio', online: true, activeSessions: 2, maxConcurrent: 4, hostname: 'mac-studio.local', version: '0.1.240',
    lastHeartbeatAt: iso(NOW - 20_000), position: 0, antigravity: google, capabilities: [],
    engines: [
      { engine: 'claude', installed: true, auth: 'yes', version: '2.1.4 (Claude Code)', accounts: [
        { id: 'default', name: 'Personal Max', home: '/Users/me/.orbit/default', auth: 'yes' },
        { id: 'slot-2', name: 'Work', home: '/Users/me/.orbit/slot-2', auth: 'yes' } ] },
      { engine: 'codex', installed: true, auth: 'no', version: 'codex-cli 0.160.0' },
      { engine: 'kimi', installed: false, auth: 'unknown' },
    ] },
  { id: HPC, name: 'HPC', online: true, activeSessions: 5, maxConcurrent: 8, hostname: 'hpc-01', version: '0.1.240',
    lastHeartbeatAt: iso(NOW - 10_000), position: 1, antigravity: google, capabilities: [],
    engines: [
      { engine: 'claude', installed: true, auth: 'yes', version: '2.1.4 (Claude Code)' },
      { engine: 'codex', installed: true, auth: 'yes', version: 'codex-cli 0.160.0' },
      { engine: 'kimi', installed: true, auth: 'yes', version: '1.4.0' },
    ] },
  { id: THINKPAD, name: 'ThinkPad', online: false, activeSessions: 0, maxConcurrent: 3, hostname: 'thinkpad', version: '0.1.231',
    lastHeartbeatAt: iso(NOW - 26 * 3600_000), position: 2, capabilities: [],
    engines: [ { engine: 'claude', installed: true, auth: 'yes' }, { engine: 'codex', installed: true, auth: 'no' }, { engine: 'kimi', installed: true, auth: 'yes' } ] },
];
const workspaces = [
  { id: id(21), name: 'orbit', createdAt: iso(NOW - 9e8), position: 0, runnerId: MAC, runner: { id: MAC, name: 'Mac Studio' } },
  { id: id(22), name: 'orbit-develop', createdAt: iso(NOW - 8e8), position: 1, runnerId: HPC, runner: { id: HPC, name: 'HPC' } },
];
const me = { id: USER, name: 'Wikova', email: 'wikova@example.test', createdAt: iso(NOW - 9e9), avatarUpdatedAt: null, role: 'MEMBER',
  preferences: { theme: 'light', defaultPermissionMode: 'default', notifySessionFinished: true, notifyAgentMessage: true, enableOrchestration: true } };

// A desktop window beside the default sidebar; a tablet (a touch screen, so nothing hovers) whose
// cards are still wide; a phone, whose cards take the narrow layout.
const SCENES = [
  { name: 'desktop', width: 1440, mobile: false },
  { name: 'desktop-hover', width: 1440, mobile: false, hover: true },
  { name: 'desktop-focus', width: 1440, mobile: false, focus: true },
  { name: 'tablet', width: 820, mobile: true },
  { name: 'phone', width: 390, mobile: true },
];

/** Where the marks are, in CSS px of the viewport (the app scrolls in its own pane; the viewport is
 *  grown until the section fits, so these are also the screenshot's coordinates). */
function measure() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const section = document.querySelector('#machines');
  return {
    section: box(section),
    cards: [...document.querySelectorAll('.re-runner-card')].map((card) => {
      const handle = card.querySelector('.re-drag');
      const style = handle ? getComputedStyle(handle) : null;
      return {
        name: card.querySelector('.re-runner')?.textContent,
        open: card.querySelector('.re-toggle')?.getAttribute('aria-expanded') === 'true',
        card: box(card),
        head: box(card.querySelector('.re-head')),
        // The column box, and the stroke it draws: the chevron's path (turned with it when open).
        chevron: box(card.querySelector('.re-chev')),
        chevronInk: box(card.querySelector('.re-chev path')),
        dot: box(card.querySelector('.re-dot')),
        name_: box(card.querySelector('.re-runner')),
        handle: box(handle),
        handleShown: !!style && style.visibility !== 'hidden' && Number(style.opacity) > 0.5,
        handleFocused: document.activeElement === handle,
        tiles: [...card.querySelectorAll('.re-row[data-engine] > .re-id > .provider-tile')].map((t) => ({
          engine: t.closest('.re-row').getAttribute('data-engine'),
          ...box(t),
        })),
        engineNames: [...card.querySelectorAll('.re-row[data-engine] > .re-id .re-name')].map(box),
      };
    }),
  };
}

const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const signed = (n) => (n > 0.05 ? '+' : n < -0.05 ? '−' : '') + f1(Math.abs(n));

/** The board: the shot, with the icon column and each chevron's centre drawn over it, what they
 *  measure written in a margin to its right (wide scenes) and above it. Everything is in the shot's
 *  CSS px. */
function board(scene, shotUrl, clip, m, title) {
  const marks = [];
  const notes = [];
  const ox = clip.x, oy = clip.y;
  const margin = scene.name === 'phone' ? 0 : 330;
  const open = m.cards.find((c) => c.tiles.length > 0);
  const column = open?.tiles[0]?.cx;
  if (scene.name !== 'phone' && column !== undefined) {
    // The icon column, down every card: dashed red, each icon boxed. Each head's chevron centre:
    // blue ticks above and below it, so the chevron itself stays in sight.
    const last = m.cards[m.cards.length - 1];
    marks.push(`<line x1="${column - ox}" y1="${m.cards[0].card.y - oy - 6}" x2="${column - ox}" y2="${last.card.y + last.card.h - oy + 6}" stroke="#e5484d" stroke-width="1" stroke-dasharray="4 3"/>`);
    for (const t of open.tiles) {
      marks.push(`<rect x="${t.x - ox}" y="${t.y - oy}" width="${t.w}" height="${t.h}" fill="none" stroke="#e5484d" stroke-width="1"/>`);
    }
    for (const c of m.cards) {
      const x = c.chevron.cx - ox, y = c.chevron.cy - oy;
      marks.push(`<line x1="${x}" y1="${y - 24}" x2="${x}" y2="${y - 13}" stroke="#0b6bcb" stroke-width="2"/>`);
      marks.push(`<line x1="${x}" y1="${y + 13}" x2="${x}" y2="${y + 24}" stroke="#0b6bcb" stroke-width="2"/>`);
      const d = c.chevron.cx - column;
      const ok = Math.abs(d) <= 2;
      marks.push(`<text x="${clip.width + 12}" y="${y - 3}" class="t">${c.name}${c.open ? '（展开）' : '（折叠）'}</text>`);
      marks.push(`<text x="${clip.width + 12}" y="${y + 13}" class="t ${ok ? 'ok' : 'bad'}">箭头 ${f1(c.chevron.cx)} − 图标 ${f1(column)} = ${signed(d)}px ${ok ? '✓' : '✗'}</text>`);
    }
    notes.push(`红色虚线 = 引擎图标列中心（${open.name} 各引擎行的图标，红框；x = ${f1(column)}）；蓝色短线 = 每张卡片头折叠箭头的中心。`);
    const worst = Math.max(...m.cards.map((c) => Math.abs(c.chevron.cx - column)));
    notes.push(`最大偏差 ${f1(worst)}px（验收线 ≤ 2px）。`);
  }
  for (const c of m.cards) {
    if (!c.handle) continue;
    if (scene.name === 'phone' || scene.name === 'tablet' || scene.hover || scene.focus) {
      marks.push(`<rect x="${c.handle.x - ox}" y="${c.handle.y - oy}" width="${c.handle.w}" height="${c.handle.h}" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 2"/>`);
    }
    if (scene.name === 'phone') {
      marks.push(`<rect x="${c.name_.x - ox}" y="${c.name_.y - oy}" width="${c.name_.w}" height="${c.name_.h}" fill="none" stroke="#0b6bcb" stroke-width="1.5" stroke-dasharray="3 2"/>`);
      const gap = c.name_.x - (c.handle.x + c.handle.w);
      notes.push(`${c.name}：把手（橙框）x ${f1(c.handle.x)}–${f1(c.handle.x + c.handle.w)}，${c.handleShown ? '显示' : '隐藏'}；名称（蓝框）从 x ${f1(c.name_.x)} 起，相距 ${f1(gap)}px，${gap >= 0 ? '不重叠 ✓' : '重叠 ✗'}`);
    }
  }
  if (scene.name !== 'phone') {
    const states = m.cards.map((c) => `${c.name} ${c.handleShown ? '显示' : '隐藏'}${c.handleFocused ? '（键盘焦点在它上面）' : ''}`).join('，');
    notes.push(`拖拽把手：${states}。`);
    const shown = m.cards.find((c) => c.handleShown);
    if (shown && (scene.hover || scene.focus || scene.name === 'tablet')) {
      const inner = shown.card.x + 1;
      notes.push(`${shown.name} 的把手（橙框）x ${f1(shown.handle.x)}–${f1(shown.handle.x + shown.handle.w)}：卡片内沿 x ${f1(inner)}，引擎图标列 x ${f1(open.tiles[0].x)}–${f1(open.tiles[0].x + open.tiles[0].w)}，箭头笔画 x ${f1(shown.chevronInk.x)}–${f1(shown.chevronInk.x + shown.chevronInk.w)}。`);
    }
  }
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#fff;font:13px/1.5 Inter,"Noto Sans SC",sans-serif;color:#1f2329;width:${clip.width + margin}px}
    .cap{padding:12px 16px 10px;border-bottom:1px solid #e5e6eb;background:#f7f8fa}
    .cap h1{font-size:15px;margin:0 0 4px}.cap p{margin:0}
    .wrap{position:relative;width:${clip.width + margin}px;height:${clip.height}px}
    .wrap img{display:block;width:${clip.width}px;height:${clip.height}px}
    svg{position:absolute;inset:0;overflow:visible}
    .t{font:600 12px Inter,"Noto Sans SC",sans-serif;fill:#1f2329}.ok{fill:#18794e}.bad{fill:#cd2b31}
  </style><div class="cap"><h1>${title}</h1>${notes.map((n) => `<p>${n}</p>`).join('')}</div>
  <div class="wrap"><img src="${shotUrl}"><svg width="${clip.width + margin}" height="${clip.height}">${marks.join('')}</svg></div>`;
}

async function shoot(browser, scene, attempt = 1) {
  try {
    return await shootOnce(browser, scene);
  } catch (e) {
    // A host this loaded can take minutes over a first page; one more try in a fresh context.
    if (attempt > 1) throw e;
    console.error(`${scene.name}: ${String(e).split('\n')[0]} — trying again`);
    return shoot(browser, scene, attempt + 1);
  }
}

async function shootOnce(browser, scene) {
  const context = await browser.newContext({
    viewport: { width: scene.width, height: 1600 },
    deviceScaleFactor: 2,
    isMobile: scene.mobile,
    hasTouch: scene.mobile,
  });
  const page = await context.newPage();
  await page.addInitScript(({ user, mac }) => {
    localStorage.clear();
    localStorage.setItem('orbit_token', `shot.${btoa(JSON.stringify({ sub: user, exp: 4102444800 }))}.fixture`);
    localStorage.setItem('orbit-theme', 'light');
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([mac]));
  }, { user: USER, mac: MAC });
  const unknown = new Set();
  await page.route('**/dl/version.json', (r) => r.fulfill({ status: 200, json: { version: '0.1.240' } }));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const m = req.method();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (p === '/api/events' || p.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\nretry: 3600000\n\n' });
    if (m !== 'GET') { unknown.add(`${m} ${p}`); return json({}); }
    if (p === '/api/users/me') return json(me);
    if (p === '/api/auth/setup-status') return json({ needsSetup: false });
    if (p === '/api/runners') return json(runners);
    if (p === '/api/workspaces') return json(workspaces);
    if (p === '/api/providers/mine' || p === '/api/providers/pools' || p === '/api/providers/shared-pools' || p === '/api/providers') return json([]);
    if (/\/api\/runners\/[^/]+\/login$/.test(p)) return json({ status: null, engine: null, url: null, userCode: null, message: null, account: null });
    if (p === '/api/tasks/counts') return json({ total: 0, open: 0, inProgress: 0, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, runnable: 0 });
    if (p === '/api/tasks/active') return json({ items: [], total: 0, truncated: false });
    if (p === '/api/tasks/labels') return json({ items: [], labelTotal: 0, truncated: false });
    unknown.add(`${m} ${p}`);
    return json([]);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/infrastructure`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.re-runner-card .re-row[data-engine]', { timeout: 300_000 }).catch(async (e) => {
    await context.close();
    throw e;
  });
  await page.waitForTimeout(600);
  // Grow the window until the whole section is on screen: the page scrolls inside its own pane.
  const bottom = await page.evaluate(() => {
    const s = document.querySelector('#machines').getBoundingClientRect();
    return Math.ceil(s.bottom + 24);
  });
  await page.setViewportSize({ width: scene.width, height: Math.max(900, bottom) });
  await page.waitForTimeout(300);
  if (scene.hover) {
    const name = page.locator('.re-runner-card .re-runner', { hasText: 'Mac Studio' });
    await name.hover();
  } else {
    await page.mouse.move(scene.width - 2, 2);
  }
  if (scene.focus) {
    // Reach the handle from the keyboard, the way :focus-visible is meant to be seen.
    await page.focus('.re-runner-card .re-drag');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
  }
  await page.waitForTimeout(400);
  const m = await page.evaluate(measure);
  const s = m.section;
  const clip = { x: Math.max(0, Math.floor(s.x - 40)), y: Math.floor(s.y - 8), width: 0, height: Math.ceil(s.h + 16) };
  clip.width = Math.min(scene.width - clip.x, Math.ceil(s.w + 80));
  if (scene.name === 'phone' || scene.name === 'tablet') { clip.x = 0; clip.width = scene.width; }
  const shot = await page.screenshot({ clip });
  await context.close();
  return { m, clip, shot, unknown: [...unknown], errors };
}

(async () => {
  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  const browser = await chromium.launch();
  const results = {};
  for (const scene of SCENES) {
    const { m, clip, shot, unknown, errors } = await shoot(browser, scene);
    fs.writeFileSync(path.join(outDir, 'raw', `${label}-${scene.name}.png`), shot);
    const title = `${label === 'before' ? '改前' : '改后'} · ${scene.name}（${scene.width}px 宽${scene.mobile ? '，触屏无悬停' : ''}${scene.hover ? '，指针停在 Mac Studio 卡片头' : ''}${scene.focus ? '，键盘 Tab 到第一张卡片的把手' : ''}）`;
    const html = board(scene, `data:image/png;base64,${shot.toString('base64')}`, clip, m, title);
    const page = await browser.newPage({ viewport: { width: clip.width + (scene.name === 'phone' ? 0 : 330), height: 400 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    const file = path.join(outDir, `${label}-${scene.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    if (scene.name !== 'phone') {
      // The first card's head and its first engine row, where the chevron meets the icon column.
      const top = await page.evaluate(() => document.querySelector('.wrap').getBoundingClientRect().top);
      const first = m.cards[0];
      const tile = m.cards.find((c) => c.tiles.length > 0).tiles[0];
      await page.screenshot({
        path: path.join(outDir, `${label}-${scene.name}-head.png`),
        clip: {
          x: Math.max(0, first.card.x - clip.x - 16),
          y: top + first.card.y - clip.y - 10,
          width: 360,
          height: tile.y + tile.h - first.card.y + 24,
        },
      });
    }
    await page.close();
    results[scene.name] = { clip, ...m, unknown, errors };
    const open = m.cards.find((c) => c.tiles.length > 0);
    console.log(scene.name, file, JSON.stringify(m.cards.map((c) => ({
      name: c.name,
      chevronCx: c.chevron && f1(c.chevron.cx),
      inkCx: c.chevronInk && f1(c.chevronInk.cx),
      tileCx: open ? f1(open.tiles[0].cx) : null,
      handle: c.handle && `${f1(c.handle.x)}+${f1(c.handle.w)}`,
      shown: c.handleShown,
      nameX: c.name_ && f1(c.name_.x),
    }))), unknown.length ? `unknown: ${unknown.join(', ')}` : '', errors.length ? `errors: ${errors.join(' | ')}` : '');
  }
  fs.writeFileSync(path.join(outDir, `${label}-measure.json`), JSON.stringify(results, null, 1) + '\n');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
