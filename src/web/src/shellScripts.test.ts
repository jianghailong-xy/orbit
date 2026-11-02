// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page's Content-Security-Policy (src/web/nginx.conf) runs no inline script, so the shell may carry
 * none: one would silently stop running on every page, in every browser, the day it was added.
 */

const shellSource = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const shell = new DOMParser().parseFromString(shellSource, 'text/html');
const themeBoot = resolve(process.cwd(), 'public/theme-boot.js');

describe('the SPA shell', () => {
  it('has no inline script', () => {
    const scripts = [...shell.querySelectorAll('script')];
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((script) => !script.src).map((script) => script.textContent)).toEqual([]);
  });

  it('has no event handler attribute', () => {
    const handlers = [...shell.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith('on')),
    );
    expect(handlers).toEqual([]);
  });

  it('holds first paint for the theme: a classic script ahead of the body, from a file the build copies as it is', () => {
    const inHead = [...shell.head.querySelectorAll('script')];
    expect(inHead.map((script) => script.getAttribute('src'))).toEqual(['/theme-boot.js']);
    expect(inHead[0].type).toBe('');
    expect(inHead[0].async || inHead[0].defer).toBe(false);
    expect(existsSync(themeBoot)).toBe(true);
    // It reads theme-color, so that has to be parsed by the time it runs.
    expect(shellSource.indexOf('id="theme-color"')).toBeLessThan(shellSource.indexOf('/theme-boot.js'));
  });

  it('names a script file the policy lets run', () => {
    const nginx = readFileSync(resolve(process.cwd(), 'nginx.conf'), 'utf8');
    for (const script of shell.querySelectorAll('script')) {
      const src = script.getAttribute('src')!;
      // The entry module: the build writes it, and the chunks it loads, under /assets/.
      expect(nginx).toContain(script.type === 'module' && src.startsWith('/src/') ? '*:*/assets/' : `*:*${src}`);
    }
  });
});

describe('public/theme-boot.js', () => {
  const run = new Function(readFileSync(themeBoot, 'utf8'));
  const prefersDark = (dark: boolean) => vi.stubGlobal('matchMedia', () => ({ matches: dark }));
  const painted = () => [
    document.documentElement.getAttribute('data-theme'),
    document.getElementById('theme-color')?.getAttribute('content'),
  ];

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '<meta id="theme-color" name="theme-color" content="#ffffff" />';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['dark', false, 'dark', '#202023'],
    ['dark', true, 'dark', '#202023'],
    ['light', true, 'light', '#ffffff'],
    ['system', true, 'dark', '#202023'],
    ['system', false, 'light', '#ffffff'],
    [null, true, 'dark', '#202023'],
    [null, false, 'light', '#ffffff'],
  ])('with %s chosen and a dark OS %s, paints %s', (choice, osDark, theme, color) => {
    if (choice) localStorage.setItem('orbit-theme', choice);
    prefersDark(osDark);
    run();
    expect(painted()).toEqual([theme, color]);
  });

  it('leaves the page to the app when storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => run()).not.toThrow();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('paints the colours the app keeps in step afterwards', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/lib/theme.tsx'), 'utf8');
    expect(app).toContain("const THEME_COLOR: Record<Resolved, string> = { light: '#ffffff', dark: '#202023' };");
  });
});
