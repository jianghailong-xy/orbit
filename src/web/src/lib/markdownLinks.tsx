import type { AnchorHTMLAttributes } from 'react';
import { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import { Link } from 'react-router-dom';
import { SameOriginLink } from '../components/SameOriginLink';
import { encodeId } from './idCodec';

/** `#`-references the composer materialises, and the same links agents are told to write when they
 *  name a task, session, project or list to the user (runner-go agent_instructions.go), so a reply
 *  reads as titles rather than bare ids. Both spellings of the id are accepted, since what a client
 *  holds is the base62 public id and older messages may carry the raw uuid. */
const ORBIT_REFERENCE_RE = /^orbit-(list|task|session|project):([0-9a-zA-Z-]+)$/;

/**
 * react-markdown's built-in urlTransform blanks any href whose scheme isn't on its allow-list
 * (http, https, mailto, …), so a `#`-reference would reach ReferenceLink as href="" — which in an
 * SPA reloads the page on click. Let references through untouched and defer every other URL to the
 * default (XSS-safe) transform so javascript:/data: links stay neutralized.
 *
 * Passed together with ReferenceLink by every surface that renders what a person or an agent wrote
 * as Markdown: a task's comments, a project's goal, instructions and criteria, the approval cards,
 * and the transcript, whose own transform also lets its attachments through.
 */
export function referenceUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (ORBIT_REFERENCE_RE.test(trimmed)) return trimmed;
  return defaultUrlTransform(url);
}

const REFERENCE_ROUTES = {
  list: { base: '/lists', label: 'Task list' },
  task: { base: '/tasks', label: 'Task' },
  session: { base: '/sessions', label: 'Session' },
  project: { base: '/projects', label: 'Project' },
} as const;

/**
 * The route a `#`-reference points at, or null when the href is not one — including when the id
 * is unparseable, which prose is entitled to contain. A bad reference falls through to a plain
 * inert link rather than throwing inside the renderer and blanking the whole message.
 */
function referenceRoute(href: unknown): { path: string; label: string } | null {
  if (typeof href !== 'string') return null;
  const m = ORBIT_REFERENCE_RE.exec(href.trim());
  if (!m) return null;
  try {
    const id = encodeId(m[2]);
    const { base, label } = REFERENCE_ROUTES[m[1] as keyof typeof REFERENCE_ROUTES];
    return { path: `${base}/${id}`, label };
  } catch {
    return null;
  }
}

/**
 * The `a` of that Markdown. A `#`-reference routes to the thing it names inside the app; any other
 * link keeps SameOriginLink's page-content semantics.
 */
export function ReferenceLink({
  node: _node,
  href,
  title,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  const to = referenceRoute(href);
  if (to) {
    return (
      <Link className="md-reference" to={to.path} title={to.label}>
        {children}
      </Link>
    );
  }
  return (
    <SameOriginLink {...rest} href={href} title={title}>
      {children}
    </SameOriginLink>
  );
}
