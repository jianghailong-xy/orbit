import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  WikiAnchorInput,
  WikiDecideAction,
  WikiEntryChanges,
  WikiEntryDraft,
  WikiKind,
  WikiOpInput,
  WikiOpOutcome,
  WikiRejectReason,
} from '@orbit/shared';
import { api } from '../api';
import type { WikiEntry } from './wiki';

/**
 * The Wiki's two writes, as this app makes them.
 *
 * BOTH GO TO THE OWNER'S DOOR, and that is the whole point rather than an implementation detail:
 * `POST /wiki/spaces/:id/changesets` is the same entry point an agent's proposal takes
 * (`WikiService.submitChangeset`), and being the owner is what makes its ops apply at once instead of
 * waiting in Review. `POST /wiki/changesets/:id/decide` is the owner's answer to somebody else's, and
 * the server refuses it to any request carrying a session header whatever that session's role — so
 * there is no client-side version of this that could decide as an agent, which is what design §4.1
 * asks for.
 *
 * WHAT THE BODIES ARE is pure and exported: the drawer's three actions and Review's three answers are
 * each one shape of a request, and a shape built inside a component is one no test can hold.
 */

/** One op, submitted. The door validates it; this only names it. */
export interface WikiProposeBody {
  rationale: string;
  idempotencyKey: string;
  ops: WikiOpInput[];
}

/** A key that makes a retried submission a replay rather than a second change. */
export function wikiIdempotencyKey(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${random}`;
}

/**
 * The owner's edit of an entry, as an amend over the revision they were looking at.
 *
 * `baseRevision` is the compare-and-set: the server refuses an amend written against a revision that
 * has moved, and answers with the current one — which is the honest outcome for an entry somebody
 * else changed while this page was open.
 */
export function amendOp(entry: WikiEntry, changes: WikiEntryChanges): WikiOpInput {
  return { op: 'amend', entryId: entry.id, baseRevision: entry.currentRevision, changes };
}

/**
 * The owner's replacement for an entry: a new lineage of the same kind, carrying what they wrote.
 *
 * `anchors` is stripped of its `check` block on the way out — that block is the server's record of
 * the last re-check, and a proposer never sends one (`WikiAnchor` is `WikiAnchorInput` plus a check).
 */
export function supersedeOp(entry: WikiEntry, draft: WikiEntryDraft): WikiOpInput {
  return { op: 'supersede', entryId: entry.id, baseRevision: entry.currentRevision, entry: draft };
}

/** What a supersede starts from: the entry as it stands, minus the parts the server owns. */
export function draftFromEntry(entry: WikiEntry, overrides: { title?: string; summary?: string } = {}): WikiEntryDraft {
  return {
    kind: entry.kind as WikiKind,
    title: overrides.title ?? entry.title,
    summary: overrides.summary ?? entry.summary,
    fields: entry.fields as unknown as WikiEntryDraft['fields'],
    topics: [...entry.topics],
    aliases: [...entry.aliases],
    anchors: (entry.anchors ?? []).map((anchor) => {
      const { check: _check, ...input } = anchor;
      return input as WikiAnchorInput;
    }),
  } as WikiEntryDraft;
}

/** Taking an entry away from agents, with the reason it goes. */
export function retireOp(entry: WikiEntry, reason: string): WikiOpInput {
  return { op: 'retire', entryId: entry.id, baseRevision: entry.currentRevision, reason };
}

/** The owner's answer to one pending op. `edited` is what `action: 'edit'` carries. */
export interface WikiDecision {
  opId: string;
  action: WikiDecideAction;
  edited?: WikiEntryChanges;
  reason?: WikiRejectReason;
  note?: string;
}

/** `POST /api/wiki/spaces/:id/changesets` — the owner's own write, applied at once. */
export function proposeToWiki(spaceId: string, body: WikiProposeBody): Promise<{ ops: WikiOpOutcome[] }> {
  return api(`/wiki/spaces/${encodeURIComponent(spaceId)}/changesets`, { method: 'POST', body });
}

/** `POST /api/wiki/changesets/:id/decide` — the owner's answer, refused to every session. */
export function decideWikiChangeset(changesetId: string, decisions: WikiDecision[]): Promise<unknown> {
  return api(`/wiki/changesets/${encodeURIComponent(changesetId)}/decide`, {
    method: 'POST',
    body: { decisions },
  });
}

/**
 * A wiki write, and the re-read that follows it.
 *
 * `['wiki']` and not a narrower key: a write can move the sidebar's count, the space's entry list, the
 * review queue and the home page's timeline at once, and the event the server publishes for it
 * (`wiki.changed`) says only that the space moved — so the client re-reads the same group the event
 * would. See `lib/queries.ts` for why every wiki read hangs off that prefix.
 */
export function useWikiWrite<TBody, TResult>(run: (body: TBody) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['wiki'] });
    },
  });
}
