import Foundation
import XCTest
@testable import OrbitKit

/// The Wiki's derivations, as the native pages draw them: the drawer's amber number, the anchor
/// marks, an entry's Details rows, an amendment's diff, the home page's topics, and Review's queue.
/// Each is a port of the web's `lib/wiki.ts` reading of the same wire, so where the web documents a
/// rule, the case here is that rule.
final class WikiLogicTests: XCTestCase {

    // MARK: the drawer's number

    /// Summed over every space, exactly as the web sidebar sums `pendingOps` — the same number the
    /// home page's banner and Review's subtitle say.
    func testTheAmberNumberSumsEverySpacesProposals() throws {
        let spaces = try WikiFixtures.decode([WikiSpace].self, WikiFixtures.spaces)
        XCTAssertEqual(WikiLogic.proposalsToReview(spaces), 3)
        XCTAssertEqual(WikiLogic.proposalsToReview([]), 0, "nothing waiting draws no number")
        XCTAssertEqual(WikiLogic.proposalsToReview([WikiSpace(id: "a", slug: "a", pendingOps: 2),
                                                    WikiSpace(id: "b", slug: "b", pendingOps: 5),
                                                    WikiSpace(id: "c", slug: "c")]), 7,
                       "a space an older server sent no count for adds nothing")
        XCTAssertEqual(WikiCopy.proposalsToReview(3), "3 proposals to review")
    }

    // MARK: marks

    func testTheAnchorMarkSaysTheRefOrTheWarning() {
        let sha = WikiFixtures.sha
        XCTAssertEqual(WikiLogic.anchorMark(state: .verified, checkedRef: sha), WikiAnchorMark(word: "4db4f9f", tone: .green))
        XCTAssertEqual(WikiLogic.anchorMark(state: .verified, checkedRef: nil), WikiAnchorMark(word: "Checked", tone: .green))
        XCTAssertEqual(WikiLogic.anchorMark(state: .changed, checkedRef: sha), WikiAnchorMark(word: "Changed", tone: .amber))
        XCTAssertEqual(WikiLogic.anchorMark(state: .missing, checkedRef: sha), WikiAnchorMark(word: "Missing", tone: .red))
        XCTAssertNil(WikiLogic.anchorMark(state: .unchecked, checkedRef: nil), "nothing checked says nothing")
        XCTAssertNil(WikiLogic.anchorMark(state: nil, checkedRef: nil))
        // A ref that is not a sha is kept as written.
        XCTAssertEqual(WikiLogic.shortSha("main"), "main")
        XCTAssertEqual(WikiLogic.shortSha(sha.uppercased()), sha.uppercased())
    }

    func testAnAnchorsOwnLineAndState() {
        XCTAssertEqual(WikiLogic.anchorLabel(WikiAnchor(type: .symbol, path: "src/runner-go/mcp.go", symbol: "askBeforeCreate")),
                       "src/runner-go/mcp.go · askBeforeCreate")
        XCTAssertEqual(WikiLogic.anchorLabel(WikiAnchor(type: .path, path: "src/a.go")), "src/a.go")
        XCTAssertEqual(WikiLogic.anchorLabel(WikiAnchor(type: .commit, sha: WikiFixtures.sha)), "4db4f9f")
        XCTAssertEqual(WikiLogic.anchorLabel(WikiAnchor(type: .command, command: "go test ./...")), "go test ./...")
        XCTAssertEqual(WikiLogic.anchorLabel(WikiAnchor(type: .record, ref: "orbit-task:34Tc")), "orbit-task:34Tc")
        XCTAssertEqual(WikiLogic.anchorLabel(WikiAnchor(type: .criterion, criterionId: "c1")), "—")
        XCTAssertEqual(WikiLogic.anchorStateMark(WikiAnchor(type: .path, path: "p")),
                       WikiAnchorMark(word: "Unchecked", tone: .muted))
        XCTAssertEqual(WikiLogic.anchorStateMark(WikiAnchor(type: .path, path: "p",
                                                            check: .init(state: .verified, ref: WikiFixtures.sha))),
                       WikiAnchorMark(word: "4db4f9f", tone: .green))
    }

    // MARK: Details

    /// A pitfall's rows in the registry's order, its trigger's parts as `Label: value` lines in theirs.
    func testAPitfallsDetailsRows() throws {
        let detail = try WikiFixtures.decode(WikiEntryDetail.self, WikiFixtures.entryDetail)
        let rows = WikiLogic.fieldRows(kind: detail.entry.kind, fields: detail.entry.fields)
        XCTAssertEqual(rows.map(\.label), ["Trigger", "Symptom", "Cause", "Fix"])
        XCTAssertEqual(rows[0].lines, ["Paths: src/runner-go", "Commands: go test ./...",
                                       "Error signature: 403 PROJECT_SCOPE_MISMATCH"])
        XCTAssertEqual(rows[1].lines, ["11 CLI tests fail and one hangs until -timeout panics."])
    }

