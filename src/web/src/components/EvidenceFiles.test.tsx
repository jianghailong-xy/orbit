// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingDecisionsQuery, taskEvidenceQuery } from '../lib/queries';
import {
  EVIDENCE_FILES_LOADING,
  EVIDENCE_FILES_SHOW_MORE,
  EVIDENCE_FILES_TITLE,
  EVIDENCE_FILES_UNREAD,
  EVIDENCE_FILE_DOWNLOAD,
  EVIDENCE_FILE_DOWNLOAD_FAILED,
  evidenceFilesShowing,
  type EvidenceFile,
  type EvidenceFilePage,
  type EvidenceTestReport,
} from '../lib/evidenceFiles';
import { saveUserFile } from '../lib/userFile';
import type { PendingDecisionQueue, PendingDecisionRow, RecordedDecisionRow } from './DecisionRail';
import {
  DECISION_CONFIRM_ACTION,
  DECISION_CRITERION_HEADING,
  DECISION_RECEIPT_OPEN,
  EvidenceDecisionCard,
  EvidenceDecisionReceipt,
  SessionEvidenceDecisionCard,
  evidenceDecisionStanding,
} from './EvidenceDecisionCard';

/**
 * The evidence card's files, as a reader meets them: the area under the standard, the page it opens, the viewer a
 * thumbnail opens, and what is left once the bytes have expired. The list comes through a mocked `api()` in the route's
 * own shape, and the bytes through a mocked `fetchAttachmentObjectUrl`, whose calls say exactly which files were read.
 * jsdom lays nothing out and decodes nothing, so how it looks is the screenshots' business.
 */

vi.mock('../api', () => ({ api: vi.fn(), fetchAttachmentObjectUrl: vi.fn(), setAttachmentPinned: vi.fn() }));
vi.mock('../lib/userFile', async (original) => ({
  ...(await original<typeof import('../lib/userFile')>()),
  saveUserFile: vi.fn(),
}));
vi.mock('../lib/toast', () => {
  const toast = { error: vi.fn() };
  return { useToast: () => toast };
});
const { api, fetchAttachmentObjectUrl, setAttachmentPinned } = await import('../api');
const { useToast } = await import('../lib/toast');
const apiMock = vi.mocked(api);
const bytesMock = vi.mocked(fetchAttachmentObjectUrl);
const pinMock = vi.mocked(setAttachmentPinned);
const saveMock = vi.mocked(saveUserFile);

const SESSION_ID = '34MOJw69NzKSq2X0exxf9';
const PROJECT_ID = '34MPiBgZ80YpSKt0lmTQA';
const TASK_ID = '34MQU2Y12ag8HVafcL8qL';
const SHA = '3f9a1c07aabbccddeeff00112233445566778899aabbccddeeff001122334455';
const FILES_ROUTE = `/tasks/${TASK_ID}/evidence/2/files`;

function file(id: string, over: Partial<EvidenceFile> = {}): EvidenceFile {
  return {
    id, name: `chromium-light-phone/${id}.png`, folder: 'menu-shots', mimeType: 'image/png', sizeBytes: 214 * 1024,
    sha256: SHA, width: null, height: null, expiredAt: null, gone: false, ...over,
  };
}

/** Nine files: two folders of pictures, a report, and what may not be drawn. */
const FILES: EvidenceFile[] = [
  file('light-open'),
  file('light-closed'),
  file('dark-open', { name: 'chromium-dark-phone/dark-open.png' }),
  file('dark-closed', { name: 'chromium-dark-phone/dark-closed.png' }),
  file('shot', { name: 'alone.png', folder: null, width: 780, height: 1688 }),
  file('webkit', { name: 'webkit-light-phone/webkit.png' }),
  file('page', { name: 'notes/page.html', mimeType: 'text/html', sizeBytes: 13 }),
  file('vector', { name: 'notes/vector.svg', mimeType: 'image/svg+xml', sizeBytes: 90 }),
  file('report', { name: 'report.json', folder: null, mimeType: 'application/json', sizeBytes: 12 * 1024 }),
];

function page(files: EvidenceFile[] = FILES, over: Partial<EvidenceFilePage> = {}): EvidenceFilePage {
  return {
    revision: '2', submittedAt: '2026-11-02T06:41:00.000Z', fileCount: files.length, totalBytes: 1_887_437, files,
    nextOffset: null, ...over,
  };
}

const REPORT: EvidenceTestReport = {
  format: 'playwright', total: 48, passed: 46, failed: 0, skipped: 2, durationMs: 38_000, failedNames: [],
  skippedNames: ['[webkit] › menu › scrolls', '[webkit] › select › wraps'],
};

