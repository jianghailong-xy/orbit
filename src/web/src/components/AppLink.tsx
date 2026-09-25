import { useContext, type AnchorHTMLAttributes } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { PublicLinkResolverCtx, publicDestination } from '../lib/publicLinks';

/**
 * A link to a page of this app, drawn as a link even where there is no router to route with.
 *
 * `<Link>` reads the router out of context, so it throws where there is none ("Cannot destructure
 * property 'basename'"), and one of the places a transcript is drawn has no router at all: the
 * standalone HTML export (lib/sessionExport), which renders through `renderToStaticMarkup` into a
 * fresh tree — the router the page itself sits under does not reach it. A session carrying an Orbit
 * reference, a task-start card or an exception item therefore failed to export at all.
 *
 * The exported file needs more than "not throwing": it is opened from disk, offline, where the
 * router's own path (`/tasks/<id>`) resolves against the filesystem and goes nowhere. So outside a
 * router the destination is the whole URL, which is what a saved file's links have to be.
 *
 * On a public page (PublicLinkResolverCtx) the destination is the page's to give, not the app's: an
 * object inside what the link shares goes to its public address, and anything else is its words.
 */
export function AppLink({
  to,
  children,
  ...rest
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const inRouter = useInRouterContext();
  const resolve = useContext(PublicLinkResolverCtx);
  const dest = resolve ? publicDestination(to, resolve) : to;
  if (dest == null) return <>{children}</>;
  if (inRouter) {
    return (
      <Link {...rest} to={dest}>
        {children}
      </Link>
    );
  }
  return (
    <a {...rest} href={absoluteUrl(dest)}>
      {children}
    </a>
  );
}

/** The destination as a URL the page's own origin can open — the only kind an offline file has. */
function absoluteUrl(to: string): string {
  return typeof window === 'undefined' ? to : new URL(to, window.location.origin).href;
}
