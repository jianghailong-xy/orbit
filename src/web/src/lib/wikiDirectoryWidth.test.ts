import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampWikiDirectoryWidth, readWikiDirectoryWidth, wikiDirectoryMax } from './wikiDirectoryWidth';

describe('the wiki directory column width', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('drags in the app sidebar range, 200 to 480', () => {
    expect(clampWikiDirectoryWidth(120)).toBe(200);
    expect(clampWikiDirectoryWidth(300.4)).toBe(300);
    expect(clampWikiDirectoryWidth(900)).toBe(480);
  });

  it('stops where the page beside it would drop under 560, and never below where the drag started', () => {
    expect(wikiDirectoryMax(248, 1200)).toBe(480);
    expect(wikiDirectoryMax(248, 700)).toBe(388);
    expect(wikiDirectoryMax(248, 400)).toBe(248);
    expect(wikiDirectoryMax(200, 300)).toBe(200);
    expect(clampWikiDirectoryWidth(450, wikiDirectoryMax(248, 700))).toBe(388);
  });

  it('starts at 248 and keeps what was dragged, clamped', () => {
    expect(readWikiDirectoryWidth()).toBe(248);
    localStorage.setItem('orbit:wiki-directory-width', '320');
    expect(readWikiDirectoryWidth()).toBe(320);
    localStorage.setItem('orbit:wiki-directory-width', '9999');
    expect(readWikiDirectoryWidth()).toBe(480);
    localStorage.setItem('orbit:wiki-directory-width', 'junk');
    expect(readWikiDirectoryWidth()).toBe(248);
  });
});
