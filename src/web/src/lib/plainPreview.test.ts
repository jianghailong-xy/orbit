import { describe, expect, it } from 'vitest';
import { plainPreview } from './plainPreview';

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
});
