import { useState } from 'react';
import { AlignLeftOutlined, CloseOutlined, EllipsisOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { refreshSessionRecap, type RecapOutcome } from '../api';
import { sessionQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Glyph } from './ProjectPanoramaHeader';
import { Menu } from './ui/Menu';

/** The card's words. The native clients say the same ones (OrbitKit `RecapCard`, Android's
 *  `RecapCard`), and their copy-parity tests hold them to this file. */
export const RECAP_CARD_COPY = {
  word: 'Recap',
  more: 'Recap actions',
  refresh: 'Refresh recap',
  hide: 'Hide recap',
  upToDate: 'The recap is already up to date.',
  tooLittle: "There's too little to recap yet.",
  unavailable: "Recaps aren't available on this server.",
  failed: "Couldn't refresh the recap. Try again.",
} as const;

/** When the recap was written: "5:38 PM" today, "Wed, Aug 6, 5:38 PM" beyond it, because a bare
 *  clock time on another day misleads. Null for a recap with no stamp (an older control plane). */
export function recapWhen(recapAt?: string | null, now: Date = new Date()): string | null {
  const at = recapAt ? new Date(recapAt) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** What a recap this device hid is remembered by (the owner, 2026-11-01,
 *  docs/mocks/session-recap-display/06-hide): when it was written, so the next one the server writes
 *  shows again — or its words, for a recap that came with no time (an older control plane). */
export const recapHideKey = (recapAt: string | null | undefined, text: string): string =>
  recapAt || `text:${text}`;

/** Where this device keeps the recap it hid in a conversation: one entry per session. */
const recapHiddenStorageKey = (sessionId: string): string => `orbit.recap.hidden.${sessionId}`;

/** The recap this device hid in the conversation (`recapHideKey`), or null. */
export function readHiddenRecap(sessionId: string): string | null {
  try {
    return localStorage.getItem(recapHiddenStorageKey(sessionId));
  } catch {
    return null;
  }
}

export function rememberHiddenRecap(sessionId: string, key: string): void {
  try {
    localStorage.setItem(recapHiddenStorageKey(sessionId), key);
  } catch {
    /* the memory is a convenience; losing it only brings the recap back */
  }
}

/** What a refresh that wrote nothing says, by the pass's reason (sessions/recap.ts
 *  `RecapSkipReason`). Null when it says nothing: another pass wrote first, and the refetch shows
 *  that one's line. */
export function recapRefreshNotice(reason: string): { text: string; failed: boolean } | null {
  switch (reason) {
    case 'cas-lost':
      return null;
    case 'no-events':
      return { text: RECAP_CARD_COPY.upToDate, failed: false };
    case 'too-few-events':
      return { text: RECAP_CARD_COPY.tooLittle, failed: false };
    case 'no-key':
    case 'disabled':
      return { text: RECAP_CARD_COPY.unavailable, failed: false };
    default:
      return { text: RECAP_CARD_COPY.failed, failed: true };
  }
}

/**
 * The conversation's last row while it is at rest (the owner, 2026-10-22,
 * docs/mocks/session-recap-display/04-decided): the recap its list row reads in one line, here in
 * full, with when it was written and a way to write it again now. Where it is drawn and when it
 * steps aside is the conversation's business (WorkspaceView); this is the card.
 *
 * Drawn as a footnote, not a panel (the owner, 2026-10-27, 05-quiet A): a filled box the composer's
 * shape, sitting on the composer, read as something floating over the conversation. So it is one
 * paragraph in the list line's own size and colour — the head runs into the recap. Refresh, and the
 * × that hides this recap in this conversation on this device (06-hide; the conversation remembers
 * that), sit behind one ⋯ at the end of the last line (07-last-line B, 2026-11-02): beside the first
 * line they held a column down the whole card. The ⋯ shows under the pointer, on keyboard focus and
 * while its menu is open (always, on a screen with no hover).
 */
export function SessionRecapCard({
  sessionId,
  text,
  recapAt,
  onHide,
}: {
  sessionId: string;
  text: string;
  recapAt?: string | null;
  onHide: () => void;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const refresh = useMutation({
    mutationFn: () => refreshSessionRecap(sessionId),
    onSuccess: async (outcome: RecapOutcome) => {
      if (!outcome.written) {
        const notice = recapRefreshNotice(outcome.reason);
        if (notice?.failed) {
          message.error(notice.text);
          return;
        }
        if (notice) {
          message.info(notice.text);
          return;
        }
      }
      // A pass wrote: read the session again, which is where this card's line and time come from,
      // and the lists, whose row reads the same line.
      await qc.invalidateQueries({ queryKey: sessionQuery(sessionId).queryKey });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: () => message.error(RECAP_CARD_COPY.failed),
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const when = recapWhen(recapAt);
  return (
    <div className={`chat-recap${refresh.isPending ? ' is-busy' : ''}${menuOpen ? ' is-open' : ''}`} aria-busy={refresh.isPending || undefined}>
      <p className="chat-recap-line">
        <span className="chat-recap-head">
          <AlignLeftOutlined aria-hidden="true" />
          <span className="chat-recap-word">{RECAP_CARD_COPY.word}</span>
          {when && <span className="chat-recap-when">· {when}</span>}
        </span>
        <span className="chat-recap-text">{text}</span>
      </p>
      <span className="chat-recap-actions">
        <Menu
          side="bottom"
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          disabled={refresh.isPending}
          items={[
            { key: 'refresh', icon: <ReloadOutlined />, label: RECAP_CARD_COPY.refresh, onSelect: () => refresh.mutate() },
            { key: 'hide', icon: <CloseOutlined />, label: RECAP_CARD_COPY.hide, onSelect: onHide },
          ]}
          trigger={
            <button type="button" className="chat-recap-more" aria-label={RECAP_CARD_COPY.more}>
              {refresh.isPending ? <Glyph shape="spinner" color="currentColor" size={13} /> : <EllipsisOutlined />}
            </button>
          }
        />
      </span>
    </div>
  );
}
