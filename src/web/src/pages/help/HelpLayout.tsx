import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HELP_ADMIN_CATEGORY, HELP_CATEGORIES, type HelpCategory } from '@orbit/shared';
import { LeftOutlined, MenuOutlined } from '@ant-design/icons';
import { getToken } from '../../api';
import { HelpDrawer } from '../../components/HelpDrawer';
import { helpArticlePath, helpIndexQuery } from '../../lib/help/helpQueries';
import { settingsReturnPath } from '../../lib/settingsReturn';
import { useMediaQuery } from '../../lib/useMediaQuery';
import '../../components/settings/Settings.css';
import './Help.css';

/** Below this width (board 01 §3) the nav folds into a menu button above the page. */
export const NARROW_HELP_QUERY = '(max-width: 899.98px)';

/** The categories before the index answers: every one but the administrators' (the server decides who sees it). */
const FALLBACK_CATEGORIES: HelpCategory[] = HELP_CATEGORIES.filter((c) => c.slug !== HELP_ADMIN_CATEGORY);

/**
 * The help center's window (docs/mocks/help-center board 01 §3–4), drawn as Settings is: its own nav in place of
 * the app's sidebar — "‹ Back to Orbit", Home, the categories the reader may see (the open one listing its
 * articles), and More — with the page beside it. It is outside the sign-in gate, so an article reads signed out.
 * Narrower than 900px the nav is a menu the button above the page opens. Signed in, the help drawer docks at the
 * right as it does in Settings, a column that narrows the page; signed out it never opens, so nothing is drawn.
 */
export function HelpLayout() {
  const narrow = useMediaQuery(NARROW_HELP_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);
  return (
    <div className={narrow ? 'settings-shell help-shell help-shell--narrow' : 'settings-shell help-shell'}>
      {(!narrow || menuOpen) && <HelpNav />}
      <main className="settings-main help-main">
        {narrow && (
          <button
            type="button"
            className="help-menu-button"
            aria-label="Help menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MenuOutlined />
            <span>Help center</span>
          </button>
        )}
        <Outlet />
      </main>
      <HelpDrawer />
    </div>
  );
}

function HelpNav() {
  const navigate = useNavigate();
  const { category: openCategory } = useParams();
  const index = useQuery(helpIndexQuery());
  const categories = index.data?.categories ?? FALLBACK_CATEGORIES;
  const signedIn = !!getToken();
  return (
    <nav className="settings-nav help-nav autohide-scrollbar" aria-label="Help">
      <button type="button" className="settings-back" onClick={() => navigate(signedIn ? settingsReturnPath() : '/')}>
        <LeftOutlined />
        <span>Back to Orbit</span>
      </button>
      <div className="settings-nav-groups help-nav-groups">
        <HelpNavRow to="/help" label="Home" end />
        <div className="settings-nav-group" role="group" aria-label="Categories">
          <div className="settings-nav-heading">
            <span>Categories</span>
          </div>
          {categories.map((category) => (
            <div key={category.slug}>
              <HelpNavRow to={`/help/${category.slug}`} label={category.title} end />
              {category.slug === openCategory && (
                <div className="help-nav-articles">
                  {(index.data?.articles ?? [])
                    .filter((article) => article.category === category.slug)
                    .map((article) => (
                      <HelpNavRow key={article.slug} to={helpArticlePath(article)} label={article.title} />
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="settings-nav-group" role="group" aria-label="More">
          <div className="settings-nav-heading">
            <span>More</span>
          </div>
          <HelpNavRow to="/help/whats-new" label="What's new" />
          {signedIn && <HelpNavRow to="/help/questions" label="Your questions" />}
        </div>
      </div>
    </nav>
  );
}

function HelpNavRow({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `settings-nav-row help-nav-row${isActive ? ' active' : ''}`}>
      <span className="settings-nav-label">{label}</span>
    </NavLink>
  );
}