const FILE_CITATIONS = [
  { kind: 'FILE', ref: 'bundle', resolved: true, reason: null, label: '8 files · 1.8 MB' },
  { kind: 'FILE', ref: 'report', resolved: true, reason: null, label: 'report.json · 12 KB · application/json', testReport: REPORT },
];

function row(over: Partial<PendingDecisionRow> = {}): PendingDecisionRow {
  return {
    taskId: TASK_ID,
    title: 'P4.3 keyboard windows',
    projectId: PROJECT_ID,
    criterion: { key: '7L4At4DOupG7FwgxfXykzS', text: 'Keyboard behaviour matches the migration.' },
    evidenceRevision: '2',
    ageSeconds: 600,
    claim: 'It matches.',
    gaps: [],
    citations: FILE_CITATIONS,
    decidability: { decidable: true, refusal: null, requiredAction: null },
    independence: { independent: true, disqualification: null, requiredAction: null },
    ...over,
  };
}

function queue(rows: PendingDecisionRow[]): PendingDecisionQueue {
  return { decidingSessionId: SESSION_ID, count: rows.length, oldestAgeSeconds: 600, pending: rows, waitingOnYou: [] };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const clients: QueryClient[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  URL.revokeObjectURL = vi.fn();
  bytesMock.mockImplementation(async (id) => `blob:test/${id}`);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  for (const qc of clients.splice(0)) qc.clear();
  apiMock.mockReset();
  bytesMock.mockReset();
  saveMock.mockReset();
  pinMock.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

function client(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(qc);
  return qc;
}

async function mount(ui: JSX.Element, qc = client()): Promise<HTMLElement> {
  const node = document.createElement('div');
  document.body.appendChild(node);
  container = node;
  root = createRoot(node);
  await act(async () => root!.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>));
  await settle();
  return node;
}

/** The route, in its own shape; `pages` by offset. `pending` is what the card's own read answers. */
function serve(pages: Record<number, EvidenceFilePage> | EvidenceFilePage = page(), pending?: PendingDecisionQueue): void {
  apiMock.mockImplementation((async (path: string) => {
    if (pending && path.startsWith('/tasks/evidence-decisions/pending')) return pending;
    if (!path.startsWith(FILES_ROUTE)) throw new Error(`nothing should read ${path}`);
    const offset = Number(new URLSearchParams(path.split('?')[1] ?? '').get('offset') ?? 0);
    return 'files' in pages ? pages : pages[offset];
  }) as never);
}

const noop = (): void => {};
const card = (live: PendingDecisionRow = row()): JSX.Element => (
  <EvidenceDecisionCard
    standing={evidenceDecisionStanding(queue([live]), PROJECT_ID, live)}
    onConfirm={noop}
    onChatAbout={noop}
  />
);

const area = (node: ParentNode): HTMLElement => node.querySelector<HTMLElement>('.evidence-files')!;
const opener = (node: ParentNode): HTMLButtonElement => node.querySelector<HTMLButtonElement>('.evidence-files-open')!;
const sheet = (): HTMLElement => document.querySelector<HTMLElement>('.evidence-files-page')!;
const viewer = (): HTMLElement => document.querySelector<HTMLElement>('.orbit-image-preview')!;
const tile = (name: string): HTMLButtonElement => {
  const found = sheet().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) throw new Error(`no tile called ${name}`);
  return found;
};

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await settle();
}

async function openPage(node: ParentNode): Promise<void> {
  await click(opener(node));
  expect(sheet()).not.toBeNull();
}

