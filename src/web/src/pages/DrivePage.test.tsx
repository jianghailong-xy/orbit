// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastViewport } from '../components/ToastViewport';
import { clearToasts } from '../lib/toastStore';

/**
 * The Files page (docs/mocks/drive/02-web) against a drive held in memory, answered the way the owner's routes
 * answer (apiserver drive/drive.controller.ts, share-links.controller.ts): what each press sends, and what the page
 * shows of what comes back.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  authedFetch: vi.fn(),
  getSession: vi.fn(),
}));
const { api, authedFetch, getSession } = await import('../api');
const { DrivePage } = await import('./DrivePage');
const { resetDriveUploadsForTest } = await import('../lib/driveUploads');

// ── the drive in memory ────────────────────────────────────────────────────────────────────────

interface Entry {
  id: string;
  parentId: string | null;
  kind: 'FILE' | 'FOLDER';
  name: string;
  sizeBytes: number;
  writer?: { kind: string; sessionId: string | null };
  bytes?: string;
}

const AT = '2026-11-20T09:00:00.000Z';
let entries: Entry[];
let links: Array<{ id: string; token: string; driveEntryId: string; pinnedIsCurrent: boolean; state: string }>;
let groups: unknown[];
let calls: Array<{ method: string; path: string; body?: unknown }>;
let chunks: Array<{ path: string; sha256: string; size: number; body: string }>;
let shareCheck: { warnings: Array<{ kind: string; line: number }>; checkedBytes: number; partial: boolean };
let uploadStatus: Record<string, { chunks: Array<{ idx: number; sha256: string; sizeBytes: number }> }>;
let uploadSeq = 0;

const view = (e: Entry) => ({
  id: e.id,
  parentId: e.parentId,
  kind: e.kind,
  name: e.name,
  sizeBytes: e.sizeBytes,
  mtime: AT,
  currentVersionId: e.kind === 'FILE' ? `v-${e.id}` : null,
  seq: 1,
  createdAt: AT,
  updatedAt: AT,
  lastWriter: { kind: e.writer?.kind ?? 'OWNER', sessionId: e.writer?.sessionId ?? null, runnerId: null, at: AT },
  trashedAt: null,
  trashGroupId: null,
});

const pathOf = (id: string): string => {
  const e = entries.find((x) => x.id === id)!;
  if (!e.parentId) return '/';
  const up = pathOf(e.parentId);
  return `${up === '/' ? '' : up}/${e.name}`;
};

function seed(): void {
  entries = [
    { id: 'root', parentId: null, kind: 'FOLDER', name: '' },
    { id: 'f-ui', parentId: 'root', kind: 'FOLDER', name: 'Orbit UI migration' },
    { id: 'f-data', parentId: 'root', kind: 'FOLDER', name: 'Datasets' },
    { id: 'f-screens', parentId: 'f-ui', kind: 'FOLDER', name: 'screens' },
    {
      id: 'sign-in',
      parentId: 'f-ui',
      kind: 'FILE',
      name: 'sign-in-v3.png',
      sizeBytes: 1_200_000,
      writer: { kind: 'AGENT', sessionId: 'sess-1' },
    },
    {
      id: 'notes',
      parentId: 'f-ui',
      kind: 'FILE',
      name: 'migration-notes.md',
      sizeBytes: 18_000,
      writer: { kind: 'AGENT', sessionId: null },
      bytes: '# Migration notes\n\nThree pages are left.\n',
    },
    { id: 'deploy', parentId: 'f-ui', kind: 'FILE', name: 'deploy-checklist.md', sizeBytes: 7_000, bytes: 'AWS key' },
  ].map((e) => ({ sizeBytes: 0, ...e })) as Entry[];
  links = [];
  groups = [];
  calls = [];
  chunks = [];
  uploadStatus = {};
  uploadSeq = 0;
  shareCheck = { warnings: [], checkedBytes: 7_000, partial: false };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function serve(): void {
  vi.mocked(getSession).mockImplementation((async (id: string) => ({ id, title: 'Redesign the sign-in page' })) as never);
  vi.mocked(api).mockImplementation((async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ method, path, body: options.body });
    const url = new URL(path, 'http://x');
    const p = url.pathname;
    if (method === 'GET' && p === '/drive/entries') {
      const parentId = url.searchParams.get('parentId') ?? 'root';
      const folder = entries.find((e) => e.id === parentId)!;
      return {
        folder: view(folder),
        entries: entries.filter((e) => e.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name)).map(view),
        nextCursor: null,
      };
    }
    if (method === 'GET' && p === '/drive/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const hits = entries.filter((e) => e.parentId && e.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
      return {
        entries: hits.map((e) => ({ ...view(e), path: pathOf(e.id), folderPath: pathOf(e.parentId!) })),
        nextCursor: null,
      };
    }
    let m = /^\/drive\/entries\/([^/]+)$/.exec(p);
    if (m && method === 'GET') return { ...view(entries.find((e) => e.id === m![1])!), path: pathOf(m[1]) };
    if (m && method === 'PATCH') {
      const e = entries.find((x) => x.id === m![1])!;
      const body = options.body as { name?: string; parentId?: string };
      if (body.name) e.name = body.name;
      if (body.parentId) e.parentId = body.parentId;
      return view(e);
    }
    if (m && method === 'DELETE') {
      entries = entries.filter((x) => x.id !== m![1]);
      return { trashGroupId: 'group-1' };
    }
    m = /^\/drive\/entries\/([^/]+)\/versions$/.exec(p);
    if (m) return { entry: view(entries.find((e) => e.id === m![1])!), versions: [] };
    m = /^\/drive\/entries\/([^/]+)\/share-check$/.exec(p);
    if (m) return { versionId: `v-${m[1]}`, ...shareCheck };
    if (p === '/share-links' && method === 'GET') {
      return {
        links: links.map((l) => ({
          id: l.id,
          kind: 'DRIVE_FILE',
          token: l.token,
          state: l.state,
          root: { id: l.driveEntryId, title: 'x', pinnedIsCurrent: l.pinnedIsCurrent },
        })),
      };
    }
    if (p === '/share-links' && method === 'POST') {
      const body = options.body as { driveEntryId: string };
      const link = { id: 'link-1', token: 'Gk2e8TqB', driveEntryId: body.driveEntryId, pinnedIsCurrent: true, state: 'ACTIVE' };
      links = [link];
      return {
        link: { id: link.id, kind: 'DRIVE_FILE', token: link.token, state: 'ACTIVE', root: { id: body.driveEntryId, title: 'x', pinnedIsCurrent: true } },
        ...shareCheck,
      };
    }
    if (p === '/drive/folders') {
      const body = options.body as { parentId: string; name: string };
      const made: Entry = { id: `folder-${entries.length}`, parentId: body.parentId, kind: 'FOLDER', name: body.name, sizeBytes: 0 };
      entries.push(made);
      return view(made);
    }
    if (p === '/drive/uploads' && method === 'POST') {
      const body = options.body as { parentId: string; name: string; size: number; relativePath?: string; dropRootId?: string };
      uploadSeq += 1;
      const id = `upload-${uploadSeq}`;
      uploadStatus[id] = { chunks: [] };
      let dropRootId: string | null = null;
      if (body.relativePath) dropRootId = body.dropRootId ?? `droproot-${uploadSeq}`;
      // A tiny chunk size, so a few bytes make several chunks.
      return { id, chunkSize: 4, parentId: body.parentId, name: body.name, dropRootId };
    }
    m = /^\/drive\/uploads\/([^/]+)$/.exec(p);
    if (m && method === 'GET') return { id: m[1], chunkSize: 4, ...uploadStatus[m[1]], completed: false, entryId: null };
    m = /^\/drive\/uploads\/([^/]+)\/complete$/.exec(p);
    if (m) {
      const opened = calls.find((c) => c.path === '/drive/uploads' && c.method === 'POST')!.body as { parentId: string; name: string; size: number };
      const made: Entry = { id: `file-${m[1]}`, parentId: opened.parentId, kind: 'FILE', name: opened.name, sizeBytes: opened.size };
      entries.push(made);
      return { ...view(made), path: pathOf(made.id) };
    }
    m = /^\/drive\/entries\/([^/]+)\/download-link$/.exec(p);
    if (m && method === 'POST') return { path: `/api/drive/dl/token-for-${m[1]}`, expiresAt: AT };
    m = /^\/drive\/trash\/groups\/([^/]+)\/items\/([^/]+)\/restore$/.exec(p);
    if (m) return { entryIds: [m[2]] };
    if (p === '/drive/trash' && method === 'GET') return { groups, nextCursor: null };
    m = /^\/drive\/trash\/groups\/([^/]+)\/restore$/.exec(p);
    if (m) return { entryIds: ['x'] };
    m = /^\/drive\/trash\/groups\/([^/]+)$/.exec(p);
    if (m && method === 'DELETE') return { deleted: true };
    m = /^\/drive\/versions\/([^/]+)\/restore$/.exec(p);
    if (m) return view(entries.find((e) => e.id === 'sign-in')!);
    throw new Error(`unstubbed ${method} ${path}`);
  }) as never);
  vi.mocked(authedFetch).mockImplementation((async (input: string, init: RequestInit = {}) => {
    const m = /^\/api\/drive\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(input);
    if (m && init.method === 'PUT') {
      const body = await (init.body as Blob).text();
      const sha256 = (init.headers as Record<string, string>)['x-orbit-chunk-sha256'];
      chunks.push({ path: input, sha256, size: body.length, body });
      uploadStatus[m[1]].chunks.push({ idx: Number(m[2]), sha256, sizeBytes: body.length });
      return json({ sha256, sizeBytes: body.length });
    }
    const c = /^\/api\/drive\/entries\/([^/]+)\/content$/.exec(input);
    if (c) return new Response(entries.find((e) => e.id === c[1])?.bytes ?? 'bytes', { status: 200 });
    throw new Error(`unstubbed fetch ${input}`);
  }) as never);
}

// ── mounting ───────────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let location = '';

function Probe() {
  const loc = useLocation();
  location = `${loc.pathname}${loc.search}`;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/drive" element={<DrivePage />} />
            <Route path="/drive/trash" element={<DrivePage view="trash" />} />
          </Routes>
          <Probe />
          <ToastViewport />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function until(check: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(check, { timeout: 5000, interval: 10 });
  });
}

const row = (name: string) => document.querySelector<HTMLElement>(`tr[data-entry="${name}"]`)!;
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;

async function click(element: Element): Promise<void> {
  await act(async () => (element as HTMLElement).click());
  await settle();
}
const click_ = click;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(element: Element, name: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
  await settle();
}

/** Open a row's ⋯ menu and press one of its items. */
async function menu(name: string, item: string): Promise<void> {
  const trigger = row(name).querySelector<HTMLButtonElement>(`button[aria-label="More for ${name}"]`)!;
  await act(async () => trigger.click());
  let found: HTMLElement | undefined;
  await until(() => {
    found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === item);
    if (!found) throw new Error(`no ${item} in the menu`);
  });
  await click(found!);
}

