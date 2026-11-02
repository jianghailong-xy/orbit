// Shared pieces of the wiki diagram look kit: the browser, the page that stands in for a wiki document's column, and
// one draw call per (diagram, Mermaid options, theme). Mermaid is the build the apps bundle (src/android/.../mermaid.min.js,
// byte-equal to OrbitApp's Resources copy), loaded with <script src> as a classic script, as the apps load it.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require('/var/tmp/t1-main-baseline/node_modules/playwright-core');
export const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The board's folder; the Mermaid build is the one the Android app bundles (byte-equal to OrbitApp's Resources copy).
const MERMAID = readFileSync(join(KIT, '../../../src/android/app/src/main/assets/mermaid/mermaid.min.js'));

// The web's tokens (src/web/src/index.css :root and :root[data-theme='dark']) the column and figure use.
export const TOKENS = {
  light: { bg: '#ffffff', text1: '#1f2329', text2: '#646a73', text3: '#8f959e', inset: 'rgba(0,0,0,0.05)', border: '#dee0e3', borderSubtle: '#eceef1', brand: '#3370ff' },
  dark: { bg: '#202023', text1: '#c9ced5', text2: '#a7adb6', text3: '#8b9099', inset: 'rgba(0,0,0,0.25)', border: '#424246', borderSubtle: '#343437', brand: '#5b8cff' },
};
export const FONT = `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

export async function browser(kind = 'chromium') {
  return pw[kind].launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' } });
}

/** A page with the web's figure CSS (.wk-dc-diagram) in a column `width` px wide, in `theme`. */
export async function page(b, { width = 792, theme = 'light', figureCss = '' } = {}) {
  const t = TOKENS[theme];
  const p = await b.newPage({ viewport: { width: Math.max(width + 48, 1800), height: 1400 }, deviceScaleFactor: 2 });
  await p.route('https://kit.local/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/mermaid.min.js') return route.fulfill({ body: MERMAID, contentType: 'text/javascript' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>
  html, body { margin: 0; background: ${t.bg}; color: ${t.text1}; font-family: ${FONT}; }
  .col { width: ${width}px; padding: 16px 24px; font-size: 15px; line-height: 1.85; }
  .col h2 { margin: 0 0 8px; font-size: 18px; font-weight: 650; line-height: 1.4; }
  .col p { margin: 0 0 12px; }
  .wk-dc-diagram { margin: 0 0 12px; padding: 12px; border-radius: 6px; background: ${t.inset}; overflow-x: auto; }
  .wk-dc-diagram svg { display: block; margin: 0 auto; }
  ${figureCss}
</style>
<script src="/mermaid.min.js"></script></head><body><div class="col" id="col"></div></body></html>` });
  });
  await p.goto('https://kit.local/');
  await p.waitForFunction(() => typeof window.mermaid !== 'undefined');
  return p;
}

/** Draws `source` with `options` into a fresh figure under a heading and a paragraph; answers the SVG's size. */
export async function draw(p, { source, options, heading = '', text = '', post = null, full = false }) {
  return p.evaluate(async ({ source, options, heading, text, post, full }) => {
    const col = document.getElementById('col');
    col.innerHTML = `${heading ? `<h2>${heading}</h2>` : ''}${text ? `<p>${text}</p>` : ''}<figure class="wk-dc-diagram" id="fig"></figure>`;
    const opts = { startOnLoad: false, securityLevel: 'strict', fontFamily: getComputedStyle(document.body).fontFamily, ...options };
    window.mermaid.initialize(opts);
    const { svg } = await window.mermaid.render('wk-diagram-' + Math.random().toString(36).slice(2), source);
    const fig = document.getElementById('fig');
    if (full) fig.style.overflow = 'visible';
    fig.innerHTML = svg;
    if (post) new Function('svg', post)(fig.firstElementChild);
    const box = fig.firstElementChild.getBoundingClientRect();
    return { w: Math.ceil(box.width), h: Math.ceil(box.height), svg: fig.innerHTML };
  }, { source, options, heading, text, post, full });
}
