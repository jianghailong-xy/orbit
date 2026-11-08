import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseWikiPlanDocBody, wikiPlanDocSourcesOf } from './wiki-plan-format';
import { WikiPlanRepo } from './wiki-plan-repo';

/**
 * A `Docs:` line as a model writes it, read into the references the gate holds to the repository. The first draft
 * of 2026-11-02 (31 documents, 953 references) failed the plan check on four of them, all in one document: several
 * sources of one section on one line with the path repeated, `a.md § x; a.md § y`. The line read as one section named
 * by the rest of it, no document has that heading, and each redo round printed the same line back to the model.
 */

type Reference = [path: string, section: string | null];

const read = (line: string): Reference[] => wikiPlanDocSourcesOf(line).map((d) => [d.path, d.section]);

/** The four lines as read off the plan page, and the references each one names. */
const FAILED_LINES: Array<{ line: string; references: Reference[] }> = [
  {
    line: '.claude/skills/tea-day-recovery/SKILL.md § 5. 核 HDFS part 完整性(导入前必做); .claude/skills/tea-day-recovery/SKILL.md § 6. import:把 part attach 进 CNCH',
    references: [
      ['.claude/skills/tea-day-recovery/SKILL.md', '5. 核 HDFS part 完整性(导入前必做)'],
      ['.claude/skills/tea-day-recovery/SKILL.md', '6. import:把 part attach 进 CNCH'],
    ],
  },
  {
    line: 'docs/dev-journal/usttp.md § 2026-09-25 09-20~09-22 回补执行完毕:第二种「静默空跑」、按任务串行的并发闸,以及一条自己定的收敛判据被证明不可达; docs/dev-journal/usttp.md § 2026-09-24 分片错位回补:重跑只补尾段的三重依据、实例选取口径,以及「缺一个小时=整天不导还 exit 0」',
    references: [
      ['docs/dev-journal/usttp.md', '2026-09-25 09-20~09-22 回补执行完毕:第二种「静默空跑」、按任务串行的并发闸,以及一条自己定的收敛判据被证明不可达'],
      ['docs/dev-journal/usttp.md', '2026-09-24 分片错位回补:重跑只补尾段的三重依据、实例选取口径,以及「缺一个小时=整天不导还 exit 0」'],
    ],
  },
  {
    line: 'docs/dev-journal/usttp.md § 五之二、`app_id` 有两个含义,别拿它当验收依据; docs/dev-journal/usttp.md § 二、「尾段 16 片与头段同量级」这条验收标准写错了口径; docs/dev-journal/usttp.md § 三、★ 自己定的收敛判据被证明在这张表上不可达',
    references: [
      ['docs/dev-journal/usttp.md', '五之二、`app_id` 有两个含义,别拿它当验收依据'],
      ['docs/dev-journal/usttp.md', '二、「尾段 16 片与头段同量级」这条验收标准写错了口径'],
      ['docs/dev-journal/usttp.md', '三、★ 自己定的收敛判据被证明在这张表上不可达'],
    ],
  },
  {
    line: '.claude/skills/tea-day-recovery/SKILL.md § 铁律(踩过坑,别省); .claude/skills/tea-day-recovery/SKILL.md § 相关',
    references: [
      ['.claude/skills/tea-day-recovery/SKILL.md', '铁律(踩过坑,别省)'],
      ['.claude/skills/tea-day-recovery/SKILL.md', '相关'],
    ],
  },
];

const WIDE: Record<string, string> = { ',': '，', ':': '：', ';': '；', '(': '（', ')': '）' };
const wide = (text: string): string => text.replace(/[,:;()]/gu, (c) => WIDE[c]);

for (const [i, { line, references }] of FAILED_LINES.entries()) {
  test(`failed line ${i + 1} reads as the ${references.length} references it names`, () => {
    assert.deepEqual(read(line), references);
  });

  // The lines came off a screenshot, so what the model really typed may be the other width of any of these marks.
  test(`failed line ${i + 1} reads the same in full-width punctuation, with no space after the separator`, () => {
    const expected = references.map(([path, section]): Reference => [path, section === null ? null : wide(section)]);
    assert.deepEqual(read(wide(line.replaceAll('; ', ';'))), expected);
  });
}

