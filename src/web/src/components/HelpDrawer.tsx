import { CloseOutlined, ExportOutlined, LeftOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { HELP_PATH, useHelpDrawer, type HelpTab } from '../lib/helpDrawer';
import { useHelpLanguage } from '../lib/help/helpLanguage';
import { helpArticlePath, helpIndexQuery } from '../lib/help/helpQueries';
import { HelpArticlesPane } from './help/HelpArticlesPane';
import { HelpAskPane } from './help/HelpAsk';
import { Segmented } from './ui/Segmented';
import { Tooltip } from './ui/Tooltip';
import './HelpDrawer.css';

// The web is built and shipped with the apiserver it talks to (one release), so its version is the server's.
declare const __APP_VERSION__: string;
const SERVER_VERSION = __APP_VERSION__;

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
  const { language } = useHelpLanguage();
  const index = useQuery({ ...helpIndexQuery(language), enabled: help.open });
  if (!help.open) return null;
  const leaveTo = (path: string) => {
    help.closeHelp();
    navigate(path);
  };
  const reading = help.tab === 'articles' && help.slug ? index.data?.articles.find((a) => a.slug === help.slug) : undefined;
  return (
    <aside className="help-drawer" aria-label="Help">
      <header className="help-drawer-head">
        {help.tab === 'articles' && help.slug && (
          <Tooltip content="All articles">
            <button type="button" className="help-drawer-icon" aria-label="All articles" onClick={() => help.openHelp({ tab: 'articles' })}>
              <LeftOutlined />
            </button>
          </Tooltip>
        )}
        <h2 className="help-drawer-title">Help</h2>
        <Segmented size="small" aria-label="Help view" value={help.tab} onValueChange={help.setTab} options={TABS} />
        <Tooltip content="Open in help center">
          <button
            type="button"
            className="help-drawer-icon"
            aria-label="Open in help center"
            onClick={() => leaveTo(reading ? helpArticlePath(reading) : HELP_PATH)}
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
        {help.tab === 'articles' ? <HelpArticlesPane /> : <HelpAskPane query={help.query} article={help.slug} />}
      </div>
      <footer className="help-drawer-foot">
        <button type="button" className="help-drawer-link" onClick={() => leaveTo(HELP_PATH)}>
          Open help center
        </button>
        <button type="button" className="help-drawer-link quiet" onClick={() => leaveTo(`${HELP_PATH}/whats-new`)}>
          What's new in {SERVER_VERSION}
        </button>
      </footer>
    </aside>
  );
}