describe('the default state', () => {
  it('sits under the standard and above the gaps: heading, four thumbnails, the count of the rest, the report', async () => {
    serve();
    const node = await mount(card());
    expect(apiMock).toHaveBeenCalledWith(FILES_ROUTE);
    const body = node.querySelector('.decision-ask-q')!;
    const order = [...body.children].map((child) => child.className.split(' ')[0]);
    expect(order.indexOf('evidence-files')).toBe(order.indexOf('decision-ask-standard') + 1);
    expect(order.indexOf('decision-ask-gaps')).toBe(order.indexOf('evidence-files') + 1);

    const files = area(node);
    expect(files.querySelector('.evidence-files-head')?.textContent).toBe('FILES · 9 · 1.8 MB');
    expect(files.querySelectorAll('.evidence-tile-img')).toHaveLength(4);
    expect(files.querySelector('.evidence-tile-more')?.textContent).toBe('+5');
    expect(files.querySelector('.evidence-report-line')?.textContent).toBe('Playwright · 46 passed · 0 failed · 2 skipped');
  });

  it('reads the bytes of the four it draws and of nothing else', async () => {
    serve();
    await mount(card());
    expect(bytesMock.mock.calls.map(([id]) => id).sort()).toEqual(['dark-closed', 'dark-open', 'light-closed', 'light-open']);
  });

  it('says no +N when all of them are drawn', async () => {
    serve(page(FILES.slice(0, 4)));
    const node = await mount(card());
    expect(area(node).querySelector('.evidence-tile-more')).toBeNull();
  });

  it('lists what failed, up to three, and counts the rest of what the report counted', async () => {
    serve();
    const failing = { ...REPORT, passed: 40, failed: 6, failedNames: ['one', 'two', 'three', 'four', 'five'] };
    const node = await mount(card(row({ citations: [{ ...FILE_CITATIONS[0], testReport: failing }] })));
    const line = area(node).querySelector('.evidence-report-line')!;
    expect(line.querySelector('.evidence-report-text')?.textContent).toBe('Playwright · 40 passed · 6 failed · 2 skipped');
    expect([...line.querySelectorAll('.evidence-report-name')].map((name) => name.textContent)).toEqual(['one', 'two', 'three', '3 more']);
    expect(line.querySelector('.evidence-report-mark.is-failed')).not.toBeNull();
  });

  it('holds its place while the list is read, and says so when it could not be', async () => {
    apiMock.mockImplementation((() => new Promise(() => {})) as never);
    const waiting = await mount(card());
    expect(area(waiting).textContent).toContain(EVIDENCE_FILES_LOADING);
    expect(area(waiting).querySelector('.evidence-files-head')?.textContent).toBe('FILES');
    expect(area(waiting).querySelector('.evidence-report-line')?.textContent, 'a report is on the citation, and need not wait').toContain('46 passed');
    await act(async () => root!.unmount());
    root = null;

    apiMock.mockImplementation((async () => { throw new Error('502'); }) as never);
    const failed = await mount(card());
    expect(area(failed).textContent).toContain(EVIDENCE_FILES_UNREAD);
  });

  it('draws a tile for a thumbnail that will not read, rather than a hole', async () => {
    serve();
    bytesMock.mockImplementation(async (id) => {
      if (id === 'light-open') throw new Error('404');
      return `blob:test/${id}`;
    });
    const node = await mount(card());
    expect(area(node).querySelectorAll('.evidence-tile-img')).toHaveLength(3);
    expect(area(node).querySelector('.evidence-tile-kind')?.textContent).toBe('PNG');
  });
});

describe('a version citing no file', () => {
  it('is the card it has always been, and asks for nothing', async () => {
    const today = row({
      citations: [{ kind: 'TOOL_CALL', ref: 'toolu_1', resolved: true, reason: null, label: 'Bash · npx vitest run' }],
    });
    const markup = renderToStaticMarkup(card(today));
    expect(markup).not.toContain('evidence-files');
    expect(markup).not.toContain('FILES');
    expect(markup).toContain(DECISION_CRITERION_HEADING);
    const node = await mount(card(today));
    expect(area(node)).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    expect(bytesMock).not.toHaveBeenCalled();
  });
});

