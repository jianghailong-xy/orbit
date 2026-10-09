import Foundation
import XCTest
@testable import OrbitKit

/// The native Wiki says the web's words, in the web phone's order.
///
/// Every sentence the native pages draw is a `WikiCopy` constant, looked up here in the web source it
/// was ported from (`src/web/src/lib/wiki.ts` and the three pages); the order of the home page's bands,
/// the entry page's sections and a Review card's answers is read out of those same pages — and, for
/// the home page, out of the phone rule in `index.css` that decides the web phone's order. Runs of
/// whitespace read as one space: JSX wraps its text across lines.
///
/// Shaped after `ProjectPageSectionsCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE, never an `XCTSkip`. A check that quietly opts out reports green on exactly
/// the day the thing it watches goes missing.
final class WikiCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wiki.ts"
    private static let home = "src/web/src/components/WikiHome.tsx"
    private static let page = "src/web/src/pages/WikiPage.tsx"
    private static let drawer = "src/web/src/components/WikiEntryDrawer.tsx"
    private static let review = "src/web/src/components/WikiReviewPage.tsx"
    private static let sources = "src/web/src/components/WikiSources.tsx"
    private static let sidebar = "src/web/src/components/TasksSidePanel.tsx"
    private static let css = "src/web/src/index.css"
    private static let shared = "src/shared/src/wiki.ts"
    private static let activity = "src/web/src/components/WikiActivityPage.tsx"
    private static let planCard = "src/web/src/components/WikiPlanCard.tsx"
    private static let spaceLib = "src/web/src/lib/wikiSpace.ts"
    private static let docsLib = "src/web/src/lib/wikiDocs.ts"
    private static let planLib = "src/web/src/lib/wikiPlan.ts"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native Wiki is one half of a pair; if the web "
                + "half moved, move this check with it rather than deleting it."
        }
    }

    /// The source with string concatenations joined, JSX's escaped apostrophe read as one, and every
    /// run of whitespace as a single space.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "&apos;", with: "'")
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertSays(_ web: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// A named constant, anchored on its declaration — not on the sentence, which a comment alone
    /// could satisfy. Either quote style: the web writes `"Where it's used"` in double quotes.
    private func assertDeclares(_ web: String, _ name: String, _ value: String, line: UInt = #line) {
        let single = "\(name) = '\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        let double = "\(name) = \"\(value)\""
        XCTAssertTrue(web.contains(single) || web.contains(double),
                      "\(name) drifted: \(Self.lib) no longer declares it as \(value.debugDescription)", line: line)
    }

    /// The literals, found in this order in `text`.
    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil),
                       "\(what): the web lost one of \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    /// From one marker to the next occurrence of another.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    // MARK: the words

    /// Every sentence the two ends compare, in one table — `WikiCopy`'s constants against the web's.
    func testEveryWordIsTheWebsWord() throws {
        let web = try source(Self.lib)
        let pairs: [(String, String)] = [
            ("WIKI_TITLE", WikiCopy.title),
            ("WIKI_SEARCH_PLACEHOLDER", WikiCopy.searchPlaceholder),
            ("WIKI_REVIEW_TITLE", WikiCopy.reviewTitle),
            ("WIKI_PRINCIPLES", WikiCopy.principles),
            ("WIKI_RECENT_DECISIONS", WikiCopy.recentDecisions),
            ("WIKI_RECENTLY_CHANGED", WikiCopy.recentlyChanged),
            ("WIKI_AGENTS_USED", WikiCopy.agentsUsed),
            ("WIKI_AGENTS_USED_HINT", WikiCopy.agentsUsedHint),
            ("WIKI_NO_SPACES", WikiCopy.noSpaces),
            ("WIKI_DISABLED_NOTE", WikiCopy.disabledNote),
            ("WIKI_SPACE_PICKER_HINT", WikiCopy.spacePickerHint),
            ("WIKI_SESSIONS_RECEIVED", WikiCopy.sessionsReceived),
            ("WIKI_SEARCHES", WikiCopy.searches),
            ("WIKI_NO_LONGER_PUSHED", WikiCopy.noLongerPushed),
            ("WIKI_SECTION_DETAILS", WikiCopy.details),
            ("WIKI_SECTION_SOURCES", WikiCopy.sources),
            ("WIKI_SECTION_ANCHORS", WikiCopy.anchors),
            ("WIKI_SECTION_USED", WikiCopy.whereUsed),
            ("WIKI_SECTION_HISTORY", WikiCopy.history),
            ("WIKI_ANCHORS_NOTE", WikiCopy.anchorsNote),
            ("WIKI_NO_USE_YET", WikiCopy.noUseYet),
            ("WIKI_ACTION_EDIT", WikiCopy.edit),
            ("WIKI_ACTION_SUPERSEDE", WikiCopy.supersede),
            ("WIKI_ACTION_RETIRE", WikiCopy.retire),
            ("WIKI_ACTION_COPY_LINK", WikiCopy.copyLink),
            ("WIKI_LINK_COPIED", WikiCopy.linkCopied),
            ("WIKI_QUOTE_VERIFIED", WikiCopy.quoteVerified),
            ("WIKI_QUOTE_UNVERIFIED", WikiCopy.quoteUnverified),
            ("WIKI_HISTORY_PROPOSED_BY", WikiCopy.historyProposedBy),
            ("WIKI_HISTORY_CONFIRMED_BY", WikiCopy.historyConfirmedBy),
            ("WIKI_HISTORY_MAINTENANCE", WikiCopy.historyMaintenance),
            ("WIKI_HISTORY_SYSTEM", WikiCopy.historySystem),
            ("WIKI_REVIEW_ACCEPT", WikiCopy.accept),
            ("WIKI_REVIEW_EDIT", WikiCopy.reviewEdit),
            ("WIKI_REVIEW_REJECT", WikiCopy.reject),
            ("WIKI_REVIEW_KEEP", WikiCopy.keep),
            ("WIKI_REVIEW_RETIRE", WikiCopy.reviewRetire),
            ("WIKI_DECIDED_ACCEPTED", WikiCopy.decidedAccepted),
            ("WIKI_DECIDED_EDITED", WikiCopy.decidedEdited),
            ("WIKI_DECIDED_REJECTED", WikiCopy.rejected),
            ("WIKI_DECIDED_RETIRED", WikiCopy.retired),
            ("WIKI_DECIDED_KEPT", WikiCopy.decidedKept),
            ("WIKI_DECIDED_RECONFIRMED", WikiCopy.decidedReconfirmed),
            ("WIKI_DECIDED_AMENDED", WikiCopy.decidedAmended),
            ("WIKI_DECIDE_FAILED", WikiCopy.decideFailed),
            ("WIKI_DECIDE_CONFLICT", WikiCopy.conflictRefused),
            ("WIKI_DECIDE_INACTIVE", WikiCopy.inactiveRefused),
            ("WIKI_DECIDE_WITHDRAWN", WikiCopy.withdrawnRefused),
            ("WIKI_SETTINGS_SAVED", WikiCopy.settingsSaved),
            ("WIKI_ACCEPT_NOTE", WikiCopy.acceptNote),
            ("WIKI_WEB_DERIVED_NOTE", WikiCopy.webDerivedNote),
            ("WIKI_REJECT_REASON_FOOT", WikiCopy.rejectReasonFoot),
            ("WIKI_SIMILAR_NONE", WikiCopy.similarNone),
            ("WIKI_SIMILAR_ENTRIES", WikiCopy.similarEntries),
            ("WIKI_AFTER_RETIRE", WikiCopy.afterRetire),
            ("WIKI_WEB_DERIVED", WikiCopy.webDerived),
            ("WIKI_WEB_DERIVED_WARNING", WikiCopy.webDerivedWarning),
            ("WIKI_AUTO_ACCEPT", WikiCopy.autoAccept),
            ("WIKI_AUTO_ACCEPT_HINT", WikiCopy.autoAcceptHint),
            ("WIKI_REINFORCE", WikiCopy.reinforce),
            ("WIKI_REINFORCE_NOTE", WikiCopy.reinforceNote),
            ("WIKI_CHALLENGE", WikiCopy.challenge),
            ("WIKI_CHALLENGE_NOTE", WikiCopy.challengeNote),
            ("WIKI_ALWAYS_ASKS", WikiCopy.alwaysAsks),
            ("WIKI_ALWAYS_ASKS_NOTE", WikiCopy.alwaysAsksNote),
            ("WIKI_PREVIOUS", WikiCopy.previous),
            ("WIKI_NEXT", WikiCopy.next),
            ("WIKI_TAB_ALL", WikiCopy.tabAll),
            ("WIKI_TAB_ADD", WikiCopy.tabAdd),
            ("WIKI_TAB_AMEND", WikiCopy.tabAmend),
            ("WIKI_TAB_RETIRE", WikiCopy.tabRetire),
            ("WIKI_NO_REVIEW", WikiCopy.noReview),
            ("WIKI_NO_CHANGES", WikiCopy.noChanges),
            ("WIKI_NO_DECISIONS", WikiCopy.noDecisions),
            ("WIKI_NO_AGENTS_YET", WikiCopy.noAgentsYet),
            ("WIKI_NO_ENTRY_SELECTED", WikiCopy.noEntrySelected),
            ("WIKI_ACTIVITY", WikiCopy.activity),
            ("WIKI_MANAGE_SPACES", WikiCopy.manageSpaces),
        ]
        for (name, word) in pairs { assertDeclares(web, name, word) }
    }

    /// What a landed Review answer's toast says: the web's `wikiDecidedToast`, case by case.
    func testTheReviewToastSaysWhatTheAnswerDid() throws {
        let web = try source(Self.lib)
        for line in ["case 'edit': return WIKI_DECIDED_EDITED;",
                     "case 'reconfirm': return WIKI_DECIDED_RECONFIRMED;",
                     "case 'amend': return WIKI_DECIDED_AMENDED;",
                     "case 'retire': return WIKI_DECIDED_RETIRED;",
                     "case 'reject': return op === 'retire' ? WIKI_DECIDED_KEPT : WIKI_DECIDED_REJECTED;",
                     "case 'accept': return op === 'retire' ? WIKI_DECIDED_RETIRED : WIKI_DECIDED_ACCEPTED;"] {
            assertSays(web, line, in: Self.lib)
        }
        XCTAssertEqual(WikiLogic.decidedToast(op: .add, action: .accept), "Accepted")
        XCTAssertEqual(WikiLogic.decidedToast(op: .amend, action: .edit), "Accepted with your edits")
        XCTAssertEqual(WikiLogic.decidedToast(op: .add, action: .reject), "Rejected")
        XCTAssertEqual(WikiLogic.decidedToast(op: .retire, action: .accept), "Retired")
        XCTAssertEqual(WikiLogic.decidedToast(op: .retire, action: .reject), "Kept",
                       "Keep is a rejection on the wire, but the owner kept the entry")
        XCTAssertEqual(WikiLogic.decidedToast(op: .challenge, action: .reconfirm), "Re-confirmed")
        XCTAssertEqual(WikiLogic.decidedToast(op: .challenge, action: .amend), "Amended")
        XCTAssertEqual(WikiLogic.decidedToast(op: .challenge, action: .retire), "Retired")
    }

    /// An answer the server recorded without applying it is a refusal, by the same rule at both ends —
    /// the web's `wikiDecisionRefusal` case by case — and Review says it where it says a refusal.
    func testARefusedAnswerIsTheWebsRefusal() throws {
        let web = try source(Self.lib)
        for line in ["return answer?.ops?.find((one) => one.id === opId)?.decision ?? null;",
                     "case 'conflict': return op === 'challenge' ? WIKI_DECIDE_INACTIVE : WIKI_DECIDE_CONFLICT;",
                     "case 'withdrawn': return op === 'challenge' && action === 'retire' ? null : WIKI_DECIDE_WITHDRAWN;"] {
            assertSays(web, line, in: Self.lib)
        }
        XCTAssertEqual(WikiLogic.decisionRefusal(.conflict, op: .amend, action: .accept), WikiCopy.conflictRefused)
        XCTAssertEqual(WikiLogic.decisionRefusal(.conflict, op: .challenge, action: .reconfirm), WikiCopy.inactiveRefused)
        XCTAssertEqual(WikiLogic.decisionRefusal(.withdrawn, op: .add, action: .accept), WikiCopy.withdrawnRefused)
        XCTAssertNil(WikiLogic.decisionRefusal(.withdrawn, op: .challenge, action: .retire))
        XCTAssertNil(WikiLogic.decisionRefusal(.accepted, op: .amend, action: .accept))
        let review = try source(Self.review)
        assertSays(review, "const refusal = wikiDecisionRefusal(wikiRecordedDecision(answer, op.id), op.op, action);",
                   in: Self.review)
        assertSays(review, "if (refusal) toast.error(WIKI_DECIDE_FAILED, refusal);", in: Self.review)
    }

    /// The sentences built around a value, each the same expression at both ends.
    func testTheSentencesBuiltAroundAValue() throws {
        let web = try source(Self.lib)
        XCTAssertEqual(WikiCopy.proposalsToReview(3), "3 proposals to review")
        XCTAssertEqual(WikiCopy.proposalsToReview(1), "1 proposal to review")
        assertSays(web, "wikiProposalsToReview = (count: number): string => `${count} proposal${count === 1 ? '' : 's'} to review`",
                   in: Self.lib)
        XCTAssertEqual(WikiCopy.proposalsFrom(3, sessions: 2), "3 proposals from 2 sessions")
        XCTAssertEqual(WikiCopy.proposalsFrom(1, sessions: 1), "1 proposal from 1 session")
        assertSays(web, "`${count} proposal${count === 1 ? '' : 's'} from ${sessions} session${sessions === 1 ? '' : 's'}`",
                   in: Self.lib)
        XCTAssertEqual(WikiCopy.oldest("2h ago"), "oldest 2h ago")
        assertSays(web, "wikiOldest = (when: string): string => `oldest ${when}`", in: Self.lib)
        XCTAssertEqual([WikiCopy.entryNoun(1), WikiCopy.entryNoun(96)], ["entry", "entries"])
        assertSays(web, "(count === 1 ? 'entry' : 'entries')", in: Self.lib)
        XCTAssertEqual(WikiCopy.anchorsVerified(ref: "4db4f9f", ago: ""), "Anchors verified at 4db4f9f")
        XCTAssertEqual(WikiCopy.anchorsVerified(ref: "4db4f9f", ago: "2h ago"), "Anchors verified at 4db4f9f 2h ago")
        assertSays(web, "ago ? `Anchors verified at ${ref} ${ago}` : `Anchors verified at ${ref}`", in: Self.lib)
        XCTAssertEqual(WikiCopy.pushedTo(sessions: 41, fetched: 6), "Pushed to 41 sessions this week · fetched 6×")
        assertSays(web, "`Pushed to ${sessions} session${sessions === 1 ? '' : 's'} this week · fetched ${fetched}×`",
                   in: Self.lib)
        XCTAssertEqual(WikiCopy.revision(2), "r2")
        assertSays(web, "wikiRevision = (revision: number): string => `r${revision}`", in: Self.lib)
        XCTAssertEqual(WikiCopy.compareWith(1), "Compare with r1")
        assertSays(web, "wikiCompareWith = (revision: number): string => `Compare with r${revision}`", in: Self.lib)
        XCTAssertEqual(WikiCopy.ofCount(1, 3), "1 of 3")
        assertSays(web, "wikiOfCount = (at: number, total: number): string => `${at} of ${total}`", in: Self.lib)
        // Activity's, and the number waiting on the owner's (design §12.3.7).
        XCTAssertEqual(WikiCopy.waitingOnYou(3), "3 waiting on you")
        assertSays(web, "wikiWaitingOnYou = (count: number): string => `${count} waiting on you`", in: Self.lib)
        XCTAssertEqual(WikiCopy.newSinceLastLooked(4), "4 new since you last looked")
        assertSays(web, "wikiNewSinceLastLooked = (count: number): string => `${count} new since you last looked`",
                   in: Self.lib)
        XCTAssertEqual(WikiCopy.countInSpace(2, "wikova"), "· 2 in wikova")
        assertSays(web, "wikiCountInSpace = (count: number, space: string): string => `· ${count} in ${space}`", in: Self.lib)
        XCTAssertEqual(WikiCopy.inSpace("wikova"), "· in wikova")
        assertSays(web, "wikiInSpace = (space: string): string => `· in ${space}`", in: Self.lib)
        XCTAssertEqual(WikiCopy.spaceWaiting(2), "· 2 waiting")
        assertSays(web, "wikiSpaceWaiting = (count: number): string => `· ${count} waiting`", in: Self.lib)
        // The native picker's documents, in the documents' own words and plural.
        let docs = try source(Self.docsLib)
        XCTAssertEqual([WikiCopy.documentCount(1), WikiCopy.documentCount(35), WikiCopy.documentCount(1234)],
                       ["1 document", "35 documents", "1,234 documents"])
        assertSays(docs, "wikiDocumentCount = (count: number): string => plural(count, 'document', 'documents');",
                   in: Self.docsLib)
        assertSays(docs, "const plural = (count: number, one: string, many: string): string => "
                   + "`${wikiCount(count)} ${count === 1 ? one : many}`;", in: Self.docsLib)
        assertSays(docs, "export const WIKI_NO_DOCUMENTS = '\(WikiCopy.noDocuments)';", in: Self.docsLib)
    }

    /// The four one-word vocabularies — trust, kind, op, status — entry for entry.
    func testTheVocabulariesAreTheWebs() throws {
        let web = try source(Self.lib)
        let trust = try slice(web, from: "export const WIKI_TRUST_LABELS", to: "};")
        for value in WikiTrust.allCases where value != .unknown {
            assertSays(trust, "\(value.rawValue): '\(WikiCopy.trustLabel(value))'", in: Self.lib)
        }
        let kinds = try slice(web, from: "export const WIKI_KIND_LABELS", to: "};")
        for value in WikiEntryKind.allCases where value != .unknown {
            assertSays(kinds, "\(value.rawValue): '\(WikiCopy.kindLabel(value))'", in: Self.lib)
        }
        let ops = try slice(web, from: "export const WIKI_OP_LABELS", to: "};")
        for value in WikiOpKind.allCases where value != .unknown {
            assertSays(ops, "\(value.rawValue): '\(WikiCopy.opLabel(value))'", in: Self.lib)
        }
        let statuses = try slice(web, from: "export const WIKI_STATUS_LABELS", to: "};")
        for value in WikiEntryStatus.allCases where value != .unknown {
            assertSays(statuses, "\(value.rawValue): '\(WikiCopy.statusLabel(value))'", in: Self.lib)
        }
        let tones = try slice(web, from: "export const WIKI_TRUST_TONE", to: "};")
        for value in WikiTrust.allCases where value != .unknown {
            assertSays(tones, "\(value.rawValue): '\(WikiLogic.trustTone(value).rawValue)'", in: Self.lib)
        }
        // The four reasons, in the order Review's menu lists them, in `@orbit/shared`'s words.
        let shared = try source(Self.shared)
        assertSays(shared, "WIKI_REJECT_REASONS = ['not_true', 'not_useful', 'duplicate', 'too_specific'] as const",
                   in: Self.shared)
        let labels = try slice(shared, from: "WIKI_REJECT_REASON_LABELS", to: "};")
        for reason in WikiRejectReason.allCases {
            assertSays(labels, "\(reason.rawValue): '\(WikiCopy.rejectReasonLabel(reason))'", in: Self.shared)
        }
    }

    /// Details walks each kind's fields in the shared registry's order (`KIND_SPECS`), with the labels
    /// the design writes itself.
    func testDetailsWalksTheRegistrysOrder() throws {
        let shared = try source(Self.shared)
        let registry = try slice(shared, from: "export const KIND_SPECS", to: "/** Each anchor type's own keys")
        for (kind, fields) in WikiLogic.kindFields {
            let spec = try slice(registry, from: "kindSpec( '\(kind.rawValue)'", to: "ownerOnlyOps")
            assertOrder(spec, fields.map { "\($0): {" }, "\(kind.rawValue)'s fields")
        }
        for (field, nested) in WikiLogic.nestedFields {
            let block = try slice(registry, from: "\(field): {", to: "}, }")
            assertOrder(block, nested.map { "\($0): {" }, "\(field)'s fields")
        }
        let web = try source(Self.lib)
        for (key, label) in [("whyRejected", "Rejected"), ("alternatives", "Rejected"), ("decidedAt", "Decided"),
                             ("notToConfuseWith", "Not to be confused with"),
                             ("expectedExit", "Expected exit code"), ("errorSignature", "Error signature")] {
            XCTAssertEqual(WikiLogic.fieldLabel(key), label)
            assertSays(web, "\(key): '\(label)'", in: Self.lib)
        }
        assertSays(web, "if (option && why) return [`${option} — ${why}`];", in: Self.lib)
    }

    // MARK: the drawer's Wiki row

    /// The row sits right after Projects, draws the book, and its amber number is what waits on the owner
    /// across every space — each space's proposals and the things its plan waits for (`wikiWaiting`) —
    /// nothing at zero, and "3 waiting on you" as its accessible name, the Projects row's own words. The
    /// head's Activity badge is the same number from the same function.
    func testTheDrawerRowCountsWhatTheWebSidebarCounts() throws {
        let web = try source(Self.sidebar)
        assertOrder(web, ["key: 'projects'", "{ key: 'wiki', icon: <SidebarNavIcon name=\"wiki\" />, label: 'Wiki' }"],
                    "the sidebar's top rows")
        assertSays(web, "const wikiWaitingCount = wikiWaiting(wikiSpaces.data ?? []);", in: Self.sidebar)
        assertSays(web, "t.key === 'wiki' && wikiWaitingCount > 0", in: Self.sidebar)
        assertSays(web, "aria-label={wikiWaitingOnYou(wikiWaitingCount)}", in: Self.sidebar)
        let rules = try source(Self.spaceLib)
        assertSays(rules, "return (space.pendingOps ?? 0) + (space.planWaiting ?? 0);", in: Self.spaceLib)
        assertSays(rules, "return spaces.reduce((sum, space) => sum + wikiWaitingIn(space), 0);", in: Self.spaceLib)
        XCTAssertEqual(WikiSpaceLogic.waiting([WikiSpace(id: "a", slug: "a", pendingOps: 1, planWaiting: 2),
                                               WikiSpace(id: "b", slug: "b", pendingOps: 3)]), 6)
        XCTAssertEqual(WikiCopy.waitingOnYou(6), "6 waiting on you")
        let page = try source(Self.page)
        assertSays(page, "<WikiActivityButton spaceSlug={space.slug} waiting={wikiWaiting(rows)} on={activity} />",
                   in: Self.page)
        XCTAssertEqual(AppSection.wiki.title, "Wiki")
        XCTAssertEqual(AppSection.workSections.firstIndex(of: .wiki), AppSection.workSections.count - 1,
                       "the Wiki follows the work: Projects, Tasks, then Wiki")
    }

    /// The head's buttons, in the web's order: Contents, Activity, Settings (then New entry, which the native
    /// bar has none of) — the bar's own order (design §12.3.1).
    func testTheHeadsButtonsAreTheWebsInItsOrder() throws {
        let page = try source(Self.page)
        let actions = try slice(page, from: "<div className=\"wk-actions\">", to: "</div>")
        assertOrder(actions, ["<WikiContentsButton />", "<WikiActivityButton", "<WikiSettingsButton", "<WikiNewEntryButton"],
                    "the head's buttons")
        let activity = try source(Self.activity)
        assertSays(activity, "icon={<HistoryOutlined />}", in: Self.activity)
        assertSays(activity, "{waiting > 0 && (", in: Self.activity)
        assertSays(activity, "aria-label={wikiWaitingOnYou(waiting)}", in: Self.activity)
    }

    /// One space is a label and several a picker (§12.3.4, mock 31 ④), by the same names; the rules for
    /// names, which space opens and what waits are held to the one fixture both ends read.
    func testTheSpaceRulesAreTheWebs() throws {
        let page = try source(Self.page)
        let head = try slice(page, from: "function WikiHeadSpace(", to: "/** The status row")
        assertOrder(head, ["const names = useMemo(() => wikiSpaceNames(spaces), [spaces]);", "if (spaces.length < 2) {",
                           "<span className=\"wk-space-tag\"", "{wikiSpaceOption(names.get(row.id) ?? row.title, row)}"],
                    "the head's space")
        assertSays(page, "wikiDefaultSpace(spaces.data ?? [], { workspaceId: readWikiFromWorkspace(), lastSlug: readWikiLastSpace() })",
                   in: Self.page)
        let rules = try source(Self.spaceLib)
        assertOrder(rules, ["if (bound) return bound;", "if (last) return last;",
                            "(most === null || (space.docs?.written ?? 0) > (most.docs?.written ?? 0) ? space : most)"],
                    "the space the Wiki opens")
        let tests = try source("src/web/src/lib/wikiSpace.test.ts")
        assertSays(tests, "'../shared/src/wiki-space.fixture.json'", in: "src/web/src/lib/wikiSpace.test.ts")
    }

    // MARK: Activity

    /// Activity's blocks are the web's, in its order (mock 31 ②): the status line under the title, the
    /// proposals' banner into Review, the space's plan banners, the other spaces' that wait, the server's
    /// runs after Review and Plan (mock 35 ④), then Recent decisions, Recently changed and Agents used the
    /// wiki — the desktop's Review and Plan cards, which a phone hides, aside. The native page iterates
    /// `WikiLogic.ActivityBand`.
    func testActivityIsTheWebsInItsOrder() throws {
        let page = try source(Self.activity)
        let body = try slice(page, from: "<div className=\"wk-act\">", to: "export function WikiActivityButton")
        assertOrder(body, ["{status}",
                           "<Link className=\"wk-banner\" to={WIKI_REVIEW_PATH} data-waiting={wikiProposalsWaiting(spaces)}>",
                           "<WikiPlanBanners space={space} />",
                           "<WikiPlanBanners key={row.id} space={row} elsewhere={names.get(row.id) ?? row.title} />",
                           "<WikiPlanCard space={space} />", "<WikiRunsCard space={space} />",
                           "title={WIKI_RECENT_DECISIONS}", "title={WIKI_RECENTLY_CHANGED}", "<UsageCard space={detail.data} />"],
                    "Activity's blocks")
        XCTAssertEqual(WikiLogic.ActivityBand.allCases, [.status, .reviewBanner, .planBanners, .otherPlanBanners, .runs,
                                                         .recentDecisions, .recentlyChanged, .agentsUsed])
        XCTAssertEqual(WikiLogic.ActivityBand.allCases.compactMap(\.title),
                       [WikiRunsCopy.runs, WikiCopy.recentDecisions, WikiCopy.recentlyChanged, WikiCopy.agentsUsed])
        // A phone draws the banners and hides the desktop's two cards.
        let css = try source(Self.css)
        for rule in [".wk-banner { display: flex; }", ".wk-review-card { display: none; }", ".wk-plan-card { display: none; }"] {
            assertSays(css, rule, in: Self.css)
        }
        // The Runs card is no desktop card: a phone draws it as the native band is drawn.
        XCTAssertFalse(css.contains(".wk-jobs-card { display: none; }"), "a phone keeps the Runs card")
        // The first banner: every space's proposals, the others' shares on its line; the other spaces' plans
        // that wait come after the space's own.
        assertSays(page, "const proposals = wikiProposalsBanner(spaces, space.id, names);", in: Self.activity)
        assertSays(page, "const elsewhere = spaces.filter((row) => row.id !== space.id && (row.planWaiting ?? 0) > 0);",
                   in: Self.activity)
        let card = try source(Self.planCard)
        assertSays(card, "const banners = waiting.length > 0 || elsewhere ? waiting : "
                   + "[{ ...wikiPlanBanner(look, plan, context), look, count: 0 }];", in: Self.planCard)
        assertSays(card, "{elsewhere ? `${banner.text} ${wikiInSpace(elsewhere)}` : banner.text}", in: Self.planCard)
        // One banner for each kind of thing the plan waits for, in the order the looks win.
        let plan = try source(Self.planLib)
        assertSays(plan, "['held', held], ['draftFailed', wikiPlanFailedJob(state) ? 1 : 0], "
                   + "['draftReady', state.draft ? 1 : 0], ['changes', state.proposals.length],", in: Self.planLib)
        let state = try JSONDecoder().decode(WikiPlanState.self, from: Data(
            #"{"draft":{"id":"v2","version":2,"status":"draft"},"proposals":[{"id":"p","status":"pending"}]}"#.utf8))
        XCTAssertEqual(WikiPlanLogic.waitingBanners(state, now: Date(), docs: nil, runnerOnline: true).map(\.look),
                       [.draftReady, .changes])
        // What is new is what came after the reader last looked: the home's stamp, as it stood before the
        // home moved it, and moved by Activity in its turn.
        assertSays(page, "const seenKey = wikiSeenKey(space.slug, 'home');", in: Self.activity)
        assertSays(page, "const [seen] = useState(() => readWikiSeenBefore(seenKey));", in: Self.activity)
        assertSays(page, "useEffect(() => moveWikiSeen(seenKey), [seenKey]);", in: Self.activity)
        assertSays(page, "const fresh = (at: string): boolean => seen <= 0 || Date.parse(at) > seen;", in: Self.activity)
        assertSays(page, "{wikiNewSinceLastLooked(freshRows)}", in: Self.activity)
        // Recent decisions keep their own read, and the head is Review's: the title and the space's name.
        assertSays(page, "useQuery(wikiEntriesOfKindQuery(space.id, 'decision', RECENT_DECISIONS))", in: Self.activity)
        assertSays(page, "<h1 className=\"page-title\">{WIKI_ACTIVITY}</h1>", in: Self.activity)
        assertSays(page, "<span className=\"wk-space-tag\">{names.get(space.id) ?? space.title}</span>", in: Self.activity)
    }

    // MARK: the home page

    /// The home under its head, top to bottom (design §12.3.1, mocks 30 ③, 31 ① ③): the line that says what
    /// the space holds, the search, the principles when there are any, the documents by category, then Browse
    /// by category · A–Z index. Three places hold the web phone's order together — `WikiPage.tsx` draws the
    /// head, the line and the search, `WikiHome.tsx` the rest, and index.css's phone rules keep them one
    /// column in that order — and iOS draws `WikiLogic.HomeBand` in the same one. No block says how the wiki
    /// is kept: the status row, Review, the plan, the decisions, the changes and the agents' use are Activity's.
    func testTheHomeBandsAreTheWebPhonesInItsOrder() throws {
        let page = try source(Self.page)
        let frame = try slice(page, from: "function WikiFrame(", to: "function WikiHeadSpace(")
        assertOrder(frame, ["<h1 className=\"page-title\">{WIKI_TITLE}</h1>",
                            "{space && (home || activity) && <WikiHomeState spaceId={space.id} />}",
                            "<div className=\"wk-search\" role=\"search\">",
                            "{!home && !activity && <WikiStatusRow space={space} />}",
                            "<div className={`wk-layout${home ? ' home' : ''}`}>"], "the web's head, line and search")
        let home = try source(Self.home)
        let body = try slice(home, from: "export function WikiHome(", to: "export function WikiHomeState(")
        assertOrder(body, ["{principles.length > 0 && <HomePrinciples", "<HomeSkeleton />", "<HomeCategory key={category.key}",
                           "<HomeTopics key={group.key}", "<HomeNewSpace", "<div className=\"wk-home-more\">",
                           "{WIKI_BROWSE}", "{WIKI_AZ_INDEX}"], "the web's home")
        for gone in ["wk-cols", "<ReviewCard", "WIKI_RECENT_DECISIONS", "WIKI_RECENTLY_CHANGED", "<UsageCard", "wk-banner"] {
            XCTAssertFalse(body.contains(gone), "the home draws \(gone) again: that is Activity's")
        }
        // A phone: one column — the head, the line under it (no rule moves it from there), the search, then
        // the home, which ends on Browse · A–Z; the directory is the Contents drawer.
        let css = try source(Self.css)
        let phone = try slice(css, from: "@media (max-width: 960px) { .wk-page { display: flex; flex-direction: column; }",
                              to: ".wk-art-page .t-title, .wk-browse-page .t-title")
        for rule in [".wk-page > .wk-title-row { order: 0; }", ".wk-page > .wk-search { order: 2;",
                     ".wk-page > .wk-layout, .wk-page > .wk-body { order: 3; }", ".wk-home > .wk-home-more { display: flex; }",
                     ".wk-dir-col { display: none; }"] {
            assertSays(phone, rule, in: Self.css)
        }
        XCTAssertFalse(css.contains(".wk-home-state { order"), "the line stays where the page draws it: under the head")
        assertSays(css, ".wk-home-more { display: none;", in: Self.css)
        XCTAssertEqual(WikiLogic.HomeBand.allCases, [.state, .search, .principles, .documents, .more],
                       "the native bands are the web phone's, block for block")
        XCTAssertEqual(WikiLogic.HomeBand.allCases.compactMap(\.title), [WikiCopy.principles])
    }

    /// What each band draws of what the home read — the web's branches, the native `homeDocuments` and
    /// `homeLine`: grey bars while the first read is out; the confirmed plan's documents; before a plan, the
    /// topic articles; else a new space's card, or nothing once maintenance is set up. Browse · A–Z ends the
    /// home only once something is listed.
    func testTheHomeDrawsWhatItReadAsTheWebDoes() throws {
        let home = try source(Self.home)
        assertSays(home, "loading: docs.isPending || (!byDocs && articles.isPending),", in: Self.home)
        assertSays(home, "const listed = home.directory !== null || home.topics > 0;", in: Self.home)
        assertSays(home, "!space.settings?.maintenance?.enabled && <HomeNewSpace spaceSlug={space.slug} />", in: Self.home)
        assertSays(home, "{!home.loading && listed && (", in: Self.home)
        assertSays(home, "{home.loading ? <span className=\"wk-sk\" aria-hidden=\"true\" /> : wikiHomeLine(home.directory, home.topics)}",
                   in: Self.home)
        assertSays(home, "<p>{WIKI_NO_DOCUMENTS_NOTE}</p> <Link to={wikiSettingsPath(spaceSlug)}>{WIKI_PLAN_SET_UP} ›</Link>",
                   in: Self.home)

        let plan = try JSONDecoder().decode(WikiDocsDirectory.self, from: Data(#"""
            {"spaceId":"s","plan":{"version":13,"confirmedAt":"2026-10-01T00:00:00.000Z"},"docs":{"total":3,"written":1},
             "categories":[{"key":"overview","number":1,"title":"产品概览与架构","docs":[
               {"slug":"product","number":"1.1","title":"产品定位与核心能力","written":true,"updatedAt":"2026-10-06T08:00:00.000Z",
                "lead":"Orbit 是自托管的 coding agent 控制台。"},
               {"slug":"deploy","number":"1.2","title":"自部署与首次运行","written":false}]},
              {"key":"runners","number":4,"title":"Runner 与运行时","docs":[{"slug":"runner","number":"4.1","title":"Runner 注册与排障","written":false}]},
              {"key":"empty","number":5,"title":"Nothing yet","docs":[]}]}
            """#.utf8))
        let articles = try JSONDecoder().decode(WikiArticleDirectory.self, from: Data(#"""
            {"spaceId":"s","categories":[{"key":"platform","title":"Platform core","topics":[
               {"slug":"tasks","title":"任务与派发"},{"slug":"sessions","title":"会话"}]}],"uncategorized":[]}
            """#.utf8))
        let none = try JSONDecoder().decode(WikiArticleDirectory.self, from: Data(#"{"categories":[],"uncategorized":[]}"#.utf8))
        let unplanned = try JSONDecoder().decode(WikiDocsDirectory.self, from: Data(#"{"plan":null,"docs":null,"categories":[]}"#.utf8))

        XCTAssertEqual(WikiLogic.homeDocuments(docs: plan, articles: articles, loading: true, maintenance: false, seen: 0), .loading)
        XCTAssertNil(WikiLogic.homeLine(docs: plan, articles: articles, loading: true))
        guard case .categories(let categories) = WikiLogic.homeDocuments(docs: plan, articles: articles, loading: false,
                                                                          maintenance: false, seen: 0) else {
            return XCTFail("a confirmed plan's home lists its documents")
        }
        XCTAssertEqual(categories.map(\.number), [1, 4], "a category with no document is left out")
        XCTAssertEqual(categories.map(WikiDocLogic.notWrittenRow), ["+1 not written yet", "1 document · Not written yet"])
        XCTAssertEqual(WikiLogic.homeLine(docs: plan, articles: articles, loading: false), "3 documents · 1 written")

        let topics = WikiLogic.homeDocuments(docs: unplanned, articles: articles, loading: false, maintenance: false, seen: 0)
        XCTAssertEqual(topics, .topics(WikiArticleLogic.directoryGroups(articles)), "before a plan: the topic articles")
        XCTAssertTrue(topics.listed)
        XCTAssertEqual(WikiLogic.homeLine(docs: unplanned, articles: articles, loading: false), "2 articles")

        XCTAssertEqual(WikiLogic.homeDocuments(docs: unplanned, articles: none, loading: false, maintenance: false, seen: 0), .newSpace)
        XCTAssertEqual(WikiLogic.homeDocuments(docs: nil, articles: nil, loading: false, maintenance: true, seen: 0), .nothing,
                       "maintenance set up: the line says No documents yet, and nothing more")
        XCTAssertFalse(WikiLogic.HomeDocuments.newSpace.listed)
        XCTAssertEqual(WikiLogic.homeLine(docs: unplanned, articles: none, loading: false), WikiCopy.noDocuments)
        XCTAssertEqual(WikiDocCopy.noDocumentsNote,
                       "This wiki has no documents yet. Maintenance drafts a plan and writes them; it isn’t set up for this space.")
        XCTAssertEqual(WikiPlanCopy.setUp, "Set up maintenance")
    }

    /// The home page's rows are the web's: principles oldest recorded first, the four newest
    /// decisions, the five newest changes, the three most used — and the verbs.
    func testTheHomeRowsAreTheWebsRows() throws {
        let activity = try source(Self.activity)
        // Recently changed is Activity's now (design §12.3.2). One run is one row: the five newest rows,
        // every run folded in by the changeset its items name (`wikiRecentRows`) — the same five
        // `WikiHomeContent.recentRows` the native Activity draws.
        assertSays(activity, "const rows = useMemo(() => wikiRecentRows(timeline.data?.items ?? []).slice(0, 5), [timeline.data]);",
                   in: Self.activity)
        assertSays(activity, "{rows.map((row) =>", in: Self.activity)
        let lib = try source(Self.lib)
        for verb in ["if (item.decision === 'accepted') return WIKI_HISTORY_CONFIRMED_BY;",
                     "if (item.decision === 'edited') return 'Edited by you';",
                     "return 'Retired';", "return 'Superseded';", "return 'Reinforced';", "return 'Challenged';",
                     "return item.origin === 'owner' ? 'Added by you' : item.appliedByMode ? 'Added' : 'Proposed';",
                     "return item.origin === 'owner' ? 'Amended by you' : 'Amended';",
                     "`replaced by “${item.supersededByTitle}”`", "`replaces “${item.supersededByTitle}”`"] {
            assertSays(lib, verb, in: Self.lib)
        }
    }

    /// Principles and Recent decisions read their own kind at both ends, the same number of each — never
    /// picked out of the newest 200 entries of every kind — and with no principle the home draws no band and
    /// says nothing of them (mock 31 ③); with some, the first three, then `All N ›`.
    func testTheHomeReadsItsBandsByKind() throws {
        let home = try source(Self.home)
        assertSays(home, "const PRINCIPLES_READ = \(WikiLogic.principlesRead);", in: Self.home)
        assertSays(home, "const PRINCIPLES_SHOWN = \(WikiLogic.principlesShown);", in: Self.home)
        assertSays(home, "const RECENT_DECISIONS = \(WikiHomeContent.recentDecisionCount);", in: Self.home)
        assertSays(home, "useQuery(wikiEntriesOfKindQuery(space.id, 'principle', PRINCIPLES_READ))", in: Self.home)
        assertSays(home, "wikiEntriesOfKind(principleRead.data ?? [], 'principle')", in: Self.home)
        // Recent decisions went to Activity with the home's other management blocks (design §12.3.2), and
        // read their own kind there, the home's number of them.
        let activity = try source(Self.activity)
        assertSays(activity, "useQuery(wikiEntriesOfKindQuery(space.id, 'decision', RECENT_DECISIONS))", in: Self.activity)
        assertSays(activity, "wikiEntriesOfKind(decisionRead.data ?? [], 'decision')", in: Self.activity)
        assertSays(home, "{principles.length > 0 && <HomePrinciples", in: Self.home)
        XCTAssertFalse(home.contains("WIKI_NO_PRINCIPLES"), "no principle, no band — and nothing said of them")
        XCTAssertFalse(home.contains("WIKI_NO_ENTRIES"), "the home no longer says the space holds nothing")
        // Oldest recorded first, the first three a title a row with its day, then the way to all of them.
        assertSays(home, "(a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt),", in: Self.home)
        assertSays(home, "{!all && principles.length > PRINCIPLES_SHOWN && (", in: Self.home)
        assertSays(home, "{wikiAllPrinciples(principles.length)}", in: Self.home)
        assertSays(home, "<WikiTrustBadge trust=\"owner\" />", in: Self.home)
        assertSays(home, "fresh={wikiChangedSince([entry], seen).length > 0}", in: Self.home)
        assertSays(home, "end={<span className=\"d\">{wikiShortDay(entry.validFrom)}</span>}", in: Self.home)
        let lib = try source(Self.lib)
        assertSays(lib, "wikiAllPrinciples = (count: number): string => `All ${count} ›`;", in: Self.lib)
        assertSays(lib, "return `${at.getMonth() + 1}/${at.getDate()}`;", in: Self.lib)
        XCTAssertEqual(WikiCopy.allPrinciples(6), "All 6 ›")
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(WikiLogic.shortDay("2026-09-06T12:00:00.000Z", timeZone: utc), "9/6")
        XCTAssertEqual(WikiLogic.shortDay("2026-10-19T12:00:00.000Z", timeZone: utc), "10/19")
        XCTAssertNil(WikiLogic.shortDay("not a day", timeZone: utc))
        let at = { (id: String, day: String) in
            WikiEntry(id: id, kind: .principle, trust: .owner, title: id, validFrom: day, recordedAt: day)
        }
        XCTAssertEqual(WikiLogic.principles([at("b", "2026-09-19T00:00:00.000Z"), at("a", "2026-09-06T00:00:00.000Z"),
                                             at("c", "2026-09-19T00:00:00.000Z")]).map(\.id), ["a", "b", "c"],
                       "oldest first, a tie in the server's order")
        let queries = try source("src/web/src/lib/queries.ts")
        assertSays(queries, "/entries?kind=${kind}&limit=${limit}`", in: "src/web/src/lib/queries.ts")
    }

    /// A Review card names the entry it is about by the title Review's read carries (`entryTitle`) when
    /// no draft names one — the web's home card and Review page, the native card's `knownTitle`.
    func testAReviewCardNamesItsEntryByTheTitleTheQueueCarries() throws {
        let home = try source(Self.home)
        let title = try slice(home, from: "export function opTitle(op: WikiChangesetOp): string {",
                              to: "return op.op === 'add' ? 'A new entry' : 'An entry';")
        assertOrder(title, ["if (typeof payload.entry?.title === 'string') return payload.entry.title;",
                            "if (op.entryTitle) return op.entryTitle;",
                            "if (typeof payload.changes?.title === 'string') return payload.changes.title;"],
                    "the home card's title")
        let shared = try source(Self.shared)
        assertSays(shared, "entryTitle?: string | null;", in: Self.shared)
        let op = WikiChangesetOp(id: "o", op: .challenge, entryId: "e", entryTitle: "An entry older than any window")
        let card = WikiLogic.ReviewCard(changeset: WikiChangeset(id: "c", ops: [op]), op: op)
        XCTAssertEqual(WikiLogic.cardTitle(card, entry: nil), "An entry older than any window")
    }

    /// The wiki off for this account (404 WIKI_DISABLED) is the web's answer at both ends: no Wiki row,
    /// and the section's sentence where its pages would be.
    func testTheWikiOffForThisAccountIsTheWebsAnswer() throws {
        let web = try source(Self.lib)
        assertSays(web, "export const WIKI_DISABLED = '\(WikiLogic.disabledCode)';", in: Self.lib)
        assertSays(web, "return error instanceof ApiError && error.status === 404 && error.code === WIKI_DISABLED;",
                   in: Self.lib)
        assertSays(web, "return spaces.data !== undefined ? spaces.data !== null : spaces.isError;", in: Self.lib)
        let sidebar = try source(Self.sidebar)
        assertSays(sidebar, "const topItems = wikiShown(wikiSpaces) ? TOP : TOP.filter((t) => t.key !== 'wiki');",
                   in: Self.sidebar)
        let page = try source(Self.page)
        assertSays(page, "<WikiEmpty>{WIKI_DISABLED_NOTE}</WikiEmpty>", in: Self.page)
        XCTAssertEqual(WikiCopy.disabledNote, "The wiki is not switched on for this account.")
    }

    // MARK: one entry

    /// Details, Sources, Anchors, Where it's used, History — the drawer's order, which the native
    /// page iterates.
    func testTheEntrySectionsAreTheDrawersInItsOrder() throws {
        let drawer = try source(Self.drawer)
        assertOrder(drawer, ["<Section title={WIKI_SECTION_DETAILS}>", "<Section title={WIKI_SECTION_SOURCES}",
                             "<Section title={WIKI_SECTION_ANCHORS}", "<Section title={WIKI_SECTION_USED}>",
                             "<Section title={WIKI_SECTION_HISTORY}>"], "the entry's sections")
        XCTAssertEqual(WikiLogic.EntrySection.allCases.map(\.title),
                       [WikiCopy.details, WikiCopy.sources, WikiCopy.anchors, WikiCopy.whereUsed, WikiCopy.history])
        // The anchors' footnote is said only when there are anchors to re-check.
        let anchors = try slice(drawer, from: "<Section title={WIKI_SECTION_ANCHORS}", to: "</Section>")
        assertOrder(anchors, ["(data.anchors?.length ?? 0) === 0 ? (", "No anchor: nothing in the repository",
                              ") : (", "<div className=\"wk-anc-note\">{WIKI_ANCHORS_NOTE}</div>"],
                    "the anchors section")
        // Only Sources and Anchors carry a count.
        assertSays(drawer, "<Section title={WIKI_SECTION_SOURCES} count={data.sources?.length ?? 0}>", in: Self.drawer)
        assertSays(drawer, "<Section title={WIKI_SECTION_ANCHORS} count={data.anchors?.length ?? 0}>", in: Self.drawer)
    }

    /// Failure titles name the same action at both ends, leaving server reasons beneath them.
    func testFailedWritesNameTheActionInTheWebsWords() throws {
        let pages: [(String, [String])] = [
            (Self.drawer, [WikiCopy.entrySaveFailed, WikiCopy.entrySupersedeFailed, WikiCopy.entryRetireFailed]),
            ("src/web/src/components/WikiEntryMarks.tsx", [WikiCopy.entryConfirmFailed]),
            ("src/web/src/components/WikiRunPage.tsx", [WikiCopy.runRevertFailed, WikiCopy.entryRejectFailed]),
            ("src/web/src/components/WikiSettingsPage.tsx", [WikiCopy.settingsSaveFailed]),
            ("src/web/src/components/WikiPlanPage.tsx", [WikiCopy.planDraftFailed, WikiCopy.planRedraftFailed,
                                                       WikiCopy.planConfirmFailed, WikiCopy.changeAcceptFailed,
                                                       WikiCopy.changeEditFailed, WikiCopy.changeRejectFailed]),
        ]
        for (path, titles) in pages {
            let web = try source(path)
            for title in titles {
                assertSays(web, "\"\(title)\"", in: path)
                XCTAssertTrue(title.hasPrefix("Couldn't "))
            }
        }
    }

    /// Edit, then the ⋯ menu — Supersede…, Retire… (the destructive one), Copy link — and the three
    /// forms they open, each in the drawer's own words.
    func testTheEntrysActionsAndForms() throws {
        let drawer = try source(Self.drawer)
        assertOrder(drawer, ["{WIKI_ACTION_EDIT}",
                             "{ key: 'supersede', icon: <SwapOutlined />, label: WIKI_ACTION_SUPERSEDE }",
                             "{ key: 'retire', icon: <StopOutlined />, label: WIKI_ACTION_RETIRE, danger: true }",
                             "label: copied ? WIKI_LINK_COPIED : WIKI_ACTION_COPY_LINK"], "the entry's actions")
        for text in [WikiCopy.editNote, WikiCopy.supersedeNote, WikiCopy.retireNote] {
            assertSays(drawer, text, in: Self.drawer)
        }
        for placeholder in [WikiCopy.titlePlaceholder, WikiCopy.summaryPlaceholder, WikiCopy.reasonPlaceholder] {
            assertSays(drawer, "placeholder=\"\(placeholder)\"", in: Self.drawer)
        }
        assertSays(drawer, "okText={mode === 'retire' ? '\(WikiCopy.retireConfirm)' : mode === 'supersede' ? "
                   + "'\(WikiCopy.supersedeConfirm)' : '\(WikiCopy.save)'}", in: Self.drawer)
        assertSays(drawer, "message.success(mode === 'retire' ? '\(WikiCopy.retired)' : mode === 'supersede' ? "
                   + "'\(WikiCopy.superseded)' : '\(WikiCopy.saved)');", in: Self.drawer)
        assertSays(drawer, "message.error(ENTRY_WRITE_FAILED[mode], error instanceof Error ? error.message : undefined);",
                   in: Self.drawer)
        XCTAssertEqual(WikiCopy.retiredRationale("T"), "the owner retired “T”")
        XCTAssertEqual(WikiCopy.editedRationale("T"), "the owner edited “T”")
        XCTAssertEqual(WikiCopy.replacedRationale("T"), "the owner replaced “T”")
        assertSays(drawer, "`the owner retired “${entry.title}”`", in: Self.drawer)
        assertSays(drawer, "`the owner ${mode === 'supersede' ? 'replaced' : 'edited'} “${entry.title}”`", in: Self.drawer)
    }

    /// The head's chips and each section's inline words.
    func testTheEntrysSectionWords() throws {
        let drawer = try source(Self.drawer)
        assertSays(drawer, "{data.pinned && <span className=\"tdp-badge tone-muted\">\(WikiCopy.pinned)</span>}", in: Self.drawer)
        assertSays(drawer, "{data.tainted && <span className=\"tdp-badge tone-amber\">\(WikiCopy.webDerived)</span>}",
                   in: Self.drawer)
        for text in [WikiCopy.noSources, WikiCopy.noAnchors, WikiCopy.noHistory] {
            assertSays(drawer, text, in: Self.drawer)
        }
        assertSays(drawer, "{row.channel === 'push' ? '\(WikiCopy.pushedAtStart)' : 'wiki_get'}", in: Self.drawer)
        assertSays(drawer, "{row.channel === 'push' ? '\(WikiCopy.pushedBadge)' : '\(WikiCopy.fetchedBadge)'}",
                   in: Self.drawer)
        assertSays(drawer, "if (!sessionId) return 'A session without an id';", in: Self.drawer)
        assertSays(drawer, "`Session ${sessionId.slice(0, 8)}`", in: Self.drawer)
        assertSays(drawer, "{index === 0 && next && ` · ${wikiCompareWith(next.revision)}`}", in: Self.drawer)
        // Where a source's word comes from.
        let words = try source(Self.sources)
        let table = try slice(words, from: "const SOURCE_WORDS", to: "};")
        for kind in WikiSourceKind.allCases where kind != .unknown && kind != .url {
            assertSays(table, "\(kind.rawValue): '\(WikiLogic.sourceWord(kind))'", in: Self.sources)
        }
    }

    // MARK: Review

    /// The tabs, the pager, a card's anatomy and its answers — Accept, Edit, Reject▾, and Retire /
    /// Keep for a retirement — in the web card's order.
    func testReviewIsTheWebsReview() throws {
        let review = try source(Self.review)
        assertOrder(review, ["['all', WIKI_TAB_ALL, counts.all]", "['add', WIKI_TAB_ADD, counts.add]",
                             "['amend', WIKI_TAB_AMEND, counts.amend]", "['retire', WIKI_TAB_RETIRE, counts.retire]"],
                    "Review's tabs")
        XCTAssertEqual(WikiLogic.ReviewTab.allCases.map(\.title),
                       [WikiCopy.tabAll, WikiCopy.tabAdd, WikiCopy.tabAmend, WikiCopy.tabRetire])
        assertOrder(review, ["{WIKI_PREVIOUS}", "{wikiOfCount(current + 1, shown.length)}", "{WIKI_NEXT}"],
                    "the phone pager")
        let actions = try slice(review, from: "<div className=\"card-actions approval-actions\">",
                                to: "<span className=\"note\">")
        assertOrder(actions, ["{WIKI_REVIEW_RETIRE}", "{WIKI_REVIEW_KEEP}", "{WIKI_REVIEW_ACCEPT}",
                              "{WIKI_REVIEW_EDIT}", "{WIKI_REVIEW_REJECT}"], "a card's answers")
        assertSays(actions, "decide({ opId: op.id, action: 'reject', reason: 'not_true' })", in: Self.review)
        XCTAssertEqual(WikiRejectReason.allCases.first, .notTrue, "Keep is a rejection as Not true")
        assertSays(review, "{op.tainted ? WIKI_WEB_DERIVED_NOTE : WIKI_ACCEPT_NOTE}", in: Self.review)
        assertSays(review, "items: WIKI_REJECT_MENU.map(({ reason, label }) => ({ key: reason, label }))", in: Self.review)
        // The retire card's three rows, and the others' three.
        assertOrder(review, ["<span className=\"k\">\(WikiCopy.reasonLabel)</span>",
                             "<span className=\"k\">\(WikiCopy.evidenceLabel)</span>",
                             "<span className=\"k\">\(WikiCopy.afterLabel)</span>"], "a retire card's rows")
        assertOrder(review, ["<span className=\"k\">\(WikiCopy.sources)</span>",
                             "<span className=\"k\">\(WikiCopy.anchors)</span>", "{WIKI_SIMILAR_ENTRIES}"],
                    "a card's references")
        assertSays(review, "{WIKI_REVIEW_RETIRE} <span className=\"q\">“{title ?? WIKI_ENTRY_WORD}”</span>", in: Self.review)
        // Who proposed it, and the chip.
        assertSays(review, "· \(WikiCopy.proposedBy){' '}", in: Self.review)
        assertSays(review, "{changeset.rationale ? shortRationale(changeset.rationale) : 'a session'}", in: Self.review)
        assertSays(review, "{changeset.origin === 'owner' ? 'you' : WIKI_MAINTENANCE_WORD}", in: Self.review)
        assertSays(review, "const WIKI_MAINTENANCE_WORD = '\(WikiCopy.historyMaintenance)';", in: Self.review)
        assertSays(review, "const WIKI_ENTRY_WORD = '\(WikiCopy.entryWord)';", in: Self.review)
        assertSays(review, "return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;", in: Self.review)
        assertSays(review, "op === 'supersede' ? 'AMEND' : op.toUpperCase()", in: Self.review)
        // The toast a landed answer floats: its outcome in the answer's words, the entry under it.
        assertSays(review, "toast.success(wikiDecidedToast(op.op, action), about ?? undefined);", in: Self.review)
        assertSays(review, "decided(decision.action, answer);", in: Self.review)
        assertSays(review, "decided('edit', answer, edited.title ?? title);", in: Self.review)
        assertSays(review, "toast.error(WIKI_DECIDE_FAILED, error instanceof Error ? error.message : undefined);",
                   in: Self.review)
        // What a card is about, and the anchors it lists: the draft's, else the named entry's.
        assertSays(review, "const draft = (payload.entry ?? {}) as Record<string, unknown>;", in: Self.review)
        assertSays(review, "typeof draft.title === 'string' ? draft.title : (target.data?.title ?? op.entryTitle ?? null);",
                   in: Self.review)
        assertSays(review, "const raw = Array.isArray(draft.anchors) ? draft.anchors : Array.isArray(fallback) ? fallback : [];",
                   in: Self.review)
        assertSays(review, "if (typeof row.sha === 'string') return [row.sha];", in: Self.review)
        // The diff is the web's: one hunk per change, in the order the changes arrive.
        let lib = try source(Self.lib)
        assertSays(lib, "return Object.entries(changes).flatMap(([key, value]) => {", in: Self.lib)
        // Under 600px the answers are one full-width column, Accept first.
        let css = try source(Self.css)
        assertSays(css, "@media (max-width: 600px) { .card-actions { flex-direction: column; align-items: stretch; }",
                   in: Self.css)
    }
}
