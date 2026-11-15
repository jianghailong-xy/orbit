import { CloseOutlined, ExportOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { HELP_PATH, useHelpDrawer, type HelpTab } from '../lib/helpDrawer';
import { Segmented } from './ui/Segmented';
import { Tooltip } from './ui/Tooltip';
import './HelpDrawer.css';

const TABS: { value: HelpTab; label: string }[] = [
  { value: 'articles', label: 'Articles' },
  { value: 'ask', label: 'Ask' },
];

/**
 * The help drawer (board docs/mocks/help-center/01-web.png ①): docked at the window's right, 380 wide, a column beside
 * the page that narrows it rather than lying over it. It takes the right-hand slot the wiki chat docks in, so the two
 * never show together (WikiChatHost closes its panel when this opens, and closes this when its panel opens).
 * Drawn by each window that has it — the app shell and Settings — from the state `HelpDrawerProvider` keeps.
 */
export function HelpDrawer() {
  const help = useHelpDrawer();
  const navigate = useNavigate();
  if (!help.open) return null;
  return (
    <aside className="help-drawer" aria-label="Help">
      <header className="help-drawer-head">
        <h2 className="help-drawer-title">Help</h2>
        <Segmented size="small" aria-label="Help view" value={help.tab} onValueChange={help.setTab} options={TABS} />
        <Tooltip content="Open in help center">
          <button
            type="button"
            className="help-drawer-icon"
            aria-label="Open in help center"
            onClick={() => {
              help.closeHelp();
              navigate(HELP_PATH);
            }}
          >
            <ExportOutlined />
          </button>
        </Tooltip>
        <Tooltip content="Close">
          <button type="button" className="help-drawer-icon" aria-label="Close help" onClick={help.closeHelp}>
            <CloseOutlined />
          </button>
        </Tooltip>
      </header>
      <div className="help-drawer-body">
        {help.tab === 'articles' ? <HelpArticlesPane slug={help.slug} /> : <HelpAskPane query={help.query} />}
      </div>
    </aside>
  );
}

/** The Articles tab: a placeholder until the drawer's articles land (For this page, reading, search). */
function HelpArticlesPane({ slug }: { slug: string | null }) {
  return (
    <div className="help-drawer-placeholder" data-help-pane="articles" data-help-slug={slug ?? undefined}>
      Articles will appear here.
    </div>
  );
}

/** The Ask tab: a placeholder until Ask lands. */
function HelpAskPane({ query }: { query: string | null }) {
  return (
    <div className="help-drawer-placeholder" data-help-pane="ask" data-help-query={query ?? undefined}>
      Ask will appear here.
    </div>
  );
}