test('the failed lines, read from a document body, name headings the document has', () => {
  const headings = FAILED_LINES.flatMap(({ references }) => references);
  const paths = [...new Set(headings.map(([path]) => path))];
  const repo = new WikiPlanRepo({
    sha: 'a'.repeat(40),
    date: '2026-11-02',
    files: paths.map((path) => ({ path, size: 1 })),
    docs: paths.map((path) => ({
      path,
      title: 'The document',
      headings: headings.filter(([p]) => p === path).map(([, section]) => ({ level: 2, text: section ?? '' })),
    })),
    symbols: {},
    contracts: [],
  });
  const body = `### 1. The section | flow | 400\nCovers: what happened.\n${FAILED_LINES.map(({ line }) => `- Docs: ${line}`).join('\n')}\n`;
  const { sections, stray } = parseWikiPlanDocBody(body);
  assert.deepEqual(stray, []);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].docs.length, headings.length);
  for (const d of sections[0].docs) assert.ok(repo.hasDocSection(d.path, d.section ?? ''), `${d.path} § ${d.section}`);
});

test('a reference starts after every separator, spaced or tight, for the same file and for another', () => {
  for (const separator of [';', '；', ',', '，', '、']) {
    for (const gap of ['', ' ', '　', '\t']) {
      const name = JSON.stringify(separator + gap);
      assert.deepEqual(read(`docs/a.md § x${separator}${gap}docs/a.md § y`), [['docs/a.md', 'x'], ['docs/a.md', 'y']], `same file, ${name}`);
      assert.deepEqual(read(`docs/a.md § x${separator}${gap}docs/b.md § y`), [['docs/a.md', 'x'], ['docs/b.md', 'y']], `another file, ${name}`);
    }
  }
});

test("another file's sections go to that file, not to the line's first path", () => {
  const cases: Array<[line: string, references: Reference[]]> = [
    ['docs/a.md § x; docs/b.md § y; § z', [['docs/a.md', 'x'], ['docs/b.md', 'y'], ['docs/b.md', 'z']]],
    ['docs/a.md § x、§ y; docs/b.md § z、§ w; docs/c.md § v', [['docs/a.md', 'x'], ['docs/a.md', 'y'], ['docs/b.md', 'z'], ['docs/b.md', 'w'], ['docs/c.md', 'v']]],
    ['docs/a.md § x; docs/b.md § y; docs/a.md § z', [['docs/a.md', 'x'], ['docs/b.md', 'y'], ['docs/a.md', 'z']]],
    // The first document taken whole, by naming no section or by saying so.
    ['docs/a.md; docs/b.md § y', [['docs/a.md', null], ['docs/b.md', 'y']]],
    ['docs/a.md § whole document; docs/b.md § y', [['docs/a.md', null], ['docs/b.md', 'y']]],
    ['docs/a.md § x; docs/b.md § whole document', [['docs/a.md', 'x'], ['docs/b.md', null]]],
  ];
  for (const [line, references] of cases) assert.deepEqual(read(line), references, line);
});

test('a path reads as a path at the root, in any script, in either wrapping and in any case', () => {
  const cases: Array<[line: string, references: Reference[]]> = [
    ['README.md § x; CLAUDE.md § y', [['README.md', 'x'], ['CLAUDE.md', 'y']]],
    ['docs/设计/总览.md § 背景; docs/设计/总览.md § 目标', [['docs/设计/总览.md', '背景'], ['docs/设计/总览.md', '目标']]],
    ['./docs/a.md § x; ./docs/b.md § y', [['./docs/a.md', 'x'], ['./docs/b.md', 'y']]],
    ['`docs/a.md` § x; `docs/b.md` § y', [['docs/a.md', 'x'], ['docs/b.md', 'y']]],
    ['「docs/a.md」 § x；「docs/b.md」 § y', [['docs/a.md', 'x'], ['docs/b.md', 'y']]],
    ['docs/A.MD § x; docs/B.Md § y', [['docs/A.MD', 'x'], ['docs/B.Md', 'y']]],
  ];
  for (const [line, references] of cases) assert.deepEqual(read(line), references, line);
});

