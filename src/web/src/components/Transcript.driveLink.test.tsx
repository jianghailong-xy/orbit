// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';
import { DriveFilePicker } from './drive/DriveFilePicker';
import { materializeReferences } from '../lib/composerRefs';

/**
 * A reply that links a drive file (`orbit-drive:<id>`, which the runner writes for a path under /home/orbit/Drive, or
 * `orbit-document:<id>`, its scheme while Drive was called Documents, which stored transcripts carry) draws that file — name, folder, size — and opens it on the Files page; one that is trashed or gone says so. The composer's
 * Add from Files picker hands back the paths of the files picked (board docs/mocks/drive/02-web frame 8).
 */

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const FILE = {
  id: 'e1', parentId: 'f1', kind: 'FILE', name: 'sign-in-copy.md', sizeBytes: 4096, path: '/Orbit UI migration/sign-in-copy.md',
  trashedAt: null,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

const reply = (text: string) => {
  const event: RunEvent = { seq: 3, type: 'assistant', turnId: 'turn-1', ts: '2026-11-21T12:00:00.000Z', payload: { text } };
  return mount(<Transcript events={[event]} />);
};

describe('a reply linking a drive file', () => {
  it.each(['orbit-drive', 'orbit-document'])('draws a %s: link as the file and links to it on the Drive page', async (scheme) => {
    apiMock.mockResolvedValue(FILE);
    await reply(`Saved [sign-in-copy.md](${scheme}:e1) for you.`);
    const card = container.querySelector<HTMLAnchorElement>('a.drive-file-card');
    expect(card?.textContent).toContain('sign-in-copy.md');
    expect(card?.textContent).toContain('Drive › Orbit UI migration · 4.1 KB');
    expect(card?.getAttribute('href')).toBe('/drive?folder=f1&file=e1');
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('e1'));
  });

  it('draws a linked folder as a folder that opens itself, with no size (a drive_sync summary links one)', async () => {
    apiMock.mockResolvedValue({ id: 'd1', parentId: 'r1', kind: 'FOLDER', name: 'out', sizeBytes: 0, path: '/Reports/out', trashedAt: null });
    await reply('305 files uploaded to [out](orbit-drive:d1), 0 failed.');
    const card = container.querySelector<HTMLAnchorElement>('a.drive-file-card');
    expect(card?.textContent).toContain('Drive › Reports');
    expect(card?.textContent).not.toContain('0 B');
    expect(card?.getAttribute('href')).toBe('/drive?folder=d1');
  });

  it('says so when the file is in Trash', async () => {
    apiMock.mockResolvedValue({ ...FILE, trashedAt: '2026-11-21T10:00:00Z' });
    await reply('[sign-in-copy.md](orbit-document:e1)');
    expect(container.querySelector('a.drive-file-card')).toBeNull();
    expect(container.querySelector('.drive-file-card.gone')?.textContent).toContain('In Trash');
  });

  it('says so when the file is gone', async () => {
    apiMock.mockRejectedValue(new Error('not found'));
    await reply('[old.png](orbit-drive:e9)');
    expect(container.querySelector('.drive-file-card.gone')?.textContent).toContain('No longer in Files');
  });
});

describe('the composer drive picker', () => {
  const listing = (folder: object, entries: object[]) => ({ folder, entries, nextCursor: null });
  const serve = () =>
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('parentId=f1')) return listing({ id: 'f1' }, [{ ...FILE, id: 'e1' }]);
      return listing({ id: 'root' }, [
        { id: 'f1', kind: 'FOLDER', name: 'Orbit UI migration', sizeBytes: 0 },
        { id: 'f2', kind: 'FOLDER', name: 'Other', sizeBytes: 0 },
      ]);
    });
  const click = async (el: Element | null | undefined) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  };
  const option = (text: string) => [...document.body.querySelectorAll('[role=option]')].find((e) => e.textContent?.includes(text));

  it('hands back the picked file with its path, browsing from the root', async () => {
    serve();
    const onPick = vi.fn();
    await mount(<DriveFilePicker onClose={() => {}} onPick={onPick} />);
    await click(option('Orbit UI migration'));
    await click(option('sign-in-copy.md'));
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Add 1'));
    expect(onPick).toHaveBeenCalledWith([{ id: 'e1', name: 'sign-in-copy.md', path: '/home/orbit/Drive/Orbit UI migration/sign-in-copy.md' }]);
  });

  it("opens on the session's project folder", async () => {
    serve();
    const onPick = vi.fn();
    await mount(<DriveFilePicker projectFolder={{ id: 'p1', title: 'Orbit UI migration' }} onClose={() => {}} onPick={onPick} />);
    await click(option('sign-in-copy.md'));
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Add 1'));
    expect(onPick.mock.calls[0]![0][0].path).toBe('/home/orbit/Drive/Orbit UI migration/sign-in-copy.md');
  });

  it('falls back to the drive root when the project has no folder yet', async () => {
    serve();
    await mount(<DriveFilePicker projectFolder={{ id: 'p1', title: 'Brand new' }} onClose={() => {}} onPick={() => {}} />);
    expect(option('Orbit UI migration')).toBeTruthy();
    expect(option('Other')).toBeTruthy();
  });

  it('searches the whole drive, shows each result with its folder, and picks it by its path', async () => {
    const searches: string[] = [];
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/drive/search')) {
        searches.push(path);
        return { entries: [{ ...FILE, id: 'e7', name: 'budget.xlsx', path: '/Finance/2026/budget.xlsx', folderPath: '/Finance/2026' }], nextCursor: null };
      }
      return listing({ id: 'root' }, [{ id: 'f2', kind: 'FOLDER', name: 'Other', sizeBytes: 0 }]);
    });
    const onPick = vi.fn();
    await mount(<DriveFilePicker onClose={() => {}} onPick={onPick} />);
    const box = document.body.querySelector<HTMLInputElement>('input[aria-label="Search Files"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'budg');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(searches[0]).toContain('q=budg');
    expect(option('budget.xlsx')?.textContent).toContain('Drive/Finance/2026');
    await click(option('budget.xlsx'));
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Add 1'));
    expect(onPick).toHaveBeenCalledWith([{ id: 'e7', name: 'budget.xlsx', path: '/home/orbit/Drive/Finance/2026/budget.xlsx' }]);
  });

  it('sends a picked chip as the file path', () => {
    const refs = { 'brief.md': { kind: 'drive' as const, id: 'e1', path: '/home/orbit/Drive/P/brief.md' } };
    expect(materializeReferences('Check #brief.md too', refs)).toBe('Check /home/orbit/Drive/P/brief.md too');
  });

  it('sends a chip without a path as an orbit-drive: link', () => {
    const refs = { 'brief.md': { kind: 'drive' as const, id: 'e1' } };
    expect(materializeReferences('Check #brief.md too', refs)).toBe('Check [brief.md](orbit-drive:e1) too');
  });
});
