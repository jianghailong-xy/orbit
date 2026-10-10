import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WIKI_REPO_OPS, type WikiPlanTopic, type WikiPlanVersion, type WikiRepoFileRead } from '@orbit/shared';

import { WikiDocsSnapshotRepo } from './wiki-docs-build-job';
import {
  assembleWikiMaintainProposal,
  parseWikiMaintainProposal,
  wikiMaintainPlanOf,
  wikiMaintainProposalPaths,
  wikiMaintainProposalSection,
  type WikiMaintainProposalItem,
} from './wiki-maintain-plan';

/**
 * One input, one deterministic answer on both paths (project criterion: "the deterministic results — parsing, gate
 * checks — agree on the old path and the new"): `src/shared/src/wiki-maintain-proposal.fixture.json` holds what the
 * runner's check of a maintenance run's plan proposal (src/runner-go/wiki_maintain_docs.go: parseWikiProposal,
 * assembleWikiProposal, wikiProposalSection) makes of a set of answers on a checkout of the fixture's files — the
 * problems it hands back to the model, and the session conditions of the sections it would send — and this holds the
 * server's check to the same answers, the files read through the reader the maintenance job reads them with
 * (`WikiDocsSnapshotRepo`), and a section's topics held to the space's (the fixture's `topics`, as the affected read
 * hands them over). The Go side holds itself to the same file (wiki_maintain_proposal_fixture_test.go), and writes it.
 * Word for word: every problem is English on both paths (AGENTS.md section 5).
 */

// From build/wiki-worker back to src/shared.
const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/wiki-maintain-proposal.fixture.json'), 'utf8')) as {
  files: Record<string, string>;
  plan: WikiPlanVersion;
  items: WikiMaintainProposalItem[];
  topics: WikiPlanTopic[];
  cases: Array<{ name: string; answer: string; problems: string[]; sessions: Array<{ entryKinds: string[]; topics: string[] } | null> }>;
};

const SHA = '5ca1ab1e0ddba11c0ffee5ca1ab1e0ddba11c0ff';

/** The fixture's files at one commit, as the job's reader holds them: their sizes from the snapshot, their text from a read. */
function snapshotOf(files: Record<string, string>, read: (file: string, text: string, size: number) => WikiRepoFileRead = found): WikiDocsSnapshotRepo {
  const sizes = new Map(Object.entries(files).map(([file, text]) => [file, Buffer.byteLength(text, 'utf8')]));
  const paths = [...sizes.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return new WikiDocsSnapshotRepo(SHA, sizes, paths, async (wanted) => new Map(wanted.map((file) => [file, read(file, files[file], sizes.get(file) ?? 0)])));
}

function found(file: string, text: string, size: number): WikiRepoFileRead {
  return { path: file, state: 'found', text, sizeBytes: size };
}

/** What the server's check makes of one answer: its problems, and the new sections' session conditions. */
async function check(answerText: string): Promise<{ problems: string[]; sessions: Array<{ entryKinds: string[]; topics: string[] } | null> }> {
  const repo = snapshotOf(FIXTURE.files);
  const answer = parseWikiMaintainProposal(answerText);
  await repo.prepare(wikiMaintainProposalPaths(answer));
  const { request, problems } = assembleWikiMaintainProposal(wikiMaintainPlanOf(FIXTURE.plan), answer, FIXTURE.items, repo, FIXTURE.topics);
  const sections = request.change.doc.sections;
  const fresh = sections.length >= answer.sections.length ? sections.slice(sections.length - answer.sections.length) : [];
  return {
    problems,
    sessions: fresh.map((section) => (section.sources.sessions === null ? null : { entryKinds: section.sources.sessions.entryKinds, topics: section.sources.sessions.topics })),
  };
}

test('every answer is checked on the server as the runner checks it: the same problems, the same session conditions', async () => {
  assert.ok(FIXTURE.cases.length >= 15);
  for (const c of FIXTURE.cases) {
    const got = await check(c.answer);
    assert.deepEqual(got.problems, c.problems, `${c.name}: the problems`);
    assert.deepEqual(got.sessions, c.sessions, `${c.name}: the session conditions`);
  }
});

test('production\'s proposal (2026-10-09, run 28ea4f5c) passes: both sections it names, `##` and all, are its document\'s', async () => {
  const production = FIXTURE.cases[0];
  assert.match(production.name, /^production/u);
  assert.match(production.answer, /§ ## 4\. wiki 怎么跟上\n/u);
  assert.match(production.answer, /§ ## 12\. 现在的缺口一起补（owner 10-09）\n/u);
  assert.deepEqual(await check(production.answer), { problems: [], sessions: [null, null] });
});

test('a file the read cut short is missing past the cut, and says so — the runner without the whole-file capability (design §7)', async () => {
  const doc = 'docs/long.md';
  const text = `# Long\n\n## 1. Early\n\nThe start.\n\n## 2. Late\n\n${'x'.repeat(60)}\n`;
  // The bounded window ends after «## 1. Early»'s paragraph: a heading past it is not seen, and the problem says why —
  // whether the read ends with the runner's marker or with the Chinese one an older runner writes.
  for (const marker of ['… (rest omitted)\n', '…（后略）\n']) {
    const repo = snapshotOf({ [doc]: text }, (file, whole, size) => ({ path: file, state: 'cut', text: `${whole.slice(0, whole.indexOf('## 2.'))}${marker}`, sizeBytes: size }));
    await repo.prepare([doc]);
    const draft = parseWikiMaintainProposal(`### 1. Early and late | flow | 300\nCovers: early and late.\n- Docs: ${doc} § 1. Early\n- Docs: ${doc} § 2. Late\n`).sections[0];
    assert.deepEqual(wikiMaintainProposalSection('section 1', draft, repo, FIXTURE.topics).problems, [
      `section 1: the document ${doc} has no section "2. Late": copy a section heading the new knowledge lists exactly, or write no § `
        + `(past the first ${WIKI_REPO_OPS.boundedChars} characters a read of the file gives)`,
    ], marker);
  }
});

test('a space with no topic yet takes none: a section\'s topic is refused, and the model told to name none, as the gate tells it', () => {
  // The run's context offers the default topics to a space with none of its own; the gate takes only the space's rows.
  const draft = parseWikiMaintainProposal("### 1. Pitfalls | pitfalls | 300\nCovers: the pitfalls.\n- Sessions: keywords rebase; topics storage-topic; look for: the owner's words\n").sections[0];
  assert.deepEqual(wikiMaintainProposalSection('section 1', draft, snapshotOf({}), []).problems, [
    'section 1: "storage-topic" is not a topic of this space: (this space has no topics yet: a session condition names no topic)',
  ]);
});
