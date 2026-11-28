// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAttachmentObjectUrl, fetchSessionArtifactObjectUrl } from '../api';
import { type RunEvent, Transcript } from './Transcript';
import { hoverTooltip } from '../test/tooltipHover';

/**
 * A reply that links a file by the path it wrote it to — the mock an agent drew, most of the time.
 * Nothing rendered it: the path is on the runner, behind a bearer-guarded API, so the reader got a
 * paperclip and a file name with no way to reach the bytes.
 *
 * The session's own directories are the exception, and there are two of them: the uploads scratch
 * older sessions wrote into, and the checkout an agent works in now. Those come back through the
 * artifact route (the runner reads the file on demand), and what arrives decides how it is drawn:
 *
 *  - a path that names an image is fetched when the row appears and drawn as a picture, because a
 *    reader who linked a picture meant to show one (including older ordinary `[label](path)` links);
 *  - anything else stays the chip web has always drawn, which downloads it on click;
 *  - a fetch that fails — a checkout GC'd since, a runner that is gone — leaves that chip too.
 *
 * A path outside those directories can never be served at all, and stays a label.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchAttachmentObjectUrl: vi.fn(),
  fetchSessionArtifactObjectUrl: vi.fn(),
}));

const SESSION = '01a0c992-61c0-727a-bbbb-d985dd45d0e0';
// The shapes that turn up in real replies: the agent's mock, and a scratch file.
const UPLOADS_IMAGE = `/root/.orbit/uploads/${SESSION}/claude-title-slot-1-diagnosis-and-A.png`;
const CHECKOUT_IMAGE = `/root/.orbit/worktrees/${SESSION}/docs/mocks/card-surface-desktop-phone.png`;
const CHECKOUT_SOURCE = `/root/.orbit/worktrees/${SESSION}/src/web/src/components/ProjectBlockers.tsx:106`;
const CHECKOUT_SOURCE_PATH = `/root/.orbit/worktrees/${SESSION}/src/web/src/components/ProjectBlockers.tsx`;
const SCRATCH_FILE = `/root/.orbit/uploads/${SESSION}/drill/out.json`;

const resolve = vi.mocked(fetchSessionArtifactObjectUrl);
const resolveAttachment = vi.mocked(fetchAttachmentObjectUrl);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resolve.mockReset();
  resolveAttachment.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** One assistant reply, rendered in a session view (which is what provides the artifact route). */
