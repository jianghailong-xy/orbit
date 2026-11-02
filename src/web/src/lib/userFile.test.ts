// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inertObjectUrl, openUserFile, saveUserFile, userFileUrl } from './userFile';

const made: Blob[] = [];
let saved: { href: string; name: string }[] = [];

beforeEach(() => {
  made.length = 0;
  saved = [];
  URL.createObjectURL = (blob: Blob) => `blob:test/${made.push(blob as Blob)}`;
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ href: this.getAttribute('href') ?? '', name: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SHOWN = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf'];
const NOT_SHOWN = [
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml', 'text/plain', 'application/json',
  'text/javascript', '', 'application/octet-stream',
];

describe('inertObjectUrl', () => {
  it.each(SHOWN)('keeps %s, a type that may be shown', (type) => {
    inertObjectUrl(new Blob(['bytes'], { type }));
    expect(made[0].type).toBe(type);
  });

  it.each(NOT_SHOWN)('labels %s as bytes', (type) => {
    inertObjectUrl(new Blob(['bytes'], { type }));
    expect(made[0].type).toBe('application/octet-stream');
  });

  it('keeps the bytes', async () => {
    inertObjectUrl(new Blob(['the bytes'], { type: 'text/html' }));
    expect(await made[0].text()).toBe('the bytes');
  });

  it('reads a type with its parameters, in any case, and never as a list', () => {
    inertObjectUrl(new Blob(['bytes'], { type: 'image/png; name=shot.png' }));
    expect(made[0].type).toBe('image/png');
    inertObjectUrl(new Blob(['bytes'], { type: 'image/png, text/html' }));
    expect(made[1].type).toBe('application/octet-stream');
  });
});

describe('userFileUrl', () => {
  it('gives an SVG a data: URL, which belongs to no origin, so that an <img> can still draw it', async () => {
    const url = await userFileUrl(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    expect(url).toBe(`data:image/svg+xml;base64,${btoa('<svg/>')}`);
    expect(made).toEqual([]);
  });

  it.each(['image/png', 'application/pdf', 'text/html', ''])('gives %s an object URL that cannot run', async (type) => {
    await expect(userFileUrl(new Blob(['bytes'], { type }))).resolves.toBe('blob:test/1');
    expect(made[0].type).toBe(type === 'text/html' || type === '' ? 'application/octet-stream' : type);
  });
});

describe('saveUserFile', () => {
  it('saves under the file\'s own name, and lets the URL go afterwards', () => {
    vi.useFakeTimers();
    const revoked = vi.spyOn(URL, 'revokeObjectURL');
    saveUserFile('blob:test/1', 'report.html');
    expect(saved).toEqual([{ href: 'blob:test/1', name: 'report.html' }]);
    expect(document.querySelector('a')).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(revoked).toHaveBeenCalledWith('blob:test/1');
    vi.useRealTimers();
  });
});

describe('openUserFile', () => {
  /** What pressing the anchor it made would do, read off the anchor at the moment it is pressed. */
  let pressed: { href: string; target: string; rel: string; download: string }[] = [];

  beforeEach(() => {
    pressed = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      pressed.push({ href: this.getAttribute('href') ?? '', target: this.target, rel: this.rel, download: this.download });
    });
  });

  it.each(SHOWN)('opens %s in a tab of its own, from the press, at the address itself', (type) => {
    openUserFile('/api/shared/t/attachments/a', type, 'file');
    expect(pressed).toEqual([{ href: '/api/shared/t/attachments/a', target: '_blank', rel: 'noopener noreferrer', download: '' }]);
    expect(made).toEqual([]);
  });

  it.each(NOT_SHOWN)('saves %s, and opens no tab', (type) => {
    openUserFile('/api/shared/t/attachments/a', type, 'report.html');
    expect(pressed).toEqual([{ href: '/api/shared/t/attachments/a', target: '', rel: '', download: 'report.html' }]);
    expect(made).toEqual([]);
  });

  it('leaves nothing behind', () => {
    openUserFile('/api/shared/t/attachments/a', 'application/pdf', 'spec.pdf');
    expect(document.querySelector('a')).toBeNull();
  });
});

describe('the list of types that may be shown', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const listIn = (file: string): string[] => {
    const source = readFileSync(path.join(REPO, file), 'utf8');
    return [...source.slice(source.indexOf('new Set(['), source.indexOf(']);')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  it('is the server\'s list, word for word', () => {
    const here = listIn('src/web/src/lib/userFile.ts');
    expect(here).toContain('application/pdf');
    expect(here).toEqual(listIn('src/apiserver/src/files/user-file-response.ts'));
  });
});

/**
 * A blob: URL is a page on Orbit's own origin for whatever it holds, so bytes somebody else wrote reach
 * one only through this module. The two listed here make theirs from bytes that are not such a file.
 */
describe('object URLs', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const OWN_BYTES = new Set([
    'lib/sessionExport.tsx', // the page this console writes itself, saved as a download
    'components/WorkspaceView.tsx', // the composer's preview of a picture of the types it draws, from this machine
  ]);

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(full);
      return /\.tsx?$/.test(entry.name) && !/\.(test|fixtures?)\.tsx?$/.test(entry.name) ? [full] : [];
    });

  it('are made in this module and nowhere else', () => {
    const makers = sources(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('URL.createObjectURL('))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(new Set(makers)).toEqual(new Set(['lib/userFile.ts', ...OWN_BYTES]));
  });
});