describe('the Evidence files page', () => {
  it('opens from the area: the version, its size, the report, and every file by its folder with a count', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    expect(document.querySelector('.orbit-overlay-title')?.textContent).toBe(EVIDENCE_FILES_TITLE);
    const version = sheet().querySelector('.evidence-files-version')!;
    expect(version.children[0].textContent).toMatch(/^Revision 2 · /);
    expect(version.children[1].textContent).toBe('9 files · 1.8 MB');
    expect(sheet().querySelector('.evidence-report-title')?.textContent).toBe('Playwright report');
    expect(sheet().querySelector('.evidence-report-facts')?.textContent).toBe('46 passed · 0 failed · 2 skipped · 38s');
    const groups = [...sheet().querySelectorAll('.evidence-files-group-head')].map((head) => head.textContent);
    expect(groups).toEqual(['chromium-light-phone 2', 'chromium-dark-phone 2', 'Files 2', 'webkit-light-phone 1', 'notes 2']);
  });

  it('opens a report into the cases it failed and skipped, and says when the names stop short of the count', async () => {
    serve();
    const failing = { ...REPORT, passed: 20, failed: 26, failedNames: Array.from({ length: 20 }, (_, k) => `case ${k}`) };
    const node = await mount(card(row({ citations: [{ ...FILE_CITATIONS[0], testReport: failing }] })));
    await openPage(node);
    const head = sheet().querySelector<HTMLButtonElement>('button.evidence-report-head')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(sheet().querySelector('.evidence-report-list')).toBeNull();
    await click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const lists = [...sheet().querySelectorAll('.evidence-report-list')];
    expect(lists.map((list) => list.querySelector('.evidence-report-list-head')?.textContent)).toEqual(['Failed · 26', 'Skipped · 2']);
    expect(lists[0].querySelectorAll('li')).toHaveLength(20);
    expect(lists[0].querySelector('.evidence-report-list-more')?.textContent).toBe('6 more');
    expect([...lists[1].querySelectorAll('li')].map((name) => name.textContent)).toEqual(REPORT.skippedNames);
    expect(lists[1].querySelector('.evidence-report-list-more')).toBeNull();
  });

  it('has nothing to open when a report failed and skipped nothing', async () => {
    serve();
    const clean = { ...REPORT, skipped: 0, skippedNames: [] };
    const node = await mount(card(row({ citations: [{ ...FILE_CITATIONS[0], testReport: clean }] })));
    await openPage(node);
    expect(sheet().querySelector('button.evidence-report-head')).toBeNull();
    expect(sheet().querySelector('.evidence-report-caret')).toBeNull();
  });

  it('reads the next page when asked, and says how many are shown until then', async () => {
    const first = page(FILES.slice(0, 4), { fileCount: 6, nextOffset: 4 });
    const second = page(FILES.slice(4, 6), { fileCount: 6, nextOffset: null });
    serve({ 0: first, 4: second });
    const node = await mount(card());
    await openPage(node);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const showing = sheet().querySelector('.evidence-files-showing')!;
    expect(showing.textContent).toContain(evidenceFilesShowing(4, 6));
    await click([...showing.querySelectorAll('button')].find((button) => button.textContent === EVIDENCE_FILES_SHOW_MORE)!);
    expect(apiMock).toHaveBeenLastCalledWith(`${FILES_ROUTE}?offset=4`);
    expect(sheet().querySelector('.evidence-files-showing')).toBeNull();
    expect(sheet().querySelectorAll('.evidence-tile-img')).toHaveLength(6);
    expect(opener(node).querySelector('.evidence-files-head')?.textContent, 'the count was the whole list\'s all along').toBe('FILES · 6 · 1.8 MB');
  });

  it('lets go of what it read when it closes', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    const revoked = vi.mocked(URL.revokeObjectURL);
    revoked.mockClear();
    await click(document.querySelector<HTMLButtonElement>('.orbit-overlay-close')!);
    await settle();
    expect(sheet()).toBeNull();
    expect(revoked.mock.calls.map(([url]) => url)).toContain('blob:test/shot');
    expect(area(node).querySelectorAll('.evidence-tile-img'), 'and the card keeps its own').toHaveLength(4);
  });
});

describe('the viewer', () => {
  it('opens on the pressed picture among the pictures, pages them, and says what each one is', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    await click(tile('chromium-dark-phone/dark-open.png'));
    expect(viewer().querySelector('.orbit-image-preview-progress')?.textContent).toBe('3 of 6');
    expect(viewer().querySelector('.evidence-viewer-path')?.textContent).toBe('chromium-dark-phone/dark-open.png');
    expect(viewer().querySelector('.orbit-image-preview-caption')?.textContent).toContain('214 KB · sha256 3f9a1c07');
    expect(viewer().querySelector('.orbit-image-preview-img')?.getAttribute('src')).toBe('blob:test/dark-open');

    await click(viewer().querySelector<HTMLButtonElement>('[aria-label="Next image"]')!);
    expect(viewer().querySelector('.orbit-image-preview-progress')?.textContent).toBe('4 of 6');
    expect(viewer().querySelector('.evidence-viewer-path')?.textContent).toBe('chromium-dark-phone/dark-closed.png');

    await click(viewer().querySelector<HTMLButtonElement>('[aria-label="Next image"]')!);
    expect(viewer().querySelector('.evidence-viewer-path')?.textContent).toBe('alone.png');
    expect(viewer().querySelector('.orbit-image-preview-caption')?.textContent, 'a size the citation recorded').toContain('214 KB · 780 × 1688 · sha256 3f9a1c07');
  });

  it('saves the file under its own name', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    await click(tile('chromium-light-phone/light-open.png'));
    await click(viewer().querySelector<HTMLButtonElement>(`[aria-label="${EVIDENCE_FILE_DOWNLOAD}"]`)!);
    expect(saveMock).toHaveBeenCalledWith('blob:test/light-open', 'light-open.png');
  });

  it('closes on its own and leaves the page open', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    await click(tile('alone.png'));
    await click(viewer().querySelector<HTMLButtonElement>('.orbit-image-preview-close')!);
    await settle();
    expect(viewer()).toBeNull();
    expect(sheet()).not.toBeNull();
  });
});

