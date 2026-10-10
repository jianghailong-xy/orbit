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
 *
 * Word for word, save three problems the server words in English (AGENTS.md section 5) where the runner's are in
 * Chinese — a section with no sources, a line that is no line of a section, a part that is no part of a session
 * condition: each must be raised for the same section and the same line, in the same place among the others.
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

/** The problems each path words its own way, read as what they refuse: the section, and the line. */
const WORDED: ReadonlyArray<{ runner: RegExp; server: RegExp; as: string }> = [
  { runner: /^(第 \d+ 节)没有写材料来源：/u, server: /^(第 \d+ 节) names no sources: /u, as: 'NO SOURCES' },
  { runner: /^(第 \d+ 节)里 ("(?:[^"\\]|\\.)*") 不是节的一行：/u, server: /^(第 \d+ 节): ("(?:[^"\\]|\\.)*") is not a line of a section: /u, as: 'NOT A LINE' },
  {
    runner: /^(第 \d+ 节)的会话条件里 ("(?:[^"\\]|\\.)*") 不是其中一项：/u,
    server: /^(第 \d+ 节): ("(?:[^"\\]|\\.)*") is not a part of a session condition: /u,
    as: 'NOT A PART',
  },
];

function refusing(problem: string, side: 'runner' | 'server'): string {
  for (const one of WORDED) {
    const m = one[side].exec(problem);
    if (m) return [m[1], one.as, m[2]].filter((part) => part !== undefined).join(' ');
  }
  return problem;
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
    assert.deepEqual(got.problems.map((p) => refusing(p, 'server')), c.problems.map((p) => refusing(p, 'runner')), `${c.name}: the problems`);
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
  // The bounded window ends after «## 1. Early»'s paragraph: a heading past it is not seen, and the problem says why.
  const repo = snapshotOf({ [doc]: text }, (file, whole, size) => ({ path: file, state: 'cut', text: `${whole.slice(0, whole.indexOf('## 2.'))}…（后略）\n`, sizeBytes: size }));
  await repo.prepare([doc]);
  const draft = parseWikiMaintainProposal(`### 1. 早晚 | flow | 300\n讲什么：早与晚。\n- 文档：${doc} § 1. Early\n- 文档：${doc} § 2. Late\n`).sections[0];
  assert.deepEqual(wikiMaintainProposalSection('第 1 节', draft, repo, FIXTURE.topics).problems, [
    `第 1 节的文档 ${doc} 里没有章节 "2. Late"：原样抄新知识里列出的章节标题，或不写 § (past the first ${WIKI_REPO_OPS.boundedChars} characters a read of the file gives)`,
  ]);
});

test('a space with no topic yet takes none: a section\'s topic is refused, and the model told to name none, as the gate tells it', () => {
  // The run's context offers the default topics to a space with none of its own; the gate takes only the space's rows.
  const draft = parseWikiMaintainProposal('### 1. 坑 | pitfalls | 300\n讲什么：坑。\n- 会话：关键词 rebase；主题 storage-topic；要找：owner 的原话\n').sections[0];
  assert.deepEqual(wikiMaintainProposalSection('第 1 节', draft, snapshotOf({}), []).problems, [
    '第 1 节: "storage-topic" is not a topic of this space: （这个 space 还没有主题：会话条件里不写主题）',
  ]);
});