async function renderReply(text: string) {
  const event: RunEvent = { seq: 3, type: 'assistant', turnId: 'turn-1', ts: '2026-09-22T12:00:00.000Z', payload: { text } };
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Transcript events={[event]} artifactSessionId={SESSION} />
      </MemoryRouter>,
    );
  });
  // Let a fetch that the render kicked off settle.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('a path in the session’s own directories', () => {
  it('draws an image, fetched from the uploads scratch', async () => {
    resolve.mockResolvedValue('blob:mock-image');
    await renderReply(`![现状与 A 案](${UPLOADS_IMAGE})\n`);
    expect(resolve).toHaveBeenCalledWith(SESSION, UPLOADS_IMAGE);
    const img = container.querySelector('img.md-image');
    expect(img?.getAttribute('src')).toBe('blob:mock-image');
    expect(img?.getAttribute('alt')).toBe('现状与 A 案');
    expect(container.querySelector('button.chat-file')).toBeNull();
  });

  it('draws an image from the checkout the agent works in', async () => {
    resolve.mockResolvedValue('blob:mock-image');
    await renderReply(`画了四格。\n\n![卡在聊天区怎么出现：桌面 / iPhone](${CHECKOUT_IMAGE})\n`);
    expect(container.querySelector('img.md-image')).not.toBeNull();
  });

  // A reply names a file the way the agent worked with it: relative to the checkout. The runner
  // uploads one it can, but a reply whose upload was lost keeps the path — and the artifact route
  // reads it back from that same checkout.
  it('draws an image named relative to the checkout', async () => {
    resolve.mockResolvedValue('blob:mock-image');
    await renderReply('![成稿态](docs/ppt-design/design/2026-11-06-studio-v2-prototype/screens/done.png)\n');
    expect(resolve).toHaveBeenCalledWith(
      SESSION,
      'docs/ppt-design/design/2026-11-06-studio-v2-prototype/screens/done.png',
    );
    expect(container.querySelector('img.md-image')?.getAttribute('src')).toBe('blob:mock-image');
    expect(container.querySelector('button.chat-file')).toBeNull();
  });

  it('falls back to the chip when a checkout-relative image is gone', async () => {
    resolve.mockRejectedValue(new Error('artifact not found'));
    await renderReply('![成稿态](docs/mocks/gone.png)\n');
    expect(resolve).toHaveBeenCalledWith(SESSION, 'docs/mocks/gone.png');
    expect(container.querySelector('img.md-image')).toBeNull();
    expect(container.querySelector('button.chat-file')).not.toBeNull();
  });

  it('leaves a remote image as the picture it is', async () => {
    await renderReply('![logo](https://example.com/logo.png)\n');
    expect(resolve).not.toHaveBeenCalled();
    expect(container.querySelector('img.md-image')?.getAttribute('src')).toBe('https://example.com/logo.png');
  });

  it('also previews an older ordinary link when its path is an image', async () => {
    resolve.mockResolvedValue('blob:mock-image');
    await renderReply(`[Blocker 卡片](${UPLOADS_IMAGE})\n`);
    expect(resolve).toHaveBeenCalledWith(SESSION, UPLOADS_IMAGE);
    expect(container.querySelector('img.md-image')?.getAttribute('alt')).toBe('Blocker 卡片');
    expect(container.querySelector('button.chat-file')).toBeNull();
  });

  it('leaves anything that is not an image as the chip that downloads it', async () => {
    await renderReply(`[运行记录](${SCRATCH_FILE})\n`);
    expect(resolve).not.toHaveBeenCalled(); // nothing is fetched until it is clicked
    const button = container.querySelector('button.chat-file');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Download out.json');
  });

  it('removes a source line suffix before requesting a local file', async () => {
    resolve.mockResolvedValue('blob:mock-file');
    await renderReply(`[Automatic blocker 通知](${CHECKOUT_SOURCE})\n`);
    const button = container.querySelector<HTMLButtonElement>('button.chat-file');
    expect(button?.getAttribute('aria-label')).toBe('Download ProjectBlockers.tsx');

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledWith(SESSION, CHECKOUT_SOURCE_PATH);
  });

  it('falls back to that chip when the image cannot be fetched', async () => {
    resolve.mockRejectedValue(new Error('artifact not found'));
    await renderReply(`![现状与 A 案](${UPLOADS_IMAGE})\n`);
    expect(resolve).toHaveBeenCalled();
    expect(container.querySelector('img.md-image')).toBeNull();
    expect(container.querySelector('button.chat-file')).not.toBeNull();
  });

  it('shows a retry state when a file download fails instead of swallowing the click', async () => {
    resolve.mockRejectedValue(new Error('artifact not found'));
    await renderReply(`[migration.sql](${SCRATCH_FILE})\n`);
    const button = container.querySelector<HTMLButtonElement>('button.chat-file');
    expect(button?.dataset.downloadState).toBe('idle');

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    const failed = container.querySelector<HTMLButtonElement>('button.chat-file');
    expect(failed?.dataset.downloadState).toBe('error');
    expect(failed?.classList.contains('is-error')).toBe(true);
    expect(failed?.getAttribute('aria-label')).toBe('Retry download out.json');
  });

  it('shows the same retry state for a sent attachment', async () => {
    resolveAttachment.mockRejectedValue(new Error('attachment not found'));
    await renderReply('[migration.sql](orbit-attachment:01a0c992-61c0-727a-bbbb-d985dd45d0e0 "migration.sql")\n');
    const button = container.querySelector<HTMLButtonElement>('button.chat-file');
    expect(button?.dataset.downloadState).toBe('idle');

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLButtonElement>('button.chat-file')?.dataset.downloadState).toBe('error');
    expect(resolveAttachment).toHaveBeenCalledWith('01a0c992-61c0-727a-bbbb-d985dd45d0e0');
  });

  it('leaves a path outside them inert', async () => {
    await renderReply('![secret](/root/notes/card.png)\n');
    expect(resolve).not.toHaveBeenCalled();
    expect(container.querySelector('button.chat-file')).toBeNull();
    expect(container.querySelector('img.md-image')).toBeNull();
    expect(container.querySelector('.md-image-unavailable')?.textContent).toContain('card.png');
  });

  // A Mac runner's temp files, as the agent names them: `/tmp` resolved to `/private/tmp`, and
  // `$TMPDIR` under `/var/folders`. These were ordinary links, and a click opened the console on a
  // page that does not exist.
  it.each([
    '/private/tmp/ppt-nev-eight-20261029/renderer/contact-sheet.png',
    '/var/folders/x1/abc123/T/tmp.q8/contact-sheet.png',
  ])('leaves a Mac temp file inert rather than a link into the app: %s', async (path) => {
    await renderReply(`[本地成稿截图总览](${path})\n`);
    expect(resolve).not.toHaveBeenCalled();
    expect(container.querySelector('a')).toBeNull();
    const chip = container.querySelector('.md-image-unavailable');
    expect(chip?.textContent).toContain('contact-sheet.png');
    expect(await hoverTooltip(chip!)).toBe(path);
  });
});