describe('only a raster image is drawn', () => {
  const SVG_AND_HTML = ['notes/page.html', 'notes/vector.svg', 'report.json'];

  it('never reads or draws what may not be drawn, on the card or on the page', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    expect(bytesMock.mock.calls.map(([id]) => id)).not.toEqual(expect.arrayContaining(['page']));
    expect(bytesMock.mock.calls.map(([id]) => id)).not.toEqual(expect.arrayContaining(['vector']));
    expect(sheet().querySelectorAll('.evidence-tile-img')).toHaveLength(6);
    expect([...sheet().querySelectorAll('.evidence-tile-kind')].map((kind) => kind.textContent)).toEqual(['JSON', 'HTML', 'SVG']);
  });

  it.each(SVG_AND_HTML)('saves %s on a press, and opens nothing', async (name) => {
    serve();
    const open = vi.spyOn(window, 'open');
    const node = await mount(card());
    await openPage(node);
    await click(tile(`${EVIDENCE_FILE_DOWNLOAD} ${name}`));
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][1]).toBe(name.split('/').at(-1));
    expect(open).not.toHaveBeenCalled();
    expect(viewer()).toBeNull();
    open.mockRestore();
  });

  it('keeps them out of the viewer’s set', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    await click(tile('webkit-light-phone/webkit.png'));
    expect(viewer().querySelector('.orbit-image-preview-progress')?.textContent).toBe('6 of 6');
    expect(viewer().querySelector<HTMLButtonElement>('[aria-label="Next image"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('says so when a save fails', async () => {
    serve();
    const node = await mount(card());
    await openPage(node);
    bytesMock.mockImplementation(async () => { throw new Error('attachment page: 404'); });
    await click(tile(`${EVIDENCE_FILE_DOWNLOAD} notes/page.html`));
    expect(saveMock).not.toHaveBeenCalled();
    expect(vi.mocked(useToast().error)).toHaveBeenCalledWith(EVIDENCE_FILE_DOWNLOAD_FAILED, 'attachment page: 404');
  });
});

describe('expired files', () => {
  const NOON = '2026-12-02T12:00:00.000Z';
  const EXPIRED = FILES.map((each) => ({ ...each, expiredAt: NOON }));

  it('takes the pictures and leaves the names, the sizes, the sha256 and the report', async () => {
    serve(page(EXPIRED));
    const node = await mount(card());
    const files = area(node);
    expect(files.querySelector('.evidence-files-head')?.textContent).toMatch(/^FILES · 9 · 1\.8 MB · EXPIRED DEC 2/);
    expect(files.querySelectorAll('.evidence-tile-img')).toHaveLength(0);
    expect([...files.querySelectorAll('.evidence-tile-expired')].map((each) => each.textContent)).toEqual(
      Array.from({ length: 4 }, () => expect.stringMatching(/^ExpiredDec 2/)),
    );
    expect(files.querySelector('.evidence-tile-more')?.textContent).toBe('+5');
    expect(files.querySelector('.evidence-report-line')?.textContent).toContain('46 passed');
    expect(files.querySelector('.evidence-report-mark.is-quiet'), 'grey, as the board draws it').not.toBeNull();
    expect(bytesMock, 'no bytes are asked for').not.toHaveBeenCalled();

    await openPage(node);
    expect(sheet().querySelectorAll('button.evidence-tile')).toHaveLength(0);
    expect(sheet().querySelectorAll('.evidence-tile-expired')).toHaveLength(9);
    const caption = sheet().querySelector('.evidence-page-tile')!;
    expect(caption.querySelector('.evidence-tile-name')?.textContent).toBe('light-open.png');
    expect(caption.querySelector('.evidence-tile-facts')?.textContent).toBe('214 KB · sha256 3f9a1c07');
    expect(sheet().querySelector('.evidence-report-facts')?.textContent).toContain('46 passed');
    expect(bytesMock).not.toHaveBeenCalled();
  });

  it('expires one tile at a time: the rest keep their pictures and the heading says nothing yet', async () => {
    serve(page(FILES.map((each, k) => (k === 0 ? { ...each, expiredAt: NOON } : each))));
    const node = await mount(card());
    await openPage(node);
    expect(area(node).querySelector('.evidence-files-head')?.textContent).toBe('FILES · 9 · 1.8 MB');
    expect(area(node).querySelectorAll('.evidence-tile-img')).toHaveLength(4);
    expect(sheet().querySelectorAll('.evidence-tile-expired')).toHaveLength(1);
    expect(sheet().querySelectorAll('.evidence-tile-img')).toHaveLength(5);
    await click(tile('chromium-light-phone/light-closed.png'));
    expect(viewer().querySelector('.orbit-image-preview-progress')?.textContent, 'and it is not in the set').toBe('1 of 5');
  });

  it('draws the same placeholder for a row that went, which has no date and no name left', async () => {
    const gone: EvidenceFile = {
      id: '34qfhTRsT3YHK4idLPSLu', name: null, folder: null, mimeType: null, sizeBytes: null, sha256: SHA, width: 20, height: 21,
      expiredAt: null, gone: true,
    };
    serve(page([gone], { totalBytes: 0 }));
    const node = await mount(card(row({
      citations: [{ kind: 'FILE', ref: gone.id, resolved: false, reason: 'no FILE of this task matches this reference', label: null }],
    })));
    expect(area(node).querySelector('.evidence-files-head')?.textContent).toBe('FILES · 1 · EXPIRED');
    expect(area(node).querySelector('.evidence-tile-expired')?.textContent).toBe('Expired');
    await openPage(node);
    expect(sheet().querySelector('.evidence-tile-name')?.textContent).toBe(gone.id);
    expect(sheet().querySelector('.evidence-tile-facts')?.textContent).toBe('sha256 3f9a1c07');
  });
});

