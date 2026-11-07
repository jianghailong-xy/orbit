import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIKI_OPS } from './wiki';
import { WIKI_JOB_KINDS } from './wikiJobs';
import {
  WIKI_CHAT_ACTIONS,
  WIKI_CHAT_COPY,
  WIKI_CHAT_DRAFT_KINDS,
  WIKI_CHAT_DRAFT_STATES,
  WIKI_CHAT_FAB_STATES,
  WIKI_CHAT_NOTE_TAGS,
  WIKI_CHAT_PRESSES,
  WIKI_CHAT_PROMPT,
  WIKI_CHAT_REWRITE_RESULTS,
  WIKI_CHAT_RULES,
  WIKI_DOC_VERSION_REASONS,
  WIKI_DOC_VERSIONS,
  WIKI_DOCS_FOLLOW,
  WIKI_DOCS_FOLLOW_SETTINGS_REASONS,
  WIKI_DOCS_FOLLOW_WAITING,
  type WikiChatCard,
  type WikiChatContext,
  type WikiChatDraftFacts,
  type WikiChatDraftKind,
  type WikiChatDraftOp,
  type WikiChatFabChat,
  type WikiChatNote,
  type WikiChatDraftSectionView,
  type WikiChatPlanChangeView,
  type WikiChatRewritesInput,
  type WikiDocChange,
  type WikiDocsFollowFacts,
  wikiChatAppliedInReview,
  wikiChatCardActions,
  wikiChatCardNeedsYou,
  wikiChatCardTitle,
  wikiChatContextErrors,
  wikiChatDraftLabel,
  wikiChatDraftState,
  wikiChatFabCounts,
  wikiChatFabState,
  wikiChatNoteLabel,
  wikiChatPlanFace,
  wikiChatPlanMovedNote,
  wikiChatRewriteLinks,
  wikiChatResultLine,
  wikiChatRewrites,
  wikiChatRewriteWaits,
  wikiChatWaiting,
  wikiChatWaitingBanner,
  wikiDocChangeLine,
  wikiDocSentenceDiff,
  wikiDocsFollowWaiting,
  wikiDocVersionHeading,
  wikiJobsMayOverlap,
} from './wikiChat';

/**
 * Holds src/shared/src/wikiChat.ts to the wiki chat's contract — contracts/wiki.contract.json `chat`, `docs.follow`
 * and `docs.versions`, and the edits around them (agentSurface.chat, reviewModes.chat, jobs.onePerSpace,
 * space.settings.chat, space.list.chatWaiting) — and runs every vector of src/shared/src/wiki-chat.fixture.json through
 * the functions the server computes states and counts with. The design's own numbers and words
 * (docs/wiki-chat-design.md, board 42) are read from the design, so a sentence or a limit that drifts from it goes red.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTRACT: any = JSON.parse(read('contracts/wiki.contract.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FIXTURE: any = JSON.parse(read('src/shared/src/wiki-chat.fixture.json'));
const DESIGN = read('docs/wiki-chat-design.md');
const BOARD = read('docs/mocks/wiki/42-wiki-chat.html');
const DOC = read('docs/wiki-contract.md');
const SOURCE_DOC = read('docs/project-source-contract.md');

const keysOf = (map: Record<string, unknown>) => Object.keys(map);
const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const names = (cases: Array<{ name: string }>) => cases.map((c) => c.name);
/** A fixture group as it.each's rows: the case's name, then the case. */
const cases = (group: string) => (FIXTURE[group] as Array<{ name: string }>).map((c) => [c.name, c] as [string, unknown]);
const user = (): string[] => CONTRACT.agentSurface.doors.user.routes;
const runner = (): string[] => [
  ...CONTRACT.agentSurface.doors.runner.routes,
  ...CONTRACT.agentSurface.doors.runner.verificationRoutes,
  ...CONTRACT.agentSurface.doors.runner.importRoutes,
  ...CONTRACT.agentSurface.doors.runner.importJobRoutes,
];