async function pick(input: HTMLInputElement, files: File[]): Promise<void> {
  await act(async () => {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  resetDriveUploadsForTest();
  seed();
  serve();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  clearToasts();
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
  vi.mocked(authedFetch).mockReset();
  vi.mocked(getSession).mockReset();
});

// ── the tests ──────────────────────────────────────────────────────────────────────────────────

describe('the folder tree and the list', () => {
  it('lists a folder with who last wrote each file: you, an agent in its session, or an agent on Orbit Cloud', async () => {
    entries.find((e) => e.id === 'deploy')!.writer = { kind: 'OWNER', sessionId: null };
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('sign-in-v3.png')).toBeTruthy());
    const writer = (name: string) => row(name).querySelector('.files-col-writer')!.textContent;
    await until(() => expect(writer('sign-in-v3.png')).toBe('Redesign the sign-in page'));
    expect(row('sign-in-v3.png').querySelector('a')!.getAttribute('aria-label')).toBe('Agent in Redesign the sign-in page');
    expect(row('sign-in-v3.png').querySelector('a')!.getAttribute('href')).toBe('/sessions/sess-1');
    expect(writer('migration-notes.md')).toBe('An agent on Orbit Cloud');
    expect(writer('deploy-checklist.md')).toBe('You');
    // The tree has the drive's folders, from its root.
    const tree = [...document.querySelectorAll('.files-tree .files-tree-name')].map((n) => n.textContent);
    expect(tree).toEqual(['Drive', 'Datasets', 'Orbit UI migration', 'screens']);
  });

  it('searches the whole drive from the box, each result with its folder, and opens a result in its folder', async () => {
    entries.push({ id: 'notes2', parentId: 'f-data', kind: 'FILE', name: 'field-notes.csv', sizeBytes: 10 });
    await visit('/drive?folder=f-data');
    const box = document.querySelector<HTMLInputElement>('input[aria-label="Search Drive"]')!;
    await type(box, 'NOTES');
    // The box asks the server once typing has stopped.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await settle();
    await until(() => expect(row('migration-notes.md')).toBeTruthy());
    expect(row('field-notes.csv').querySelector('.files-col-writer')!.textContent).toBe('Drive/Datasets');
    expect(row('migration-notes.md').querySelector('.files-col-writer')!.textContent).toBe('Drive/Orbit UI migration');
    expect(row('sign-in-v3.png')).toBeNull();
    await click(row('migration-notes.md'));
    expect(location).toBe('/drive?folder=f-ui&file=notes');
    expect(document.querySelector('input[aria-label="Search Drive"]')).toBeTruthy();
    expect((document.querySelector('input[aria-label="Search Drive"]') as HTMLInputElement).value).toBe('');
  });

  it('opens a folder from the tree', async () => {
    await visit('/drive');
    await until(() => expect(document.querySelectorAll('.files-tree .files-tree-name').length).toBe(3));
    const datasets = [...document.querySelectorAll<HTMLElement>('.files-tree-row')].find((r) => r.textContent?.includes('Datasets'))!;
    await click(datasets);
    expect(location).toBe('/drive?folder=f-data');
  });

  it('previews a Markdown file rendered, and a picture drawn from its bytes', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:picture', revokeObjectURL: () => {} }));
    await visit('/drive?folder=f-ui&file=notes');
    await until(() => expect(document.querySelector('.files-preview-markdown h1')?.textContent).toBe('Migration notes'));
    expect(calls.some((c) => c.path === '/drive/entries/notes')).toBe(true);
    await click(row('sign-in-v3.png'));
    await until(() => expect(document.querySelector<HTMLImageElement>('.files-preview-picture')?.getAttribute('src')).toBe('blob:picture'));
  });

  it('previews text and code as written, a page in a frame that runs nothing, and a PDF in a frame of its own', async () => {
    const made: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => `blob:file-${made.push(b)}`, revokeObjectURL: () => {} }));
    entries.push(
      { id: 'cfg', parentId: 'f-data', kind: 'FILE', name: 'run.json', sizeBytes: 20, bytes: '{ "ok": true }\n<b>x</b>' },
      { id: 'log', parentId: 'f-data', kind: 'FILE', name: 'runner.log', sizeBytes: 6_400_000, bytes: 'heartbeat ok' },
      { id: 'page', parentId: 'f-data', kind: 'FILE', name: 'report.html', sizeBytes: 60, bytes: '<h1>Week 47</h1><script>parent.x=1</script>' },
      { id: 'pdf', parentId: 'f-data', kind: 'FILE', name: 'review.pdf', sizeBytes: 1_800, bytes: '%PDF-1.4' },
      { id: 'scan', parentId: 'f-data', kind: 'FILE', name: 'scan.pdf', sizeBytes: 48_000_000, bytes: '%PDF-1.4' },
      { id: 'zip', parentId: 'f-data', kind: 'FILE', name: 'eval.zip', sizeBytes: 10, bytes: 'PK' },
    );
    await visit('/drive?folder=f-data&file=cfg');
    // Text, not markup: the angle brackets stay as written.
    await until(() => expect(document.querySelector('.files-preview-text')?.textContent).toBe('{ "ok": true }\n<b>x</b>'));
    expect(document.querySelector('.files-preview-text b')).toBeNull();
    expect(document.querySelector('.files-preview-note')).toBeNull();

    await click(row('runner.log'));
    await until(() => expect(document.querySelector('.files-preview-text')?.textContent).toBe('heartbeat ok'));
    expect(document.querySelector('.files-preview-note')?.textContent).toBe('Showing the first 1 MB of 6.4 MB.');
    const reads = vi.mocked(authedFetch).mock.calls.filter(([input]) => String(input) === '/api/drive/entries/log/content');
    expect((reads[0][1] as RequestInit).headers).toEqual({ range: 'bytes=0-1048575' });

    await click(row('report.html'));
    await until(() => expect(document.querySelector('iframe.files-preview-page')).toBeTruthy());
    const page = document.querySelector<HTMLIFrameElement>('iframe.files-preview-page')!;
    // Every sandbox permission off: no script, no origin, no form, no navigation.
    expect(page.getAttribute('sandbox')).toBe('');
    expect(page.getAttribute('srcdoc')).toBe('<h1>Week 47</h1><script>parent.x=1</script>');
    expect(page.getAttribute('src')).toBeNull();

    await click(row('review.pdf'));
    await until(() => expect(document.querySelector('iframe.files-preview-pdf')?.getAttribute('src')).toMatch(/^blob:file-/));
    const pdf = made[Number(document.querySelector('iframe.files-preview-pdf')!.getAttribute('src')!.slice('blob:file-'.length)) - 1];
    expect(pdf.type).toBe('application/pdf');

    await click(row('scan.pdf'));
    await until(() => expect(document.querySelector('.files-preview-none')?.textContent).toBe('Too large to preview (48 MB). Download it to open.'));
    expect(vi.mocked(authedFetch).mock.calls.some(([input]) => String(input) === '/api/drive/entries/scan/content')).toBe(false);

    await click(row('eval.zip'));
    await until(() => expect(document.querySelector('.files-pane-name')?.textContent).toBe('eval.zip'));
    expect(document.querySelector('.files-preview-text, .files-preview-page, .files-preview-pdf, .files-preview-none')).toBeNull();
  });
});

