import { useEffect, useId, useState } from 'react';
import { WIKI_DOC_DIAGRAM } from '../lib/wikiDocs';

type Theme = 'light' | 'dark';
type Mermaid = (typeof import('mermaid'))['default'];

let loading: Promise<Mermaid> | null = null;

/** Mermaid, loaded the first time a page has a diagram to draw: its own chunk, which no other page pays for. */
function mermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((module) => module.default);
  return loading;
}

/** The page's theme as `<html data-theme>` has it (lib/theme.tsx), followed as it changes. */
function usePageTheme(): Theme {
  const read = (): Theme => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * A section's diagram (contract `docs.diagram`): the Mermaid flowchart the server wrote out again, drawn strict, in
 * the page's theme and at its own size — a wide one scrolls rather than shrinking its words. Its source shows as
 * code when it does not draw.
 */
export function WikiDiagram({ source }: { source: string }) {
  const theme = usePageTheme();
  const id = `wk-diagram-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
  const [drawn, setDrawn] = useState<{ svg: string } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const draw = await mermaid();
      draw.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'neutral',
        fontFamily: getComputedStyle(document.body).fontFamily,
        flowchart: { useMaxWidth: false },
      });
      return draw.render(id, source);
    })().then(
      ({ svg }) => live && setDrawn({ svg }),
      () => live && setDrawn('failed'),
    );
    return () => {
      live = false;
    };
  }, [id, source, theme]);
  if (drawn === 'failed') {
    return (
      <pre className="wk-dc-code">
        <code>{source}</code>
      </pre>
    );
  }
  return (
    <figure
      className="wk-dc-diagram"
      role="img"
      aria-label={WIKI_DOC_DIAGRAM}
      aria-busy={drawn === null}
      dangerouslySetInnerHTML={drawn === null ? undefined : { __html: drawn.svg }}
    />
  );
}