    /// A decision's alternatives read as the design writes them — one line each, the option and why
    /// it lost, under the design's own word for the row.
    func testADecisionsRowsAndTheLabelsTheDesignWrites() {
        let fields: JSONValue = .object([
            "context": .string("Two dispatchers raced."),
            "decision": .string("Priority is a field."),
            "alternatives": .array([.object(["option": .string("A dispatcher session"),
                                             "whyRejected": .string("It is a second writer.")])]),
            "consequences": .string("   "),
            "decidedAt": .string("2026-09-25"),
        ])
        let rows = WikiLogic.fieldRows(kind: .decision, fields: fields)
        XCTAssertEqual(rows.map(\.label), ["Context", "Decision", "Rejected", "Decided"],
                       "a blank value draws no row")
        XCTAssertEqual(rows[2].lines, ["A dispatcher session — It is a second writer."])
        XCTAssertEqual(WikiLogic.fieldLabel("notToConfuseWith"), "Not to be confused with")
        XCTAssertEqual(WikiLogic.fieldLabel("expectedExit"), "Expected exit code")
        XCTAssertEqual(WikiLogic.fieldLabel("regionSha256"), "Region sha256")
        let recipe = WikiLogic.fieldRows(kind: .recipe, fields: .object([
            "steps": .array([.string("Run /upgrade"), .string("curl -fsS /api/health")]),
            "verify": .object(["expectedExit": .int(0), "command": .string("curl -fsS")]),
        ]))
        XCTAssertEqual(recipe.map(\.label), ["Steps", "Verify"])
        XCTAssertEqual(recipe[1].lines, ["Command: curl -fsS", "Expected exit code: 0"])
    }

    /// A kind this build has no schema for is drawn from what it carries rather than not at all.
    func testAKindWithNoSchemaIsDrawnFromWhatItCarries() {
        let rows = WikiLogic.fieldRows(kind: .unknown, fields: .object(["probe": .string("curl"),
                                                                        "contract": .string("200")]))
        XCTAssertEqual(rows.map(\.label), ["Contract", "Probe"])
    }

    /// Every line of the old value removed and every line of the new one added; a key the op does
    /// not name carries over, so it is not drawn.
    func testAnAmendmentsDiff() {
        let hunks = WikiLogic.changesDiff(
            before: .object(["summary": .string("Old"), "title": .string("Same")]),
            changes: .object(["summary": .string("New"), "topics": .array([.string("deploy-ops")])]))
        XCTAssertEqual(hunks.map(\.label), ["Summary", "Topics"])
        XCTAssertEqual(hunks[0].lines, [.init(sign: .removed, text: "Old"), .init(sign: .added, text: "New")])
        XCTAssertEqual(hunks[1].lines, [.init(sign: .added, text: "deploy-ops")])
        XCTAssertTrue(WikiLogic.changesDiff(before: nil, changes: nil).isEmpty)
    }

    // MARK: the home page

    func testTopicsAreTheSlugsInUseMostEntriesFirst() throws {
        let entries = try WikiFixtures.decode([WikiEntry].self, WikiFixtures.entries)
        let topics = WikiLogic.topicSummaries(entries)
        XCTAssertEqual(topics.map(\.slug), ["runner-engines", "tasks-dispatch", "projects-criteria",
                                            "deploy-ops", "testing-ci"])
        XCTAssertEqual(topics.map(\.count), [3, 3, 2, 1, 1])
        XCTAssertEqual(topics[1].latest?.title, "Task priority is a field on the task, not a dispatcher session",
                       "the most recently changed entry is the line a topic shows")
    }

    func testTheBandsReadTheirEntriesNewestFirst() throws {
        let entries = try WikiFixtures.decode([WikiEntry].self, WikiFixtures.entries)
        XCTAssertEqual(WikiLogic.entries(entries, ofKind: .decision).map(\.title), [
            "Task priority is a field on the task, not a dispatcher session",
            "Wakeups are held by the server",
            "EXECUTABLE judges by exit code and records nothing",
        ])
        XCTAssertEqual(WikiLogic.entries(entries, ofKind: .principle).count, 4)
    }

    /// The home page's bands, top to bottom: the search under the title, then the one band that asks
    /// for anything, then the rest in the web phone's order.
    func testTheHomeBandsOrder() {
        XCTAssertEqual(WikiLogic.HomeBand.allCases, [.search, .reviewBanner, .principles, .topics,
                                                     .recentDecisions, .recentlyChanged, .agentsUsed])
        XCTAssertEqual(WikiLogic.HomeBand.allCases.compactMap(\.title),
                       ["Principles", "Topics", "Recent decisions", "Recently changed", "Agents used the wiki"])
        XCTAssertEqual(WikiLogic.entrySections, ["Details", "Sources", "Anchors", "Where it's used", "History"])
    }

