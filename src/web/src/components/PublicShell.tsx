import { Fragment, type ReactNode, type Ref, type UIEventHandler } from 'react';
import { Link } from 'react-router-dom';

/** One step of a public page's breadcrumb. `to` makes it a link: only to a page the same link shares. */
export interface PublicCrumb {
  label: string;
  to?: string;
}

/** The dialog's own sentence for a Live link (docs/share-links-design.md §2), said again where the
 *  link is read. */
const PUBLIC_LIVE_NOTE = 'Live — viewers see changes as they happen';

/**
 * The frame every public (signed-out, read-only) page shares: the brand, the breadcrumb — which is
 * the link's scope, root first, the page being read last — then on the right the page's `status`,
 * the Live mark, Read-only and the page's `actions`; the page's content in one scroller; and the
 * footer. Nothing in it links into the app.
 */
export function PublicShell({
  crumbs,
  status,
  actions,
  scrollRef,
  onScroll,
  children,
}: {
  crumbs: PublicCrumb[];
  status?: ReactNode;
  actions?: ReactNode;
  scrollRef?: Ref<HTMLElement>;
  onScroll?: UIEventHandler<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <div className="share-page">
      <header className="share-header">
        <div className="share-brand">Orbit</div>
        <nav className="share-crumbs" aria-label="Shared">
          {crumbs.map((crumb, i) => {
            const here = i === crumbs.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && <span className="share-crumb-sep" aria-hidden>›</span>}
                {crumb.to && !here ? (
                  <Link className="share-crumb" to={crumb.to} title={crumb.label}>
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    className={`share-crumb${here ? ' is-here' : ''}`}
                    title={crumb.label}
                    aria-current={here ? 'page' : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
              </Fragment>
            );
          })}
        </nav>
        <div className="share-right">
          {status}
          <span className="share-live" title={PUBLIC_LIVE_NOTE}>
            <i aria-hidden />
            Live
          </span>
          <span className="share-badge">Read-only</span>
          {actions}
        </div>
      </header>
      <main className="share-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="share-inner">{children}</div>
      </main>
      <footer className="share-footer">Shared from Orbit · read-only</footer>
    </div>
  );
}
