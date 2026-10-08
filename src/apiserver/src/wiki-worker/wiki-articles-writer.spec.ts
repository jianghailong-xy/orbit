import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WIKI_ARTICLE_RULES, WIKI_ARTICLES_JOB, type WikiEntryKind } from '@orbit/shared';

import { splitSentences } from '../wiki/wiki-articles';
import {
  WIKI_ARTICLE_SYSTEM_PROMPT,
  WIKI_ARTICLE_WRITER,
  groupWikiArticleEntries,
  wikiArticleDraftChars,
  wikiArticleEntryLine,
  wikiArticleFallbackName,
  wikiArticleGroupName,
  wikiArticleNamePrompt,
  wikiArticlePrompt,
  wikiArticleRetrySuffix,
  wikiArticleTitle,
  type WikiArticleWriterEntry,
} from './wiki-articles-writer';

/**
 * The writer the server's `articles` job writes with (wiki-articles-writer.ts), held to what
 * `src/runner-go/wiki_articles_test.go` holds the runner's to: the grouping puts a topic's entries in groups by
 * their paths first and gives the same groups every time, what a draft keeps is counted as the server keeps
 * it, a title and a group's name are read out of what the model wrote. And beside those, what only the server's
 * worker has to answer for: the grouping lets the event loop run while it computes (design §4.5).
 *
 * The runner and the server are held to ONE ANSWER for the same input by `src/shared/src/wiki-article-writer.fixture.json`,
 * which `wiki_articles_test.go` reads too: the prompts word for word, the groups index for index.
 */

// From build/wiki-worker back to the repository root, as wiki-system-model.spec.ts reads the contract.
const ROOT = path.resolve(__dirname, '../../../..');
const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'contracts/wiki.contract.json'), 'utf8')) as {
  articles: { rules: Record<string, number>; job: Record<string, unknown> };
};

/** The topic the runner and the server must write the same way (its `about` says how it is made). */
const WRITER_FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'src/shared/src/wiki-article-writer.fixture.json'), 'utf8')) as {
  model: { names: string[]; article: string; short: string; shortFor: string };
  topics: Array<{ slug: string; title: string; entrySetSha256: string; entries: WikiArticleWriterEntry[] }>;
  system: string;
  calls: Record<string, Record<string, string>>;
  groups: Record<string, string[][]>;
};

function entry(id: string, title: string, summary: string, paths: string[], sources: number, kind: WikiEntryKind = 'pitfall'): WikiArticleWriterEntry {
  return {
    id,
    kind,
    title,
    summary,
    fields: { symptom: 'It broke.', cause: 'An order.', fix: 'Another order.' },
    paths,
    sources,
  };
}

/** 90 entries in three directories whose words are the same: only the paths tell them apart. */
function threeDirectories(): WikiArticleWriterEntry[] {
  const dirs = ['src/apiserver/prisma/migrations', 'src/web/src/components', 'src/runner-go/worktree'];
  return Array.from({ length: 90 }, (_, i) =>
    entry(String(i), `一条关于顺序的经验 ${i}`, '按顺序做，别跳步。', [`${dirs[i % 3]}/f${i}.ts`], 90 - i));
}

/** A big topic for the timing cases: deterministic words over a handful of directories, no Math.random. */
function bigTopic(n: number): WikiArticleWriterEntry[] {
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
  const dirs = Array.from({ length: 24 }, (_, i) => `src/area${i % 6}/part${i}`);
  return Array.from({ length: n }, (_, i) => {
    const title = Array.from({ length: 6 }, () => words[next() % words.length]).join(' ');
    const summary = Array.from({ length: 10 }, () => words[next() % words.length]).join(' ');
    return entry(`e${i}`, title, summary, [`${dirs[next() % dirs.length]}/f${i}.ts`], n - i);
  });
}

