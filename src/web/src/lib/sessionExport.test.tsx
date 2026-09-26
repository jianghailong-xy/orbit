// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenItemDeliveryCard as Delivery, TaskStartCard as StartCard } from '@orbit/shared';
import type { PublicLinkResolver, RunEvent } from '../components/Transcript';
import { encodeId } from './idCodec';
import { exportSessionHtml, type ExportSession } from './sessionExport';
import { TASK_START_LABEL, TASK_START_OPEN_TASK } from './taskStartCard';

// The export inlines two stylesheets through vite's `?raw`, and one of them lives in node_modules —
// which in a worktree is linked into the main checkout (scripts/worktree-overlay.sh), outside vite's
// allow list, where that transform is refused as "Denied ID". What it holds is not what this file is
// about, and the export under test is the real one.
vi.mock('highlight.js/styles/github.css?raw', () => ({ default: '' }));

/**
 * Download HTML, on a session shared through `/s/<token>`.
 *
 * The file is built by rendering the very same `<Transcript>` the app shows, through
 * `renderToStaticMarkup` — which builds a render tree of its own, so the router the page is sitting
 * under is NOT in it. Anything the transcript drew as a react-router `<Link>` therefore had nothing
 * to route with and threw ("Cannot destructure property 'basename'"), so a session that named a task
 * (`orbit-task:<id>`), started one, or delivered an exception item about one exported as nothing at
 * all: the page could only say "Download failed".
 *
 * Two things are held here, and they are different. The export does not throw — each case below is
 * one of the three shapes that used to take it down. And every link it leaves behind is a whole URL,
 * which is not a cosmetic difference: the file is opened from disk, offline, where the router's own
 * path (`/tasks/<id>`) resolves against the filesystem and goes nowhere. Saved from the public page,
 * the file links no further than that page does (its PublicLinkResolver): the rest are words.
 */

const ORIGIN = window.location.origin;

/** The ids as a client holds them. The reference below carries the older spelling on purpose: what a
 *  transcript stores is whatever the runner wrote at the time, and both are normalized on the way
 *  into a route. */
const TASK = '01a0cca7-8609-70ed-a0e2-d4b55b832b60';
const PROJECT = '01a0cca0-aeaa-7618-bd5a-caccc089108c';
const CONFLICTED_TASK = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e';
const FAILED_SESSION = '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f';

const SESSION: ExportSession = {
  id: '34ToZJmiOG8Ym1MR6ingQ',
  title: '应用内 Orbit 链接 → 实时卡片',
  status: 'AWAITING_INPUT',
  createdAt: '2026-09-23T13:59:36.399Z',
  startedAt: '2026-09-23T13:59:36.399Z',
  workspace: { name: 'orbit' },
};

/** 1. A reply that names a task — the `[title](orbit-task:<id>)` reference an agent writes. */
const REFERENCE: RunEvent = {
  seq: 1,
  type: 'assistant',
  turnId: 'turn-1',
  ts: '2026-09-21T12:26:47.307Z',
  payload: { text: `已开单：[Fix the login redirect](orbit-task:${TASK})，等它落地。` },
};

/** 2. The turn that starts a task's run: the brief the agent was handed, with the task the control
 *  plane recorded beside it (lib/taskStartCard). */
const TASK_START: StartCard = {
  taskId: TASK,
  title: 'runner + web：配额按账户归属',
  description: '让每个账户的 plan usage 只进它自己那一行。',
  acceptanceCriteria: '配额按账户归属：每个账户的 plan usage 只进它自己那一行。',
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: "{ out=$(env -u ORBIT_SESSION_ID go test -C src/runner-go -count=1 ./... 2>&1); }",
  acceptanceExpectedExitCode: 0,
  listInstructions: null,
  project: { id: PROJECT, title: 'Codex 多账户：一台机器上登录多个 Codex' },
  auto: true,
};

const STARTED: RunEvent = {
  seq: 2,
  type: 'user',
  turnId: 'turn-2',
  ts: '2026-09-21T12:27:03.000Z',
  payload: {
    text: `请开始执行任务「${TASK_START.title}」。\n\n任务描述：\n${TASK_START.description}`,
    taskStart: TASK_START,
  },
};

/** 3. An exception item delivered to the coordinator: the paragraph written for the agent, with the
 *  item the control plane recorded beside it (lib/openItemDelivery). */
