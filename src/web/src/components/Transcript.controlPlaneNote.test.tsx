// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * told about, a list console's condition board, a promoted coordinator's standing role. Those
 * blocks say outright that the user did not say them, and all of them used to render as the
 * person's own words.
 *
 * The apiserver records the appended part beside the echo, as `controlPlaneNote`, when it stores
 * the event: it holds what the person actually wrote (the turn row), so where their words end is a
 * fact of the write rather than a guess about the text. Each block is checked from both sides. With
 * the note, the person's words stand alone and the block is one folded entry under them, in the
 * same bubble, named ⊕ Orbit attached: and the kind of block it is. Without it — someone who typed
 * those very characters — the bubble shows exactly what they typed and there is no entry, however
 * much it looks like a block.
 *
 * That holds for every block, a `#`-reference and a coordinator's role included: events stored
 * before notes were recorded had theirs backfilled, so none of them is read out of the text.
 */

const LABEL = '⊕ Orbit attached:';

// The shapes the server appends (background-jobs-context.ts, list-events.service.ts,
// coordinator-opening.ts, reference-expansion.ts).
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

const COORDINATOR = [
  '<orbit_project_coordinator_context>',
  '你是项目（id: 34HvVYzGmE4NFDMiomVgi）的协调会话。',
  '这里用来协调任务，不是替任务干活。',
  '</orbit_project_coordinator_context>',
].join('\n');

const REFERENCED_TASK = [
  '<referenced-task id="34MQb2AXbj3QAkZko92ob">',
  '  标题   回填历史 user 事件的 controlPlaneNote',
  '  状态   OPEN',
  '  所属   (无列表) · 负责 orbit',
  '  运行   共 1 次，其中执行过 turn 的 1 次；最近一次：RUNNING, 0 turns',
  '  详情请用 task_get 自取。',
  '</referenced-task>',
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

/** The entry's toggle, found by what it says rather than by how it is styled. */
function attachedToggle(): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(LABEL)) ?? null;
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * How every appended block must read once it is known to be Orbit's: last in the person's bubble,
 * under their words, named for its kind, folded until clicked, the block verbatim once open, and
 * folded again on a second click.
 */
async function expectFoldedEntry({ typed, block, kind, marker }: {
  typed: string;
  block: string;
  kind: string;
  marker: string;
}) {
  const toggle = attachedToggle();
  expect(toggle, `no entry signed ${LABEL}:\n${container.innerHTML}`).not.toBeNull();
  expect(toggle!.textContent).toBe(`${LABEL} ${kind}`);
  const entry = toggle!.parentElement!;
  expect(bubble().lastElementChild, 'the entry closes the person’s own bubble').toBe(entry);
  // Everything else the bubble says is exactly what the person typed.
  const words = () => (bubble().textContent ?? '').replace(entry.textContent ?? '', '').trim();
  expect(words()).toBe(typed);
  // Folded: the entry is named, but what the model read is not on the page until asked for.
  expect(toggle!.getAttribute('aria-expanded')).toBe('false');
  expect(container.textContent).not.toContain(marker);

  await click(toggle!);

  expect(toggle!.getAttribute('aria-expanded')).toBe('true');
  const original = [...entry.querySelectorAll('*')].find((el) => el.textContent === block);
  expect(original, `the opened entry does not show the block verbatim:\n${container.innerHTML}`).toBeTruthy();
  expect(words()).toBe(typed);

  await click(toggle!);

  expect(toggle!.getAttribute('aria-expanded')).toBe('false');
  expect(container.textContent).not.toContain(marker);
}

