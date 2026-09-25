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
            ("WIKI_TOPICS", WikiCopy.topics),
            ("WIKI_RECENT_DECISIONS", WikiCopy.recentDecisions),
            ("WIKI_RECENTLY_CHANGED", WikiCopy.recentlyChanged),
            ("WIKI_AGENTS_USED", WikiCopy.agentsUsed),
            ("WIKI_AGENTS_USED_HINT", WikiCopy.agentsUsedHint),
            ("WIKI_NO_SPACES", WikiCopy.noSpaces),
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
            ("WIKI_NO_ENTRIES", WikiCopy.noEntries),
            ("WIKI_NO_REVIEW", WikiCopy.noReview),
            ("WIKI_NO_CHANGES", WikiCopy.noChanges),
            ("WIKI_NO_DECISIONS", WikiCopy.noDecisions),
            ("WIKI_NO_TOPICS", WikiCopy.noTopics),
            ("WIKI_NO_AGENTS_YET", WikiCopy.noAgentsYet),
            ("WIKI_NO_ENTRY_SELECTED", WikiCopy.noEntrySelected),
        ]
        for (name, word) in pairs { assertDeclares(web, name, word) }
    }

    /// The sentences built around a value, each the same expression at both ends.
    func testTheSentencesBuiltAroundAValue() throws {
        let web = try source(Self.lib)
        XCTAssertEqual(WikiCopy.proposalsToReview(3), "3 proposals to review")
        assertSays(web, "wikiProposalsToReview = (count: number): string => `${count} proposals to review`", in: Self.lib)
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

    /// The row sits right after Projects, draws the book, and its amber number is every space's
    /// `pendingOps`, summed — nothing at zero, and "3 proposals to review" as its accessible name.
    func testTheDrawerRowCountsWhatTheWebSidebarCounts() throws {
        let web = try source(Self.sidebar)
        assertOrder(web, ["key: 'projects'", "{ key: 'wiki', icon: <BookOutlined />, label: 'Wiki' }"],
                    "the sidebar's top rows")
        assertSays(web, "(wikiSpaces.data ?? []).reduce((sum, space) => sum + (space.pendingOps ?? 0), 0)",
                   in: Self.sidebar)
        assertSays(web, "t.key === 'wiki' && wikiPending > 0", in: Self.sidebar)
        assertSays(web, "aria-label={wikiProposalsToReview(wikiPending)}", in: Self.sidebar)
        XCTAssertEqual(AppSection.wiki.title, "Wiki")
        XCTAssertEqual(AppSection.workSections.firstIndex(of: .wiki), AppSection.workSections.count - 1,
                       "the Wiki follows the work: Projects, Tasks, then Wiki")
    }

    // MARK: the home page

    /// The web phone draws one column: the Review card first (the one block that asks for anything),
    /// then the main column — Principles, Topics, Recent decisions — then Recently changed and Agents
    /// used the wiki. iOS draws the same blocks in the same order, the banner standing where the web's
    /// Review card stands, with the search under the title as on the web phone.
    func testTheHomeBandsAreTheWebPhonesInItsOrder() throws {
        let home = try source(Self.home)
        let columns = try slice(home, from: "<div className=\"wk-cols\">", to: "<UsageCard space={space} />")
        let main = try slice(columns, from: "<div className=\"wk-col\">", to: "</div> <div className=\"wk-col\">")
        assertOrder(main, ["title={WIKI_PRINCIPLES}", "title={WIKI_TOPICS}", "title={WIKI_RECENT_DECISIONS}"],
                    "the main column")
        let side = try slice(columns, from: "</div> <div className=\"wk-col\">", to: "<UsageCard space={space} />")
        assertOrder(side, ["<ReviewCard", "title={WIKI_RECENTLY_CHANGED}", "<UsageCard"], "the right column")
        assertSays(home, "title={WIKI_REVIEW_TITLE}", in: Self.home)
        assertSays(home, "<WikiCard title={WIKI_AGENTS_USED} hint={WIKI_AGENTS_USED_HINT}>", in: Self.home)

        // The phone rule that makes that one column: the right column's first card leads, then the
        // main column, then the rest of the right column.
        let css = try source(Self.css)
        let phone = try slice(css, from: "@media (max-width: 900px) { .wk-cols, .rv-cols", to: ".wk-topics {")
        for rule in [".wk-cols { display: flex; flex-direction: column; }",
                     ".wk-cols > .wk-col:last-child { display: contents; }",
                     ".wk-cols > .wk-col:last-child > .wk-card:first-child { order: -1; }",
                     ".wk-cols > .wk-col:first-child { order: 1;",
                     ".wk-cols > .wk-col:last-child > .wk-card { order: 2; }"] {
            assertSays(phone, rule, in: Self.css)
        }
        let webPhone = [WikiCopy.reviewTitle, WikiCopy.principles, WikiCopy.topics, WikiCopy.recentDecisions,
                        WikiCopy.recentlyChanged, WikiCopy.agentsUsed]
        let native = WikiLogic.HomeBand.allCases.filter { $0 != .search }
            .map { $0 == .reviewBanner ? WikiCopy.reviewTitle : ($0.title ?? "") }
        XCTAssertEqual(native, webPhone, "the native bands are the web phone's, block for block")

        // The Review card counts the space on screen; the sidebar's row counts every space.
        assertSays(home, "wikiReviewQuery(space.id)", in: Self.home)
        // The search is under the title on the web phone, and first on the native page.
        let page = try source(Self.page)
        assertOrder(page, ["<h1 className=\"page-title\">{WIKI_TITLE}</h1>", "<div className=\"wk-search\" role=\"search\">"],
                    "the web phone's head")
        XCTAssertEqual(WikiLogic.HomeBand.allCases.first, .search)
    }

    /// The home page's rows are the web's: principles oldest recorded first, the four newest
    /// decisions, the five newest changes, the three most used, topics by count — and the verbs.
    func testTheHomeRowsAreTheWebsRows() throws {
        let home = try source(Self.home)
        assertSays(home, ".slice(0, 5).map((item) => (", in: Self.home)
        assertSays(home, "return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');",
                   in: Self.home)
        for verb in ["if (entry.status === 'superseded') return 'Superseded';",
                     "if (entry.status === 'retired') return 'Retired';",
                     "if (entry.trust === 'owner') return 'Added by you';",
                     "return 'Confirmed';"] {
            assertSays(home, verb, in: Self.home)
        }
        let lib = try source(Self.lib)
        for verb in ["if (item.decision === 'accepted') return WIKI_HISTORY_CONFIRMED_BY;",
                     "if (item.decision === 'edited') return 'Edited by you';",
                     "return 'Retired';", "return 'Superseded';", "return 'Reinforced';", "return 'Challenged';",
                     "return item.origin === 'owner' ? 'Added by you' : 'Proposed';",
                     "return item.origin === 'owner' ? 'Amended by you' : 'Amended';",
                     "`replaced by “${item.supersededByTitle}”`", "`replaces “${item.supersededByTitle}”`"] {
            assertSays(lib, verb, in: Self.lib)
        }
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
        assertSays(drawer, "'\(WikiCopy.refused)'", in: Self.drawer)
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
        assertSays(review, "message.success(decision.action === 'reject' ? '\(WikiCopy.rejected)' : '\(WikiCopy.decided)');",
                   in: Self.review)
        // What a card is about, and the anchors it lists: the draft's, else the named entry's.
        assertSays(review, "const draft = (payload.entry ?? {}) as Record<string, unknown>;", in: Self.review)
        assertSays(review, "typeof draft.title === 'string' ? draft.title : (target.data?.title ?? null);", in: Self.review)
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
