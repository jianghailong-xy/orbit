// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAttachmentObjectUrl } from '../api';
import { ExpiredAttachmentError } from '../lib/evidenceFiles';
import { saveUserFile } from '../lib/userFile';
import { AttachmentImage, type RunEvent, Transcript } from './Transcript';

/**
 * What a reply's file leaves behind once its bytes have gone (docs/orbit-files-design.md §2.8): a read answers 410, and the
 * conversation draws the grey tile an evidence card draws, in the card's words. Only that answer: anything else that goes wrong
 * with a read may come back, and stays what it has always been. Whether `fetchAttachmentObjectUrl` turns a 410 into this error
 * is asserted beside it, against a real `Response`.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchAttachmentObjectUrl: vi.fn(),
}));
vi.mock('../lib/userFile', async (original) => ({
  ...(await original<typeof import('../lib/userFile')>()),
  saveUserFile: vi.fn(),
}));

const read = vi.mocked(fetchAttachmentObjectUrl);
const saved = vi.mocked(saveUserFile);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  read.mockReset();
  saved.mockReset();
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function reply(text: string): Promise<void> {
  const events: RunEvent[] = [{ seq: 1, type: 'assistant', payload: { text }, ts: '2026-11-03T00:00:00.000Z' } as unknown as RunEvent];
  await act(async () => root.render(<MemoryRouter><Transcript events={events} /></MemoryRouter>));
  await settle();
}

const IMAGE = 'Here it is.\n\n![menu-open.png](orbit-attachment:pic)';
const FILE = 'Here it is.\n\n[report.html](orbit-attachment:doc "report.html")';

describe('a picture in a reply', () => {
  it('draws the grey tile with its date when the read says the bytes went', async () => {
    read.mockRejectedValue(new ExpiredAttachmentError('2026-09-14T12:00:00.000Z'));
    await reply(IMAGE);
    const tile = container.querySelector('.chat-expired')!;
    expect(tile.textContent).toBe('ExpiredSep 14');
    expect(tile.getAttribute('title')).toBe('menu-open.png');
    expect(container.querySelector('.md-image-loading'), 'no grey box beside it').toBeNull();
    expect(read, 'one read: a file that went does not come back by asking again').toHaveBeenCalledTimes(1);
  });

  it('draws it with no date from a server that does not say when', async () => {
    read.mockRejectedValue(new ExpiredAttachmentError(null));
    await reply(IMAGE);
    expect(container.querySelector('.chat-expired')?.textContent).toBe('Expired');
  });

  it.each(['attachment pic: 404', 'attachment pic: 500', 'file request timed out'])('stays the box it always was on “%s”', async (message) => {
    read.mockRejectedValue(new Error(message));
    await reply(IMAGE);
    expect(container.querySelector('.chat-expired')).toBeNull();
    expect(container.querySelector('.md-image-loading')).not.toBeNull();
  });

  it('draws the picture while the bytes remain, tombstone or not', async () => {
    read.mockResolvedValue('blob:test/pic');
    await reply(IMAGE);
    expect(container.querySelector('.chat-expired')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test/pic');
  });
});

describe('a file in a reply', () => {
  const chip = (): HTMLElement => container.querySelector<HTMLElement>('.chat-file')!;

  it('is the chip until it is pressed: nothing is read for it', async () => {
    await reply(FILE);
    expect(read).not.toHaveBeenCalled();
    expect(chip().tagName).toBe('BUTTON');
    expect(chip().className).not.toContain('is-expired');
  });

  it('becomes the placeholder when a press is told the bytes went, with nothing left to press', async () => {
    read.mockRejectedValue(new ExpiredAttachmentError('2026-09-14T12:00:00.000Z'));
    await reply(FILE);
    await act(async () => chip().click());
    await settle();
    expect(chip().tagName).toBe('SPAN');
    expect(chip().className).toContain('is-expired');
    expect(chip().textContent).toBe('report.html· Expired Sep 14');
    expect(saved).not.toHaveBeenCalled();
  });

  it('says only that from a server that does not say when', async () => {
    read.mockRejectedValue(new ExpiredAttachmentError(null));
    await reply(FILE);
    await act(async () => chip().click());
    await settle();
    expect(chip().textContent).toBe('report.html· Expired');
  });

  it('stays retryable on any other failure, and a retry that works saves it', async () => {
    read.mockRejectedValueOnce(new Error('attachment doc: 404'));
    await reply(FILE);
    await act(async () => chip().click());
    await settle();
    expect(chip().tagName).toBe('BUTTON');
    expect(chip().className).toContain('is-error');
    expect(chip().getAttribute('aria-label')).toBe('Retry download report.html');
    read.mockResolvedValueOnce('blob:test/doc');
    await act(async () => chip().click());
    await settle();
    expect(saved).toHaveBeenCalledWith('blob:test/doc', 'report.html');
  });
});

describe('what a person sent', () => {
  it('says so in the transcript, and a chip or a tray keeps its box: neither has room to', async () => {
    read.mockRejectedValue(new ExpiredAttachmentError('2026-09-14T12:00:00.000Z'));
    await act(async () => root.render(
      <MemoryRouter>
        <AttachmentImage id="a" />
        <AttachmentImage id="b" variant="chip" />
        <AttachmentImage id="c" variant="tray" />
      </MemoryRouter>,
    ));
    await settle();
    expect(container.querySelectorAll('.chat-expired')).toHaveLength(1);
    expect(container.querySelector('.composer-attach-thumb.chat-image-loading')).not.toBeNull();
    expect(container.querySelector('.pending-tray-thumb.chat-image-loading')).not.toBeNull();
  });
});
