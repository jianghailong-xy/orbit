/**
 * The review mode's words and readings (criterion 8): the Wiki settings page, the Auto / Unreviewed /
 * Web-derived marks an entry wears, the owner's Confirm and Reject, one run's page with its Revert,
 * and the answers a challenge card offers.
 *
 * A FILE OF ITS OWN, beside `lib/wiki.ts` rather than inside it, for the reason that file gives for
 * existing at all: every sentence here is one OrbitKit says too (`WikiModeCopy`), held to this one by
 * `WikiReviewModeCopyParityTests` and by the cases in `src/shared/src/wiki-review-mode.fixture.json`,
 * which both clients are proved against. The words are the mocks' (docs/mocks/wiki 17–20), as the
 * owner confirmed them on 2026-09-28.
 *
 * A RUN IS READ BY ITS OWN ID (`GET /api/wiki/changesets/:id`, contract `reviewModes.run`), whatever of
 * it still waits in Review: the server counts what it did and says whether Revert run… would take
 * anything back, so every run — an Automatic one nothing of which waits anywhere included — folds into
 * one row, opens and reverts. What the server does not say yet, these readings leave out rather than
 * invent: how many sessions a run read and on which provider.
 */
import {
  WIKI_LIMITS,
  WIKI_REVIEW_RULES,
  type WikiAnchor,
  type WikiChangesetOp,
  type WikiChangesetView,
  type WikiEntry,
  type WikiReviewMode,
  type WikiSpaceSettings,
  type WikiTrust,
} from '@orbit/shared';
import { encodeId } from './idCodec';
import { WIKI_HISTORY_MAINTENANCE, shortSha } from './wiki';

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export const wikiSettingsPath = (spaceSlug: string): string => `/wiki/${spaceSlug}/settings`;
export const wikiRunPath = (spaceSlug: string, changesetId: string): string =>
  `/wiki/${spaceSlug}/run/${encodeId(changesetId)}`;

// ── Wiki settings (mocks 19–20) ─────────────────────────────────────────────────────────────────

/** The gear in the Wiki's head, and the crumb over the page it opens. */
export const WIKI_SETTINGS = 'Settings';
export const WIKI_SETTINGS_TITLE = 'Wiki settings';

export const WIKI_REVIEW_MODE = 'Review mode';
export const WIKI_REVIEW_MODE_HINT = 'Only you can switch it';
export const WIKI_REVIEW_MODE_LEAD = 'Who has to look at a change before agents get it.';
export const WIKI_MODE_DEFAULT = 'default';

/** The three modes, in the order both clients list them, each with its one sentence. */
export const WIKI_MODE_LABELS: Record<WikiReviewMode, string> = {
  manual: 'Manual',
  tiered: 'Tiered',
  automatic: 'Automatic',
};
export const WIKI_MODE_NOTES: Record<WikiReviewMode, string> = {
  manual: 'Every change from sessions, maintenance and imports waits for you in Review.',
  tiered: 'Your own words and machine-checked entries apply at once; the rest show as Unreviewed and are not sent to agents.',
  automatic:
    'local-vllm checks each change against its sources first: supported ones apply, partly supported ones show as Unreviewed, the rest are rejected with a reason.',
};
/** The mode a space is made with, which the list tags `default`. */
export const WIKI_DEFAULT_REVIEW_MODE: WikiReviewMode = 'tiered';
export const WIKI_MODE_ORDER: readonly WikiReviewMode[] = ['manual', 'tiered', 'automatic'];

export const WIKI_SPOT_CHECK = 'Spot-check Automatic';
export const WIKI_SPOT_CHECK_NOTE =
  'Send 1 in 200 of the changes it applies to Review, to see what it lets through. Off by default; spot checks do not count toward the 30 waiting in Review.';

/** The floors, said once under the three modes: what no mode lets through. */
export const WIKI_FLOORS_LEAD = 'Always asks you, in any mode:';
export const WIKI_FLOORS_NOTE =
  'principles, anything a session proposed after reading the web, and changes to entries you wrote or confirmed. A run that would change more than 10% of the wiki stops.';