describe('wiki chat contract', () => {
  it('points at files that exist, and ships the numbers the design set', () => {
    const chat = CONTRACT.chat;
    for (const file of [chat.design, chat.board, 'docs/wiki-contract.md', 'src/shared/src/wiki-chat.fixture.json']) {
      expect(existsSync(path.join(ROOT, file)), `${file} does not exist`).toBe(true);
    }
    expect(chat.vectors).toMatch(/^src\/shared\/src\/wiki-chat\.fixture\.json: /u);
    expect(chat.rules).toEqual({ ...WIKI_CHAT_RULES });
    // Design §4.2, §8.1, §8.2 and §8.4: decided, not tuned.
    expect(WIKI_CHAT_RULES.selectionSentencesMax).toBe(20);
    expect(DESIGN).toContain('最多 20 句');
    expect(WIKI_CHAT_RULES.rewritesMax).toBe(5);
    expect(DESIGN).toContain('一张卡至多 5 节');
    expect(CONTRACT.docs.follow.rules.sectionsPerDay).toBe(WIKI_DOCS_FOLLOW.sectionsPerDay);
    expect(WIKI_DOCS_FOLLOW.sectionsPerDay).toBe(40);
    expect(DESIGN).toContain('每个 space 每天至多 40 节（`followSectionsPerDay`）');
    expect(CONTRACT.docs.versions.rules).toEqual({ ...WIKI_DOC_VERSIONS });
    expect(WIKI_DOC_VERSIONS.perSection).toBe(5);
    expect(DESIGN).toContain('每节至多 5 版');
  });

  it('binds a session to a space once, chooses its workspace once, and starts it from origin/main', () => {
    const chat = CONTRACT.chat;
    expect(chat.binding.column).toBe('session.wiki_chat_space_id');
    expect(chat.binding.rule).toMatch(/written by create alone, in the session row's own INSERT, and never afterwards/u);
    expect(chat.tables).toEqual(['wiki_chat_draft']);
    // The workspace: remembered on the space, offered only with worktrees, never moved off an offline machine.
    expect(chat.workspace.setting).toBe('space.settings.chat.workspaceId');
    expect(CONTRACT.space.settings.chat.default).toEqual({ workspaceId: null });
    expect(keysOf(CONTRACT.space.settings.chat.keys)).toEqual(['workspaceId']);
    expect(CONTRACT.space.settings.chat.channel).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(chat.workspace.eligible).toMatch(/enableWorktree/u);
    expect(chat.workspace.none).toContain('copy.panel.noWorktree');
    expect(DESIGN).toContain(WIKI_CHAT_COPY.panel.noWorktree);
    expect(chat.workspace.offline).toMatch(/nothing moves the chat to another machine/u);
    expect(chat.workspace.choose).toMatch(/No default is worked out/u);
    expect(chat.workspace.choose).toMatch(/orbit-develop/u);
    // The SOURCE: origin/main, a selector at create and a pin at the first claim, the project-source contract's SR54.
    expect(chat.source).toMatch(/docs\/project-source-contract\.md SR54/u);
    expect(chat.source).toMatch(/kind CHAT_UPSTREAM, ref refs\/heads\/main, authority REMOTE/u);
    expect(chat.source).toMatch(/needsSourcePin/u);
    expect(SOURCE_DOC).toMatch(/\*\*SR54（wiki 聊天的 SOURCE/u);
    for (const word of ['`CHAT_UPSTREAM`', '`refs/heads/main`', '`REMOTE`', '`origin`']) expect(SOURCE_DOC.split('**SR54')[1]).toContain(word);
    // A chat with no commit leaves no branch.
    expect(chat.branch).toMatch(/deletes the worktree's branch if it holds nothing past the pinned commit/u);
  });

  it('keeps the owner\'s words the turn\'s content, and every attachment a note of a known shape', () => {
    const { notes, turns, create } = CONTRACT.chat;
    expect(create.rules).toMatch(/content is the owner's first message, word for word, and clientTurnId a UUID/u);
    expect(create.rules).toMatch(/reviewModes\.tiered\.auto\.ownerWords/u);
    expect(turns).toMatch(/Its content is the owner's words alone/u);
    expect(notes.how).toMatch(/conversation_turn\.content stays the owner's words alone/u);
    expect(notes.how).toMatch(/control-plane-note\.ts/u);
    // The four blocks are the four tags, and the first message's block is the prompt, word for word.
    expect({ chat: notes.chat.tag, page: notes.page.tag, selection: notes.selection.tag, drafts: notes.drafts.tag }).toEqual({ ...WIKI_CHAT_NOTE_TAGS });
    expect(notes.chat.text).toBe(WIKI_CHAT_PROMPT);
    expect(WIKI_CHAT_PROMPT.startsWith(`<${WIKI_CHAT_NOTE_TAGS.chat}>\n`)).toBe(true);
    expect(WIKI_CHAT_PROMPT.endsWith(`\n</${WIKI_CHAT_NOTE_TAGS.chat}>`)).toBe(true);
    for (const said of ['wiki_propose', 'wiki_draft', "Never edit a document's text", 'nothing changes until the owner applies it', 'replaces']) {
      expect(WIKI_CHAT_PROMPT).toContain(said);
    }
    // The selection: at most twenty sentences, read by the server from ids, with the section's repoSha.
    expect(notes.wikiContext.shape).toContain('rules.selectionSentencesMax');
    expect(notes.wikiContext.check).toMatch(/wikiChatContextErrors/u);
    expect(notes.wikiContext.check).toMatch(/WIKI_SCHEMA/u);
    expect(notes.selection.attributes).toMatch(/repoSha/u);
    expect(notes.selection.body).toMatch(/never from text the client sends/u);
    expect(DESIGN).toContain('客户端只发 `{ docSlug, sectionKey, sentenceIds }`');
    // An unknown block is drawn generically: Android and every older client count nothing from them.
    expect(notes.how).toMatch(/the Android client and every older one draw them and count nothing from them/u);
  });

  it('drafts every op of a chat, opens wiki_draft to a chat alone, and serves it as the fifth tool (C6)', () => {
    const surface = CONTRACT.agentSurface;
    // The runner's Go test holds tools to what a binary serves; wiki_draft joined with the binary that serves it (C6).
    expect(surface.tools).toEqual(['wiki_search', 'wiki_get', 'wiki_propose', 'wiki_note', 'wiki_draft']);
    expect(surface.chat.draft.arrival).toMatch(/TestWikiAgentSurfaceIsTheContracts/u);
    const draft = surface.chat.draft;
    // The live tool spec is the chat's block, field for field, and its command is the block's.
    expect(surface.toolSpecs.wiki_draft.params).toEqual(draft.params);
    expect([surface.toolSpecs.wiki_draft.readOnly, surface.toolSpecs.wiki_draft.destructive]).toEqual([draft.readOnly, draft.destructive]);
    expect(surface.cli.wiki_draft).toBe(draft.cli);
    // replaces joined both drafting tools' params, a chat's alone.
    expect(surface.toolSpecs.wiki_propose.params.replaces).toMatch(/in a wiki chat alone/u);
    expect(surface.toolSpecs.wiki_note.params.replaces).toMatch(/in a wiki chat alone/u);
    expect(draft.tool).toBe('wiki_draft');
    expect([draft.readOnly, draft.destructive]).toEqual([false, false]);
    expect(keysOf(draft.params)).toEqual(['kind', 'sections', 'change', 'reason', 'replaces', 'idempotencyKey']);
    expect(draft.params.sections).toContain('chat.rules.rewritesMax');
    expect(draft.cli).toBe('orbit wiki draft');
    expect(surface.doors.runner.routes).toContain(draft.route);
    expect(draft.who).toMatch(/WIKI_SESSION_EXCLUDED/u);
    // The plan kind opened with the plan card (C12): gated as a proposal is, its errors back to the agent that wrote it.
    expect(draft.plan).toMatch(/opened with the plan card \(C12/u);
    for (const said of ['WIKI_PLAN_GATE', 'WIKI_PLAN_UNCONFIRMED', 'WIKI_PLAN_STALE', 'plan.gate.author', 'covers']) expect(draft.plan).toContain(said);
    // One card, several documents (C17): { docs, categories? }, a split's two documents in one edit; a proposal's shape is one.
    expect(draft.params.change).toMatch(/\{ docs, categories\? \}/u);
    expect(draft.params.change).toMatch(/A plan proposal's \{ doc, category\? \} is taken as one document/u);
    expect(draft.params.change).toMatch(/A writing requirement goes into the covers of the sections it is for/u);
    expect(draft.plan).toMatch(/gated once/u);
    expect(draft.plan).toContain('change.docs[1].sections[2].covers');
    expect(draft.description).toMatch(/Works only in a wiki chat\.$/u);
    expect(draft.description).toMatch(/never call a draft applied/u);
    for (const tool of [draft.tool, ...surface.tools]) expect(tool).not.toMatch(/accept|confirm|decide|delete|doc/u);
    // notTools is the sentence it was: no tool accepts, confirms, decides, hard-deletes or overwrites a page.
    expect(surface.notTools).toBe('No tool accepts, confirms, decides, hard-deletes or overwrites a page. Confirmation exists only on the owner channel.');
    // In a chat every op drafts, the two that apply at once elsewhere included; a note's corrects drafts its challenge.
    for (const op of WIKI_OPS) expect(surface.chat.propose).toContain(op);
    expect(surface.chat.propose).toMatch(/In every space and every review mode alike/u);
    expect(surface.chat.propose).toMatch(/A principle op is not refused WIKI_KIND_OWNER_ONLY in a chat/u);
    expect(surface.chat.note).toMatch(/corrects drafts its challenge/u);
    expect(surface.chat.note).toMatch(/A note without corrects is unchanged/u);
    expect(surface.chat.unchanged).toMatch(/Outside a chat nothing here applies/u);
    const excluded = CONTRACT.refusals.find((r: { code: string }) => r.code === 'WIKI_SESSION_EXCLUDED');
    expect(excluded.when).toMatch(/wiki_draft from a session that is not a wiki chat/u);
  });

  it('presses only on the owner door, writes confirmed (a principle the owner\'s), and lets no mode touch a card', () => {
    const chat = CONTRACT.chat;
    expect(keysOf(chat.routes)).toEqual(['create', 'list', 'drafts', 'draft', ...WIKI_CHAT_PRESSES]);
    for (const press of WIKI_CHAT_PRESSES) {
      expect(chat.routes[press]).toBe(`POST /api/wiki/chat-drafts/:id/${press}`);
      expect(typeof chat.presses[press], `${press} says what it does`).toBe('string');
    }
    for (const route of Object.values<string>(chat.routes)) {
      expect(user()).toContain(route);
      expect(runner().some((r) => r.includes('chat'))).toBe(false);
    }
    expect(chat.door).toMatch(/refused WIKI_OWNER_CHANNEL_ONLY whatever the session/u);
    expect(chat.door).toMatch(/OWNER_INTERACTIVE_CREDENTIAL_REQUIRED/u);
    const ownerOnly = CONTRACT.refusals.find((r: { code: string }) => r.code === 'WIKI_OWNER_CHANNEL_ONLY');
    expect(ownerOnly.when).toMatch(/every route of the wiki chat/u);
    expect(ownerOnly.when).toMatch(/docs\.versions\.restore/u);
    // The press's effect, and the floors kept.
    expect(CONTRACT.trust.onApply.chatApplied).toMatch(/^confirmed: /u);
    expect(CONTRACT.trust.onApply.chatApplied).toMatch(/a principle's is owner/u);
    expect(chat.presses.apply).toMatch(/accepted by the owner in the same transaction/u);
    expect(chat.presses.apply).toMatch(/no verification/u);
    expect(chat.presses.edit).toMatch(/effectPolicy\.decide\.edit/u);
    expect(chat.presses.discard).toMatch(/no rejection, no reason, no counter-example/u);
    expect(chat.presses.undo).toMatch(/revert:<changeset id>/u);
    expect(chat.presses.undo).toMatch(/docs\.versions\.restore/u);
    expect(chat.presses.undo).toMatch(/every op is an add or an amend/u);
    // A plan card's press (C12): the plan's own edit, confirmation and build, all or nothing — every document of it at once (C17).
    for (const door of ['plan.routes.edit', 'plan.routes.confirm', 'plan.jobs.request', 'plan.proposals.accept']) expect(chat.presses.apply).toContain(door);
    expect(chat.presses.apply).toMatch(/nothing is written — no version, no confirmation, no build and no press/u);
    expect(chat.presses.apply).toMatch(/every error, of every document/u);
    // A plan card's Undo (C17): the plan back as a new confirmed version of the owner's, the sections its builds wrote
    // restored with no model asked, and refused once the plan moved on.
    expect(chat.presses.undo).not.toMatch(/A plan card never is/u);
    for (const said of ['WIKI_REVISION_CONFLICT', "plan.routes.edit's storeIn", "plan.routes.confirm's confirmIn", 'docs.versions.restore', 'no model asked', 'reason restore', 'plan.jobs.request']) {
      expect(chat.presses.undo).toContain(said);
    }
    expect(chat.drafts.states.applied).toContain('copy.card.planMovedNote');
    expect(chat.drafts.actions).toMatch(/Open in Plan for a plan card/u);
    expect(CONTRACT.docs.versions.kept).toMatch(/A write that drops a section/u);
    expect(chat.presses.retry).toMatch(/plan\.jobs\.rebuild/u);
    expect(chat.drafts.read).toContain('changesetId, rewrite, change, createdAt');
    expect(chat.drafts.results.plan).toMatch(/kind build, of the version the press confirmed/u);
    const modes = CONTRACT.reviewModes.chat;
    expect(modes.rule).toMatch(/in manual, tiered and automatic alike/u);
    expect(modes.rule).toMatch(/no verification even in automatic/u);
    expect(modes.rule).toMatch(/pendingOpsPerSpace, opsPerTurn or opsPerSession/u);
    for (const floor of ['principleOwnerOnly', 'taintedWaits', 'ownerVouchedWaits', 'opsPerChangeset']) expect(modes.floors).toContain(floor);
    expect(modes.otherSessions).toMatch(/nothing here changes wiki_propose outside a chat/u);
    expect(chat.drafts.what).toMatch(/takes no place in pendingOpsPerSpace, leaves no proposed entry, is in no Review and no verification/u);
    expect(chat.dossier).toMatch(/wiki-dossier\.ts/u);
  });

  it('ships the card\'s closed sets and every one of their words', () => {
    const drafts = CONTRACT.chat.drafts;
    expect(keysOf(drafts.kinds)).toEqual([...WIKI_CHAT_DRAFT_KINDS]);
    expect(keysOf(drafts.states)).toEqual([...WIKI_CHAT_DRAFT_STATES]);
    expect(drafts.results.values).toEqual([...WIKI_CHAT_REWRITE_RESULTS]);
    expect(CONTRACT.chat.fab.states).toEqual([...WIKI_CHAT_FAB_STATES]);
    expect(drafts.derivation).toMatch(/wikiChatDraftState/u);
    expect(drafts.rewrites).toMatch(/wikiChatRewrites/u);
    expect(drafts.rewrites).toMatch(/at most rules\.rewritesMax/u);
    // Every action has its words, and every word is English.
    expect(keysOf(WIKI_CHAT_COPY.actions).sort()).toEqual([...WIKI_CHAT_ACTIONS].sort());
    expect(CONTRACT.chat.copy).toEqual(JSON.parse(JSON.stringify(WIKI_CHAT_COPY)));
    for (const sentence of [...strings(WIKI_CHAT_COPY), WIKI_CHAT_PROMPT]) {
      expect(sentence, sentence).not.toMatch(/[　-〿㐀-鿿＀-￯]/u);
    }
    expect(keysOf(WIKI_CHAT_COPY.waiting)).toEqual([...WIKI_DOCS_FOLLOW_WAITING]);
    expect(keysOf(WIKI_CHAT_COPY.reasons)).toEqual([...WIKI_DOC_VERSION_REASONS]);
  });

  it('says an applied card whose challenge waits in Review is in Review, never confirmed', () => {
    // The coordinator's reading of C6: Apply raises a challenge's flag, and the owner answers it in Review, so the
    // contract's `Applied · Confirmed by you` would say the opposite of what happened.
    expect(CONTRACT.chat.copy.card.appliedInReview).toBe('Applied · In Review');
    expect(CONTRACT.chat.copy.card.appliedInReviewNote).toBe('Keep, amend or retire the entry in Review.');
    for (const sentence of [WIKI_CHAT_COPY.card.appliedInReview, WIKI_CHAT_COPY.card.appliedInReviewNote]) {
      expect(sentence).not.toMatch(/\bconfirmed\b/iu);
    }
    const applied = CONTRACT.chat.drafts.states.applied as string;
    expect(applied).toContain('copy.card.appliedInReview');
    expect(applied).toContain('copy.card.appliedInReviewNote');
    expect(applied).toContain('wikiChatAppliedInReview');
    expect(applied).toMatch(/Review item/u);
    expect(DOC).toContain('`Applied · In Review` · `Keep, amend or retire the entry in Review.`');
    const pending = [{ op: 'challenge', decision: 'pending' }];
    expect(wikiChatAppliedInReview('applied', pending)).toBe(true);
    expect(wikiChatCardTitle('applied', 'Challenge entry', true)).toBe('Applied · In Review');
    // Only an applied card, and only while the challenge is pending: answered in Review, or any other op, it is confirmed.
    for (const state of WIKI_CHAT_DRAFT_STATES.filter((s) => s !== 'applied')) expect(wikiChatAppliedInReview(state, pending)).toBe(false);
    expect(wikiChatAppliedInReview('applied', [{ op: 'challenge', decision: 'accepted' }])).toBe(false);
    expect(wikiChatAppliedInReview('applied', [{ op: 'amend', decision: 'pending' }])).toBe(false);
    expect(wikiChatAppliedInReview('applied', [{ op: 'add', decision: 'accepted' }, { op: 'challenge', decision: 'pending' }])).toBe(true);
  });

  it('says what the design and its board say, word for word', () => {
    // From the design's tables (§3, §4.2, §5.1, §7.3, §8.3, §8.4).
    for (const sentence of [
      WIKI_CHAT_COPY.fab.idle, WIKI_CHAT_COPY.fab.working, WIKI_CHAT_COPY.fab.updated, WIKI_CHAT_COPY.panel.noWorktree,
      WIKI_CHAT_COPY.panel.fromWiki, WIKI_CHAT_COPY.card.replaced, WIKI_CHAT_COPY.card.changed, WIKI_CHAT_COPY.card.web,
      WIKI_CHAT_COPY.card.applied, WIKI_CHAT_COPY.card.discarded, WIKI_CHAT_COPY.card.notApplied, WIKI_CHAT_COPY.result.failed,
      WIKI_CHAT_COPY.actions.try_again, WIKI_CHAT_COPY.actions.see_changes, WIKI_CHAT_COPY.actions.undo, WIKI_CHAT_COPY.actions.open_entry,
      WIKI_CHAT_COPY.actions.redo, WIKI_CHAT_COPY.actions.apply, WIKI_CHAT_COPY.actions.edit, WIKI_CHAT_COPY.actions.discard,
      WIKI_CHAT_COPY.waiting.maintenance_running, 'Rewrite waiting', 'reads the same', 'Wiki updated · N sentences · See changes',
      'Orbit attached: Wiki selection · 3.1 §3 · 1 sentence · 2 sources', 'Rewrite from main', 'Plan change', 'Section no longer in the plan',
      'Add / Amend / Supersede / Retire', 'N needs you', WIKI_CHAT_COPY.notes.outdated,
    ]) {
      expect(DESIGN, sentence).toContain(sentence);
    }
    // From board 42.
    for (const sentence of [
      WIKI_CHAT_COPY.panel.newChat, WIKI_CHAT_COPY.panel.runsIn, WIKI_CHAT_COPY.panel.ask, WIKI_CHAT_COPY.panel.emptyHint,
      WIKI_CHAT_COPY.panel.emptyNote, WIKI_CHAT_COPY.panel.placeholder, WIKI_CHAT_COPY.panel.placeholderDraft,
      WIKI_CHAT_COPY.panel.mergeNote, WIKI_CHAT_COPY.card.wouldRewrite, WIKI_CHAT_COPY.card.replacedNote,
      WIKI_CHAT_COPY.card.webNote, WIKI_CHAT_COPY.card.yourMessage, WIKI_CHAT_COPY.card.rewrites, WIKI_CHAT_COPY.card.sources,
      WIKI_CHAT_COPY.card.sectionUpdated, WIKI_CHAT_COPY.actions.rewrite, WIKI_CHAT_COPY.actions.open_in_plan,
      WIKI_CHAT_COPY.actions.settings, WIKI_CHAT_COPY.fab.needsYouOne, WIKI_CHAT_COPY.card.planCovers,
    ]) {
      expect(BOARD, sentence).toContain(sentence.replace('&', '&amp;'));
    }
    expect(BOARD).toContain('Apply &amp; rebuild');
    expect(WIKI_CHAT_COPY.actions.apply_rebuild).toBe('Apply & rebuild');
    // The lines the board draws, as the functions compose them.
    expect(BOARD).toContain('Draft · Add decision');
    expect(BOARD.replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ')).toContain('Wiki updated · 3.1 §3 — 1 sentence · 7.1 §2 — reads the same');
  });

  it('lets a follow job run beside the jobs that write no document, and nothing else beside anything', () => {
    const follow = CONTRACT.docs.follow;
    expect(follow.kind).toMatch(/^docs_follow, /u);
    expect(WIKI_DOCS_FOLLOW.kind).toBe('docs_follow');
    expect(follow.kind).toMatch(/there is no orbit wiki docs follow/u);
    // The writers and the rest split every kind there is, docs_follow among the writers.
    const kinds = [...WIKI_JOB_KINDS, WIKI_DOCS_FOLLOW.kind];
    expect([...WIKI_DOCS_FOLLOW.writers, ...WIKI_DOCS_FOLLOW.alongside].sort()).toEqual([...new Set(kinds)].sort());
    for (const kind of [...WIKI_DOCS_FOLLOW.writers, ...WIKI_DOCS_FOLLOW.alongside]) {
      if (kind !== WIKI_DOCS_FOLLOW.kind) expect(CONTRACT.jobs.kinds).toContain(kind);
    }
    const rule: string = CONTRACT.jobs.onePerSpace;
    expect(rule).toMatch(/runs beside a job of its space that writes no document — articles, verify, import or smoke — and waits only for the ones that do: maintain, docs_build, plan_draft, plan_revise and another docs_follow/u);
    expect(rule).toContain("WHERE state = 'running' AND kind <> 'docs_follow'");
    expect(rule).toContain(`WHERE state = 'running' AND kind IN (${WIKI_DOCS_FOLLOW.writers.map((k) => `'${k}'`).join(', ')})`);
    expect(rule).toMatch(/entries first and documents after/u);
    expect(rule).toMatch(/A job that is waiting \(waiting_for set\) holds no lease and does not occupy the space\.$/u);
    // Every pair: only the follow job beside one that writes no document.
    for (const a of kinds) {
      for (const b of kinds) {
        const expected = (a === 'docs_follow') !== (b === 'docs_follow') && [a, b].some((k) => (WIKI_DOCS_FOLLOW.alongside as readonly string[]).includes(k));
        expect(wikiJobsMayOverlap(a, b), `${a} beside ${b}`).toBe(expected);
      }
    }
    for (const [a, b, may] of FIXTURE.overlap as Array<[string, string, boolean]>) {
      expect(wikiJobsMayOverlap(a, b), `${a} beside ${b}`).toBe(may);
      expect(wikiJobsMayOverlap(b, a), `${b} beside ${a}`).toBe(may);
    }
    // C4 made it a kind (migration 0477): the CHECK takes it, and the two indexes the rule names replace 0401's one.
    expect(CONTRACT.jobs.kinds).toContain(WIKI_DOCS_FOLLOW.kind);
    expect(WIKI_JOB_KINDS).toContain(WIKI_DOCS_FOLLOW.kind);
    expect(keysOf(CONTRACT.jobs.kindRuns)).toContain(WIKI_DOCS_FOLLOW.kind);
    expect(keysOf(CONTRACT.jobs.carry.kinds)).toContain(WIKI_DOCS_FOLLOW.kind);
    const sql = read('src/apiserver/prisma/migrations/0477_wiki_docs_follow/migration.sql').replace(/\s+/gu, ' ');
    expect(sql).toContain(`CHECK ("kind" IN ('${CONTRACT.jobs.kinds.join("', '")}'))`);
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "wiki_job_space_running_other_key" ON "wiki_job" ("space_id") WHERE "state" = 'running' AND "kind" <> 'docs_follow';`);
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "wiki_job_space_running_writer_key" ON "wiki_job" ("space_id") WHERE "state" = 'running' AND "kind" IN (${WIKI_DOCS_FOLLOW.writers.map((k) => `'${k}'`).join(', ')});`);
    expect(sql).toContain('DROP INDEX IF EXISTS "wiki_job_space_running_key";');
    expect(rule).toContain('wiki_job_space_running_other_key and wiki_job_space_running_writer_key');
  });

  it('follows every press and every change that reaches main, and only those, under one budget a day', () => {
    const follow = CONTRACT.docs.follow;
    expect(keysOf(follow.triggers)).toEqual([...WIKI_DOCS_FOLLOW.triggers, 'none']);
    expect(follow.triggers.none).toMatch(/no clock, no schedule, no sweep/u);
    expect(follow.priorities).toEqual({ ...WIKI_DOCS_FOLLOW.priorities });
    expect(WIKI_DOCS_FOLLOW.priorities).toEqual({ press: 1, chatMerge: 1, merge: 0, landing: 0 });
    expect(follow.queue).toMatch(/At most one queued follow job a space/u);
    expect(follow.sections.forced).toMatch(/whatever their fingerprint/u);
    expect(follow.sections.merges).toMatch(/asks no model and writes nothing/u);
    expect(follow.catchUp).toMatch(/still follows/u);
    expect(follow.daily).toMatch(/rules\.sectionsPerDay/u);
    expect(follow.daily).toMatch(/A press's sections are neither counted nor left/u);
    expect(follow.material).toMatch(/the entries the card wrote/u);
    expect(follow.material).toMatch(/the owner's turns in the chat/u);
    expect(follow.outcomes).toMatch(/it reads the same, and the card says so rather than pretend/u);
    // Why it waits: the reasons, their order, their words, and the two the owner fixes in Settings.
    expect(follow.waiting.reasons).toEqual([...WIKI_DOCS_FOLLOW_WAITING]);
    expect(follow.waiting.settings).toEqual([...WIKI_DOCS_FOLLOW_SETTINGS_REASONS]);
    expect(follow.waiting.rule).toMatch(/wikiDocsFollowWaiting/u);
    expect(follow.report).toMatch(/jobs\.read\.never/u);
  });

  it('keeps five versions of a section, says why, compares them sentence by sentence, and restores one on the owner door', () => {
    const versions = CONTRACT.docs.versions;
    expect(versions.table).toBe('wiki_doc_section_version');
    expect(versions.reasons.values).toEqual([...WIKI_DOC_VERSION_REASONS]);
    for (const reason of WIKI_DOC_VERSION_REASONS) expect(typeof versions.reasons[reason], reason).toBe('string');
    expect(versions.kept).toMatch(/whoever wrote it: a maintenance run, a build, a follow job or a restore/u);
    expect(versions.kept).toMatch(/one left unchanged was not written again and keeps nothing/u);
    expect(versions.retention).toMatch(/rules\.perSection/u);
    expect(versions.compare).toMatch(/wikiDocSentenceDiff/u);
    for (const route of Object.values<string>(versions.routes)) expect(user()).toContain(route);
    expect(versions.restore).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(versions.restore).toMatch(/counts by its old fingerprint/u);
    expect(versions.reads.changes).toMatch(/keeps its items as they are, ops alone/u);
    expect(CONTRACT.realtime.publishedWhen.some((when: string) => /chat's card was made/u.test(when))).toBe(true);
    expect(CONTRACT.realtime.publishedWhen.some((when: string) => /restored to a version/u.test(when))).toBe(true);
  });

  it('docks the panel as the design draws it, and keeps the header\'s buttons where they are', () => {
    const { panel, fab, boundaries } = CONTRACT.chat;
    expect(panel.address).toContain('?chat=<session>');
    expect(DESIGN).toContain('带 `?chat=<session>`，翻页不关，刷新还在');
    // Board 43 (owner 11-07): the session page's composer, the page and the selection first in its attachment row.
    expect(panel.composer).toMatch(/^The session page's composer, the same component/u);
    expect(panel.composer).toMatch(/holds the page and the selection \(notes\.wikiContext\) first, each with its cross, beside the pictures and files/u);
    expect(panel.header).toMatch(/Runs in, which holds only the workspace and folds once the first message goes/u);
    expect(CONTRACT.chat.create.body).toContain('attachmentIds?');
    expect(DESIGN).toContain('就是 session 页的 composer，是同一个组件');
    expect(keysOf(panel.widths)).toEqual(['atLeast1440', 'from1200', 'from640', 'below640']);
    expect(panel.widths.atLeast1440).toMatch(/400 wide by default, dragged between 320 and 560/u);
    for (const row of ['| ≥ 1440 | 右侧停靠，默认 400，可拖 320–560 | 照旧 |', '| 1200–1439 | 右侧停靠 |', '| 640–1199 | 从右滑出，盖住正文右侧，不加遮罩 |', '| < 640 | 底部 sheet，半屏与全屏两档 |']) {
      expect(DESIGN).toContain(row);
    }
    expect(panel.drawer).toMatch(/The entry drawer opens to the left of the panel/u);
    expect(fab.where).toMatch(/The page header gets no Chat button/u);
    expect(boundaries).toContain('copy.notes.outdated');
  });

  it('adds the chat to W on the clients that have it, and nothing an Android client cannot open', () => {
    const list = CONTRACT.space.list;
    expect(list.row).toContain('pendingOps, planWaiting, chatWaiting, workspaceIds and docs');
    expect(list.chatWaiting).toMatch(/wikiChatWaiting/u);
    expect(list.chatWaiting).toMatch(/Android, this phase/u);
    expect(CONTRACT.chat.waiting.notCounted).toMatch(/An open card is not/u);
    expect(CONTRACT.chat.waiting.notCounted).toMatch(/An approval is not/u);
    expect(CONTRACT.chat.fab.counts).toMatch(/wikiChatFabCounts/u);
    expect(CONTRACT.chat.fab.state).toMatch(/wikiChatFabState/u);
  });

  it('is explained in the contract document, section by section', () => {
    for (const heading of ['## 28. Wiki 聊天：边聊边改（`chat`）', '## 29. 跟进作业 `docs_follow`（`docs.follow`）', '## 30. 节的留版（`docs.versions`）']) {
      expect(DOC).toContain(heading);
    }
    const sections = DOC.slice(DOC.indexOf('\n## 28. '));
    for (const said of ['session.wiki_chat_space_id', 'space.settings.chat.workspaceId', '<orbit_wiki_chat>', 'wiki_chat_draft', 'WIKI_OWNER_CHANNEL_ONLY', 'wiki_doc_section_version', 'followSectionsPerDay', 'CHAT_UPSTREAM']) {
      expect(sections, said).toContain(said);
    }
  });
});

describe('wiki chat vectors', () => {
  it('names every case once, and covers every state, result, look, reason and note', () => {
    for (const group of ['cards', 'results', 'fab', 'waiting', 'followWaiting', 'rewrites', 'sentenceDiff', 'notes', 'contexts', 'changes', 'planFaces', 'rewriteLinks']) {
      const cases = FIXTURE[group] as Array<{ name: string }>;
      expect(cases.length, group).toBeGreaterThan(0);
      expect(new Set(names(cases)).size, `${group} names a case twice`).toBe(cases.length);
    }
    expect(new Set(FIXTURE.cards.map((c: { state: string }) => c.state))).toEqual(new Set(WIKI_CHAT_DRAFT_STATES));
    expect(new Set(FIXTURE.cards.map((c: { kind: string }) => c.kind))).toEqual(new Set(WIKI_CHAT_DRAFT_KINDS));
    expect(new Set(FIXTURE.results.map((c: { card: WikiChatCard }) => c.card.rewrite!.result))).toEqual(new Set(WIKI_CHAT_REWRITE_RESULTS));
    expect(new Set(FIXTURE.fab.map((c: { state: string }) => c.state))).toEqual(new Set(WIKI_CHAT_FAB_STATES));
    const reasons = new Set(FIXTURE.followWaiting.map((c: { reason: string | null }) => c.reason));
    for (const reason of WIKI_DOCS_FOLLOW_WAITING) expect(reasons.has(reason), reason).toBe(true);
    expect(new Set(FIXTURE.notes.map((c: { note: WikiChatNote }) => c.note.kind))).toEqual(new Set(keysOf(WIKI_CHAT_NOTE_TAGS)));
    expect(new Set(FIXTURE.changes.map((c: { change: WikiDocChange }) => (c.change.kind === 'section' ? c.change.reason.kind : 'left'))))
      .toEqual(new Set([...WIKI_DOC_VERSION_REASONS, 'left']));
  });

  it.each(cases('cards'))('card: %s', (_name, vector) => {
    const v = vector as {
      facts: WikiChatDraftFacts; kind: WikiChatDraftKind; ops: Array<WikiChatDraftOp & { decision?: string }>; undoable: boolean; state: string;
      label: string; title: string; actions: string[]; needsYou: boolean; note?: string | null;
    };
    const state = wikiChatDraftState(v.facts);
    expect(state).toBe(v.state);
    expect(wikiChatDraftLabel(v.kind, v.ops)).toBe(v.label);
    expect(wikiChatCardTitle(state, v.label, wikiChatAppliedInReview(state, v.ops))).toBe(v.title);
    const card: WikiChatCard = { kind: v.kind, state, undoable: v.undoable, rewrite: null };
    expect(wikiChatCardActions(card)).toEqual(v.actions);
    expect(wikiChatCardNeedsYou(card)).toBe(v.needsYou);
    // The line an applied plan card that can no longer be undone carries (C17); every other card carries none of it.
    expect(wikiChatPlanMovedNote(card)).toBe(v.note ?? null);
  });

  it.each(cases('results'))('result: %s', (_name, vector) => {
    const v = vector as { card: WikiChatCard; line: string; actions: string[]; waits: boolean; needsYou: boolean };
    expect(wikiChatResultLine(v.card.rewrite!)).toBe(v.line);
    expect(wikiChatCardActions(v.card)).toEqual(v.actions);
    expect(wikiChatRewriteWaits(v.card)).toBe(v.waits);
    expect(wikiChatCardNeedsYou(v.card)).toBe(v.needsYou);
  });

  it.each(cases('fab'))('button: %s', (_name, vector) => {
    const v = vector as { chats: WikiChatFabChat[]; counts: unknown; state: string; label: string };
    const counts = wikiChatFabCounts(v.chats);
    expect(counts).toEqual(v.counts);
    expect(wikiChatFabState(counts)).toEqual({ state: v.state, label: v.label });
  });

  it.each(cases('waiting'))('waiting count: %s', (_name, vector) => {
    const v = vector as { cards: WikiChatCard[]; chatWaiting: number; banner: string | null };
    expect(wikiChatWaiting(v.cards)).toBe(v.chatWaiting);
    expect(wikiChatWaitingBanner(v.chatWaiting)).toBe(v.banner);
  });

  it.each(cases('followWaiting'))('follow job waits: %s', (_name, vector) => {
    const v = vector as { facts: WikiDocsFollowFacts; reason: string | null };
    expect(wikiDocsFollowWaiting(v.facts)).toBe(v.reason);
  });

  it.each(cases('rewrites'))('rewrites: %s', (_name, vector) => {
    const v = vector as { input: WikiChatRewritesInput; sections: unknown[] };
    const sections = wikiChatRewrites(v.input);
    expect(sections).toEqual(v.sections);
    expect(sections.length).toBeLessThanOrEqual(WIKI_CHAT_RULES.rewritesMax);
  });

  it.each(cases('sentenceDiff'))('sentences: %s', (_name, vector) => {
    const v = vector as { before: string[]; after: string[]; rows: unknown[]; changed: number };
    expect(wikiDocSentenceDiff(v.before, v.after)).toEqual({ rows: v.rows, changed: v.changed });
  });

  it.each(cases('notes'))('note: %s', (_name, vector) => {
    const v = vector as { note: WikiChatNote; label: string };
    expect(wikiChatNoteLabel(v.note)).toBe(v.label);
  });

  it.each(cases('contexts'))('wikiContext: %s', (_name, vector) => {
    const v = vector as { value: WikiChatContext | unknown; errors: string[] };
    expect(wikiChatContextErrors(v.value).sort()).toEqual([...v.errors].sort());
  });

  it.each(cases('planFaces'))('plan card face: %s', (_name, vector) => {
    const v = vector as { change: WikiChatPlanChangeView; heading: string; rows: unknown[] };
    expect(wikiChatPlanFace(v.change)).toEqual({ heading: v.heading, rows: v.rows });
  });

  it.each(cases('rewriteLinks'))('Rewrites row: %s', (_name, vector) => {
    const v = vector as { kind: WikiChatDraftKind; rewrites: WikiChatDraftSectionView[]; links: unknown[] };
    expect(wikiChatRewriteLinks(v.kind, v.rewrites)).toEqual(v.links);
  });

  it.each(cases('changes'))('Docs row: %s', (_name, vector) => {
    const v = vector as { change: WikiDocChange; line: string; heading: string | null };
    expect(wikiDocChangeLine(v.change)).toBe(v.line);
    if (v.change.kind === 'section') expect(wikiDocVersionHeading(v.change.reason)).toBe(v.heading);
    else expect(v.heading).toBeNull();
  });
});
