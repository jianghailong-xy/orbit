/**
 * A wiki document as a public link shows it (public-wiki.ts `publicWikiDoc`): what is kept of the
 * owner's view, what is left out, and how the footnotes are numbered once it is. The owner's view here
 * carries a value in every field a visitor must never read — a commit, a record's id and its session,
 * task and project, the entry a quote came through, the model, a withdrawn sentence, a merge receipt's
 * and an owner decision's words — and the answer is searched for each. public-wiki.pg.spec.ts holds the
 * same over HTTP, against documents in a real database.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WikiDocFootnoteView, WikiDocSentenceView, WikiDocView } from '@orbit/shared';
import { publicWikiDoc, wikiSpaceName } from './public-wiki';

const SHA = 'f3c9a1b2d4e5f60718293a4b5c6d7e8f90a1b2c3';
const SECRETS = {
  commit: SHA,
  record: '0199aaaa-1111-7222-8333-444455556666',
  session: '0199bbbb-1111-7222-8333-444455556666',
  sessionTitle: 'Secret session title',
  task: '0199cccc-1111-7222-8333-444455556666',
  taskTitle: 'Secret task title',
  project: '0199dddd-1111-7222-8333-444455556666',
  projectTitle: 'Secret project title',
  entry: '0199eeee-1111-7222-8333-444455556666',
  model: 'claude-secret-model',
  withdrawn: 'A withdrawn claim the wiki no longer stands behind.',
  receipt: 'merged 1a2b3c4 into main with --no-ff',
  decision: 'Blocked until the owner pays the invoice.',
  receiptLabel: 'MERGED_CLEAN',
  decisionLabel: 'OWNER_DECISION_KIND',
  disposition: 'a disposition nobody reads',
};

function note(over: Partial<WikiDocFootnoteView> & Pick<WikiDocFootnoteView, 'n' | 'kind'>): WikiDocFootnoteView {
  return {
    verdict: 'verified',
    checkedBy: 'server',
    quote: 'quoted words',
    location: `turn:${SECRETS.record}#c0-12`,
    path: null,
    sha: null,
    lineStart: null,
    lineEnd: null,
    section: null,
    symbol: null,
    excerpt: null,
    recordId: SECRETS.record,
    charStart: 0,
    charEnd: 12,
    sessionId: SECRETS.session,
    sessionTitle: SECRETS.sessionTitle,
    seq: 4,
    at: '2026-09-30T08:00:00.000Z',
    label: null,
    taskId: SECRETS.task,
    taskTitle: SECRETS.taskTitle,
    projectId: SECRETS.project,
    projectTitle: SECRETS.projectTitle,
    notePath: null,
    viaEntryId: SECRETS.entry,
    ...over,
  };
}

function sentence(text: string, notes: number[], status: WikiDocSentenceView['status'] = 'sourced'): WikiDocSentenceView {
  return {
    text,
    status,
    notes,
    newTokens: [],
    withdrawn: status === 'withdrawn' ? { reason: 'retired', entryId: SECRETS.entry, path: null, at: '2026-10-01T00:00:00.000Z' } : null,
  };
}

const section = {
  stale: false,
  staleAt: null,
  generatedAt: '2026-10-01T00:00:00.000Z',
  repoSha: SECRETS.commit,
  model: SECRETS.model,
  dispositions: [{ material: 'S1', kind: 'turn' as const, ref: SECRETS.record, action: 'drop' as const, into: null, reason: SECRETS.disposition }],
};

const VIEW: WikiDocView = {
  spaceId: '0199ffff-1111-7222-8333-444455556666',
  slug: 'session-runtime',
  number: '1.1',
  title: 'Session runtime',
  question: 'How does a session run?',
  audience: ['Someone new to the runner'],
  scopeIn: ['The run loop'],
  scopeOut: [
    { text: 'Storage', docs: [{ slug: 'storage', number: '1.2', title: 'Storage' }] },
    { text: 'Later', docs: [{ slug: 'later', number: '2.1', title: 'Later' }, { slug: 'gone', number: null, title: null }] },
  ],
  category: { key: 'runtime', number: 1, title: 'Runtime' },
  length: { min: 100, max: 2000 },
  planVersion: 3,
  written: true,
  status: 'needs_review',
  writtenFromPlanVersion: 2,
  repoSha: SECRETS.commit,
  updatedAt: '2026-10-01T00:00:00.000Z',
  counts: { sentences: 6, sourced: 4, transition: 0, unsourced: 1, unverified: 0, withdrawn: 2 },
  unsourcedShare: 0.2,
  sections: [
    {
      ...section,
      key: 'loop',
      number: 1,
      title: 'The loop',
      kind: 'flow',
      written: true,
      blocks: [
        { kind: 'heading', text: 'How it starts', sentences: [] },
        {
          kind: 'paragraph',
          text: null,
          sentences: [
            sentence('A session claims a turn.', [1, 2]),
            sentence(SECRETS.withdrawn, [3], 'withdrawn'),
            sentence('It runs the engine.', [4], 'unsourced'),
          ],
        },
        // Every sentence of it withdrawn: the item goes with them.
        { kind: 'item', text: null, sentences: [sentence(`${SECRETS.withdrawn} Again.`, [3], 'withdrawn')] },
        { kind: 'code', text: 'orbit run --once', sentences: [] },
      ],
    },
    { ...section, key: 'unwritten', number: 2, title: 'Not written yet', kind: 'ops', written: false, blocks: [] },
    {
      ...section,
      key: 'end',
      number: 3,
      title: 'The end',
      kind: 'overview',
      written: true,
      blocks: [{ kind: 'paragraph', text: null, sentences: [sentence('It finishes.', [5, 1])] }],
    },
  ],
  footnotes: [
    note({
      n: 1,
      kind: 'code',
      checkedBy: 'runner',
      quote: 'claimTurn(',
      location: `src/runner/loop.ts@${SECRETS.commit}#L10-12`,
      path: 'src/runner/loop.ts',
      sha: SECRETS.commit,
      lineStart: 10,
      lineEnd: 12,
      symbol: 'RunLoop.claim',
      excerpt: 'function claim() {\n  claimTurn(next);\n}',
      recordId: null,
      charStart: null,
      charEnd: null,
      seq: null,
    }),
    note({ n: 2, kind: 'merge_receipt', quote: SECRETS.receipt, label: SECRETS.receiptLabel }),
    note({ n: 3, kind: 'turn', quote: 'only the withdrawn sentence cites this', label: 'user' }),
    note({ n: 4, kind: 'task_comment', quote: 'the engine runs it', label: 'USER' }),
    note({ n: 5, kind: 'owner_decision', quote: SECRETS.decision, label: SECRETS.decisionLabel }),
  ],
  entries: [
    { id: SECRETS.entry, kind: 'decision', title: 'An entry title', status: 'active', trust: 'owner', anchorState: 'verified', notes: [1] },
  ],
};

const WRITTEN = new Set(['session-runtime', 'storage']);

function assertNothingPrivate(answer: unknown): void {
  const text = JSON.stringify(answer);
  for (const [what, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `the public answer carries the ${what}: ${value}`);
  }
  for (const field of ['sha', 'repoSha', 'recordId', 'sessionId', 'taskId', 'projectId', 'viaEntryId', 'model', 'location', 'entries', 'dispositions', 'status', 'counts', 'planVersion']) {
    assert.ok(!text.includes(`"${field}"`), `the public answer has a "${field}" field`);
  }
}

test('without Footnotes: the text alone — no numbers, no footnotes, nothing withdrawn or unwritten', () => {
  const doc = publicWikiDoc(VIEW, WRITTEN, false);
  assert.equal('footnotes' in doc, false);
  assert.deepEqual(doc.sections.map((s) => s.key), ['loop', 'end'], 'a section not written yet is left out');
  assert.deepEqual(doc.sections[0].blocks, [
    { kind: 'heading', text: 'How it starts', sentences: [] },
    {
      kind: 'paragraph',
      text: null,
      sentences: [{ text: 'A session claims a turn.', notes: [] }, { text: 'It runs the engine.', notes: [] }],
    },
    { kind: 'code', text: 'orbit run --once', sentences: [] },
  ]);
  assert.deepEqual(doc.sections[1].blocks, [{ kind: 'paragraph', text: null, sentences: [{ text: 'It finishes.', notes: [] }] }]);
  assertNothingPrivate(doc);
});

test('with Footnotes: numbered again by first appearance, private records left out, nothing that leads back', () => {
  const doc = publicWikiDoc(VIEW, WRITTEN, true);
  const [loop, end] = doc.sections;
  assert.deepEqual(loop.blocks[1].sentences.map((s) => s.notes), [[1], [2]], 'the merge receipt is gone; the comment is 2');
  assert.deepEqual(end.blocks[0].sentences[0].notes, [1], 'the owner decision is gone; the code is still 1');
  assert.deepEqual(doc.footnotes, [
    {
      n: 1,
      kind: 'code',
      verdict: 'verified',
      quote: 'claimTurn(',
      path: 'src/runner/loop.ts',
      lineStart: 10,
      lineEnd: 12,
      section: null,
      symbol: 'RunLoop.claim',
      excerpt: 'function claim() {\n  claimTurn(next);\n}',
      seq: null,
      at: '2026-09-30T08:00:00.000Z',
      label: null,
      notePath: null,
    },
    {
      n: 2,
      kind: 'task_comment',
      verdict: 'verified',
      quote: 'the engine runs it',
      path: null,
      lineStart: null,
      lineEnd: null,
      section: null,
      symbol: null,
      excerpt: null,
      seq: 4,
      at: '2026-09-30T08:00:00.000Z',
      label: 'USER',
      notePath: null,
    },
  ]);
  assertNothingPrivate(doc);
});

test('a document left to another links only when the link opens it, and one the plan cannot name is dropped', () => {
  const doc = publicWikiDoc(VIEW, WRITTEN, false);
  assert.deepEqual(doc.scopeOut, [
    { text: 'Storage', docs: [{ slug: 'storage', number: '1.2', title: 'Storage' }] },
    { text: 'Later', docs: [{ slug: null, number: '2.1', title: 'Later' }] },
  ]);
  assert.deepEqual(
    { slug: doc.slug, number: doc.number, title: doc.title, question: doc.question, category: doc.category, updatedAt: doc.updatedAt },
    {
      slug: 'session-runtime',
      number: '1.1',
      title: 'Session runtime',
      question: 'How does a session run?',
      category: { key: 'runtime', number: 1, title: 'Runtime' },
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  );
});

test("a space is named by its repository's last part, else by its title", () => {
  assert.equal(wikiSpaceName({ title: 'My space', repoUrlNorm: 'github.com/acme/orbit' }), 'orbit');
  assert.equal(wikiSpaceName({ title: 'My space', repoUrlNorm: null }), 'My space');
  assert.equal(wikiSpaceName({ title: 'My space', repoUrlNorm: '' }), 'My space');
});
