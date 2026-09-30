import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  WikiAnchorInput,
  WikiDecideAction,
  WikiEntryChanges,
  WikiEntryDraft,
  WikiKind,
  WikiMaintenanceSettings,
  WikiOpInput,
  WikiOpOutcome,
  WikiPlanDecisionResult,
  WikiPlanDocInput,
  WikiPlanGateError,
  WikiPlanRedraftResult,
  WikiPlanSectionInput,
  WikiPlanVersion,
  WikiRejectReason,
  WikiReviewMode,
} from '@orbit/shared';
import { ApiError, api } from '../api';
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

/**
 * Review's Edit, as `edited`: the keys the owner changed in the form, and no others.
 *
 * The server lays `edited` over the proposal key by key (contract `effectPolicy.decide.edit`), so a key
 * sent back unchanged would record the owner as rewriting what they only read. Empty means nothing was
 * changed — which is an Accept, and the form leaves that to the Accept button.
 */
export function wikiEditedChanges(
  proposed: { title: string; summary: string },
  version: { title: string; summary: string },
): WikiEntryChanges {
  const edited: WikiEntryChanges = {};
  if (version.title.trim() !== proposed.title.trim()) edited.title = version.title.trim();
  if (version.summary.trim() !== proposed.summary.trim()) edited.summary = version.summary.trim();
  return edited;
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
 * `POST /api/wiki/entries/:id/confirm` — the owner vouching for what a review mode applied: the entry
 * becomes Confirmed and is pushed from then on. Refused to every session, like a decide.
 */
export function confirmWikiEntry(entryId: string): Promise<unknown> {
  return api(`/wiki/entries/${encodeURIComponent(entryId)}/confirm`, { method: 'POST', body: {} });
}

/**
 * `POST /api/wiki/entries/:id/reject` — the owner taking back what a review mode applied, with one of
 * the four reasons Review's menu offers. The entry ends as rejected, a counter-example like a
 * rejected proposal.
 */
export function rejectWikiEntry(entryId: string, reason: WikiRejectReason): Promise<unknown> {
  return api(`/wiki/entries/${encodeURIComponent(entryId)}/reject`, { method: 'POST', body: { reason } });
}

/** What a revert answers: the changeset it wrote (none when nothing was left to undo), and what it left. */
export interface WikiRevertAnswer {
  revertedChangesetId: string;
  changesetId: string | null;
  replayed?: boolean;
  skipped: Array<{ entryId: string; reason: string }>;
}

/**
 * `POST /api/wiki/changesets/:id/revert` — every op of one run its review mode applied that nobody
 * has answered, taken back at once. Keyed by the run, so a second press answers with the first.
 */
export function revertWikiChangeset(changesetId: string): Promise<WikiRevertAnswer> {
  return api(`/wiki/changesets/${encodeURIComponent(changesetId)}/revert`, { method: 'POST', body: {} });
}

/** What the settings page changes: the review mode, Automatic's spot checks, and maintenance. */
export interface WikiSpaceUpdate {
  reviewMode?: WikiReviewMode;
  automaticSpotChecks?: boolean;
  maintenance?: Partial<Pick<WikiMaintenanceSettings, 'enabled' | 'workspaceId' | 'provider' | 'dailyRunLimit' | 'lookbackDays'>>;
}

/** `PATCH /api/wiki/spaces/:id` — the owner's settings; refused to every session. */
export function updateWikiSpace(spaceId: string, body: WikiSpaceUpdate): Promise<unknown> {
  return api(`/wiki/spaces/${encodeURIComponent(spaceId)}`, { method: 'PATCH', body });
}

// ── The plan's writes (contract `plan.routes`), the owner's door only ───────────────────────────

/**
 * `POST /api/wiki/spaces/:id/plan/redraft` — ask for a draft of the plan; with `instructions`, a revision
 * of its newest version. The server makes it a task of the space's maintenance list, queued behind the
 * list's unfinished task or held with why; a draft that has not ended answers a second press.
 */
export function redraftWikiPlan(spaceId: string, instructions: string | null): Promise<WikiPlanRedraftResult> {
  const words = instructions?.trim() ?? '';
  return api(`/wiki/spaces/${encodeURIComponent(spaceId)}/plan/redraft`, {
    method: 'POST',
    body: words ? { instructions: words } : {},
  });
}

/** `POST …/plan/versions/:version/confirm` — the owner's confirmation of the space's draft. */
export function confirmWikiPlan(spaceId: string, version: number): Promise<WikiPlanVersion> {
  return api(`/wiki/spaces/${encodeURIComponent(spaceId)}/plan/versions/${version}/confirm`, { method: 'POST', body: {} });
}

/**
 * `POST …/plan/edits` — one document, or one of its sections, as the owner rewrote it: a new draft over
 * `baseVersion`, which must still be the newest. The body is the DRAFT's shape (`wikiPlanDocEdit`).
 */
export function editWikiPlan(
  spaceId: string,
  body: { baseVersion: number; docSlug: string; doc: WikiPlanDocInput } | { baseVersion: number; docSlug: string; sectionKey: string; section: WikiPlanSectionInput },
): Promise<WikiPlanVersion> {
  return api(`/wiki/spaces/${encodeURIComponent(spaceId)}/plan/edits`, { method: 'POST', body });
}

/** `POST /api/wiki/plan-proposals/:id/decide` — accept (a new draft) or reject (nothing but the proposal). */
export function decideWikiPlanProposal(proposalId: string, action: 'accept' | 'reject', note?: string): Promise<WikiPlanDecisionResult> {
  return api(`/wiki/plan-proposals/${encodeURIComponent(proposalId)}/decide`, {
    method: 'POST',
    body: note ? { action, note } : { action },
  });
}

/**
 * Accept a proposal, and — with no other draft waiting (`wikiPlanAcceptConfirms`) — confirm the draft
 * accepting it made: two requests, the second only once the first came back with a draft that passed
 * the gate. A refusal of either is the caller's to show; the gate's errors are read with `wikiPlanGateErrors`.
 */
export async function acceptWikiPlanProposal(
  spaceId: string,
  proposalId: string,
  confirm: boolean,
): Promise<{ draft: WikiPlanVersion; confirmed: WikiPlanVersion | null }> {
  const decided = await decideWikiPlanProposal(proposalId, 'accept');
  if (!decided.draft) throw new Error('The server accepted the change but made no draft of it.');
  if (!confirm) return { draft: decided.draft, confirmed: null };
  return { draft: decided.draft, confirmed: await confirmWikiPlan(spaceId, decided.draft.version) };
}

/** The gate's errors a refusal carries (422 `WIKI_PLAN_GATE`), or null for a failure of any other kind. */
export function wikiPlanGateErrors(error: unknown): WikiPlanGateError[] | null {
  if (!(error instanceof ApiError) || error.code !== 'WIKI_PLAN_GATE') return null;
  const errors = error.body?.errors;
  return Array.isArray(errors) ? (errors as WikiPlanGateError[]) : [];
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