/**
 * An HTML file a reply links is an agent's mock board, made to be looked at. A relative link to one
 * (`docs/mocks/x/board.html`, a reply whose upload was lost) used to be an ordinary link that opened
 * a page of the app that does not exist; an attached one downloaded. Both open a sandboxed preview.
 */
describe('an HTML file', () => {
  const PAGE = '<!doctype html><h1>Task link card</h1>';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PAGE)));
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openPreview(): Promise<HTMLIFrameElement | null> {
    const chip = container.querySelector<HTMLButtonElement>('button.chat-file');
    expect(chip?.getAttribute('aria-label')).toBe('Preview board.html');
    await act(async () => {
      chip?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    return document.querySelector<HTMLIFrameElement>('iframe.chat-html-preview-page');
  }

  it('named relative to the checkout opens in a sandboxed preview, not a link into the app', async () => {
    resolve.mockResolvedValue('blob:board');
    await renderReply('The HTML source is [board.html](docs/mocks/task-link-card/board.html).\n');
    expect(container.querySelector('a')).toBeNull();
    expect(resolve).not.toHaveBeenCalled(); // read when opened
    const frame = await openPreview();
    expect(resolve).toHaveBeenCalledWith(SESSION, 'docs/mocks/task-link-card/board.html');
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toBe(PAGE);
  });

  it('attached to the reply opens in the same preview instead of downloading', async () => {
    resolveAttachment.mockResolvedValue('blob:board');
    await renderReply('[board.html](orbit-attachment:01a0c992-61c0-727a-bbbb-d985dd45d0e0 "board.html")\n');
    const frame = await openPreview();
    expect(resolveAttachment).toHaveBeenCalledWith('01a0c992-61c0-727a-bbbb-d985dd45d0e0');
    expect(frame?.getAttribute('srcdoc')).toBe(PAGE);
  });
});

/**
 * Any other file a reply links relative to the checkout was an ordinary link too, and opened a page of
 * the app that does not exist. It is the file now: a picture drawn, anything else the chip that
 * downloads it. What cannot be a checkout file stays the link it was.
 */
describe('a file named relative to the checkout', () => {
  it('becomes the chip that downloads it', async () => {
    resolve.mockResolvedValue('blob:notes');
    await renderReply('Notes are in [the README](docs/mocks/task-link-card/README.md).\n');
    expect(container.querySelector('a')).toBeNull();
    const chip = container.querySelector<HTMLButtonElement>('button.chat-file');
    expect(chip?.getAttribute('aria-label')).toBe('Download README.md');
    expect(chip?.textContent).toBe('the README');
    await act(async () => {
      chip?.click();
      await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledWith(SESSION, 'docs/mocks/task-link-card/README.md');
  });

  it.each([
    ['src/web/src/App.tsx:42', 'src/web/src/App.tsx'],
    ['./scripts/run.sh', 'scripts/run.sh'],
    ['package.json', 'package.json'],
  ])('asks for %s as %s', async (href, path) => {
    resolve.mockResolvedValue('blob:file');
    await renderReply(`See [this](${href}).\n`);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.chat-file')?.click();
      await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledWith(SESSION, path);
  });

  it('draws a picture an ordinary link names', async () => {
    resolve.mockResolvedValue('blob:mock-image');
    await renderReply('[the board](docs/mocks/task-link-card/board.png)\n');
    expect(resolve).toHaveBeenCalledWith(SESSION, 'docs/mocks/task-link-card/board.png');
    expect(container.querySelector('img.md-image')?.getAttribute('alt')).toBe('the board');
  });

  it.each(['../other/notes.md', 'docs/guide', '#setup', 'https://example.com/a.md', '/settings/profile.json'])(
    'leaves %s the link it was',
    async (href) => {
      await renderReply(`See [this](${href}).\n`);
      expect(container.querySelector('button.chat-file')).toBeNull();
      expect(container.querySelector('a')).not.toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});