describe.each([
  { tag: '<background-jobs>', typed: '已经部署，请帮我测试', block: BACKGROUND_JOBS, kind: 'background jobs', marker: 'bgj_3a1af2b50428' },
  { tag: '<list-conditions>', typed: '这个列表现在什么情况？', block: LIST_CONDITIONS, kind: 'list conditions', marker: '累计 47 次' },
  { tag: '<orbit_project_coordinator_context>', typed: '把这个项目协调起来', block: COORDINATOR, kind: 'project coordinator context', marker: '的协调会话' },
  { tag: '<referenced-task>', typed: '这个任务现在什么状态？', block: REFERENCED_TASK, kind: 'referenced task', marker: '详情请用 task_get 自取' },
])('$tag', ({ typed, block, kind, marker }) => {
  it('with the note recorded: only the typed words are the bubble’s own, and the block is a folded entry under them that opens to its original text', async () => {
    const appended = `\n\n${block}`;
    await mount([userEvent(`${typed}${appended}`, appended)]);

    await expectFoldedEntry({ typed, block, kind, marker });
  });

  it('with no note: someone who typed the same characters sees them in their bubble as typed, and nothing is folded away', async () => {
    await mount([userEvent(`${typed}\n\n${block}`)]);

    const shown = bubble().textContent ?? '';
    expect(shown).toContain(typed);
    for (const line of block.split('\n')) expect(shown).toContain(line.trim());
    expect(attachedToggle()).toBeNull();
    expect(container.textContent).not.toContain('Orbit attached');
  });
});

describe('the exported transcript', () => {
  // lib/sessionExport's buildSessionHtml renders exactly this tree — ExportCtx around the app's own
  // <Transcript> — through renderToStaticMarkup, so the export has no user-bubble code of its own.
  // Rendered here rather than imported: that module inlines the stylesheet through Vite `?raw`
  // imports, which Vite refuses to serve from a node_modules linked in from outside the tree.
  it('is drawn by the same component, so the entry is in the bubble there too — and open, since a file has nothing to click', () => {
    const appended = `\n\n${BACKGROUND_JOBS}`;
    const html = renderToStaticMarkup(
      <ExportCtx.Provider value={{ images: new Map() }}>
        <div className="workspace-sessions">
          <Transcript events={[userEvent(`已经部署，请帮我测试${appended}`, appended)]} live={false} />
        </div>
      </ExportCtx.Provider>,
    );
    const exported = new DOMParser().parseFromString(html, 'text/html').querySelector('.chat-user');
    const toggle = [...(exported?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.startsWith(LABEL));

    expect(toggle?.textContent, `no entry signed ${LABEL} in the exported bubble:\n${html}`).toBe(`${LABEL} background jobs`);
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    expect([...exported!.querySelectorAll('*')].some((el) => el.textContent === BACKGROUND_JOBS)).toBe(true);
    expect(exported!.textContent!.replace(toggle!.parentElement!.textContent!, '').trim()).toBe('已经部署，请帮我测试');
  });
});

describe('the entry’s focus ring', () => {
  it('is drawn for keyboard focus alone (:focus-visible), so a click leaves no ring behind', async () => {
    const appended = `\n\n${BACKGROUND_JOBS}`;
    await mount([userEvent(`已经部署，请帮我测试${appended}`, appended)]);
    const toggle = attachedToggle();
    expect(toggle, `no entry signed ${LABEL}:\n${container.innerHTML}`).not.toBeNull();

    // Read as text: jsdom cannot tell focus that arrived by a click from focus that arrived by Tab,
    // so only the selector can say which of them draws. Every rule naming the toggle's class that
    // draws an outline or a shadow is collected, wherever in the stylesheet it sits.
    const found = ['src/index.css', 'src/web/src/index.css']
      .map((each) => resolve(process.cwd(), each))
      .find(existsSync);
    const css = readFileSync(found!, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    const names = new RegExp(`\\.${toggle!.className}(?![\\w-])`, 'u');
    const drawing = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, , body]) => /(?:^|;)\s*(?:outline(?:-style)?\s*:(?!\s*(?:none|0)\s*(?:;|$))|box-shadow\s*:)/u.test(body))
      .flatMap(([, selectors]) => selectors.split(',').map((selector) => selector.trim()))
      .filter((selector) => names.test(selector));

    expect(drawing).toEqual([`.${toggle!.className}:focus-visible`]);
  });
});