describe('the header', () => {
  // Project acceptance: these controls in this order, and none of what they replaced.
  it('holds Search Drive, New folder, Upload, an icon-only Settings and a primary Agents, and nothing it replaced', async () => {
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('sign-in-v3.png')).toBeTruthy());
    const controls = [
      ...document.querySelectorAll<HTMLElement>('.files-head-actions input:not([type="file"]), .files-head-actions button'),
    ];
    const names = controls.map((c) => c.getAttribute('aria-label') ?? c.textContent!.trim());
    expect(names).toEqual(['Search Drive', 'New folder', 'Upload', 'Settings', 'Agents']);
    const [search, , , settings, agents] = controls;
    expect(search.getAttribute('placeholder')).toBe('Search Drive');
    expect(settings.textContent).toBe('');
    expect(settings.querySelector('.anticon-setting')).toBeTruthy();
    expect(controls.filter((c) => c.classList.contains('orbit-button-primary'))).toEqual([agents]);

    const replaced = [...document.querySelectorAll('button, a')].filter((el) =>
      /^(Trash|Storage)\b/.test((el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
    );
    expect(replaced.map((el) => el.outerHTML)).toEqual([]);
    expect(document.querySelector('.files-crumbs')).toBeNull();
    expect(document.querySelector('.files-tray')).toBeNull();
    expect(document.querySelector('.wk-chat-fab')).toBeNull();
  });
});

