import { AlignLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { refreshSessionRecap, type RecapOutcome } from '../api';
import { sessionQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Glyph } from './ProjectPanoramaHeader';

/** The card's words. The native clients say the same ones (OrbitKit `RecapCard`, Android's
 *  `RecapCard`), and their copy-parity tests hold them to this file. */
export const RECAP_CARD_COPY = {
  word: 'Recap',
  refresh: 'Refresh recap',
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
 * paragraph in the list line's own size and colour — the head runs into the recap — and Refresh
 * shows only under the pointer or keyboard focus (always, on a screen with no hover).
 */
export function SessionRecapCard({
  sessionId,
  text,
  recapAt,
}: {
  sessionId: string;
  text: string;
  recapAt?: string | null;
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
  const when = recapWhen(recapAt);
  return (
    <div className={`chat-recap${refresh.isPending ? ' is-busy' : ''}`} aria-busy={refresh.isPending || undefined}>
      <p className="chat-recap-line">
        <span className="chat-recap-head">
          <AlignLeftOutlined aria-hidden="true" />
          <span className="chat-recap-word">{RECAP_CARD_COPY.word}</span>
          {when && <span className="chat-recap-when">· {when}</span>}
        </span>
        <span className="chat-recap-text">{text}</span>
      </p>
      <button
        type="button"
        className="chat-recap-refresh"
        aria-label={RECAP_CARD_COPY.refresh}
        title={RECAP_CARD_COPY.refresh}
        disabled={refresh.isPending}
        onClick={() => refresh.mutate()}
      >
        {refresh.isPending ? <Glyph shape="spinner" color="currentColor" size={13} /> : <ReloadOutlined />}
      </button>
    </div>
  );
}
