import { useHelpDrawer } from '../../lib/helpDrawer';

/**
 * An error card's "Learn more →" (board docs/mocks/help-center/01-web.png ① note 5): opens the help drawer at the
 * article about the error, beside the page, rather than leaving it.
 */
export function HelpLearnMore({ slug }: { slug: string }) {
  const help = useHelpDrawer();
  return (
    <button type="button" className="re-link help-learn-more" data-help-article={slug} onClick={() => help.openHelp({ slug })}>
      Learn more →
    </button>
  );
}
