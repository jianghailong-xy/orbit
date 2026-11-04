import { describe, expect, it } from 'vitest';
import { CODE_WORD_MAX, breaksBeforeCode, codeWordParts } from './codeWords';

describe('the words of inline code', () => {
  it('keeps each word whole and the spaces between them as they are', () => {
    expect(codeWordParts('python tea-cli.py  --app_id')).toEqual([
      { text: 'python', whole: true },
      { text: ' ', whole: false },
      { text: 'tea-cli.py', whole: true },
      { text: '  ', whole: false },
      { text: '--app_id', whole: true },
    ]);
  });

  it('leaves a word to wrap once it is longer than the narrowest line can hold', () => {
    const fits = 'a'.repeat(CODE_WORD_MAX);
    expect(codeWordParts(fits)).toEqual([{ text: fits, whole: true }]);
    const over = `${fits}a`;
    expect(codeWordParts(over)).toEqual([{ text: over, whole: false }]);
  });

  it('gives back every character it was handed', () => {
    for (const text of ['--force', ' a  b ', 'a\tb', `${'x'.repeat(40)} y`]) {
      expect(codeWordParts(text).map((part) => part.text).join('')).toBe(text);
    }
  });
});

describe('where a line may end before code', () => {
  it('is anywhere but after what opens a bracket or a quote', () => {
    for (const words of ['参数、', '例如：', '运行', 'a=', '', ')', '。']) expect(breaksBeforeCode(words)).toBe(true);
    for (const words of ['（', '(', '[', '【', '「', '『', '“', '‘', '《', '参数（']) expect(breaksBeforeCode(words)).toBe(false);
  });
});