test("a heading's own separators stay in it, whatever follows them", () => {
  const headings = [
    '五之二、`app_id` 有两个含义,别拿它当验收依据',
    '第二种「静默空跑」、按任务串行的并发闸',
    // A `§` after a word, a version, a protocol: none of them a document.
    '恢复策略,契约 §6.4',
    '版本,v1.2 §3',
    '协议、TCP/IP §2',
    // A file, but no document: only a `.md` file has headings for a `§` to name.
    '说明,main.go §3',
    '附录,notes.txt § 2',
    // A path after other words, or a link: not a path by itself.
    '加固,见 docs/y.md §2',
    '来源,https://example.com/a.md § 2',
    // A path with no `§` after it.
    '重构,README.md',
  ];
  for (const heading of headings) assert.deepEqual(read(`docs/x.md § ${heading}`), [['docs/x.md', heading]], heading);
});

test("a heading's separators do not reach for the reference after it", () => {
  assert.deepEqual(read('docs/x.md § 甲、乙,丙;docs/y.md § 丁'), [['docs/x.md', '甲、乙,丙'], ['docs/y.md', '丁']]);
  assert.deepEqual(read('docs/x.md § 甲,乙；docs/y.md § 丁'), [['docs/x.md', '甲,乙'], ['docs/y.md', '丁']]);
});

test('nothing splits inside parentheses, of either width, however deep', () => {
  const cases: Array<[line: string, references: Reference[]]> = [
    ['docs/x.md § 2. 恢复策略(契约 §6.4、§6.5)', [['docs/x.md', '2. 恢复策略(契约 §6.4、§6.5)']]],
    ['docs/x.md § 恢复(见 docs/y.md § 2; docs/z.md § 3)', [['docs/x.md', '恢复(见 docs/y.md § 2; docs/z.md § 3)']]],
    ['docs/x.md § 恢复（见 docs/y.md § 2； docs/z.md § 3）', [['docs/x.md', '恢复（见 docs/y.md § 2； docs/z.md § 3）']]],
    ['docs/x.md § 恢复(甲(乙; docs/y.md § 2); docs/y.md § 3)', [['docs/x.md', '恢复(甲(乙; docs/y.md § 2); docs/y.md § 3)']]],
    // Out of them again, the next reference starts.
    ['docs/x.md § 恢复(见 docs/y.md § 2; docs/z.md § 3); docs/x.md § 下一节', [['docs/x.md', '恢复(见 docs/y.md § 2; docs/z.md § 3)'], ['docs/x.md', '下一节']]],
  ];
  for (const [line, references] of cases) assert.deepEqual(read(line), references, line);
});

test('what one reference on a line always read, it still reads', () => {
  const cases: Array<[line: string, references: Reference[]]> = [
    ['', []],
    ['none', []],
    ['—', []],
    ['docs/a.md', [['docs/a.md', null]]],
    ['docs/a.md § x', [['docs/a.md', 'x']]],
    ['docs/a.md § whole document', [['docs/a.md', null]]],
    ['docs/a.md § x; § y', [['docs/a.md', 'x'], ['docs/a.md', 'y']]],
    ['docs/a.md § x、§ y', [['docs/a.md', 'x'], ['docs/a.md', 'y']]],
    ['docs/a.md § 4. Data model (new table `share_link`), § (5. Interface)', [['docs/a.md', '4. Data model (new table `share_link`)'], ['docs/a.md', '5. Interface']]],
  ];
  for (const [line, references] of cases) assert.deepEqual(read(line), references, line);
});
