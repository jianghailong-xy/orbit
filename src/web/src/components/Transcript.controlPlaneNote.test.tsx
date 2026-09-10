// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportCtx, type RunEvent, Transcript } from './Transcript';

/**
 * What delivery appended to a person's message must not be signed with their name.
 *
 * The runner echoes what it was handed, so a `user` event's text is the person's words followed by
 * whatever the control plane appended on the way out — the background work a returning engine is
 * told about, a list console's condition board. Both blocks say outright that the user did not say
 * them, and both used to render inside the user's own bubble.
 *
 * The apiserver records the appended part beside the echo, as `controlPlaneNote`, when it stores
 * the event: it holds what the person actually wrote (the turn row), so where their words end is a
 * fact of the write rather than a guess about the text. Each block is checked from both sides. With
 * the note, the bubble holds only the person's words and the block is a folded entry signed
 * 控制面附注. Without it — someone who typed those very characters — the bubble shows exactly what
 * they typed and nothing is folded away, however much it looks like a block.
 */

const LABEL = '控制面附注';

// The shapes the server appends (background-jobs-context.ts, list-events.service.ts).
const BACKGROUND_JOBS = [
  '<background-jobs>',
  '  你不在的时候结束了：',
  '    bgj_3a1af2b50428｜job｜bash /root/orbit/.claude/skills/upgrade/upgrade.sh 2>&1 | tail -60｜completed｜退出码 0｜输出 /root/.orbit/runs/01a07c80/bgj_3a1af2b50428.output',
  '  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。',
  '  用 mcp__orbit__bg_output 按 id 读输出，mcp__orbit__bg_list 取完整清单。',
  '</background-jobs>',
].join('\n');

const LIST_CONDITIONS = [
  '<list-conditions list="3Hq9fVbYmP2kQhZ8aNcW4x" title="FineWeb CC-MAIN-2025-26">',
  '  配额挡住派发｜12 个就绪任务被配额挡住｜首次 2026-08-15T03:11:00.000Z，最近 2026-08-15T04:07:00.000Z，累计 47 次',
  '  以上是控制面在你上次收到消息之后观察到的，不是用户说的。',
  '  需要更完整的现状用 tasklist_get / task_list 自取。',
  '</list-conditions>',
].join('\n');

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

/** A `user` event as ingest stores it: the runner's echo, and the note only when one was recorded. */
function userEvent(text: string, controlPlaneNote?: string): RunEvent {
  return {
    seq: 7,
    type: 'user',
    turnId: 'turn-1',
    ts: '2026-09-10T12:26:47.307Z',
    payload: controlPlaneNote === undefined ? { text } : { text, controlPlaneNote },
  };
}

async function mount(events: RunEvent[]) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Transcript events={events} />
      </MemoryRouter>,
    );
  });
}

function bubble(): Element {
  const el = container.querySelector('.chat-user');
  if (!el) throw new Error(`no user bubble was rendered:\n${container.innerHTML}`);
  return el;
}

/** The entry signed 控制面附注, found by what it says rather than by how it is styled. */
function noteToggle(): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(LABEL)) ?? null;
}

describe.each([
  { tag: '<background-jobs>', typed: '已经部署，请帮我测试', block: BACKGROUND_JOBS, marker: 'bgj_3a1af2b50428' },
  { tag: '<list-conditions>', typed: '这个列表现在什么情况？', block: LIST_CONDITIONS, marker: '累计 47 次' },
])('$tag', ({ typed, block, marker }) => {
  it('with the note recorded: only the typed words are in the bubble, and the block is a folded 控制面附注 that opens to its original text', async () => {
    const appended = `\n\n${block}`;
    await mount([userEvent(`${typed}${appended}`, appended)]);

    expect(bubble().textContent?.trim()).toBe(typed);

    const toggle = noteToggle();
    expect(toggle, `no entry signed ${LABEL}:\n${container.innerHTML}`).not.toBeNull();
    expect(toggle!.closest('.chat-user'), 'the note sits inside the person’s bubble').toBeNull();
    // Folded: the entry is named, but what the model read is not on the page until asked for.
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain(marker);

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    const original = [...container.querySelectorAll('*')].find((el) => el.textContent === block);
    expect(original, `the opened note does not show the block verbatim:\n${container.innerHTML}`).toBeTruthy();
    expect(bubble().textContent?.trim()).toBe(typed);
  });

  it('with no note: someone who typed the same characters sees them in their bubble as typed, and nothing is folded away', async () => {
    await mount([userEvent(`${typed}\n\n${block}`)]);

    const shown = bubble().textContent ?? '';
    expect(shown).toContain(typed);
    for (const line of block.split('\n')) expect(shown).toContain(line.trim());
    expect(noteToggle()).toBeNull();
    expect(container.textContent).not.toContain(LABEL);
  });
});

describe('the exported transcript', () => {
  // lib/sessionExport's buildSessionHtml renders exactly this tree — ExportCtx around the app's own
  // <Transcript> — through renderToStaticMarkup, so the export has no user-bubble code of its own.
  // Rendered here rather than imported: that module inlines the stylesheet through Vite `?raw`
  // imports, which Vite refuses to serve from a node_modules linked in from outside the tree.
  it('is drawn by the same component, so the note is out of the bubble there too — and open, since a file has nothing to click', () => {
    const appended = `\n\n${BACKGROUND_JOBS}`;
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <div className="workspace-sessions">
          <Transcript events={[userEvent(`已经部署，请帮我测试${appended}`, appended)]} live={false} />
        </div>
      </ExportCtx.Provider>,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');

    expect(doc.querySelector('.chat-user')?.textContent?.trim()).toBe('已经部署，请帮我测试');
    expect(doc.body.textContent).toContain(LABEL);
    expect([...doc.body.querySelectorAll('*')].some((el) => el.textContent === BACKGROUND_JOBS)).toBe(true);
  });
});
