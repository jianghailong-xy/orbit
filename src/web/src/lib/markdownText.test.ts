import { describe, expect, it } from 'vitest';
import { markdownToPlainText } from './markdownText';

/** The marks a row must never show. Asserted as a set on every case below, so a rule that stops
 *  firing shows up as a failure here rather than as source text on the page. */
const MARKS = /[#*`~]|\]\(/;

describe('markdownToPlainText', () => {
  it('returns the empty string for nothing to strip', () => {
    expect(markdownToPlainText(null)).toBe('');
    expect(markdownToPlainText(undefined)).toBe('');
    expect(markdownToPlainText('   \n\n  ')).toBe('');
  });

  it('drops ATX heading marks, opening and closing', () => {
    expect(markdownToPlainText('## 现状缺口')).toBe('现状缺口');
    expect(markdownToPlainText('###### Deep')).toBe('Deep');
    expect(markdownToPlainText('## Closed heading ##')).toBe('Closed heading');
    expect(markdownToPlainText('## 现状缺口')).not.toMatch(MARKS);
  });

  it('unwraps bold, italic, bold-italic and strikethrough', () => {
    expect(markdownToPlainText('**一个依赖字段都没有**')).toBe('一个依赖字段都没有');
    expect(markdownToPlainText('*emphasis*')).toBe('emphasis');
    expect(markdownToPlainText('***both***')).toBe('both');
    expect(markdownToPlainText('~~gone~~')).toBe('gone');
    expect(markdownToPlainText('**a** and *b*')).not.toMatch(MARKS);
  });

  it('unwraps inline code, including a doubled-backtick span', () => {
    expect(markdownToPlainText('`ROW_EXCERPT_LENGTH`')).toBe('ROW_EXCERPT_LENGTH');
    expect(markdownToPlainText('run `npm test` first')).toBe('run npm test first');
    expect(markdownToPlainText('``a `b` c``')).toBe('a `b` c'.replace(/`/g, ''));
    expect(markdownToPlainText('`x`')).not.toMatch(MARKS);
  });

  it('keeps a link’s text and drops its target', () => {
    expect(markdownToPlainText('see [the plan](https://example.com/p)')).toBe('see the plan');
    expect(markdownToPlainText('![a screenshot](/img.png)')).toBe('a screenshot');
    expect(markdownToPlainText('[text][ref]')).toBe('text');
    expect(markdownToPlainText('<https://example.com/x>')).toBe('https://example.com/x');
    expect(markdownToPlainText('[a](b)')).not.toMatch(MARKS);
  });

  it('drops bullet and ordered-list markers at any indent', () => {
    expect(markdownToPlainText('- first\n* second\n+ third')).toBe('first second third');
    expect(markdownToPlainText('1. one\n2) two')).toBe('one two');
    expect(markdownToPlainText('  - nested')).toBe('nested');
    expect(markdownToPlainText('- a\n- b')).not.toMatch(MARKS);
  });

  it('drops blockquote markers, fences and thematic breaks', () => {
    expect(markdownToPlainText('> quoted\n> > deeper')).toBe('quoted deeper');
    expect(markdownToPlainText('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(markdownToPlainText('above\n\n---\n\nbelow')).toBe('above below');
    expect(markdownToPlainText('Title\n=====\nbody')).toBe('Title body');
  });

  it('collapses every run of whitespace, blank lines included, into one space', () => {
    expect(markdownToPlainText('a\n\n\nb\t\tc   d')).toBe('a b c d');
    expect(markdownToPlainText('  padded  ')).toBe('padded');
  });

  it('leaves identifiers and prose punctuation alone', () => {
    // The exact string this page used to show as source: a path with a line number in it, which
    // carries no marks at all and must come back byte for byte.
    expect(markdownToPlainText('src/web/src/pages/ProjectsPage.tsx:521')).toBe(
      'src/web/src/pages/ProjectsPage.tsx:521',
    );
    // Underscores inside a word are identifier characters, not italics.
    expect(markdownToPlainText('file_path and snake_case_name')).toBe(
      'file_path and snake_case_name',
    );
    // ...while a standalone `_word_` is emphasis and does get unwrapped.
    expect(markdownToPlainText('an _italic_ word')).toBe('an italic word');
    // A lone asterisk between spaces is multiplication, not an unterminated italic.
    expect(markdownToPlainText('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('reduces a real mixed-Markdown goal to one line of prose', () => {
    const goal = [
      '把 Project 详情页从「父子任务树」改造成全景视图。',
      '',
      '## 现状缺口（2026-08-22 现网实测）',
      '',
      '- 项目页 payload `ProjectTask`（src/web/src/pages/ProjectsPage.tsx:521）**一个依赖字段都没有**',
      '- 详见 [依赖图设计](https://example.com/design)',
    ].join('\n');

    const line = markdownToPlainText(goal);

    expect(line).not.toMatch(MARKS);
    expect(line).not.toContain('\n');
    expect(line).toContain('现状缺口（2026-08-22 现网实测）');
    expect(line).toContain('ProjectTask');
    expect(line).toContain('src/web/src/pages/ProjectsPage.tsx:521');
    expect(line).toContain('一个依赖字段都没有');
    expect(line).toContain('依赖图设计');
    expect(line).not.toContain('https://example.com/design');
  });
});
