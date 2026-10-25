import Foundation
import XCTest
@testable import OrbitKit

/// The Wiki's derivations, as the native pages draw them: the drawer's amber number, the anchor
/// marks, an entry's Details rows, an amendment's diff, the home page's topics, and Review's queue.
/// Each is a port of the web's `lib/wiki.ts` reading of the same wire, so where the web documents a
/// rule, the case here is that rule.
final class WikiLogicTests: XCTestCase {

    // MARK: the drawer's number

    /// Summed over every space as the web sidebar sums it (`wikiWaiting`): each space's proposals and the
    /// things its plan waits on the owner for — the number the bar's Activity badge shows too. The
    /// proposals alone are Activity's first banner and Review's head.
    func testTheAmberNumberSumsWhatWaitsInEverySpace() throws {
        let spaces = try WikiFixtures.decode([WikiSpace].self, WikiFixtures.spaces)
        XCTAssertEqual(WikiSpaceLogic.waiting(spaces), 3, "a server older than planWaiting: the proposals alone")
        XCTAssertEqual(WikiSpaceLogic.waiting([]), 0, "nothing waiting draws no number")
        let planned = [WikiSpace(id: "a", slug: "a", pendingOps: 2, planWaiting: 1),
                       WikiSpace(id: "b", slug: "b", pendingOps: 5),
                       WikiSpace(id: "c", slug: "c", planWaiting: 2),
                       WikiSpace(id: "d", slug: "d")]
        XCTAssertEqual(WikiSpaceLogic.waiting(planned), 10, "a count an older server did not send adds nothing")
        XCTAssertEqual(WikiSpaceLogic.proposalsWaiting(planned), 7)
        XCTAssertEqual(WikiCopy.waitingOnYou(10), "10 waiting on you", "the Projects row's own words")
        XCTAssertEqual(WikiCopy.proposalsToReview(3), "3 proposals to review")
        XCTAssertEqual(WikiCopy.proposalsToReview(1), "1 proposal to review", "one proposal is one proposal")
    }

    // MARK: whether the account has the wiki

