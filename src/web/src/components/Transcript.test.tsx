import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MD } from './Transcript';

describe('transcript Markdown links', () => {
  it('opens ordinary links in a new tab without exposing the opener', () => {
    const html = renderToStaticMarkup(<MD>[Orbit](https://example.com/docs)</MD>);

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
