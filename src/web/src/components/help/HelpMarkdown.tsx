import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import Markdown from '../Markdown';
import { forPlatform, headingId, helpArticleLink, ORBIT_LINK_PREFIX, resolveOrbitLink, type HelpLinkAccount } from '../../lib/help/helpContent';
import './HelpMarkdown.css';

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const textOf = (node: HastNode | undefined): string =>
  !node ? '' : node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');

/** An `orbit:/…` link to a page of the app (not another article): drawn as a button. */
const isAppLink = (href: unknown): href is string =>
  typeof href === 'string' && href.startsWith(ORBIT_LINK_PREFIX) && helpArticleLink(href) === null;

/** Keeps `orbit:/…` hrefs for the components below; every other URL goes through react-markdown's safe transform. */
function urlTransform(url: string): string {
  return url.startsWith(ORBIT_LINK_PREFIX) ? url : defaultUrlTransform(url);
}

/**
 * A help article's body as the web reads it (docs/mocks/help-center boards 01 §2/§4, 03): only the web's
 * platform passages, `##` headings carrying the anchors "On this page" links to, code blocks with Copy, links to
 * other articles as links, and in-app `orbit:/…` links as buttons that go where the target is for this reader.
 * A button whose target does not exist for them (signed out included) is not drawn: alone in its paragraph the
 * paragraph goes, in a sentence its words stay as plain text. Links into the docs repository (`../x.md`) are
 * words on the web, which has no page for them.
 */
export function HelpMarkdown({ body, account }: { body: string; account: HelpLinkAccount | null }) {
  const components: Components = {
    h2: ({ node, children }) => <h2 id={headingId(textOf(node as HastNode))}>{children}</h2>,
    p: ({ node, children }) => {
      const kids = ((node as HastNode | undefined)?.children ?? []).filter((c) => !(c.type === 'text' && !c.value?.trim()));
      const only = kids.length === 1 && kids[0].tagName === 'a' ? kids[0] : null;
      if (only && isAppLink(only.properties?.href) && resolveOrbitLink(only.properties.href as string, account) === null) {
        return null;
      }
      return <p>{children}</p>;
    },
    a: ({ href, children }) => {
      if (typeof href === 'string' && href.startsWith(ORBIT_LINK_PREFIX)) {
        const to = resolveOrbitLink(href, account);
        if (!isAppLink(href)) return to ? <Link to={to}>{children}</Link> : <>{children}</>;
        if (!to) return <>{children}</>;
        return (
          <Link className="help-md-action" to={to} data-orbit-link={href}>
            {children}
            <span className="help-md-action-chevron" aria-hidden> ›</span>
          </Link>
        );
      }
      if (typeof href === 'string' && /^https?:\/\//.test(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      }
      if (typeof href === 'string' && href.startsWith('#')) return <a href={href}>{children}</a>;
      return <>{children}</>;
    },
    pre: ({ node, children }) => <CodeBlock text={textOf(node as HastNode)}>{children}</CodeBlock>,
  };
  return (
    <div className="help-md">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} urlTransform={urlTransform} components={components}>
        {forPlatform(body, 'web')}
      </Markdown>
    </div>
  );
}

function CodeBlock({ text, children }: { text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="help-md-code">
      <pre>{children}</pre>
      <button
        type="button"
        className="help-md-copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text.replace(/\n$/, '')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