function assertPartition(groups: number[][], n: number): void {
  const seen = new Map<number, number>();
  for (const group of groups) {
    assert.deepEqual(group, [...group].sort((a, b) => a - b), 'a group lists its entries in the input\'s order');
    for (const i of group) seen.set(i, (seen.get(i) ?? 0) + 1);
  }
  assert.equal(seen.size, n, 'every entry is in a group');
  for (const [i, times] of seen) assert.equal(times, 1, `entry ${i} is in exactly one group`);
}

test('the writer\'s numbers are the contract\'s (articles.rules, articles.job)', () => {
  for (const [name, value] of Object.entries(WIKI_ARTICLE_RULES)) assert.equal(CONTRACT.articles.rules[name], value, `rules.${name}`);
  assert.deepEqual(CONTRACT.articles.job, { ...WIKI_ARTICLES_JOB });
  // The step is one the queue gives the default wait limit and call budget: 15 minutes each (modelQueue).
  assert.equal(WIKI_ARTICLES_JOB.step, 'articles');
});

test('a big topic is grouped by its paths first, the same way every time', async () => {
  const entries = threeDirectories();
  const groups = await groupWikiArticleEntries(entries);
  assert.equal(groups.length, 3, `ceil(90/${WIKI_ARTICLE_RULES.groupTarget}) groups`);
  assertPartition(groups, entries.length);
  for (const group of groups) {
    const first = entries[group[0]].paths[0];
    const dir = first.slice(0, first.lastIndexOf('/'));
    for (const i of group) assert.ok(entries[i].paths[0].startsWith(`${dir}/`), `the group led by ${dir} holds ${entries[i].paths[0]}`);
  }
  assert.deepEqual(await groupWikiArticleEntries(entries), groups, 'the same entries grouped twice give one answer');
  // Yielding at every check changes nothing but when the work is done.
  assert.deepEqual(await groupWikiArticleEntries(entries, { sliceMs: 0 }), groups);
  // Few entries: two groups at least, none below rules.groupMin unless nothing reaches it.
  const few = await groupWikiArticleEntries(entries.slice(0, 50));
  for (const group of few) assert.ok(group.length >= WIKI_ARTICLE_RULES.groupMin, `a group of ${group.length}, below ${WIKI_ARTICLE_RULES.groupMin}`);
  assertPartition(few, 50);
  // Nothing reaches the minimum: the groups stand as they are.
  const tiny = await groupWikiArticleEntries(entries.slice(0, 5));
  assertPartition(tiny, 5);
  assert.deepEqual(await groupWikiArticleEntries([]), []);
});

test('the runner\'s groups, entry for entry: the topic of wiki-article-writer.fixture.json', async () => {
  for (const topic of WRITER_FIXTURE.topics) {
    if (topic.entries.length <= WIKI_ARTICLE_RULES.splitAbove) continue;
    const groups = await groupWikiArticleEntries(topic.entries);
    assert.deepEqual(groups.map((group) => group.map((i) => topic.entries[i].id)), WRITER_FIXTURE.groups[topic.slug]);
  }
  assert.ok(Object.keys(WRITER_FIXTURE.groups).length > 0, 'the fixture has a topic big enough to group');
  assert.equal(WIKI_ARTICLE_SYSTEM_PROMPT, WRITER_FIXTURE.system, 'the system prompt is the runner\'s');
});

test('two clusters that share no path and no word come apart, thirty and thirty', async () => {
  const entries: WikiArticleWriterEntry[] = [];
  for (let i = 0; i < 30; i += 1) {
    entries.push(entry(`mig-${i}`, `migration numbering rule ${i}`, `prisma migration ledger collision ${i}`,
      [`src/apiserver/prisma/migrations/03${String(i).padStart(2, '0')}_x/migration.sql`], 90 - i));
    entries.push(entry(`web-${i}`, `vitest harness quirk ${i}`, `react component render stub ${i}`,
      [`src/web/src/components/Widget${i}.tsx`], 60 - i));
  }
  const groups = await groupWikiArticleEntries(entries);
  assert.equal(groups.length, 2);
  assertPartition(groups, 60);
  for (const group of groups) {
    const clusters = new Set(group.map((i) => entries[i].id.split('-')[0]));
    assert.equal(clusters.size, 1, `a group mixes ${[...clusters].join(' and ')}`);
    assert.equal(group.length, 30);
  }
});