describe('upload', () => {
  it('sends a picked file in chunks, each named by its sha256, then completes it into the open folder', async () => {
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('sign-in-v3.png')).toBeTruthy());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Files to upload"]')!;
    await pick(input, [new File(['hello world'], 'labels.csv', { lastModified: 1 })]);
    await until(() => expect(calls.some((c) => c.path === '/drive/uploads/upload-1/complete')).toBe(true));
    expect(calls.find((c) => c.path === '/drive/uploads')!.body).toEqual({ parentId: 'f-ui', name: 'labels.csv', size: 11 });
    // Chunks of the size the open answered (4 bytes here), every one with its digest.
    expect(chunks.map((c) => c.body)).toEqual(['hell', 'o wo', 'rld']);
    expect(chunks.map((c) => c.sha256)).toEqual(['hell', 'o wo', 'rld'].map(sha));
    expect(document.querySelector('.files-tray')).toBeNull();
    await until(() => expect(row('labels.csv')).toBeTruthy());
  });

  it('goes on from a reload when the same file is chosen again on the row: only the chunks the server lacks are sent', async () => {
    uploadStatus['upload-7'] = { chunks: [{ idx: 0, sha256: sha('hell'), sizeBytes: 4 }] };
    localStorage.setItem(
      'orbit:drive-uploads',
      JSON.stringify([
        { key: 'k1', name: 'eval.zip', size: 11, lastModified: 5, parentId: 'f-data', parentName: 'Datasets', relativePath: null, dropKey: null, uploadId: 'upload-7' },
      ]),
    );
    resetDriveUploadsForTest();
    await visit('/drive?folder=f-data');
    await until(() => expect(document.querySelector('tr.pending')?.textContent).toContain('Stopped'));
    expect(document.querySelector('.files-tray')).toBeNull();
    const pending = document.querySelector<HTMLElement>('tr.pending')!;
    expect(button('Choose file again', pending)).toBeTruthy();
    expect(button('Cancel', pending)).toBeTruthy();
    const again = pending.querySelector<HTMLInputElement>('input[aria-label="Pick eval.zip again"]')!;
    await pick(again, [new File(['hello world'], 'eval.zip', { lastModified: 5 })]);
    await until(() => expect(calls.some((c) => c.path === '/drive/uploads/upload-7/complete')).toBe(true));
    // Nothing opened anew; chunk 0 was there already.
    expect(calls.filter((c) => c.path === '/drive/uploads' && c.method === 'POST')).toEqual([]);
    expect(chunks.map((c) => c.path)).toEqual(['/api/drive/uploads/upload-7/chunks/1', '/api/drive/uploads/upload-7/chunks/2']);
  });

  it('pauses on a lost connection, saying so on its row, and goes on from there on Resume', async () => {
    let fail = true;
    const served = vi.mocked(authedFetch).getMockImplementation()!;
    vi.mocked(authedFetch).mockImplementation((async (input: string, init: RequestInit) => {
      if (fail && input.includes('/chunks/1')) throw new TypeError('Failed to fetch');
      return served(input, init);
    }) as never);
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout'] });
    try {
      await visit('/drive?folder=f-ui');
      await until(() => expect(row('sign-in-v3.png')).toBeTruthy());
      await pick(document.querySelector<HTMLInputElement>('input[aria-label="Files to upload"]')!, [new File(['hello world'], 'big.bin')]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await until(() => expect(document.querySelector('tr.pending')?.textContent).toContain('Connection lost'));
      expect(document.querySelector('.files-tray')).toBeNull();
      fail = false;
      await click(button('Resume', document.querySelector('tr.pending')!));
      await until(() => expect(calls.some((c) => c.path === '/drive/uploads/upload-1/complete')).toBe(true));
      expect(chunks.map((c) => c.body)).toEqual(['hell', 'o wo', 'rld']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a paused upload from its row', async () => {
    localStorage.setItem(
      'orbit:drive-uploads',
      JSON.stringify([
        { key: 'k2', name: 'old.zip', size: 11, lastModified: 5, parentId: 'f-ui', parentName: 'UI', relativePath: null, dropKey: null, uploadId: null },
      ]),
    );
    resetDriveUploadsForTest();
    await visit('/drive?folder=f-ui');
    await until(() => expect(document.querySelector('tr.pending')).toBeTruthy());
    await click(button('Cancel', document.querySelector('tr.pending')!));
    expect(document.querySelector('tr.pending')).toBeNull();
  });

  it('drops a folder as one drop: its files keep their paths and share the top folder the first one made', async () => {
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('sign-in-v3.png')).toBeTruthy());
    const file = (name: string, text: string) => ({
      isFile: true, isDirectory: false, name, file: (done: (f: File) => void) => done(new File([text], name)),
    });
    const dir = (name: string, children: unknown[]) => {
      let read = false;
      return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => ({ readEntries: (done: (e: unknown[]) => void) => { done(read ? [] : children); read = true; } }),
      };
    };
    const survey = dir('survey-2026', [file('a.csv', 'aa'), dir('raw', [file('b.csv', 'bb')])]);
    const dataTransfer = { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => survey }], files: [] };
    const zone = document.querySelector('.files-list-wrap')!;
    await act(async () => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      zone.dispatchEvent(event);
    });
    await until(() => expect(calls.filter((c) => c.path === '/drive/uploads' && c.method === 'POST')).toHaveLength(2));
    const opens = calls.filter((c) => c.path === '/drive/uploads' && c.method === 'POST').map((c) => c.body);
    expect(opens[0]).toEqual({ parentId: 'f-ui', name: 'a.csv', size: 2, relativePath: 'survey-2026/a.csv' });
    expect(opens[1]).toEqual({ parentId: 'f-ui', name: 'b.csv', size: 2, relativePath: 'survey-2026/raw/b.csv', dropRootId: 'droproot-1' });
  });
});

