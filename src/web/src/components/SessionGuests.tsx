import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { getSessionGuests, getSessionGuestSuggestions, inviteSessionGuest, removeSessionGuest } from '../api';
import { lastInvitedLabel, matchGuestSuggestions, type GuestSuggestionMatch, type MatchRange } from '../lib/guestSuggestions';
import type { SessionReach } from '../lib/sessionReach';
import { countOf } from '../lib/shareLinks';
import { useToast } from '../lib/toast';
import { Autocomplete } from './ui/Autocomplete';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { Checkbox } from './ui/Checkbox';

/** When an invitation's email went out, as the row says it: the hour and minute, local time. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** The session's permission mode as the consequence line says it (docs/session-guests-design.md §3). */
const MODE_WORDS: Record<string, string> = {
  default: 'Default',
  plan: 'Plan',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  dontAsk: 'Don’t ask',
  bypassPermissions: 'Bypass permissions',
};

/** The modes in which the agent acts on a guest's message without asking anyone first. */
const UNASKING_MODES = new Set(['auto', 'dontAsk', 'bypassPermissions']);

export const GUESTS_ACKNOWLEDGE = 'I understand the agent won’t ask before acting on their messages';

/**
 * What inviting someone means, said in the dialog rather than in a separate warning (§3): their messages run on the
 * owner's machine, in the session's mode, on the owner's accounts. In a mode that does not ask, the line is amber and
 * says so instead of promising the approvals that will not come.
 */
export function guestConsequence(runnerName: string, permissionMode: string): { text: string; warn: boolean } {
  const warn = UNASKING_MODES.has(permissionMode);
  const runs = `They can send messages to this session. The agent runs them on ${runnerName} as ${MODE_WORDS[permissionMode] ?? permissionMode}, using your accounts`;
  return warn
    ? { text: `${runs} — it won’t ask before acting.`, warn }
    : { text: `${runs}. Approvals and the agent’s questions still come only to you.`, warn };
}

export const guestsQueryKey = (sessionId: string) => ['session-guests', sessionId] as const;
const suggestionsQueryKey = (sessionId: string) => ['session-guest-suggestions', sessionId] as const;

/** `text` with the part that matched what was typed in bold. */
function marked(text: string, range: MatchRange | null): ReactNode {
  if (!range) return text;
  return (
    <>
      {text.slice(0, range[0])}
      <b>{text.slice(range[0], range[1])}</b>
      {text.slice(range[1])}
    </>
  );
}

/** One suggestion under the email field: who, their email, and when the owner last invited them. */
function SuggestionRow({ match }: { match: GuestSuggestionMatch }) {
  const { person } = match;
  return (
    <span className="share-suggestion">
      <Avatar size={24} className="share-person-avatar">
        {person.name.trim().charAt(0).toUpperCase() || '?'}
      </Avatar>
      <span className="share-suggestion-main">
        <span className="share-suggestion-name">{marked(person.name, match.name)}</span>
        <span className="share-suggestion-email">{marked(person.email, match.email)}</span>
      </span>
      <span className="share-suggestion-when">{lastInvitedLabel(person.lastInvitedAt)}</span>
    </span>
  );
}

/**
 * People who can reply: the Share dialog's section for a session (docs/session-guests-design.md §3; board
 * docs/mocks/share-links/10-session-guests-2). An email and Invite, one row per guest with today's messages, and
 * Remove, which takes effect at once. The first invite to a session in Auto, Don't ask or Bypass asks the owner to
 * tick that the agent won't ask before acting on a guest's message.
 */
