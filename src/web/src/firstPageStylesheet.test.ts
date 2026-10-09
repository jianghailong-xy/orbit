import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * The production build's first page gets one stylesheet, its modules in the order they are first imported.
 *
 * Where a page rule in index.css and an Orbit component rule have the same weight, the order the two
 * stylesheets are linked in decides the winner. Before vite.config.ts grouped the first page's CSS, that
 * order came out of automatic chunking: a component the entry shares with a lazy chunk moved into a shared
 * chunk, and a shared chunk's stylesheet is linked ahead of the entry's own, index.css included. P4.3b
 * (2026-10-09) gave the lazy dependency graphs Orbit's Button, Dialog, Alert and Spinner, and the decision
 * cards the session export draws Orbit's Select, Switch, Textarea and NumberInput; all their styles moved
 * ahead of index.css, and page rules that had been losing their ties started winning them (the runner
 * engines' "More actions" stopped greying on hover).
 *
 * The build runs in memory (`write: false`), and a plugin reads which CSS modules each chunk holds.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/** A module id as the assertions spell it: under src/ from src/web/src, a package path from node_modules. */
function short(id: string): string {
  return id.replace(/^.*\/src\/web\/src\//u, '').replace(/^.*\/node_modules\//u, '');
}

async function productionBuild(): Promise<{ links: string[]; cssOf: Map<string, string[]> }> {
  const cssOf = new Map<string, string[]>();
  const capture: Plugin = {
    name: 'first-page-stylesheet-test',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        // The chunk that holds the CSS modules names the file they become; an importer of a pure-CSS
        // chunk may list that file too, holding none of the modules itself.
        const css = Object.keys(item.modules).filter((id) => /\.css$/u.test(id)).map(short);
        if (css.length) for (const file of item.viteMetadata?.importedCss ?? []) cssOf.set(file, css);
      }
    },
  };
  const result = await build({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: 'silent',
    plugins: [capture],
    build: { write: false, emptyOutDir: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((one) => ('output' in one ? one.output : []));
  const html = outputs.find((item) => item.fileName === 'index.html');
  if (!html || html.type !== 'asset') throw new Error('the build emitted no index.html');
  const links = [...String(html.source).matchAll(/<link rel="stylesheet"[^>]*href="\/([^"]+)"/gu)].map((m) => m[1]);
  return { links, cssOf };
}

describe('the first page stylesheet', () => {
  it('is one file: the overlays, review cards and highlight theme, the reset, index.css, then the components', async () => {
    const { links, cssOf } = await productionBuild();
    expect(links).toHaveLength(1);
    const sheet = cssOf.get(links[0]) ?? [];
    expect(sheet.slice(0, 6)).toEqual([
      'components/ui/Overlay.css',
      'components/ReviewCard.css',
      'highlight.js/styles/github.css',
      'antd/dist/reset.css',
      'index.css',
      'components/ui/foundation.css',
    ]);
    // The components the lazy graphs and the session export share with the entry are in it, after
    // index.css, rather than in a shared chunk linked ahead of it.
    for (const shared of ['Button', 'Floating', 'Alert', 'Spinner', 'Select', 'TextControls', 'NumberInput', 'ChoiceControls']) {
      expect(sheet.indexOf(`components/ui/${shared}.css`)).toBeGreaterThan(sheet.indexOf('index.css'));
    }
    // CSS only a lazy chunk imports still comes with that chunk.
    expect(sheet).not.toContain('@xyflow/react/dist/style.css');
    expect([...cssOf.values()].some((css) => css.includes('@xyflow/react/dist/style.css'))).toBe(true);
  });
});
