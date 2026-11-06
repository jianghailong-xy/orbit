import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import Markdown from '../components/Markdown';
import { mendCjkMarkdown } from './cjkMarkdown';

// The same inputs as OrbitKit's MarkdownTests and Android's CjkMarkdownTest, so the three read one rule.
const parser = unified().use(remarkParse).use(remarkGfm);
const read = (md: string) => {
  const found = { bold: 0, text: '', links: [] as string[] };
  const walk = (node: any) => {
    if (node.type === 'strong') found.bold += 1;
    if (node.type === 'link') found.links.push(node.url);
    if (typeof node.value === 'string') found.text += node.value;
    (node.children ?? []).forEach(walk);
  };
  walk(parser.parse(md));
  return found;
};

describe('mendCjkMarkdown: bold', () => {
  it.each([
    ['**做法：**照上个项目的办法', '**做法**：照上个项目的办法'],
    ['这是**“重点”**内容', '这是“**重点**”内容'],
    ['**注意：**run this', '**注意**：run this'],
    ['**note:**中文', '**note**:中文'],
    ['- **跑哪一版？**我的建议', '- **跑哪一版**？我的建议'],
    ['**做法（注意）：**照', '**做法（注意）**：照'],
    ['**运行 `npm test`：**然后', '**运行 `npm test`**：然后'],
    ['**好**的：**做法：**照', '**好**的：**做法**：照'],
    ['**涨幅 10%**以上', '**涨幅 10**%以上'],
    ['用**C++**写', '用**C+**+写'],
    ['这是**✅完成**内容', '这是✅**完成**内容'],
    ['**a *b*：**c', '**a *b***：c'],
    ['**[做法](orbit-task:34q)：**照', '**[做法](orbit-task:34q)**：照'],
    ['**[`a*b`](u)：**照', '**[`a*b`](u)**：照'],
    ['```\ncode\n```\n**做法：**照', '```\ncode\n```\n**做法**：照'],
    ['**做法：**照\r\n**注意：**看', '**做法**：照\r\n**注意**：看'],
  ])('moves the mark that keeps the stars drawn: %s', (md, mended) => {
    expect(mendCjkMarkdown(md)).toBe(mended);
    // The parser's own reading, before and after: the same words, now bold and with no stars.
    const before = read(md);
    const after = read(mended);
    expect(before.text).toContain('**');
    expect(after.text).not.toContain('**');
    expect(after.bold).toBeGreaterThan(before.bold);
    expect(after.text).toBe(before.text.replaceAll('**', ''));
  });

  it.each([
    ['no CJK at the marks', '**note:**word'],
    ['a power', 'a**-1 和 b**2'],
    ['a power beside CJK', '值**-1 和 b**2'],
    ['paths', 'src/tasks/**和 lib/**目录'],
    ['a path beside CJK', '目录**/b 和 c**/d'],
    ['a glob on a file name', '目录**.ts 和 lib/**.js'],
    ['already flanking, a space outside', '**做法：** 照'],
    ['already flanking, punctuation outside', '**做法：**，照'],
    ['already flanking, the end of the line', '**做法：**'],
    ['already flanking, no mark inside', '**做法**：照'],
    ['a code span', '`**做法：**照`'],
    ['a link', '**[做法](https://a.com)**照'],
    ['an image', '**![图](a.png)**照'],
    ['an image after CJK', '这是**![图](a.png)**照'],
    ['a reference link', '**[做法][ref]**照'],
    ['a reference image after CJK', '这是**![图][ref]**照'],
    ['stars in an autolink’s address', '<https://a.com/**做法：**照>'],
    ['a footnote', '**做法[^1]**后面'],
    ['an autolink', '**看 <https://a.com>**照'],
    ['an entity', '**a&amp;**照'],
    ['an escaped mark', '**做法\\:**照'],
    ['an escaped backslash, not its star', '**做法\\**照'],
    ['already flanking, code outside', '**做法：**`x`'],
    ['already flanking, a link outside', '**做法：**[链接](u)'],
    ['escaped stars', '\\*\\*做法：\\*\\*照'],
    ['an escaped star', '\\**做法：**照'],
    ['three stars opening', '***做法：**照'],
    ['stars with spaces inside', '** BUILD SUCCEEDED **，然后'],
    ['a space would take the mark’s place', '这是**「 重点**内容'],
    ['bold and italic', '***做法：***照'],
    ['nothing left to be bold', '**：**照'],
    ['no stars', '没有星号：这里'],
    ['a fenced block', '```\n**做法：**照\n```'],
    ['a tilde fence', '~~~\n**做法：**照\n~~~'],
    ['a fence in a quote', '> ```\n> **做法：**照\n> ```'],
    ['a fence cut off', '```\n**做法：**照'],
  ])('leaves alone %s', (_, md) => {
    expect(mendCjkMarkdown(md)).toBe(md);
  });

  it('draws the bubble’s bold, with every word and no stars', () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, '**做法：**照上个项目的办法'));
    expect(html).toBe('<p><strong>做法</strong>：照上个项目的办法</p>');
  });

  it('passes nothing to draw through', () => {
    expect(renderToStaticMarkup(createElement(Markdown))).toBe('');
  });
});