describe('a file being kept', () => {
  const PINNED_AT = '2026-11-03T01:00:00.000Z';
  const DATE = '2026-11-17T06:00:00.000Z';
  const pictureFiles = (): EvidenceFile[] => [
    file('kept', { pinnable: true, expiresAt: DATE }),
    file('held', { pinnable: true, pinnedAt: PINNED_AT, expiresAt: null }),
    file('foreign', { pinnable: false, name: 'chromium-light-phone/foreign.png' }),
  ];
  const pinOn = (name: string): HTMLButtonElement | null => {
    const holder = [...sheet().querySelectorAll<HTMLElement>('.evidence-page-tile')]
      .find((each) => each.querySelector(`[aria-label="${name}"]`) || each.querySelector(`[title="${name}"]`))!;
    return holder.querySelector<HTMLButtonElement>('button.evidence-tile-pin');
  };
  const markOn = (name: string): HTMLElement | null => {
    const holder = [...sheet().querySelectorAll<HTMLElement>('.evidence-page-tile')]
      .find((each) => each.querySelector(`[aria-label="${name}"]`))!;
    return holder.querySelector<HTMLElement>('span.evidence-tile-pin');
  };
  const viewerAction = (label: string): HTMLButtonElement | null =>
    viewer().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('marks only a pinned picture on the page, and offers it nothing to press there', async () => {
    serve(page(pictureFiles()));
    const node = await mount(card());
    await openPage(node);
    expect(markOn('chromium-light-phone/held.png')?.getAttribute('aria-label')).toBe('Pinned');
    expect(markOn('chromium-light-phone/kept.png')).toBeNull();
    expect(sheet().querySelector('button.evidence-tile-pin'), 'a picture is pinned from the viewer').toBeNull();
    expect(pinMock).not.toHaveBeenCalled();
  });

  it('pins and unpins a picture in the viewer, beside the download, and says how long it stays', async () => {
    serve(page(pictureFiles()));
    const node = await mount(card());
    await openPage(node);
    await click(tile('chromium-light-phone/kept.png'));
    const caption = (): string => viewer().querySelector('.orbit-image-preview-caption')!.textContent!;
    expect(caption()).toContain('Expires Nov 17');
    const actions = [...viewer().querySelectorAll('.orbit-image-preview-action')].map((action) => action.getAttribute('aria-label'));
    expect(actions.slice(-2)).toEqual(['Download', 'Pin']);

    pinMock.mockResolvedValueOnce({ expiresAt: DATE, expiredAt: null, pinnedAt: PINNED_AT });
    await click(viewerAction('Pin')!);
    expect(pinMock).toHaveBeenLastCalledWith('kept', true);
    expect(caption()).toContain('Pinned');
    expect(caption()).not.toContain('Expires');
    expect(viewerAction('Pin')).toBeNull();
    expect(markOn('chromium-light-phone/kept.png'), 'and the page behind it says so').not.toBeNull();

    pinMock.mockResolvedValueOnce({ expiresAt: DATE, expiredAt: null, pinnedAt: null });
    await click(viewerAction('Unpin')!);
    expect(pinMock).toHaveBeenLastCalledWith('kept', false);
    expect(caption()).toContain('Expires Nov 17');
    expect(markOn('chromium-light-phone/kept.png')).toBeNull();
  });

  it('offers no pin in the viewer on what the server does not offer one', async () => {
    serve(page(pictureFiles()));
    const node = await mount(card());
    await openPage(node);
    await click(tile('chromium-light-phone/foreign.png'));
    expect(viewerAction('Pin')).toBeNull();
    expect(viewerAction('Unpin')).toBeNull();
    expect(viewerAction('Download')).not.toBeNull();
  });

  it('reads a server older than the field as no pin anywhere', async () => {
    serve(page(FILES));
    const node = await mount(card());
    await openPage(node);
    expect(sheet().querySelector('.evidence-tile-pin')).toBeNull();
    await click(tile('chromium-light-phone/light-open.png'));
    expect(viewerAction('Pin')).toBeNull();
  });

  it('keeps the pin on the tile of a file with no viewer, and takes it off again', async () => {
    serve(page([file('page', { name: 'notes/page.html', mimeType: 'text/html', pinnable: true, expiresAt: DATE })]));
    const node = await mount(card());
    await openPage(node);
    const facts = (): string => sheet().querySelector('.evidence-tile-caption')!.textContent!;
    expect(facts()).toContain('Expires Nov 17');
    const pin = sheet().querySelector<HTMLButtonElement>('button.evidence-tile-pin')!;
    expect(pin.getAttribute('aria-label')).toBe('Pin');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    pinMock.mockResolvedValueOnce({ expiresAt: DATE, expiredAt: null, pinnedAt: PINNED_AT });
    await click(pin);
    expect(pinMock).toHaveBeenLastCalledWith('page', true);
    expect(saveMock, 'pressing the pin saves nothing').not.toHaveBeenCalled();
    const pressed = sheet().querySelector<HTMLButtonElement>('button.evidence-tile-pin')!;
    expect(pressed.getAttribute('aria-label')).toBe('Unpin');
    expect(pressed.className).toContain('is-pinned');
    expect(facts()).toContain('Pinned');
  });

  it('brings a tombstoned picture back from its tile, where it then has a viewer and only a mark', async () => {
    serve(page([file('old', { pinnable: true, expiredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' })]));
    const node = await mount(card());
    await openPage(node);
    expect(sheet().querySelector('.evidence-tile-expired')).not.toBeNull();
    expect(bytesMock, 'an expired tile reads nothing').not.toHaveBeenCalled();
    pinMock.mockResolvedValueOnce({ expiresAt: '2026-10-01T00:00:00.000Z', expiredAt: null, pinnedAt: PINNED_AT });
    await click(sheet().querySelector<HTMLButtonElement>('button.evidence-tile-pin')!);
    expect(sheet().querySelector('.evidence-tile-expired')).toBeNull();
    expect(sheet().querySelector('button.evidence-tile-pin')).toBeNull();
    expect(markOn('chromium-light-phone/old.png')).not.toBeNull();
    expect(bytesMock).toHaveBeenCalledWith('old');
  });

  it('has no pin on a file whose bytes have gone, nor on a row that went', async () => {
    serve(page([
      file('went', { pinnable: false, expiredAt: '2026-10-01T00:00:00.000Z' }),
      file('row', { name: null, gone: true, mimeType: null, sizeBytes: null, pinnable: false }),
    ]));
    const node = await mount(card());
    await openPage(node);
    expect(sheet().querySelectorAll('.evidence-tile-expired')).toHaveLength(2);
    expect(sheet().querySelector('.evidence-tile-pin')).toBeNull();
  });

  it('stops offering when a press is told the bytes went, and says so', async () => {
    const error = useToast().error as ReturnType<typeof vi.fn>;
    error.mockClear();
    serve(page([file('old', { pinnable: true, expiredAt: '2026-10-01T00:00:00.000Z' })]));
    const node = await mount(card());
    await openPage(node);
    pinMock.mockRejectedValueOnce(Object.assign(new Error('this file expired and its bytes have been deleted'), { status: 410 }));
    await click(sheet().querySelector<HTMLButtonElement>('button.evidence-tile-pin')!);
    expect(error).toHaveBeenCalledWith("Couldn't pin the file", 'this file expired and its bytes have been deleted');
    expect(sheet().querySelector('button.evidence-tile-pin')).toBeNull();
    expect(sheet().querySelector('.evidence-tile-expired')).not.toBeNull();
  });

  it('keeps the pin when a press fails any other way', async () => {
    const error = useToast().error as ReturnType<typeof vi.fn>;
    error.mockClear();
    serve(page([file('page', { name: 'notes/page.html', mimeType: 'text/html', pinnable: true, pinnedAt: PINNED_AT })]));
    const node = await mount(card());
    await openPage(node);
    pinMock.mockRejectedValueOnce(Object.assign(new Error('502'), { status: 502 }));
    await click(sheet().querySelector<HTMLButtonElement>('button.evidence-tile-pin')!);
    expect(error).toHaveBeenCalledWith("Couldn't unpin the file", '502');
    const pin = sheet().querySelector<HTMLButtonElement>('button.evidence-tile-pin')!;
    expect(pin.disabled).toBe(false);
    expect(pin.getAttribute('aria-label')).toBe('Unpin');
  });
});

describe('with the page open', () => {
  it('leaves Enter alone: the card behind it is suspended, and takes its keys back when it closes', async () => {
    const qc = client();
    const live = row();
    qc.setQueryData(pendingDecisionsQuery(SESSION_ID).queryKey, queue([live]));
    serve(page(), queue([live]));
    const node = await mount(
      <SessionEvidenceDecisionCard sessionId={SESSION_ID} projectId={PROJECT_ID} onSendBack={noop} />,
      qc,
    );
    const confirm = (): HTMLButtonElement => [...node.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith(DECISION_CONFIRM_ACTION))!;
    const enter = async (): Promise<void> => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      await settle();
    };
    expect(confirm().textContent, 'it holds the keys').toContain('Enter');
    await openPage(node);
    expect(confirm().textContent, 'and has let go of them').not.toContain('Enter');

    // Focus rests on the page, or on nothing: where a bare Enter belongs to the card.
    (document.activeElement as HTMLElement | null)?.blur();
    await enter();
    const posts = (): unknown[] => apiMock.mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === 'POST');
    expect(posts(), 'nothing went to the decision door').toEqual([]);

    await click(document.querySelector<HTMLButtonElement>('.orbit-overlay-close')!);
    await settle();
    expect(confirm().textContent, 'closed, the keys are back').toContain('Enter');
  });
});

describe('a receipt', () => {
  const decided: RecordedDecisionRow = {
    taskId: TASK_ID, title: 'P4.3 keyboard windows', projectId: PROJECT_ID, evidenceRevision: '2', decision: 'SEND_BACK',
    note: 'not yet', decidedAt: '2026-11-02T07:00:00.000Z', decidedByType: 'USER',
  };

  it('is where an older version’s files are seen, expired ones included', async () => {
    const qc = client();
    qc.setQueryData(taskEvidenceQuery(TASK_ID).queryKey, [{
      revision: '2', evidence: { claim: 'It matches.', gaps: [] }, citations: FILE_CITATIONS,
    }]);
    serve(page(FILES.map((each) => ({ ...each, expiredAt: '2026-12-02T12:00:00.000Z' }))));
    const node = await mount(<EvidenceDecisionReceipt decided={decided} />, qc);
    expect(area(node), 'folded, it asks for nothing').toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    await click([...node.querySelectorAll('button')].find((button) => button.textContent?.startsWith(DECISION_RECEIPT_OPEN))!);
    expect(area(node).querySelector('.evidence-files-head')?.textContent).toContain('EXPIRED DEC 2');
    expect(area(node).querySelector('.evidence-report-line')?.textContent).toContain('46 passed');
  });

  it('is unchanged for a version citing no file', async () => {
    const qc = client();
    qc.setQueryData(taskEvidenceQuery(TASK_ID).queryKey, [{ revision: '2', evidence: { claim: 'It matches.', gaps: [] }, citations: null }]);
    const node = await mount(<EvidenceDecisionReceipt decided={decided} />, qc);
    await click([...node.querySelectorAll('button')].find((button) => button.textContent?.startsWith(DECISION_RECEIPT_OPEN))!);
    expect(area(node)).toBeNull();
    expect(apiMock.mock.calls.map(([path]) => path)).not.toContain(FILES_ROUTE);
  });
});