test('the grouping lets the event loop run while it computes (design §4.5): a timer set before it fires during it', async () => {
  const entries = bigTopic(3000);
  // At every check: the callback queued before the grouping runs before the grouping is done.
  const order: string[] = [];
  setImmediate(() => order.push('timer'));
  const eager = await groupWikiArticleEntries(entries.slice(0, 300), { sliceMs: 0 });
  order.push('grouped');
  assert.deepEqual(order, ['timer', 'grouped']);
  assertPartition(eager, 300);
  // At the worker's own slice: a topic of thousands takes several slices, and a 1 ms interval set before it
  // ticks while it runs — what a lease renewal needs.
  let ticks = 0;
  const interval = setInterval(() => {
    ticks += 1;
  }, 1);
  const started = performance.now();
  const groups = await groupWikiArticleEntries(entries);
  const took = performance.now() - started;
  clearInterval(interval);
  assert.ok(took > 3 * WIKI_ARTICLE_WRITER.groupingSliceMs, `3000 entries take more than three slices (${took.toFixed(1)} ms)`);
  assert.ok(ticks >= 1, `the interval ticked ${ticks} times in ${took.toFixed(1)} ms`);
  assert.equal(groups.length <= WIKI_ARTICLE_RULES.groupsMax, true);
  assertPartition(groups, entries.length);
});

test('what a draft keeps is counted as the server keeps it', () => {
  const draft = [
    '# 标题不算',
    '第一句有脚注[1]。第二句没有。',
    '第三句的脚注越界[9]。',
    '- `arr[0]` 是代码，第四句有脚注[2]。',
    '## 小节也不算',
    'The fifth sentence counts. [2]',
  ].join('\n');
  // Kept: 第一句有脚注。(7) · `arr[0]` 是代码，第四句有脚注。(19) · The fifth sentence counts.(26)
  const want = Array.from('第一句有脚注。').length + Array.from('`arr[0]` 是代码，第四句有脚注。').length
    + Array.from('The fifth sentence counts.').length;
  assert.equal(wikiArticleDraftChars(draft, ['e1', 'e2']), want);
  // A footnote that names no entry the draft was written from keeps nothing, however well it is formed.
  assert.equal(wikiArticleDraftChars('只有一句[1]。', []), 0);
  assert.deepEqual(splitSentences('一。二[1][2]。三」[3]。four. five'), ['一。', '二[1][2]。', '三」[3]。', 'four.', ' five']);
  // Code a model left outside backticks is not a sentence's end; an ASCII question after a word is.
  assert.deepEqual(splitSentences('lastTurnAt ?? createdAt 降序[1]。为什么? 因为[2]。a != b 时成立[3]！'),
    ['lastTurnAt ?? createdAt 降序[1]。', '为什么?', ' 因为[2]。', 'a != b 时成立[3]！']);
});

test('a title and a group\'s name are read out of what the model wrote', () => {
  assert.equal(wikiArticleTitle('前言\n# **标题** [3]\n正文', 'fallback'), '标题');
  assert.equal(wikiArticleTitle('没有标题', 'fallback'), 'fallback');
  assert.equal(wikiArticleTitle('# **[1]**\n# 第二个', 'fallback'), 'fallback', 'only the first title line is read');
  assert.equal(wikiArticleTitle(`# ${'长'.repeat(200)}`, 'x').length, WIKI_ARTICLE_RULES.titleMaxChars);
  assert.equal(wikiArticleGroupName('好的，这组的小标题是：\n「迁移与写入清单」'), '迁移与写入清单');
  assert.equal(wikiArticleGroupName('  **— 迁移编号。**  '), '— 迁移编号');
  assert.equal(wikiArticleGroupName(''), '');
  assert.equal(Array.from(wikiArticleGroupName('名'.repeat(40))).length, WIKI_ARTICLE_WRITER.nameMaxChars);
  assert.equal(wikiArticleFallbackName([
    { title: 'a', paths: ['src/web/src/a.ts'] },
    { title: 'b', paths: ['src/web/src/b.ts', 'docs/x.md'] },
  ]), 'src/web/src');
  // Equal counts: the smaller path, so the name is the same whatever order the counts were taken in.
  assert.equal(wikiArticleFallbackName([{ title: 'a', paths: ['b/x', 'a/y'] }]), 'a/y');
  assert.equal(wikiArticleFallbackName([{ title: '一个没有路径的条目的标题很长很长', paths: [] }]), '一个没有路径的条目的标题很长');
  assert.equal(wikiArticleFallbackName([]), '其他');
});