export function SessionGuestsSection({
  sessionId,
  runnerName,
  permissionMode,
}: {
  sessionId: string;
  runnerName: string;
  permissionMode: string;
}) {
  const qc = useQueryClient();
  const message = useToast();
  const key = guestsQueryKey(sessionId);
  const guestsQ = useQuery({
    queryKey: key,
    meta: { entities: ['session'], sessionReach: { session: sessionId } satisfies SessionReach },
    queryFn: () => getSessionGuests(sessionId),
  });
  const suggestionsQ = useQuery({
    queryKey: suggestionsQueryKey(sessionId),
    meta: { entities: ['session'], sessionReach: { session: sessionId } satisfies SessionReach },
    queryFn: () => getSessionGuestSuggestions(sessionId),
  });
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // The list's two-person icon reads the row's `hasGuests`.
  const settle = (answer: Awaited<ReturnType<typeof getSessionGuests>>) => {
    qc.setQueryData(key, answer);
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    // Who can now reply here leaves the suggestions; someone removed comes back to them.
    void qc.invalidateQueries({ queryKey: suggestionsQueryKey(sessionId) });
  };
  const inviteMut = useMutation({
    mutationFn: (to: string) => inviteSessionGuest(sessionId, to),
    onSuccess: (answer) => {
      settle(answer);
      setEmail('');
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });
  const removeMut = useMutation({
    mutationFn: (userId: string) => removeSessionGuest(sessionId, userId),
    onSuccess: settle,
    onError: (e: Error) => message.error("Couldn't remove them", e.message),
  });

  const guests = guestsQ.data?.guests ?? [];
  const matches = matchGuestSuggestions(suggestionsQ.data?.people ?? [], email);
  const consequence = guestConsequence(runnerName, permissionMode);
  const needsAcknowledge = consequence.warn && guestsQ.isSuccess && guests.length === 0;
  const canInvite = email.trim() !== '' && !inviteMut.isPending && (!needsAcknowledge || acknowledged);
  const invite = () => {
    if (canInvite) inviteMut.mutate(email.trim());
  };

  return (
    <section className="share-people" aria-label="People who can reply">
      <div className="share-dialog-label">People who can reply</div>
      <div className="share-people-box">
        <form
          className="share-people-invite"
          onSubmit={(e) => {
            e.preventDefault();
            invite();
          }}
        >
          <Autocomplete
            className="share-people-email"
            type="email"
            aria-label="Email of an Orbit account"
            placeholder="Email of an Orbit account"
            value={email}
            invalid={!!error}
            onValueChange={(next) => {
              setEmail(next);
              setError(null);
            }}
            items={matches}
            itemToValue={(match) => match.person.email}
            renderItem={(match) => <SuggestionRow match={match} />}
            header={email.trim() === '' ? <div className="share-suggestion-head">People you’ve invited before</div> : undefined}
          />
          <Button type="submit" variant="primary" disabled={!canInvite} loading={inviteMut.isPending}>
            Invite
          </Button>
        </form>
        {error && (
          <div className="share-people-error" role="alert">
            {error}
          </div>
        )}
        {guests.map((guest) => (
          <div key={guest.userId} className="share-person" data-guest={guest.email}>
            <Avatar size={28} className="share-person-avatar">
              {guest.name.trim().charAt(0).toUpperCase() || '?'}
            </Avatar>
            <div className="share-person-main">
              <div className="share-person-name">{guest.name}</div>
              <div className="share-person-email">{guest.email}</div>
            </div>
            <span className="share-person-today">
              {guest.opened || guest.messagesToday > 0
                ? `${countOf(guest.messagesToday, 'message')} today`
                : guest.emailSentAt
                  ? `Invited by email · ${clockTime(guest.emailSentAt)}`
                  : 'Not opened yet'}
            </span>
            <Button
              size="small"
              aria-label={`Remove ${guest.name}`}
              disabled={removeMut.isPending}
              onClick={() => removeMut.mutate(guest.userId)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <div className={`share-people-consequence${consequence.warn ? ' is-warn' : ''}`}>{consequence.text}</div>
      {needsAcknowledge && (
        <Checkbox className="share-people-ack" checked={acknowledged} onCheckedChange={setAcknowledged}>
          {GUESTS_ACKNOWLEDGE}
        </Checkbox>
      )}
    </section>
  );
}
