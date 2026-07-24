import { describe, expect, it } from 'vitest';
import { splitLinks } from './linkify';

describe('splitLinks', () => {
  it('returns a single text run when there is no URL', () => {
    expect(splitLinks('just some plain text')).toEqual([{ type: 'text', value: 'just some plain text' }]);
  });

  it('returns an empty array for empty text', () => {
    expect(splitLinks('')).toEqual([]);
  });

  it('splits a URL out of surrounding text', () => {
    expect(splitLinks('see https://example.com now')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'url', value: 'https://example.com', href: 'https://example.com' },
      { type: 'text', value: ' now' },
    ]);
  });

  it('keeps query strings and encoded chars in the link (the reported dataleap URL)', () => {
    const url =
      'https://dataleap-va.tiktok-row.net/dorado/instance?searchType=content&keyword=100031972&project=i18n_1029';
    const [seg] = splitLinks(url);
    expect(seg).toEqual({ type: 'url', value: url, href: url });
  });

  it('trims trailing ASCII punctuation back into the text run', () => {
    expect(splitLinks('go to https://example.com.')).toEqual([
      { type: 'text', value: 'go to ' },
      { type: 'url', value: 'https://example.com', href: 'https://example.com' },
      { type: 'text', value: '.' },
    ]);
  });

  it('trims a trailing CJK comma so a Chinese sentence keeps it as text', () => {
    expect(splitLinks('打开 https://example.com，然后继续')).toEqual([
      { type: 'text', value: '打开 ' },
      { type: 'url', value: 'https://example.com', href: 'https://example.com' },
      { type: 'text', value: '，然后继续' },
    ]);
  });

  it('handles multiple URLs in one message', () => {
    expect(splitLinks('a https://one.com b https://two.com c')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'url', value: 'https://one.com', href: 'https://one.com' },
      { type: 'text', value: ' b ' },
      { type: 'url', value: 'https://two.com', href: 'https://two.com' },
      { type: 'text', value: ' c' },
    ]);
  });

  it('does not linkify a bare word with a dot', () => {
    expect(splitLinks('read the file.txt please')).toEqual([{ type: 'text', value: 'read the file.txt please' }]);
  });
});