describe('mendCjkMarkdown: a bare URL', () => {
  it.each([
    ['打开 https://orbitd.io，也就是你的账号。', '打开 <https://orbitd.io>，也就是你的账号。', 'https://orbitd.io'],
    ['地址 **http://217.216.108.220:2087**（IPv4 明文', '地址 **<http://217.216.108.220:2087>**（IPv4 明文', 'http://217.216.108.220:2087'],
    ['**http://192.168.1.12:8765/**，点“下载”', '**<http://192.168.1.12:8765/>**，点“下载”', 'http://192.168.1.12:8765/'],
    ['http://localhost:2376看看', '<http://localhost:2376>看看', 'http://localhost:2376'],
    ['https://a.com/docs查看说明', '<https://a.com/docs>查看说明', 'https://a.com/docs'],
    ['https://zh.wikipedia.org/wiki/中文，然后', '<https://zh.wikipedia.org/wiki/中文>，然后', 'https://zh.wikipedia.org/wiki/中文'],
    ['https://zh.wikipedia.org/wiki/中文_语言。', '<https://zh.wikipedia.org/wiki/中文_语言>。', 'https://zh.wikipedia.org/wiki/中文_语言'],
    ['(see http://a.com)，然后', '(see <http://a.com>)，然后', 'http://a.com'],
    ['http://a.com/x_(y)，然后', '<http://a.com/x_(y)>，然后', 'http://a.com/x_(y)'],
    ['http://a.com.，然后', '<http://a.com>.，然后', 'http://a.com'],
    ['“http://a.com”是地址', '“<http://a.com>”是地址', 'http://a.com'],
    ['地址http://a.com，然后', '地址<http://a.com>，然后', 'http://a.com'],
    ['http://a.com?x=1&y=2，然后', '<http://a.com?x=1&y=2>，然后', 'http://a.com?x=1&y=2'],
    ['**看 http://a.com：**然后', '**看 <http://a.com>**：然后', 'http://a.com'],
    ['http://a.com/**/b，然后**做法：**照', '<http://a.com/**/b>，然后**做法**：照', 'http://a.com/**/b'],
  ])('ends the link where the address ends: %s', (md, mended, link) => {
    expect(mendCjkMarkdown(md)).toBe(mended);
    // The parser's own reading, before and after: the same words, and a link with only the address.
    const before = read(md);
    const after = read(mended);
    expect(before.links[0]).not.toBe(link);
    expect(after.links).toEqual([link]);
    expect(after.text.replaceAll('**', '')).toBe(before.text.replaceAll('**', ''));
  });

  it.each([
    ['one that stops at a space', 'plain http://a.com/x then words'],
    ['a path segment that opens on CJK', 'https://zh.wikipedia.org/wiki/中文 是页面'],
    ['a scheme inside a word', 'xhttp://a.com，然后'],
    ['no address', 'http://，然后'],
    ['no address, only marks', 'http://**，然后'],
    ['a code span', '`http://a.com，然后`'],
    ['a link’s address', '[链接](http://a.com/路径，然后)'],
    ['a link’s text', '[http://a.com，然后](http://a.com)'],
    ['an image’s address', '![图](http://a.com/图，一)'],
    ['an autolink', '<http://a.com，然后>'],
    ['a reference definition', '[ref]: http://a.com/路径，然后'],
    ['a fenced block', '```\nhttp://a.com，然后\n```'],
  ])('leaves alone %s', (_, md) => {
    expect(mendCjkMarkdown(md)).toBe(md);
  });

  it('draws the link with only the address, and the sentence after it', () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, '打开 https://orbitd.io，也就是你的账号。'));
    expect(html).toBe('<p>打开 <a href="https://orbitd.io">https://orbitd.io</a>，也就是你的账号。</p>');
  });
});
