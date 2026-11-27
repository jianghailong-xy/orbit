// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedDriveFile } from '../api';
import { SharedLinkPage } from './SharedLinkPage';

/**
 * A Drive file link's page (`/s/<token>`, kind DRIVE_FILE): it used to be drawn as a session's conversation and
 * crash. It shows the file's name and size and a Download of the link's bytes; a PDF in a frame of the browser's
 * viewer from a blob: URL, a picture from the content route, and anything else as a note to download it.
 */

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const TOKEN = 'nxQG33n2BtxyAMh1D11faZmQKoNUEBfG';
const CONTENT = `/api/shared/${TOKEN}/content`;

let file: SharedDriveFile;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith(`/api/shared/${TOKEN}?`)) {
        return new Response(JSON.stringify({ kind: 'DRIVE_FILE', include: {}, sharedAt: '2026-11-24T05:44:09.626Z', root: file }));
      }
      if (url === CONTENT) return new Response(new Blob(['%PDF-1.5']));
      return new Response('{}', { status: 404 });
    }),
  );
  let made = 0;
  URL.createObjectURL = () => `blob:file-${++made}`;
  URL.revokeObjectURL = () => {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/s/${TOKEN}`]}>
          <Routes>
            <Route path="/s/:token" element={<SharedLinkPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const download = () => container.querySelector<HTMLAnchorElement>('a[download]');

describe('a shared Drive file', () => {
  it('shows a PDF in a frame from a blob: URL, with its name, size and a Download', async () => {
    file = { name: '蠶織圖.F1954-20.注释.pdf', sizeBytes: 653_269, mimeType: 'application/pdf', preview: true };
    await mount();
    expect(container.querySelector('.share-file-name')?.textContent).toBe(file.name);
    expect(container.querySelector('.share-file-size')?.textContent).toBeTruthy();
    expect(download()?.getAttribute('href')).toBe(CONTENT);
    expect(download()?.getAttribute('download')).toBe(file.name);
    expect(container.querySelector('iframe.share-file-pdf')?.getAttribute('src')).toMatch(/^blob:file-/);
  });

  it('draws a picture from the content route', async () => {
    file = { name: 'scroll.png', sizeBytes: 2_000, mimeType: 'image/png', preview: true };
    await mount();
    expect(container.querySelector('img.share-file-picture')?.getAttribute('src')).toBe(CONTENT);
  });

  it('offers only the download for a file the browser cannot show', async () => {
    file = { name: 'notes.docx', sizeBytes: 2_000, mimeType: 'application/octet-stream', preview: false };
    await mount();
    expect(container.querySelector('iframe, img')).toBeNull();
    expect(container.querySelector('.share-file-none')?.textContent).toContain('Download it to open');
    expect(download()).toBeTruthy();
  });
});
