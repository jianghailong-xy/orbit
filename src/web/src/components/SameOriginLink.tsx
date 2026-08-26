import type { AnchorHTMLAttributes } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

/**
 * Turn an href on the current web origin into the location React Router should receive.
 * Different schemes and ports deliberately count as external, just as they do for the
 * browser's same-origin policy.
 */
export function sameOriginRoute(href: unknown, currentHref?: string): string | null {
  if (typeof href !== 'string' || !href.trim()) return null;
  const value = href.trim();
  const browserHref = typeof window === 'undefined' ? undefined : window.location.href;
  const baseHref = currentHref ?? browserHref;

  // Server rendering has no origin to compare an absolute URL with. Relative web links are
  // still unambiguously local; SameOriginLink will render them as plain anchors when there is
  // no router (for example in a standalone transcript export).
  if (!baseHref) {
    return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') ? null : value;
  }

  try {
    const base = new URL(baseHref);
    const destination = new URL(value, base);
    if (
      !/^https?:$/.test(destination.protocol) ||
      destination.origin !== base.origin ||
      destination.username ||
      destination.password
    ) {
      return null;
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return null;
  }
}

/**
 * Page-content link semantics: same-origin destinations stay in the SPA, while external
 * destinations open in an isolated tab. Outside a router (notably static HTML export), an
 * internal destination degrades to a normal same-tab anchor instead of requiring React context.
 */
export function SameOriginLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const inRouter = useInRouterContext();
  const to = sameOriginRoute(href);
  const nativeSameTab =
    (rest.download !== undefined && rest.download !== false) ||
    (typeof href === 'string' && href.trim().startsWith('#'));

  // Downloads need the browser's native response handling, and a local fragment should retain
  // native anchor scrolling. Neither should be turned into a history navigation or a new tab.
  if (nativeSameTab) {
    return (
      <a {...rest} href={href} target={undefined} rel={undefined}>
        {children}
      </a>
    );
  }

  if (to && inRouter) {
    return (
      <Link {...rest} to={to} target={undefined} rel={undefined}>
        {children}
      </Link>
    );
  }
  if (to) {
    return (
      <a {...rest} href={href} target={undefined} rel={undefined}>
        {children}
      </a>
    );
  }
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