describe('download', () => {
  it('navigates to a minted URL for the browser to stream, rather than reading the file into the page', async () => {
    const opened: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      opened.push(this.getAttribute('href') ?? '');
    });
    try {
      await visit('/drive?folder=f-ui&file=deploy');
      await until(() => expect(document.querySelector('.files-pane')).toBeTruthy());
      await click_(button('Download', document.querySelector('.files-pane')!));
      await until(() => expect(opened).toEqual(['/api/drive/dl/token-for-deploy']));
      expect(calls.find((c) => c.path === '/drive/entries/deploy/download-link')).toEqual({
        method: 'POST', path: '/drive/entries/deploy/download-link', body: {},
      });
      // No byte of it went through the page: the one read of its content is the Markdown preview's, bounded by a Range.
      const reads = vi.mocked(authedFetch).mock.calls.filter(([input]) => String(input).includes('/content'));
      expect(reads.map(([, init]) => (init as RequestInit).headers)).toEqual([{ range: 'bytes=0-1048575' }]);
    } finally {
      click.mockRestore();
    }
  });
});

describe('rename and move', () => {
  it('renames in the row: Enter sends the new name', async () => {
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('migration-notes.md')).toBeTruthy());
    await menu('migration-notes.md', 'Rename');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="New name for migration-notes.md"]')!;
    expect(input.value).toBe('migration-notes.md');
    // The menu closing hands focus to the field, not back to its ⋯: typing goes into the name.
    await until(() => expect(document.activeElement).toBe(input));
    await type(input, 'brief-v2.md');
    await key(input, 'Enter');
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/drive/entries/notes', body: { name: 'brief-v2.md' } });
    await until(() => expect(row('brief-v2.md')).toBeTruthy());
  });

  it('Escape leaves the name as it was', async () => {
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('migration-notes.md')).toBeTruthy());
    await menu('migration-notes.md', 'Rename');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="New name for migration-notes.md"]')!;
    await type(input, 'other.md');
    await key(input, 'Escape');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('moves into a folder picked in Move to…, its own folder greyed', async () => {
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('migration-notes.md')).toBeTruthy());
    await menu('migration-notes.md', 'Move to…');
    await until(() => expect(document.querySelector('.files-move-dialog .files-picker-row')).toBeTruthy());
    const pickerRow = (name: string) =>
      [...document.querySelectorAll<HTMLElement>('.files-picker-row')].find((r) => r.textContent?.includes(name))!;
    await until(() => expect(pickerRow('Datasets')).toBeTruthy());
    expect(pickerRow('Orbit UI migration').getAttribute('aria-disabled')).toBe('true');
    expect(pickerRow('Orbit UI migration').textContent).toContain('(here now)');
    await click(pickerRow('Datasets'));
    await click(button('Move to Datasets'));
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/drive/entries/notes', body: { parentId: 'f-data' } });
  });
});

