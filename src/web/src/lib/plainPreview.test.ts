import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { plainPreview } from './plainPreview';

// The words a bubble draws, from the parser and GFM plugin behind the transcript's `MD`: the cases
// below take their answer from it, so none of them can pin what a row merely happens to do.
const INLINE_PARENTS = new Set(['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link']);
const words = (node: any): string =>
  node.value ?? (node.children ?? []).map(words).join(INLINE_PARENTS.has(node.type) ? '' : ' ');
const drawn = (md: string): string =>
  words(unified().use(remarkParse).use(remarkGfm).parse(md)).replace(/\s+/g, ' ').trim();

// The same inputs as OrbitKit's SessionLinePlainPreviewTests, so both lists read a reply alike.
describe('plainPreview', () => {
  it('keeps an Orbit reference’s name and drops its target', () => {
    const line = plainPreview('Filed [runner + web：配额按账户归属](orbit-task:34TcwQ8x2kLmNpRsTuVwX) for the quota split.');
    expect(line).toBe('Filed runner + web：配额按账户归属 for the quota split.');
    expect(line).not.toMatch(/\]\(/);
  });

  it('keeps an ordinary link’s text and drops its URL', () => {
    const line = plainPreview('See [the migration guide](https://example.com/docs/migrate?from=6#steps) before upgrading.');
    expect(line).toBe('See the migration guide before upgrading.');
    expect(line).not.toMatch(/\]\(/);
  });

  it('flattens every link in a multi-line reply, list items included', () => {
    const md = [
      'Done:',
      '- [Fix login redirect](orbit-task:34TqaiYd61qX2pspp4su0) landed',
      '- CI: [run 123](https://github.com/o/r/actions/runs/123)',
    ].join('\n');
    expect(plainPreview(md)).toBe('Done: Fix login redirect landed CI: run 123');
  });

  it('unwraps inline code inside a link’s text', () => {
    expect(plainPreview('Moved it to [`plainPreview.ts`](src/web/src/lib/plainPreview.ts).')).toBe(
      'Moved it to plainPreview.ts.',
    );
  });

  it('reads an image as its alt text, a linked one included', () => {
    expect(plainPreview('![CI run](https://example.com/shot.png) is green')).toBe('CI run is green');
    expect(plainPreview('[![badge](https://example.com/b.svg)](https://example.com/ci) passing')).toBe('badge passing');
    expect(plainPreview('![](orbit-attachment:abc) done')).toBe('done');
  });

  it('leaves brackets inside code alone', () => {
    expect(plainPreview('Call `render[0](x)` and read `xs[i]`.')).toBe('Call render[0](x) and read xs[i].');
    expect(plainPreview('`[x](y)` is not a link, [z](https://example.com/z) is')).toBe(
      '[x](y) is not a link, z is',
    );
    expect(plainPreview('```ts\nconst a = [x](y);\n```\nThen [ship it](https://example.com).')).toBe('Then ship it.');
  });

  it('flattens the rest as before', () => {
    expect(plainPreview('## Heading\n> quoted\n- **bold** and _em_ item')).toBe('Heading quoted bold and em item');
    expect(plainPreview('- [x] done, [y] (not a link)')).toBe('[x] done, [y] (not a link)');
    expect(plainPreview('run `npm test`\n\n  twice')).toBe('run npm test twice');
  });

  it.each([
    // The message whose row read `teauserprofilebuildcnch` under a bubble that said this.
    ['把其他的 tea_user_profile_build_*_cnch 也修复了', '把其他的 tea_user_profile_build_*_cnch 也修复了'],
    ['file_path and snake_case_name', 'file_path and snake_case_name'],
    ['看_重点_吧', '看_重点_吧'],
    ['~/.orbit/bin takes ~30 minutes', '~/.orbit/bin takes ~30 minutes'],
    ['2 * 3 * 4', '2 * 3 * 4'],
    ['foo* and bar*', 'foo* and bar*'],
    ['** BUILD SUCCEEDED **', '** BUILD SUCCEEDED **'],
    ['*.ts files', '*.ts files'],
    ['*_cnch too', '*_cnch too'],
    ['--force is needed', '--force is needed'],
    ['-1 is wrong', '-1 is wrong'],
    ['#123 is broken', '#123 is broken'],
    ['_private and __dunder', '_private and __dunder'],
  ])('keeps what is not a mark: %s', (md, row) => {
    expect(plainPreview(md)).toBe(row);
    expect(drawn(md)).toBe(row);
  });

  it.each([
    ['**bold**, *italic* and ***both***', 'bold, italic and both'],
    ['_em_, __strong__ and ___both___', 'em, strong and both'],
    ['~~gone~~ stays', 'gone stays'],
    ['这是**重点**内容', '这是重点内容'],
    ['**a *b* c** and *d **e** f*', 'a b c and d e f'],
    ['**a*b**', 'a*b'],
    ['_foo_bar_', 'foo_bar'],
    // Two globs in one message: Markdown reads their marks as emphasis, and the bubble draws it so.
    ['把 tea_*_cnch 和 foo_*_bar 都修了', '把 tea_cnch 和 foo_bar 都修了'],
    ['**run `npm test` now**', 'run npm test now'],
    ['above\n\n---\n***\n___\n- - -\n\nbelow', 'above below'],
    ['> - ## nested\n* item', 'nested item'],
  ])('drops a real mark: %s', (md, row) => {
    expect(plainPreview(md)).toBe(row);
    expect(drawn(md)).toBe(row);
  });

  it.each([
    ['`a*b*c` and `_x_` and `~~y~~`', 'a*b*c and _x_ and ~~y~~'],
    ['(v1-beta.*), and no `android-v*` tags', '(v1-beta.*), and no android-v* tags'],
    ['`- x` and `#1` start this', '- x and #1 start this'],
    ['see `tea_*_cnch` and `foo_*_bar`', 'see tea_*_cnch and foo_*_bar'],
    ['``a_b_c`` and ``d`e`` and `f`', 'a_b_c and d`e and f'],
    ['one `` tick pair stays', 'one `` tick pair stays'],
  ])('leaves every mark inside code alone: %s', (md, row) => {
    expect(plainPreview(md)).toBe(row);
    expect(drawn(md)).toBe(row);
  });
});
