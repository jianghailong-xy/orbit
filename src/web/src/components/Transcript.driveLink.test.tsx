// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';
import { DriveFilePicker } from './files/DriveFilePicker';

/**
 * A reply that links a drive file (`orbit-drive:<id>`, which the runner writes for a path under /home/orbit/Files) draws
 * that file — name, folder, size — and opens it on the Files page; one that is trashed or gone says so. The composer's
 * Add from Files picker hands back the paths of the files picked (board docs/mocks/orbit-files/02-web frame 8).
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
  it('draws the file and links to it on the Files page', async () => {
    apiMock.mockResolvedValue(FILE);
    await reply('Saved [sign-in-copy.md](orbit-drive:e1) for you.');
    const card = container.querySelector<HTMLAnchorElement>('a.drive-file-card');
    expect(card?.textContent).toContain('sign-in-copy.md');
    expect(card?.textContent).toContain('Files › Orbit UI migration · 4.1 KB');
    expect(card?.getAttribute('href')).toBe('/files?folder=f1&file=e1');
  });

  it('says so when the file is in Trash', async () => {
    apiMock.mockResolvedValue({ ...FILE, trashedAt: '2026-11-21T10:00:00Z' });
    await reply('[sign-in-copy.md](orbit-drive:e1)');
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
  it('hands back the path of the picked file, inside its folders', async () => {
    const listing = (folder: object, entries: object[]) => ({ folder, entries, nextCursor: null });
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('parentId=f1')) {
        return listing({ id: 'f1' }, [{ ...FILE, id: 'e1' }]);
      }
      return listing({ id: 'root' }, [{ id: 'f1', kind: 'FOLDER', name: 'Orbit UI migration', sizeBytes: 0 }]);
    });
    const onPick = vi.fn();
    await mount(<DriveFilePicker onClose={() => {}} onPick={onPick} />);
    const click = async (el: Element | null | undefined) => {
      await act(async () => {
        (el as HTMLElement).click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    };
    const body = () => document.body;
    await click([...body().querySelectorAll('[role=option]')].find((e) => e.textContent?.includes('Orbit UI migration')));
    await click([...body().querySelectorAll('[role=option]')].find((e) => e.textContent?.includes('sign-in-copy.md')));
    await click([...body().querySelectorAll('button')].find((b) => b.textContent === 'Add 1'));
    expect(onPick).toHaveBeenCalledWith(['/home/orbit/Files/Orbit UI migration/sign-in-copy.md']);
  });
});