    /// A 404 carrying WIKI_DISABLED is the server saying the wiki is off for this account — and only
    /// that: a plain 404, another code, or the code on another status is not (`isWikiDisabled`).
    func testWikiDisabledIsA404CarryingItsCode() {
        let disabled = APIError.http(status: 404, body: #"{"code":"WIKI_DISABLED","message":"The Orbit wiki is not on for this account"}"#)
        XCTAssertTrue(WikiLogic.isDisabled(disabled))
        XCTAssertFalse(WikiLogic.isDisabled(APIError.http(status: 404, body: #"{"message":"Not Found"}"#)))
        XCTAssertFalse(WikiLogic.isDisabled(APIError.http(status: 404, body: #"{"code":"NOT_FOUND"}"#)))
        XCTAssertFalse(WikiLogic.isDisabled(APIError.http(status: 500, body: #"{"code":"WIKI_DISABLED"}"#)))
        XCTAssertFalse(WikiLogic.isDisabled(APIError.http(status: 404, body: nil)))
        XCTAssertFalse(WikiLogic.isDisabled(APIError.invalidResponse))
    }

    /// The drawer's Wiki row — the iPad sidebar's too — is drawn as the web sidebar's is (`wikiShown`):
    /// once the spaces read answered anything but WIKI_DISABLED, and when it failed for another reason;
    /// never while it is on its way.
    func testTheWikiRowIsDrawnAsTheWebSidebarDrawsIt() {
        var state = ListLoadState()
        XCTAssertFalse(WikiLogic.shown(state, disabled: false), "nothing answered yet: no row to press")
        state.begin()
        XCTAssertFalse(WikiLogic.shown(state, disabled: false))
        state.succeed()
        XCTAssertTrue(WikiLogic.shown(state, disabled: false), "a list, even an empty one, is a wiki")
        XCTAssertFalse(WikiLogic.shown(state, disabled: true), "WIKI_DISABLED: no row at all")
        state.fail()
        XCTAssertFalse(WikiLogic.shown(state, disabled: true), "a refresh that failed does not undo the answer")
        var failed = ListLoadState()
        failed.begin()
        failed.fail()
        XCTAssertTrue(WikiLogic.shown(failed, disabled: false), "a failure is not the server saying no")
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

    /// A kind this build has no schema for is drawn from what it carries rather than not at all, in
    /// the order its keys arrive.
    func testAKindWithNoSchemaIsDrawnFromWhatItCarries() {
        let rows = WikiLogic.fieldRows(kind: .unknown, fields: .object(["probe": .string("curl"),
                                                                        "contract": .string("200")]))
        XCTAssertEqual(rows.map(\.label), ["Probe", "Contract"])
    }

    /// The order keys arrive in from a `jsonb` column — shortest first, then bytewise — which is the
    /// order the web's `Object.entries` walks them in.
    func testKeysGoInTheOrderJsonbKeepsThem() {
        XCTAssertEqual(WikiLogic.jsonbOrder(["summary", "title", "anchors", "fields", "aliases", "topics"]),
                       ["title", "fields", "topics", "aliases", "anchors", "summary"])
        // Every phase-1 kind's nested fields arrive in the registry's order anyway.
        for (_, nested) in WikiLogic.nestedFields {
            XCTAssertEqual(WikiLogic.jsonbOrder(nested), nested)
        }
    }

    /// Every line of the old value removed and every line of the new one added, one hunk per change in
    /// the order the changes arrive; a key the op does not name carries over, so it is not drawn.
    func testAnAmendmentsDiff() {
        let hunks = WikiLogic.changesDiff(
            before: .object(["summary": .string("Old"), "title": .string("Same")]),
            changes: .object(["summary": .string("New"), "topics": .array([.string("deploy-ops")])]))
        XCTAssertEqual(hunks.map(\.label), ["Topics", "Summary"])
        XCTAssertEqual(hunks[1].lines, [.init(sign: .removed, text: "Old"), .init(sign: .added, text: "New")])
        XCTAssertEqual(hunks[0].lines, [.init(sign: .added, text: "deploy-ops")])
        XCTAssertTrue(WikiLogic.changesDiff(before: nil, changes: nil).isEmpty)
    }

    /// A card's anchors: the draft's own, else the ones the named entry stands on — a commit by its
    /// whole sha, as the web's card lists it.
    func testACardsAnchorLines() {
        let draft: JSONValue = .object(["anchors": .array([
            .object(["type": .string("symbol"), "path": .string("src/a.go"), "symbol": .string("f")]),
            .object(["type": .string("commit"), "sha": .string(WikiFixtures.sha)]),
        ])])
        XCTAssertEqual(WikiLogic.reviewAnchorLines(draft: draft, fallback: nil), ["src/a.go · f", WikiFixtures.sha])
        let named = [WikiAnchor(type: .path, path: "src/runner-go/mcp.go"), WikiAnchor(type: .criterion, criterionId: "c")]
        XCTAssertEqual(WikiLogic.reviewAnchorLines(draft: .object([:]), fallback: named), ["src/runner-go/mcp.go"])
        XCTAssertEqual(WikiLogic.reviewAnchorLines(draft: nil, fallback: nil), [])
    }

    /// An anchor goes back as a proposer writes it: the server's last check and the public-id twin it
    /// adds beside a criterion's id are keys no anchor type names, and the door refuses them.
    func testAnAnchorGoesBackAsWritten() {
        let echoed: JSONValue = .object([
            "type": .string("criterion"), "criterionId": .string("3dLgnjLcmdUL6pGaRCT2xr"),
            "criterionPublicId": .string("3dLgnjLcmdUL6pGaRCT2xr"),
            "check": .object(["state": .string("verified")]),
        ])
        XCTAssertEqual(WikiLogic.anchorInput(echoed),
                       .object(["type": .string("criterion"), "criterionId": .string("3dLgnjLcmdUL6pGaRCT2xr")]))
    }

    // MARK: the home page

    func testTheBandsReadTheirEntriesNewestFirst() throws {
        let entries = try WikiFixtures.decode([WikiEntry].self, WikiFixtures.entries)
        XCTAssertEqual(WikiLogic.entries(entries, ofKind: .decision).map(\.title), [
            "Task priority is a field on the task, not a dispatcher session",
            "Wakeups are held by the server",
            "EXECUTABLE judges by exit code and records nothing",
        ])
        XCTAssertEqual(WikiLogic.entries(entries, ofKind: .principle).count, 4)
    }

    /// The home's bands under its head, top to bottom (design §12.3.1): what the space holds, the search, the
    /// principles, the documents, then Browse · A–Z — content alone; how the wiki is kept is Activity's.
    func testTheHomeBandsOrder() {
        XCTAssertEqual(WikiLogic.HomeBand.allCases, [.state, .search, .principles, .documents, .more])
        XCTAssertEqual(WikiLogic.HomeBand.allCases.compactMap(\.title), ["Principles"])
        XCTAssertEqual(WikiLogic.entrySections, ["Details", "Sources", "Anchors", "Where it's used", "History"])
    }

    /// The row the iPad's and the Mac's directory column lights is a read of the Wiki's stack (mock 32): Home
    /// at the root; the page a row opened; that page still under an entry or a run opened over it; and no row
    /// for Activity, Review or the settings, which are not the directory's.
    func testTheDirectoryColumnLightsThePageOnTop() {
        var nav = NavState(section: .wiki)
        XCTAssertEqual(nav.wikiContentsAt, .home)
        nav.push(.wikiEntry(entryID: "e1"))
        XCTAssertEqual(nav.wikiContentsAt, .home, "a principle's entry, opened from the home")
        nav.path = [.wikiDoc(slug: "session-runtime", section: "s3")]
        XCTAssertEqual(nav.wikiContentsAt, .doc(slug: "session-runtime"))
        nav.push(.wikiEntry(entryID: "e2"))
        XCTAssertEqual(nav.wikiContentsAt, .doc(slug: "session-runtime"), "an entry over a document keeps it lit")
        nav.path = [.wikiArticle(topic: "tasks", part: 2)]
        XCTAssertEqual(nav.wikiContentsAt, .article(topic: "tasks", part: 2))
        for (frame, at) in [(NavNode.wikiBrowse, WikiContentsAt.browse), (.wikiIndex, .index), (.wikiPlan(version: 3), .plan),
                            (.wikiPlanDoc(slug: "d", version: nil), .plan),
                            (.wikiPlanSection(slug: "d", index: 1, version: nil), .plan)] {
            nav.path = [frame]
            XCTAssertEqual(nav.wikiContentsAt, at)
        }
        for frame in [NavNode.wikiActivity, .wikiReview, .wikiSettings] {
            nav.path = [frame]
            XCTAssertNil(nav.wikiContentsAt, "\(frame) is no row of the directory")
        }
        nav.path = [.wikiActivity, .wikiRun(changesetID: "c1")]
        XCTAssertNil(nav.wikiContentsAt, "a run opened from Activity lights nothing either")
        // A server run's page, pushed from Activity's Runs band or its status line's View run (mock 35 ⑤).
        nav.path = [.wikiActivity, .wikiJob(jobID: "j1")]
        XCTAssertNil(nav.wikiContentsAt, "a server run opened from Activity lights nothing")
        XCTAssertEqual(nav.selectedWikiJobID, "j1")
        XCTAssertNil(nav.selectedWikiRunID, "a server run is no changeset")
        nav.path = [.wikiActivity]
        XCTAssertNil(nav.selectedWikiJobID)
    }

    /// Activity's blocks, top to bottom (mock 31 ②): the home's management blocks in their order, the
    /// other spaces' plan banners after the space's own, the server's runs after them (mock 35 ④), and
    /// Principles not among them — it is content.
    func testTheActivityBandsOrder() {
        XCTAssertEqual(WikiLogic.ActivityBand.allCases, [.status, .reviewBanner, .planBanners, .otherPlanBanners, .runs,
                                                         .recentDecisions, .recentlyChanged, .agentsUsed])
        XCTAssertEqual(WikiLogic.ActivityBand.allCases.compactMap(\.title),
                       ["Runs", "Recent decisions", "Recently changed", "Agents used the wiki"])
        XCTAssertFalse(WikiLogic.ActivityBand.allCases.map(\.rawValue).contains("principles"))
    }

    /// Recently changed's rows that came after the reader last looked: all of them the first time, then
    /// only what is newer than the stamp — a run by its newest change.
    func testRecentlyChangedCountsWhatIsNewSinceTheReaderLastLooked() throws {
        let items = try XCTUnwrap(try WikiFixtures.decode(WikiTimeline.self, WikiFixtures.timeline).items)
        let home = WikiHomeContent(space: try WikiFixtures.decode(WikiSpace.self, WikiFixtures.space), spaces: [],
                                   entries: [], timeline: items)
        XCTAssertEqual(home.newRows(seen: 0), home.recentRows.count, "never looked: every row is new")
        let times = home.recentRows.compactMap { WikiHomeContent.time(of: $0) }.compactMap(RelativeTime.parse)
        XCTAssertEqual(times.count, home.recentRows.count, "every row has its time")
        let newest = try XCTUnwrap(times.max()).timeIntervalSince1970
        XCTAssertEqual(home.newRows(seen: newest), 0, "nothing after the newest")
        let middle = times.sorted()[times.count / 2].timeIntervalSince1970
        XCTAssertEqual(home.newRows(seen: middle), times.filter { $0.timeIntervalSince1970 > middle }.count)
    }

    /// Activity's bands, read out of the fixture — the four newest decisions, five changes, three most used,
    /// and the status line without the count its banner says — and the home's principles, oldest first.
    func testActivitysBandsAndTheHomesPrinciples() throws {
        let spaces = try WikiFixtures.decode([WikiSpace].self, WikiFixtures.spaces)
        let entries = try WikiFixtures.decode([WikiEntry].self, WikiFixtures.entries)
        // The two bands' own reads (`?kind=principle`, `?kind=decision`), as the server answers them.
        XCTAssertEqual(WikiLogic.principles(entries.filter { $0.kind == .principle }).map(\.title),
                       ["Agent-writable data never becomes a system instruction", "Completion is adjudicated, not claimed",
                        "A clock never starts agent work", "Delete means forget"])
        let home = WikiHomeContent(space: try WikiFixtures.decode(WikiSpace.self, WikiFixtures.space),
                                   spaces: spaces,
                                   entries: entries,
                                   decisions: entries.filter { $0.kind == .decision },
                                   timeline: try XCTUnwrap(try WikiFixtures.decode(WikiTimeline.self,
                                                                                   WikiFixtures.timeline).items))
        XCTAssertEqual(home.recentDecisions.count, 3)
        XCTAssertEqual(home.recentlyChanged.count, 5)
        XCTAssertEqual(home.mostUsed.map(\.total), [41, 33, 29])
        XCTAssertTrue(home.usedThisWeek)
        XCTAssertEqual(home.statusLine, "9 entries · Anchors verified at 4db4f9f")
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
        // Review's read carries the title of the entry each op names: the card says it before — or
        // without — the entry's own read.
        let carried = try WikiFixtures.decode(WikiChangesetOp.self, """
            {"id":"34UDOpRetireWakeup002","seq":0,"op":"retire","entryId":"34UDFnrgM4q5oWakeLost",
             "decision":"pending","entryTitle":"Claude's ScheduleWakeup is lost when the engine is recycled",
             "payload":{"op":"retire","reason":"Fix landed."}}
            """)
        let card = WikiLogic.ReviewCard(changeset: cards[1].changeset, op: carried)
        XCTAssertEqual(WikiLogic.cardTitle(card, entry: nil), named.title)
        XCTAssertEqual(WikiLogic.knownTitle(card, entry: nil), named.title)
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
