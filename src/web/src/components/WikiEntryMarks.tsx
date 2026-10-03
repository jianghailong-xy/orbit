import { CheckCircleOutlined, CheckOutlined, GlobalOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { relTime } from './Transcript';
import { WikiRejectButton, useRejectEntry } from './WikiRunPage';
import {
  WIKI_HISTORY_CONFIRMED_BY,
  WIKI_HISTORY_MAINTENANCE,
  WIKI_HISTORY_PROPOSED_BY,
  WIKI_HISTORY_SYSTEM,
  type WikiEntryDetail,
} from '../lib/wiki';
import {
  WIKI_CONFIRM,
  WIKI_CONFIRMED,
  wikiCanConfirm,
  wikiCheckedLine,
  wikiEntryAnswerable,
  wikiMarkBanner,
} from '../lib/wikiReviewMode';
import { confirmWikiEntry, useWikiWrite } from '../lib/wikiWrites';
import { useToast } from '../lib/toast';

/**
 * The owner's two answers to what a review mode applied (mocks 17–18 ①): Confirm for an entry agents
 * are not sent yet, and Reject ▾ with its reason for either — in Review's own order, the primary
 * answer first. Drawn only for a live entry whose trust is Auto or Unreviewed; what the owner wrote
 * or confirmed is retired from the ⋯ menu, and a proposal is answered in Review.
 */
export function WikiEntryAnswers({ entry }: { entry: WikiEntryDetail }) {
  const message = useToast();
  const confirm = useWikiWrite((entryId: string) => confirmWikiEntry(entryId));
  const reject = useRejectEntry();
  if (!wikiEntryAnswerable(entry)) return null;
  return (
    <>
      {wikiCanConfirm(entry) && (
        <Button
          type="primary"
          icon={<CheckOutlined />}
          loading={confirm.isPending}
          onClick={async () => {
            try {
              await confirm.mutateAsync(entry.id);
              message.success(WIKI_CONFIRMED, entry.title);
            } catch (error) {
              message.error("Couldn't confirm the entry", error instanceof Error ? error.message : undefined);
            }
          }}
        >
          {WIKI_CONFIRM}
        </Button>
      )}
      <WikiRejectButton onReject={(reason) => void reject(entry.id, reason)} />
    </>
  );
}

/**
 * The bar under an entry's head (mock 17 ③): what its mark means for agents in one sentence, then who
 * checked it and what they said, and who applied it, when.
 *
 * THE VERDICT IS THE ONE ITS CURRENT REVISION WAS APPLIED ON: the entry's read says where that revision
 * came from (`verification`, contract `reviewModes.run.entry`), whether or not anything of its run
 * still waits in Review; who applied it and when come from the entry's own History.
 */
export function WikiMarkBar({ entry }: { entry: WikiEntryDetail }) {
  const banner = wikiMarkBanner(entry);
  if (!banner) return null;
  const current = [...(entry.history ?? [])].sort((a, b) => b.revision - a.revision)[0];
  const line = wikiCheckedLine({
    verification: entry.verification ?? null,
    tainted: entry.tainted,
    who: current ? historyWho(current.authorKind) : null,
    when: current ? relTime(current.createdAt) : null,
  });
  const icon =
    banner.tone === 'amber' ? <GlobalOutlined className="ic" /> : banner.tone === 'green' ? <CheckCircleOutlined className="ic" /> : <InfoCircleOutlined className="ic" />;
  return (
    <div className={`wk-markbar tone-${banner.tone}`} role="note">
      {icon}
      <div>
        <div>
          <b>{banner.lead}</b> · {banner.text}
        </div>
        {line && <div className="wk-markbar-line">{line}</div>}
      </div>
    </div>
  );
}

/** Who wrote a revision, in the History section's own words. */
function historyWho(authorKind: string): string {
  switch (authorKind) {
    case 'owner':
      return WIKI_HISTORY_CONFIRMED_BY;
    case 'maintenance':
      return WIKI_HISTORY_MAINTENANCE;
    case 'system':
      return WIKI_HISTORY_SYSTEM;
    default:
      return WIKI_HISTORY_PROPOSED_BY;
  }
}