describe('Trash', () => {
  it('moves to Trash without asking, and Undo restores the group it went in', async () => {
    await visit('/drive?folder=f-ui');
    await until(() => expect(row('migration-notes.md')).toBeTruthy());
    await menu('migration-notes.md', 'Move to Trash');
    expect(calls.find((c) => c.method === 'DELETE')!.path).toBe('/drive/entries/notes');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await until(() => expect(document.body.textContent).toContain('Moved to Trash'));
    await click(document.querySelector('button[aria-label="Undo moving migration-notes.md to Trash"]')!);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/drive/trash/groups/group-1/restore')).toBe(true);
  });

  it('groups Trash by folder and time, restores a group whole, and a version as current', async () => {
    const actor = { kind: 'AGENT', sessionId: null, runnerId: null };
    groups = [
      {
        id: 'g-del', kind: 'DELETE', folderId: 'f-ui', folderPath: '/Orbit UI migration', createdAt: AT, itemCount: 18,
        sizeBytes: 46_000_000, actor, items: [{ ...view({ id: 'old-screens', parentId: 'f-ui', kind: 'FOLDER', name: 'old-screens', sizeBytes: 0 }) }],
        version: null,
      },
      {
        id: 'g-ver', kind: 'VERSION', folderId: 'f-ui', folderPath: '/Orbit UI migration', createdAt: AT, itemCount: 1,
        sizeBytes: 1_100_000, actor,
        version: {
          id: 'ver-1', entryId: 'sign-in', sizeBytes: 1_100_000, chunkCount: 1, createdAt: AT, current: false,
          writer: { kind: 'OWNER', sessionId: null, runnerId: null }, replacedAt: AT, trashGroupId: 'g-ver',
          entry: view(entries.find((e) => e.id === 'sign-in')!),
        },
        items: [],
      },
      {
        id: 'g-data', kind: 'DELETE', folderId: 'f-data', folderPath: '/Datasets', createdAt: AT, itemCount: 2,
        sizeBytes: 2_600_000_000, actor: { kind: 'OWNER', sessionId: null, runnerId: null },
        items: [
          view({ id: 'draft', parentId: 'f-data', kind: 'FILE', name: 'eval-runs-draft.zip', sizeBytes: 2_500_000_000 }),
          view({ id: 'labels-old', parentId: 'f-data', kind: 'FILE', name: 'labels-old.csv', sizeBytes: 80_000_000 }),
        ],
        version: null,
      },
    ];
    await visit('/drive/trash');
    await until(() => expect(document.querySelectorAll('.files-trash-group')).toHaveLength(3));
    const heads = [...document.querySelectorAll('.files-trash-group-head')].map((h) => h.textContent);
    expect(heads[0]).toContain('From Orbit UI migration · deleted');
    expect(heads[0]).toContain('An agent on Orbit Cloud · 18 items · 46 MB');
    expect(heads[1]).toContain('From Orbit UI migration · replaced');
    expect(heads[2]).toContain('From Datasets');
    const [, versionGroup, dataGroup] = document.querySelectorAll<HTMLElement>('.files-trash-group');
    // One item out of a group, leaving the rest (rule 3).
    await click(dataGroup.querySelector('button[aria-label="Restore eval-runs-draft.zip"]')!);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/drive/trash/groups/g-data/items/draft/restore')).toBe(true);
    expect(calls.some((c) => c.path === '/drive/trash/groups/g-data/restore')).toBe(false);
    await click(button('Restore all', dataGroup));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/drive/trash/groups/g-data/restore')).toBe(true);
    await click(button('Restore as current', versionGroup));
    expect(calls.find((c) => c.path === '/drive/versions/ver-1/restore')!.body).toEqual({ as: 'CURRENT' });
    await click(button('Restore as a copy', versionGroup));
    expect(calls.filter((c) => c.path === '/drive/versions/ver-1/restore').map((c) => c.body)).toEqual([{ as: 'CURRENT' }, { as: 'COPY' }]);
  });

  it('asks before deleting for good, and says when that ends a share link', async () => {
    groups = [
      {
        id: 'g-data', kind: 'DELETE', folderId: 'f-data', folderPath: '/Datasets', createdAt: AT, itemCount: 1, sizeBytes: 80,
        actor: { kind: 'OWNER', sessionId: null, runnerId: null },
        items: [view({ id: 'shared-file', parentId: 'f-data', kind: 'FILE', name: 'labels-old.csv', sizeBytes: 80 })],
        version: null,
      },
    ];
    links = [{ id: 'link-9', token: 't', driveEntryId: 'shared-file', pinnedIsCurrent: true, state: 'PAUSED' }];
    entries.push({ id: 'shared-file', parentId: 'f-data', kind: 'FILE', name: 'labels-old.csv', sizeBytes: 80 });
    await visit('/drive/trash');
    await until(() => expect(document.querySelectorAll('.files-trash-group')).toHaveLength(1));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="More for the group from Datasets"]')!;
    await act(async () => trigger.click());
    let item: HTMLElement | undefined;
    await until(() => {
      item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Delete for good'));
      if (!item) throw new Error('no menu');
    });
    await click(item!);
    await until(() => expect(document.body.textContent).toContain('Delete for good?'));
    expect(document.body.textContent).toContain('This ends a share link.');
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === 'Delete for good').at(-1)!;
    await click(confirm);
    await until(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/drive/trash/groups/g-data')).toBe(true));
  });
});