/**
 * What the page says when the space changed its own mode: Automatic's verification sent it back to
 * Tiered, or the spot checks sent it back to Manual. Said while that is still the mode the space is
 * in — a mode the owner chose since is theirs, and needs no explaining.
 */
export function wikiModeFallback(
  settings: Pick<WikiSpaceSettings, 'reviewMode' | 'reviewModeChangedAt' | 'reviewModeChangedBy'>,
): string | null {
  const on = settings.reviewModeChangedAt ? wikiMonthDay(settings.reviewModeChangedAt) : null;
  const when = on ? ` on ${on}` : '';
  if (settings.reviewModeChangedBy === 'verification' && settings.reviewMode === 'tiered') {
    return `Automatic switched itself back to Tiered${when}: the check rejected more than 30% of the last 50 changes. Choose Automatic again when you want it back.`;
  }
  if (settings.reviewModeChangedBy === 'spot_checks' && settings.reviewMode === 'manual') {
    return `The spot checks switched this space back to Manual${when}: you rejected more than 30% of the last 10. Choose another mode when you want it back.`;
  }
  return null;
}

/** `Sep 27`: the day a thing happened, in the words the fallback sentence uses. */
export function wikiMonthDay(iso: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Maintenance: the card, its Set up form, and the rows it shows once it is on. */
export const WIKI_MAINTENANCE = 'Maintenance';
export const WIKI_MAINTENANCE_NAME = WIKI_HISTORY_MAINTENANCE;
export const WIKI_MAINTENANCE_NOTE =
  'Keeps the wiki up to date from sessions, tasks and receipts as they settle. Runs on the workspace you pick, with the provider pinned.';
export const WIKI_OFF = 'Off';
export const WIKI_ON = 'On';
export const WIKI_SET_UP = 'Set up…';
export const WIKI_SET_UP_TITLE = 'Set up maintenance';
export const WIKI_STATUS = 'Status';
export const WIKI_WORKSPACE = 'Workspace';
export const WIKI_WORKSPACE_NOTE = 'The runner that checks out this codebase; maintenance runs there.';
export const WIKI_PROVIDER = 'Provider';
export const WIKI_PROVIDER_NOTE = 'Pinned: a run never falls back to another provider.';
export const WIKI_PINNED_NO_FALLBACK = 'pinned, no fallback';
export const WIKI_DAILY_LIMIT = 'Daily limit';
export const WIKI_RUNS_A_DAY = 'runs a day';
export const wikiRunsADay = (runs: number): string => (runs === 1 ? '1 run a day' : `${runs} ${WIKI_RUNS_A_DAY}`);
export const WIKI_DAILY_LIMIT_NOTE =
  'A run starts when 20 sessions have settled, or when the oldest waits a day. Each run writes at most 30 changes.';
export const WIKI_CANCEL = 'Cancel';
export const WIKI_TURN_ON = 'Turn on';
export const WIKI_TURN_OFF = 'Turn off';
export const WIKI_MAINTENANCE_EDIT = 'Edit';
export const WIKI_SAVE = 'Save';
/** What the pickers say before the owner has a workspace, or a provider this build can list. */
export const WIKI_NO_WORKSPACE = 'Pick a workspace';

/** A workspace as the picker lists it: its name, and the runner it lives on. */
export function wikiWorkspaceLabel(workspace: { name?: string | null; runner?: { name?: string | null; displayName?: string | null } | null }): string {
  const runner = workspace.runner?.displayName || workspace.runner?.name || null;
  const name = workspace.name || '—';
  return runner ? `${name} · ${runner}` : name;
}

/** A provider as the picker lists it: its slug, and the model it runs when it names one. */
export function wikiProviderLabel(provider: string, model: string | null | undefined): string {
  return model ? `${provider} · ${model}` : provider;
}

/**
 * The sections of the settings page, top to bottom — the order both clients draw them in, which
 * `WikiReviewModeCopyParityTests` reads out of the page and holds `WikiLogic.SettingsSection` to.
 */
export const WIKI_SETTINGS_SECTIONS = [WIKI_REVIEW_MODE, WIKI_MAINTENANCE] as const;

// ── The marks an entry wears, and the owner's two answers (mocks 17–18) ─────────────────────────

export const WIKI_CONFIRM = 'Confirm';
export const WIKI_CONFIRMED = 'Confirmed';
export const WIKI_REJECTED = 'Rejected';
/** Under the reason menu of an entry's Reject: there is no session to send it back to. */
export const WIKI_REJECT_ON_RECORD = 'The reason goes on the record.';
/** Where it's used, for an entry the push leaves out until the owner confirms it. */
export const WIKI_NOT_SENT_UNREVIEWED = 'Not sent to agents while it is Unreviewed.';

export type WikiMarkTone = 'green' | 'muted' | 'amber';

/** The bar under an entry's head: what its mark means for agents, and the answer that changes it. */
export interface WikiMarkBanner {
  tone: WikiMarkTone;
  lead: string;
  text: string;
}

export const WIKI_BANNER_AUTO = 'applied without asking you, and sent to agents. Reject takes it back.';
export const WIKI_BANNER_UNREVIEWED = 'applied without review, and not sent to agents until you confirm it.';
export const WIKI_BANNER_WEB_DERIVED =
  'this session read web pages before proposing. Confirming shows it to agents.';

/**
 * Whether the owner's two answers apply to an entry: it is live, and it is what a review mode applied
 * with nobody vouching for it (contract `reviewModes.entryReject` / `entryConfirm`). Anything else is
 * decided elsewhere — a proposal in Review, and what the owner wrote or confirmed by retiring it.
 */
export function wikiEntryAnswerable(entry: Pick<WikiEntry, 'status' | 'trust'>): boolean {
  return entry.status === 'active' && (entry.trust === 'auto' || entry.trust === 'unreviewed');
}

/** Confirm is for what agents are not sent yet: an Auto entry is already pushed, so it has Reject alone. */
export function wikiCanConfirm(entry: Pick<WikiEntry, 'status' | 'trust'>): boolean {
  return wikiEntryAnswerable(entry) && entry.trust === 'unreviewed';
}

/** The bar an entry's page draws under its head, or none for an entry no mode applied. */
export function wikiMarkBanner(entry: Pick<WikiEntry, 'status' | 'trust' | 'tainted'>): WikiMarkBanner | null {
  if (!wikiEntryAnswerable(entry)) return null;
  if (entry.tainted) return { tone: 'amber', lead: 'Web-derived', text: WIKI_BANNER_WEB_DERIVED };
  if (entry.trust === 'auto') return { tone: 'green', lead: 'Auto', text: WIKI_BANNER_AUTO };
  return { tone: 'muted', lead: 'Unreviewed', text: WIKI_BANNER_UNREVIEWED };
}

/** A verdict as the bar's second line says it. */
export const WIKI_VERDICT_WORDS: Record<string, string> = {
  supported: 'supported',
  partial: 'partly supported',
  unsupported: 'not supported',
  duplicate: 'a duplicate',
};
export const WIKI_CAPPED_AT_UNREVIEWED = 'capped at Unreviewed';

/**
 * The bar's second line: who checked it and what they said, when that is known, then who applied it
 * and when — `Checked by qwen3.8: partly supported · Wiki maintenance, 2h ago`.
 */
export function wikiCheckedLine(input: {
  verification?: { verdict: string; model: string } | null;
  tainted: boolean;
  who: string | null;
  when: string | null;
}): string {
  const parts: string[] = [];
  if (input.verification) {
    const verdict = WIKI_VERDICT_WORDS[input.verification.verdict] ?? input.verification.verdict;
    parts.push(`Checked by ${input.verification.model}: ${verdict}`);
    if (input.tainted) parts.push(WIKI_CAPPED_AT_UNREVIEWED);
  }
  if (input.who) parts.push(input.when ? `${input.who}, ${input.when}` : input.who);
  return parts.join(' · ');
}

// ── One run (mock 17 ⑧, 18 ④⑤) ──────────────────────────────────────────────────────────────────

export const WIKI_RUN = 'run';
export const WIKI_VIEW_RUN = 'View run';
export const WIKI_REVERT_RUN = 'Revert run…';
export const WIKI_REVERT_RUN_CONFIRM = 'Revert run';
export const WIKI_REVERT_TITLE = 'Revert this run?';
export const WIKI_REVERT_KEEPS = 'Changes you have confirmed, edited or rejected since are left as they are.';
export const WIKI_REVERTED = 'Reverted';
export const WIKI_OPEN_SESSION = 'Open session';
export const WIKI_RUN_ADDED = 'Added';
export const WIKI_RUN_AMENDED = 'Amended';
export const WIKI_RUN_REINFORCED = 'Reinforced';

/** Who a run was, as its page's kicker and its Recently changed row name it. */
export const WIKI_ORIGIN_WORDS: Record<string, string> = {
  maintenance: WIKI_HISTORY_MAINTENANCE,
  import: 'Import',
  agent: 'A session',
  watch: 'A watch',
  owner: 'You',
};

export const wikiRunKicker = (origin: string): string => `${WIKI_ORIGIN_WORDS[origin] ?? origin} · ${WIKI_RUN}`;
/** `Sep 28, 07:41`: when a run was recorded, as its page's meta line says it. */
export function wikiRunWhen(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
export const wikiAppliedChanges = (count: number): string =>
  `Applied ${count} change${count === 1 ? '' : 's'}`;
export const wikiRejectedByCheck = (count: number): string => `${count} rejected by the check`;
export const wikiToReview = (count: number): string => `${count} to review`;

/** One entry a run changed, as its page lists it. */
export interface WikiRunRow {
  op: WikiChangesetOp;
  entryId: string | null;
  title: string;
  summary: string;
  /** The entry's trust as it stands now — none once it has ended — else what the op's verdict applied it with. */
  trust: WikiTrust | null;
}

/**
 * What one run did, as its page and its Recently changed row say it: the server's counts, its entries
 * grouped Added / Amended / Reinforced, and what Revert run… would undo.
 */
export interface WikiRunSummary {
  /** Every op whose effect the run left standing: what the mode applied, and what applied by itself. */
  applied: number;
  auto: number;
  unreviewed: number;
  rejectedByCheck: number;
  toReview: number;
  added: WikiRunRow[];
  amended: WikiRunRow[];
  reinforced: WikiRunRow[];
  /** Whether the server says Revert run… would take anything back now. */
  revertible: boolean;
  /** What it would undo, as the server counts it by the revert's own rules. */
  revertAdds: number;
  revertAmends: number;
}

/** Whether an op's effect stands from the run itself — the mode applied it, or it needed nobody. */
export function wikiOpApplied(op: Pick<WikiChangesetOp, 'decision' | 'spotCheck' | 'appliedByMode'>): boolean {
  if (op.decision === 'auto_applied') return true;
  if (op.appliedByMode === null || op.appliedByMode === undefined) return false;
  return (op.decision === 'pending' && op.spotCheck) || op.decision === 'accepted' || op.decision === 'edited';
}

/**
 * Whether a changeset is a run a person can take back: some op of it was applied by its review mode —
 * which the server says as the changeset's `appliedByMode`, and the timeline as each item's
 * `changesetAppliedByMode`.
 */
export function wikiIsRun(changeset: { appliedByMode?: string | null }): boolean {
  return changeset.appliedByMode !== null && changeset.appliedByMode !== undefined;
}

/**
 * One run as its read answers it: the server's counts and what Revert would undo, and its entries
 * grouped Added / Amended / Reinforced, as its page lists them.
 */
export function wikiRunSummary(changeset: WikiChangesetView): WikiRunSummary {
  const entries = new Map(changeset.entries.map((entry) => [entry.id, entry]));
  const summary: WikiRunSummary = {
    ...changeset.counts,
    added: [],
    amended: [],
    reinforced: [],
    revertible: changeset.revertible,
    revertAdds: changeset.revert?.adds ?? 0,
    revertAmends: changeset.revert?.amends ?? 0,
  };
  for (const op of [...changeset.ops].sort((a, b) => a.seq - b.seq)) {
    if (!wikiOpApplied(op)) continue;
    const row = runRow(op, entries);
    if (op.op === 'add') summary.added.push(row);
    else if (op.op === 'amend') summary.amended.push(row);
    else if (op.op === 'reinforce') summary.reinforced.push(row);
  }
  return summary;
}

function runRow(op: WikiChangesetOp, entries: ReadonlyMap<string, WikiEntry>): WikiRunRow {
  const entryId = op.op === 'add' || op.op === 'supersede' ? (op.resultEntryId ?? op.entryId) : op.entryId;
  const entry = entryId ? entries.get(entryId) : undefined;
  const payload = (op.payload ?? {}) as { entry?: { title?: unknown; summary?: unknown }; changes?: { title?: unknown; summary?: unknown } };
  const draft = payload.entry ?? payload.changes ?? {};
  const verdictTrust =
    op.verification?.verdict === 'supported' ? 'auto' : op.verification?.verdict === 'partial' ? 'unreviewed' : null;
  return {
    op,
    entryId: entryId ?? null,
    title: entry?.title ?? (typeof draft.title === 'string' ? draft.title : '—'),
    summary: entry?.summary ?? (typeof draft.summary === 'string' ? draft.summary : ''),
    // An entry that has ended since (retired with its run, rejected) wears no mark: nothing it was applied with stands.
    trust: entry ? (entry.status === 'active' ? entry.trust : null) : op.tainted && verdictTrust ? 'unreviewed' : verdictTrust,
  };
}

/** The run's counts in a line, as its page's summary and its Recently changed row say them. */
export function wikiRunCounts(summary: Pick<WikiRunSummary, 'auto' | 'unreviewed' | 'rejectedByCheck' | 'toReview'>): string[] {
  const parts: string[] = [];
  if (summary.auto > 0) parts.push(`${summary.auto} Auto`);
  if (summary.unreviewed > 0) parts.push(`${summary.unreviewed} Unreviewed`);
  if (summary.rejectedByCheck > 0) parts.push(wikiRejectedByCheck(summary.rejectedByCheck));
  if (summary.toReview > 0) parts.push(wikiToReview(summary.toReview));
  return parts;
}

/**
 * What the Revert dialog says it will do: how many changes, the adds withdrawn and the amends put
 * back, and that agents stop getting them. The count is what Revert undoes — the adds and amends the
 * mode applied that nobody answered — so the sentence and the outcome agree.
 */
export function wikiRevertBody(summary: Pick<WikiRunSummary, 'revertAdds' | 'revertAmends'>): string {
  const total = summary.revertAdds + summary.revertAmends;
  const clauses: string[] = [];
  if (summary.revertAdds > 0) {
    clauses.push(`${summary.revertAdds} added ${summary.revertAdds === 1 ? 'entry is' : 'entries are'} withdrawn`);
  }
  if (summary.revertAmends > 0) {
    clauses.push(
      `${summary.revertAmends} amended ${summary.revertAmends === 1 ? 'one goes back to its' : 'ones go back to their'} previous revision`,
    );
  }
  const head = `The ${total} change${total === 1 ? '' : 's'} it applied ${total === 1 ? 'is' : 'are'} undone`;
  return `${clauses.length > 0 ? `${head}: ${clauses.join(' and ')}` : head}. Agents stop getting ${total === 1 ? 'it' : 'them'}.`;
}

// ── Recently changed: one run is one row ────────────────────────────────────────────────────────

/** What the fold reads of a timeline item: the op, when, and the changeset it came in (`WikiTimelineItem`). */
export interface WikiRecentItem {
  opId: string;
  at: string;
  origin: string;
  changesetId?: string | null;
  changesetAppliedByMode?: string | null;
}

/** A row of Recently changed: one op, or every op of a run, which opens by its changeset's id. */
export type WikiRecentRow<T extends WikiRecentItem> =
  | { kind: 'op'; item: T }
  | { kind: 'run'; changesetId: string; origin: string; at: string; items: T[] };

/**
 * The feed with each run folded into one row, at the place of its newest change.
 *
 * EVERY RUN FOLDS: each item names its changeset and the review mode that applied any of it (contract
 * `reviewModes.run.timeline`), so an op some mode's run applied joins that run's row whether or not
 * anything of the run still waits in Review. An op of no run — the owner's own write, a proposal the
 * owner accepted, a revert — stays a row of its own.
 */
export function wikiRecentRows<T extends WikiRecentItem>(items: readonly T[]): Array<WikiRecentRow<T>> {
  const rows: Array<WikiRecentRow<T>> = [];
  const folded = new Map<string, { kind: 'run'; changesetId: string; origin: string; at: string; items: T[] }>();
  for (const item of items) {
    const changesetId = item.changesetId ?? null;
    if (!changesetId || !wikiIsRun({ appliedByMode: item.changesetAppliedByMode })) {
      rows.push({ kind: 'op', item });
      continue;
    }
    const row = folded.get(changesetId);
    if (row) {
      row.items.push(item);
      continue;
    }
    const created = { kind: 'run' as const, changesetId, origin: item.origin, at: item.at, items: [item] };
    folded.set(changesetId, created);
    rows.push(created);
  }
  return rows;
}

// ── A challenge's answers (contract `anchorRules.verify.answers`) ──────────────────────────────

export const WIKI_RECONFIRM = 'Re-confirm';
export const WIKI_AMEND = 'Amend';
export const WIKI_RETIRE = 'Retire';
export const WIKI_CHALLENGE_WAITS = 'Agents stop getting this entry until you answer.';
export const WIKI_CHALLENGED = 'Challenged';
export const WIKI_AMEND_NOTE = 'Your version replaces the entry, and its anchors are checked again.';
export const wikiCheckedOnMain = (ref: string): string => `checked on main at ${shortSha(ref)}`;

/** One anchor that no longer holds, in the words the server's own challenge reason uses. */
export interface WikiBrokenAnchor {
  state: 'changed' | 'missing';
  /** `path src/a.ts`, `symbol foo in src/a.ts`, `commit 1588c3b`. */
  label: string;
}

/**
 * The anchors a challenge is about: every one whose last check found it changed or missing, said the
 * way `anchorChallengeReason` on the server says them. Empty for a challenge a session filed about
 * something else, which the card then explains with its own reason.
 */
export function wikiBrokenAnchors(anchors: readonly WikiAnchor[] | null | undefined): WikiBrokenAnchor[] {
  return (anchors ?? []).flatMap((anchor): WikiBrokenAnchor[] => {
    const state = anchor.check?.state;
    if (state !== 'changed' && state !== 'missing') return [];
    return [{ state, label: wikiAnchorWords(anchor) }];
  });
}

export function wikiAnchorWords(anchor: WikiAnchor): string {
  const row = anchor as unknown as { type?: string; path?: string; symbol?: string; sha?: string };
  switch (row.type) {
    case 'path':
      return `path ${row.path ?? ''}`;
    case 'symbol':
      return `symbol ${row.symbol ?? ''} in ${row.path ?? ''}`;
    case 'commit':
      return `commit ${shortSha(row.sha ?? '')}`;
    default:
      return `${row.type ?? 'unknown'} anchor`;
  }
}

/** The ref the broken anchors were checked on — the newest check among them. */
export function wikiChallengeRef(anchors: readonly WikiAnchor[] | null | undefined): string | null {
  const refs = (anchors ?? [])
    .map((anchor) => anchor.check)
    .filter((check): check is NonNullable<WikiAnchor['check']> => !!check && (check.state === 'changed' || check.state === 'missing'))
    .sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? 1 : (a.at ?? '') > (b.at ?? '') ? -1 : 0));
  return refs[0]?.ref ?? null;
}

/** The numbers the settings sentences quote, kept here so a test can hold the words to the rules. */
export const WIKI_SETTINGS_NUMBERS = {
  automaticSpotCheckEvery: WIKI_REVIEW_RULES.automaticSpotCheckEvery,
  pendingOpsPerSpace: WIKI_LIMITS.pendingOpsPerSpace,
  breakerMaxChangedPercent: WIKI_REVIEW_RULES.breakerMaxChangedPercent,
  verificationWindow: WIKI_REVIEW_RULES.verificationWindow,
  verificationMaxUnsupportedPercent: WIKI_REVIEW_RULES.verificationMaxUnsupportedPercent,
  spotCheckWindow: WIKI_REVIEW_RULES.spotCheckWindow,
  spotCheckMaxRejectPercent: WIKI_REVIEW_RULES.spotCheckMaxRejectPercent,
  opsPerChangeset: WIKI_LIMITS.opsPerChangeset,
} as const;