    /// The home page's bands, read out of the fixture: the four principles oldest first and said to
    /// be the owner's once, the four newest decisions, five changes, three most used, and the status
    /// line without the count the banner says.
    func testTheHomePagesBands() throws {
        let spaces = try WikiFixtures.decode([WikiSpace].self, WikiFixtures.spaces)
        let home = WikiHomeContent(space: try WikiFixtures.decode(WikiSpace.self, WikiFixtures.space),
                                   spaces: spaces,
                                   entries: try WikiFixtures.decode([WikiEntry].self, WikiFixtures.entries),
                                   timeline: try XCTUnwrap(try WikiFixtures.decode(WikiTimeline.self,
                                                                                   WikiFixtures.timeline).items),
                                   proposals: WikiLogic.proposalsToReview(spaces))
        XCTAssertEqual(home.principles.map(\.title), ["Agent-writable data never becomes a system instruction",
                                                       "Completion is adjudicated, not claimed",
                                                       "A clock never starts agent work", "Delete means forget"])
        XCTAssertTrue(home.principlesAllOwner)
        XCTAssertEqual(home.recentDecisions.count, 3)
        XCTAssertEqual(home.recentlyChanged.count, 5)
        XCTAssertEqual(home.mostUsed.map(\.total), [41, 33, 29])
        XCTAssertTrue(home.usedThisWeek)
        XCTAssertEqual(home.statusLine, "9 entries · Anchors verified at 4db4f9f")
        XCTAssertEqual(home.proposals, 3)
        XCTAssertEqual(WikiLogic.topicTitle("tasks-dispatch"), "Tasks dispatch")
        XCTAssertEqual(WikiLogic.topicTitle("ci"), "Ci")
        let latest = try XCTUnwrap(home.topics.first?.latest)
        XCTAssertEqual(WikiLogic.entryVerb(latest, loaded: home.loadedIDs), "Confirmed")
        XCTAssertEqual(WikiLogic.entryVerb(WikiEntry(id: "e", status: .retired), loaded: []), "Retired")
        XCTAssertEqual(WikiLogic.entryVerb(WikiEntry(id: "e", status: .active, trust: .owner), loaded: []),
                       "Added by you")
    }

    func testASourcesWordAndRef() {
        XCTAssertEqual(WikiLogic.sourceWord(.ownerDecision), "Your decision")
        XCTAssertEqual(WikiLogic.sourceWord(.toolCall), "Tool call")
        XCTAssertEqual(WikiLogic.sourceRef(WikiSource(id: "s", kind: .commit, ref: WikiFixtures.sha, locator: nil,
                                                      quote: nil, quoteVerified: nil, state: nil, tainted: nil,
                                                      createdAt: nil)), "4db4f9f")
        XCTAssertEqual(WikiLogic.sourceRef(WikiSource(id: "s", kind: .note, ref: "n1",
                                                      locator: .object(["path": .string("CLAUDE.md")]),
                                                      quote: nil, quoteVerified: nil, state: nil, tainted: nil,
                                                      createdAt: nil)), "CLAUDE.md")
    }

    func testATimelineRowsVerbAndNote() throws {
        let items = try XCTUnwrap(try WikiFixtures.decode(WikiTimeline.self, WikiFixtures.timeline).items)
        XCTAssertEqual(items.map(WikiLogic.changeVerb),
                       ["Confirmed by you", "Confirmed by you", "Amended by you", "Added by you", "Confirmed by you"])
        XCTAssertEqual(WikiLogic.changeNote(items[1]), "replaced by “Headless Chromium clamps windows under 500”")
        XCTAssertNil(WikiLogic.changeNote(items[0]))
        XCTAssertEqual(WikiLogic.changeVerb(WikiTimelineItem(opId: "o", op: .add, decision: .autoApplied, origin: .agent)),
                       "Proposed")
        XCTAssertEqual(WikiLogic.changeVerb(WikiTimelineItem(opId: "o", op: .retire, decision: .autoApplied, origin: .owner)),
                       "Retired")
        XCTAssertEqual(WikiLogic.changeVerb(WikiTimelineItem(opId: "o", op: .amend, decision: .edited, origin: .agent)),
                       "Edited by you")
    }

    // MARK: Review