test('an entry line carries its kind\'s fields: text as it is, a decision\'s alternatives, anything else as JSON', () => {
  assert.equal(
    wikiArticleEntryLine(3, entry('x', 'Title', 'Summary.', [], 1)),
    '[3] (pitfall, 1 source) Title —— Summary. | symptom: It broke. | cause: An order. | fix: Another order.',
  );
  const decision: WikiArticleWriterEntry = {
    id: 'd', kind: 'decision', title: 'Use one queue', summary: 'One queue for all calls.', paths: [], sources: 2,
    fields: { context: 'skipped', decision: 'One queue.', alternatives: [{ option: 'Per space', whyRejected: 'no global cap' }], consequences: '  ' },
  };
  assert.equal(wikiArticleEntryLine(1, decision),
    '[1] (decision, 2 sources) Use one queue —— One queue for all calls. | decision: One queue. | alternatives: Per space（no global cap）');
  const recipe: WikiArticleWriterEntry = {
    id: 'r', kind: 'recipe', title: 'Run a spec', summary: 'How.', paths: [], sources: 0,
    fields: { steps: ['build', 'run'], verify: { expectedExit: 0, command: 'a && b < c' } },
  };
  // Go's json.Marshal: keys sorted, `<` `>` `&` escaped.
  assert.equal(wikiArticleEntryLine(2, recipe),
    '[2] (recipe, 0 sources) Run a spec —— How. | steps: build; run | verify: {"command":"a \\u0026\\u0026 b \\u003c c","expectedExit":0}');
});

test('the prompts carry the contract\'s numbers and the entries they were written from, numbered from one', () => {
  const entries = threeDirectories().slice(0, 3);
  const article = wikiArticlePrompt('article', '数据库', '数据库', entries, '');
  assert.match(article, /^Write a wiki article titled "数据库", using ONLY/u);
  assert.match(article, new RegExp(`Anything past ${WIKI_ARTICLE_RULES.maxChars} characters is cut off`, 'u'));
  assert.ok(article.endsWith(`ENTRIES:\n${entries.map((e, i) => wikiArticleEntryLine(i + 1, e)).join('\n')}`));
  const sub = wikiArticlePrompt('subtopic', '数据库', '迁移', entries, '');
  assert.match(sub, /^Write a wiki article titled "迁移" \(a part of the topic "数据库"\), using ONLY/u);
  const overview = wikiArticlePrompt('overview', '数据库', '数据库', entries, '- 迁移（30 条）\n- 界面（30 条）');
  assert.match(overview, /^Write the overview of the wiki topic "数据库"\. The topic is split into these sub-articles:\n- 迁移（30 条）\n- 界面（30 条）\n\n/u);
  assert.equal(wikiArticleRetrySuffix(37),
    '\n\nA previous draft kept only 37 characters with footnotes: write the whole length asked for, every sentence with its markers.');
  const first = wikiArticleNamePrompt('测试', entries, []);
  assert.ok(!first.includes('已经叫') && first.endsWith('只输出这个小标题。'));
  assert.match(wikiArticleNamePrompt('测试', entries, ['迁移与界面', '工作树']), /同一主题的其他组已经叫：迁移与界面、工作树。/u);
  assert.match(WIKI_ARTICLE_SYSTEM_PROMPT, /encyclopedia-style wiki articles/u);
});
