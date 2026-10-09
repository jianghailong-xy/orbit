// @vitest-environment jsdom
// Scratch probe (copied into a tree, run, removed): the session export's file for a transcript with this
// batch's review-turn cards, built by the real buildSessionHtml (the lazy sessionExport module) on this
// tree. Writes the file for both themes to EXPORT_OUT, and what a review-request turn does to the export.
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { RunEvent } from '../components/Transcript';
import { buildSessionHtml, type ExportSession } from './sessionExport';

// The highlight.js theme is read through `?raw` from node_modules, which a scratch tree links from the
// task's worktree, outside vite's allow list: the same text is read here instead.
// vitest hands CSS imports over as empty strings (its `css` option), `?raw` included; the file the
// production build inlines is this tree's index.css, read as text.
vi.mock('../index.css?raw', async () => {
  const { readFileSync } = await import('node:fs');
  return { default: readFileSync(process.env.INDEX_CSS as string, 'utf8') };
});
vi.mock('highlight.js/styles/github.css?raw', async () => {
  const { readFileSync } = await import('node:fs');
  return { default: readFileSync(process.env.HLJS_CSS as string, 'utf8') };
});

const SESSION: ExportSession = {
  id: '34blYpxEcHMAf4oafuC2W', title: 'P4.3b export probe', status: 'AWAITING_INPUT',
  createdAt: '2026-09-28T11:40:00.000Z', startedAt: '2026-09-28T11:40:00.000Z', workspace: { name: 'orbit' },
};
const REPLY: RunEvent = {
  seq: 1, type: 'assistant', turnId: 't1', ts: '2026-09-28T11:41:00.000Z',
  payload: { text: 'Submitted the evidence for review:\n\n- the dependency graphs\n- the decision cards\n\n```ts\nconst checked = true;\n```' },
};
const RETURNED: RunEvent = {
  seq: 2, type: 'user', turnId: 't2', ts: '2026-09-28T11:42:00.000Z',
  payload: {
    text: '[Orbit] The confirmation reviewer sent the report back.',
    confirmationReturn: {
      requestId: 'req-1', recordId: 'rec-1', reviewerSessionId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f',
      reviewerTitle: 'Confirmation review: P4.3b', reason: 'The phone layout of the start dialog is not shown.',
      problems: [{ key: 'p1', text: 'No phone screenshot of the start dialog.' }, { key: 'p2', text: 'The merge check log is missing.' }],
    },
  },
};
const REQUESTED: RunEvent = {
  seq: 3, type: 'user', turnId: 't3', ts: '2026-09-28T11:43:00.000Z',
  payload: {
    text: '[Orbit] A confirmation review was requested.',
    confirmationReviewRequest: {
      requestId: 'req-2', reviewId: 'rev-2', taskId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60', title: 'P4.3b 迁移依赖图与业务决策卡片',
      runSessionId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e', branch: 'orbit/p4-3b', sha: 'd1a3f6f7b', dueAt: '2026-09-29T11:40:00.000Z',
    },
  },
};

it('exports a returned review, both themes', () => {
  const out = process.env.EXPORT_OUT as string;
  mkdirSync(out, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const html = buildSessionHtml(SESSION, [REPLY, RETURNED], new Map(), theme);
    expect(html).toContain('crc is-returned');
    writeFileSync(`${out}/returned-${theme}.html`, html);
  }
});

it('exports a requested review, or says why not', () => {
  let outcome = 'exported';
  try {
    const html = buildSessionHtml(SESSION, [REPLY, REQUESTED], new Map(), 'light');
    writeFileSync(`${process.env.EXPORT_OUT}/requested-light.html`, html);
  } catch (error) {
    outcome = `threw: ${(error as Error).message}`;
  }
  writeFileSync(`${process.env.EXPORT_OUT}/requested-outcome.txt`, `${outcome}\n`);
});