describe('the one-file share link', () => {
  it('warns, naming what the check found, and the owner can still share', async () => {
    shareCheck = { warnings: [{ kind: 'an AWS access key id', line: 14 }], checkedBytes: 26_214_400, partial: true };
    await visit('/drive?folder=f-ui&file=deploy');
    await until(() => expect(document.querySelector('.files-pane')).toBeTruthy());
    await click(button('Share link…', document.querySelector('.files-pane')!));
    await until(() => expect(document.querySelector('.files-share-warning')).toBeTruthy());
    const warning = document.querySelector('.files-share-warning')!.textContent!;
    expect(warning).toContain('This file looks like it holds secrets');
    expect(warning).toContain('An AWS access key id');
    expect(warning).toContain('line 14');
    expect(warning).toContain('Only the first 26 MB of this file was checked for secrets.');
    expect(warning).toContain('You can still share it.');
    // Nothing is made before the owner says so.
    expect(calls.some((c) => c.path === '/share-links' && c.method === 'POST')).toBe(false);
    await click(button('Share anyway'));
    expect(calls.find((c) => c.path === '/share-links' && c.method === 'POST')!.body).toEqual({ kind: 'DRIVE_FILE', driveEntryId: 'deploy' });
    await until(() =>
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Share link"]')?.value).toBe(`${window.location.origin}/s/Gk2e8TqB`),
    );
  });

  it('makes the link at once when the check finds nothing', async () => {
    await visit('/drive?folder=f-ui&file=deploy');
    await until(() => expect(document.querySelector('.files-pane')).toBeTruthy());
    await click(button('Share link…', document.querySelector('.files-pane')!));
    await until(() => expect(document.querySelector<HTMLInputElement>('input[aria-label="Share link"]')).toBeTruthy());
    expect(document.querySelector('.files-share-warning')).toBeNull();
    expect(calls.filter((c) => c.path.endsWith('/share-check')).map((c) => c.path)).toEqual(['/drive/entries/deploy/share-check']);
  });

  it('offers Share this version when the link pins an earlier one, and moves it', async () => {
    links = [{ id: 'link-1', token: 'Gk2e8TqB', driveEntryId: 'deploy', pinnedIsCurrent: false, state: 'ACTIVE' }];
    await visit('/drive?folder=f-ui&file=deploy');
    await until(() => expect(document.querySelector('.files-pane-shared')?.textContent).toContain('An earlier version'));
    await click(button('Share this version'));
    await until(() => expect(calls.some((c) => c.path === '/share-links' && c.method === 'POST')).toBe(true));
    expect(calls.some((c) => c.path === '/drive/entries/deploy/share-check')).toBe(true);
  });
});