const DELIVERY: Delivery = {
  itemId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d',
  kind: 'INTEGRATION_CONFLICT',
  title: 'Merge conflict: 回填历史 user 事件的 controlPlaneNote',
  task: {
    id: CONFLICTED_TASK,
    title: '回填历史 user 事件的 controlPlaneNote',
    sessionId: FAILED_SESSION,
  },
  files: [
    'src/web/src/components/Transcript.tsx',
    'src/apiserver/src/projects/coordinator-delivery.service.ts',
    'src/web/src/lib/deliveredMessage.ts',
    'docs/project-integration-line-contract.md',
  ],
  targetRef: 'refs/heads/project/34Tq39ByZ0rV4c6pJkfw7',
  check: null,
  errorCode: null,
  failure: null,
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  landing: { receipts: 0, state: 'NOT_KNOWN', upstream: 'main', integration: 'main' },
};

const DELIVERED: RunEvent = {
  seq: 3,
  type: 'user',
  turnId: 'turn-3',
  ts: '2026-09-21T12:31:10.000Z',
  payload: {
    text: `【例外待办】Merge conflict: ${DELIVERY.title}\n\n冲突的文件（4 个）：\n- ${DELIVERY.files[0]}`,
    openItemDelivery: DELIVERY,
  },
};

let blobs: Blob[];

beforeEach(() => {
  blobs = [];
  // jsdom implements neither half of the download step: it has no object URLs, and following a link
  // would be a navigation it does not do. Both are observed instead — what is under test is the file
  // the export builds, not the browser's part in saving it.
  URL.createObjectURL = (blob: Blob): string => {
    blobs.push(blob);
    return 'blob:orbit-export';
  };
  URL.revokeObjectURL = (): void => {};
  vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Export these events, and read the file back. The shared page's Download HTML button passes its
 *  link resolver too (SharedSessionPage). */
async function exported(events: RunEvent[], linkResolver: PublicLinkResolver | null = null): Promise<string> {
  // The shared page passes the token-scoped attachment fetcher here; these transcripts carry no
  // images, so nothing is ever asked of it.
  await exportSessionHtml(SESSION, events, async () => 'data:image/png;base64,', linkResolver);
  expect(blobs, 'the export produced no file').toHaveLength(1);
  return blobs[0].text();
}

/** Every link in the exported transcript, as a browser opening that file would read it. */
function bodyLinks(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('.orbit-export .workspace-sessions a[href]')].map(
    (a) => a.getAttribute('href') ?? '',
  );
}

describe('exporting a session that names Orbit objects', () => {
  it('leaves a reply’s `orbit-task:` reference as a link to the whole URL', async () => {
    const html = await exported([REFERENCE]);

    expect(bodyLinks(html)).toContain(`${ORIGIN}/tasks/${encodeId(TASK)}`);
    // The reference reads as its title, the way it does in the app — not as bare markdown.
    expect(html).toContain('>Fix the login redirect</a>');
  });

  it('links a task-start card’s task and project by URL', async () => {
    const html = await exported([STARTED]);

    const links = bodyLinks(html);
    expect(links).toContain(`${ORIGIN}/tasks/${encodeId(TASK)}`);
    expect(links).toContain(`${ORIGIN}/projects/${encodeId(PROJECT)}`);
    // The turn exported is the card, not the brief as a message: the card's own head is on the page,
    // and its way into the task survives beside the links above.
    expect(html).toContain(TASK_START_LABEL);
    expect(html).toContain(TASK_START_OPEN_TASK);
  });

  it('links an exception item’s task and failed session by URL', async () => {
    const html = await exported([DELIVERED]);

    const links = bodyLinks(html);
    expect(links).toContain(`${ORIGIN}/tasks/${encodeId(CONFLICTED_TASK)}`);
    expect(links).toContain(`${ORIGIN}/sessions/${encodeId(FAILED_SESSION)}`);
    expect(html).toContain('Open the failed session ↗');
  });

  it('saved from a session link, leaves each of those links its words and no address', async () => {
    // A session link shares nothing the session names, so its resolver answers null for all of it.
    const html = await exported([REFERENCE, STARTED, DELIVERED], () => null);

    expect(bodyLinks(html)).toEqual([]);
    expect(html).toContain('Fix the login redirect');
    expect(html).toContain(TASK_START.project!.title);
    expect(html).toContain(TASK_START_OPEN_TASK);
    expect(html).toContain('Open the failed session ↗');
  });
});
