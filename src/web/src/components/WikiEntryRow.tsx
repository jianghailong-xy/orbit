import { ExclamationCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import {
  WIKI_NO_LONGER_PUSHED,
  WIKI_STATUS_LABELS,
  WIKI_REVIEW_REJECT,
  WIKI_SUPERSEDED_BY,
  WIKI_WEB_DERIVED,
  wikiAnchorMark,
  wikiEntryPath,
  wikiRowSummary,
  wikiUsedThisWeek,
  type WikiEntry,
} from '../lib/wiki';
import { WikiAnchorMark, WikiKindMark, WikiStatusBadge, WikiTrustBadge } from './WikiMarks';
import { WikiRejectMenu, useRejectEntry } from './WikiRunPage';
import { wikiEntryAnswerable } from '../lib/wikiReviewMode';

/**
 * One entry, in the two shapes the Wiki draws a row in.
 *
 * THE ROW IS THE APP'S PROJECT ROW, not a new one: a 22px kind mark, a two-line main cell (title,
 * then one line of summary) and the facts that decide whether a reader opens it. What differs between
 * the two shapes is only how many facts fit — the home page's cards show the trust badge alone, and a
 * topic page's grid shows all three, which is what the design's own grid measures its columns
 * against (`Confirmed by` / `Anchor` / `This week`).
 *
 * A SUPERSEDED ENTRY STAYS, struck through, naming what replaced it: the design keeps it in History
 * rather than deleting it, because "we tried this and moved on" is knowledge too. Its anchor and use
 * columns are left empty — they describe the entry that is live, and this one is not.
 */
export function WikiEntryRow({
  entry,
  spaceSlug,
  used = 0,
  selected = false,
  changedSinceLastVisit = false,
  warnLine,
  successor,
}: {
  entry: WikiEntry;
  spaceSlug: string;
  /** How many times this entry was used in the window the space read. 0 hides the number. */
  used?: number;
  selected?: boolean;
  /** A blue dot: this entry moved since the reader last opened this topic. White row, like any
   *  other — the tint below belongs to a broken anchor, which is a different and worse fact. */
  changedSinceLastVisit?: boolean;
  /** Why the row is tinted amber and held back from agents: its anchor moved on main. */
  warnLine?: string | null;
  /** The entry that superseded this one, when the list already holds it. */
  successor?: WikiEntry | null;
}) {
  const superseded = entry.status === 'superseded' || entry.status === 'retired' || entry.status === 'rejected';
  const mark = wikiAnchorMark(entry);
  return (
    <div
      className={`wk-erow${superseded ? ' sup' : ''}${selected ? ' is-selected' : ''}${
        warnLine ? ' changed' : ''
      }`}
    >
      <WikiKindMark kind={entry.kind} />
      <div className="main">
        <div className="wk-row-t">
          {changedSinceLastVisit && <span className="wk-new" />}
          <span className="tt">
            <Link to={wikiEntryPath(spaceSlug, entry.id)}>{entry.title}</Link>
          </span>
          {!superseded && entry.tainted && <span className="tdp-badge tone-amber">{WIKI_WEB_DERIVED}</span>}
        </div>
        {superseded ? (
          <div className="supby">
            {successor ? (
              <>
                {`${WIKI_SUPERSEDED_BY} `}
                <Link to={wikiEntryPath(spaceSlug, successor.id)}>{successor.title}</Link>
                {` · ${WIKI_NO_LONGER_PUSHED}`}
              </>
            ) : (
              `${WIKI_STATUS_LABELS[entry.status] ?? entry.status} · ${WIKI_NO_LONGER_PUSHED}`
            )}
          </div>
        ) : (
          <div className="wk-row-d">{wikiRowSummary(entry)}</div>
        )}
        {warnLine && (
          <div className="warnline">
            <ExclamationCircleOutlined className="ic" />
            <span>{warnLine}</span>
          </div>
        )}
      </div>
      <span>
        {superseded ? <WikiStatusBadge status={entry.status} /> : <WikiTrustBadge trust={entry.trust} />}
      </span>
      <span>{superseded ? null : <WikiAnchorMark mark={mark} />}</span>
      <span className="used">
        {superseded || used <= 0 ? null : <span className="n">{wikiUsedThisWeek(used)}</span>}
        {/* What a review mode applied can be taken back from the row itself, on a pointer (mock 17 ⑧). */}
        {wikiEntryAnswerable(entry) && <RowReject entryId={entry.id} />}
      </span>
    </div>
  );
}

function RowReject({ entryId }: { entryId: string }) {
  const reject = useRejectEntry();
  return (
    <WikiRejectMenu onReject={(reason) => void reject(entryId, reason)}>
      <button type="button" className="wk-row-reject">
        {WIKI_REVIEW_REJECT}
      </button>
    </WikiRejectMenu>
  );
}