    /// The pending ops in the server's order, each changeset's in its own: decided ops ride along in a
    /// changeset and are left out.
    func testReviewPagesThroughThePendingOpsInTheServersOrder() throws {
        let review = try WikiFixtures.decode([WikiChangeset].self, WikiFixtures.review)
        let cards = WikiLogic.reviewCards(review)
        XCTAssertEqual(cards.map(\.op.op), [.add, .retire, .amend])
        XCTAssertEqual(cards.map(\.op.id), ["34UDOpAddPitfall00001", "34UDOpRetireWakeup002", "34UDOpAmendDeploy0003"])
        XCTAssertEqual(WikiLogic.oldestProposal(cards), "2026-09-25T11:00:00.000Z")
        XCTAssertEqual(WikiLogic.proposingSessions(cards), 2,
                       "two sessions; the maintenance run has none — the web's count, and mock 09's")
        XCTAssertEqual(WikiLogic.ReviewTab.allCases.map { WikiLogic.tabLabel($0, cards: cards) },
                       ["All 3", "Add 1", "Amend 1", "Retire 1"])
        XCTAssertEqual(WikiCopy.ofCount(1, cards.count), "1 of 3")
        XCTAssertEqual(WikiCopy.proposalsFrom(3, sessions: 2), "3 proposals from 2 sessions")
        XCTAssertEqual(WikiCopy.proposalsFrom(1, sessions: 1), "1 proposal from 1 session")
    }

    /// What each card says it is about, and who it came from — the web's `opTitle` and the
    /// `Proposed by` line's three cases.
    func testACardsTitleChipAndProposer() throws {
        let cards = WikiLogic.reviewCards(try WikiFixtures.decode([WikiChangeset].self, WikiFixtures.review))
        XCTAssertEqual(WikiLogic.cardTitle(cards[0], entry: nil), "Secret redaction lets ENV_VAR=value secrets through",
                       "an add is about the entry it drafts")
        XCTAssertEqual(WikiLogic.cardKind(cards[0], entry: nil), .pitfall)
        XCTAssertEqual(WikiLogic.cardTitle(cards[1], entry: nil), "entry", "until the named entry is read")
        let named = WikiEntry(id: "34UDFnrgM4q5oWakeLost", kind: .pitfall,
                              title: "Claude's ScheduleWakeup is lost when the engine is recycled")
        XCTAssertEqual(WikiLogic.cardTitle(cards[1], entry: named), named.title)
        XCTAssertEqual(WikiLogic.cardTitle(cards[2], entry: named), named.title,
                       "an amend that leaves the title alone is about the entry it names")
        XCTAssertEqual(WikiLogic.cardKind(cards[1], entry: named), .pitfall)
        XCTAssertEqual(cards.map { WikiLogic.cardChip($0.op.op) }, ["ADD", "RETIRE", "AMEND"])
        XCTAssertEqual(WikiLogic.cardChip(.supersede), "AMEND", "a supersede is an Amend on Review")
        XCTAssertEqual(cards.map { WikiLogic.proposedBy($0.changeset) },
                       ["Orbit wiki review", "Wiki maintenance", "Upgrade deploy"])
        XCTAssertEqual(WikiLogic.proposedBy(WikiChangeset(id: "c", origin: .owner)), "you")
        XCTAssertEqual(WikiLogic.proposedBy(WikiChangeset(id: "c", origin: .agent, sessionId: "s")), "a session")
        XCTAssertEqual(WikiLogic.proposedBy(WikiChangeset(id: "c", origin: .agent, sessionId: "s",
                                                          rationale: String(repeating: "x", count: 60))),
                       String(repeating: "x", count: 47) + "…")
    }

    /// A supersede is an Amend, as far as Review's tabs go; a reinforce or a challenge counts only in All.
    func testTheTabsHoldTheOpsTheWebsTabsHold() {
        XCTAssertTrue(WikiLogic.ReviewTab.amend.holds(.supersede))
        XCTAssertTrue(WikiLogic.ReviewTab.amend.holds(.amend))
        XCTAssertFalse(WikiLogic.ReviewTab.add.holds(.reinforce))
        XCTAssertFalse(WikiLogic.ReviewTab.retire.holds(.challenge))
        XCTAssertTrue(WikiLogic.ReviewTab.all.holds(.challenge))
    }

    /// Deciding a card moves the queue under the pager: it keeps its place, or falls back to the last
    /// card, or has nothing to show.
    func testThePagerKeepsItsPlaceAsTheQueueShrinks() {
        XCTAssertEqual(WikiLogic.clampedIndex(1, count: 3), 1)
        XCTAssertEqual(WikiLogic.clampedIndex(2, count: 2), 1)
        XCTAssertEqual(WikiLogic.clampedIndex(-1, count: 2), 0)
        XCTAssertNil(WikiLogic.clampedIndex(0, count: 0))
    }
}
