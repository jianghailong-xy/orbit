// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';

/**
 * A reply that links a file by the path it wrote it to — the mock an agent drew, most of the time.
 * Nothing rendered it: the path is on the runner, behind a bearer-guarded API, so the reader got a
 * paperclip and a file name with no way to reach the bytes.
 *
 * The session's own directories are the exception, and there are two of them: the uploads scratch
 * older sessions wrote into, and the checkout an agent works in now. For those the transcript
 * offers the file through the artifact route — the bytes come back from the runner on demand, which
 * is also what lets a path from an older reply (or one the runner did not upload) still open.
 *
 * Anything else stays a chip: a path outside the session's directories can never be served, and a
 * button that always failed would be worse than the label it is.
 */

const SESSION = '01a0c8ed-3b0b-742c-a7ee-93f0de502852';
const CHECKOUT = `/root/.orbit/worktrees/${SESSION}/docs/mocks/card-surface-desktop-phone.png`;
const SCRATCH = `/root/.orbit/uploads/${SESSION}/drill/out.json`;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
}

describe('a path in the session’s own directories', () => {
  it('is offered as a download, from the checkout the agent works in', async () => {
    await renderReply(`画了四格。\n\n![卡在聊天区怎么出现：桌面 / iPhone](${CHECKOUT})\n`);
    const button = container.querySelector('button.chat-file');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('title')).toBe('Download card-surface-desktop-phone.png');
    expect(button?.textContent).toContain('card-surface-desktop-phone.png');
    expect(container.querySelector('.md-image-unavailable')).toBeNull();
  });

  it('is offered as a download, from the uploads scratch', async () => {
    await renderReply(`[运行记录](${SCRATCH})\n`);
    const button = container.querySelector('button.chat-file');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('title')).toBe('Download out.json');
  });

  it('leaves a path outside them inert', async () => {
    await renderReply('![secret](/root/notes/card.png)\n');
    expect(container.querySelector('button.chat-file')).toBeNull();
    expect(container.querySelector('.md-image-unavailable')?.textContent).toContain('card.png');
  });
});
