// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MD } from './Transcript';

/**
 * Inline code in a conversation's prose. No line may end before a hyphen and one may after it, so `、--hour` could only
 * end a line inside `--`, and a reply cut `--dry-run` in two wherever the width fell. `MD` keeps each word of the code
 * whole and gives back the break the hyphen took away. The wiki's documents read by the same rule (`WikiWords`), and
 * where it stops is lib/codeWords.
 */
function rendered(markdown: string, props: { highlight?: boolean; breaks?: boolean } = {}): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<MD {...props}>{markdown}</MD>);
  return host;
}
const words = (scope: ParentNode): string[] => [...scope.querySelectorAll('.code-word')].map((node) => node.textContent ?? '');
/** What stands right before each piece of inline code: a `.code-break`, some words, or nothing. */
const before = (scope: ParentNode): string[] =>
  [...scope.querySelectorAll('code')].map((code) => {
    const previous = code.previousSibling;
    if (!previous) return 'nothing';
    if (previous.nodeType === Node.TEXT_NODE) return 'words';
    return (previous as Element).className || (previous as Element).tagName;
  });

describe('inline code in a reply', () => {
  it('keeps each word whole, and what a reader copies is the command as written', () => {
    const md = rendered('Run `python tea-cli.py --app_id 123` now.');
    expect(md.querySelector('code')?.textContent).toBe('python tea-cli.py --app_id 123');
    expect(words(md)).toEqual(['python', 'tea-cli.py', '--app_id', '123']);
    expect(md.querySelector('p')?.textContent).toBe('Run python tea-cli.py --app_id 123 now.');
  });

  it('leaves a word longer than the narrowest line to wrap, as it does today', () => {
    const long = 'src/web/src/components/WorkspaceView.landingSession.test.tsx';
    const md = rendered(`See \`${long}\`.`);
    expect(md.querySelector('code')?.textContent).toBe(long);
    expect(words(md)).toEqual([]);
  });

  it('lets a line end before the code where nothing else would, and only there', () => {
    expect(before(rendered('参数、`--force`'))).toEqual(['code-break']);
    expect(before(rendered('运行`--force`'))).toEqual(['code-break']);
    expect(before(rendered('**粗体**`--force`'))).toEqual(['code-break']);
    // A space already ends a line, and a block's first word has nothing to part from.
    expect(before(rendered('参数 `--force`'))).toEqual(['words']);
    expect(before(rendered('`--force` 在前'))).toEqual(['nothing']);
    // A line must not end on what opens a bracket or a quote.
    expect(before(rendered('参数（`--hour`）和“`--date`”'))).toEqual(['words', 'words']);
  });

  it('draws that break in the stylesheet, so nothing is copied with it', () => {
    const md = rendered('参数、`--force`、`--hour`。');
    expect(md.querySelector('p')?.textContent).toBe('参数、--force、--hour。');
    expect(md.querySelector('.code-break')?.textContent).toBe('');
    expect(md.querySelector('wbr')).toBeNull();
  });

  it('holds in a heading, a list, a quote and a link, and while a reply streams', () => {
    for (const markdown of ['## 必填：`--app_id`', '- 列表、`--app_id`', '> 引用、`--app_id`', '[`--app_id`](https://example.com/x)']) {
      expect(words(rendered(markdown))).toEqual(['--app_id']);
      expect(words(rendered(markdown, { highlight: false }))).toEqual(['--app_id']);
    }
    expect(words(rendered('第一行\n第二行、`--app_id`', { breaks: true }))).toEqual(['--app_id']);
  });

  it('leaves a code block alone: its copy button reads the words as they are', () => {
    const source = 'python tea-cli.py --app_id 123\n  --date 2024-01-15';
    for (const highlight of [true, false]) {
      const md = rendered(`文字\n\n\`\`\`bash\n${source}\n\`\`\``, { highlight });
      expect(md.querySelector('pre')?.textContent).toBe(`${source}\n`);
      expect(md.querySelector('.code-word')).toBeNull();
      expect(md.querySelector('.code-break')).toBeNull();
    }
  });

  it('holds in a table, which scrolls on its own when its whole words are wider than the column', () => {
    const md = rendered('| a | b |\n|---|---|\n| 参数、`--enable_part_writer` | `python tea-cli.py` |');
    expect(words(md)).toEqual(['--enable_part_writer', 'python', 'tea-cli.py']);
    expect(md.querySelector('.md-table-scroll > table td')).not.toBeNull();
    expect(md.querySelector('td')?.textContent).toBe('参数、--enable_part_writer');
  });
});
