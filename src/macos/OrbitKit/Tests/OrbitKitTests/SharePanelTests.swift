import XCTest
@testable import OrbitKit

/// The Share panel's state, one panel for a session, a task and a project (docs/share-links-design.md
/// §1, §2, §3, §8): what Access says and asks, which layers each kind of root offers with how much
/// each holds, which switches can be pressed, what Expires shows and sends, how often the link was
/// opened, and what the ⋯ menus say beside Share….
final class SharePanelTests: XCTestCase {

    /// 2026-09-25 12:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_790_337_600)

    private func link(_ kind: ShareRootKind, include: ShareInclude = ShareInclude(),
                      expiresAt: String? = nil, viewCount: Int = 0, lastViewedAt: String? = nil,
                      state: ShareLinkState = .active) -> ShareLink {
        ShareLink(id: "L1", kind: kind, token: "Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa", include: include,
                  expiresAt: expiresAt, viewCount: viewCount, lastViewedAt: lastViewedAt, state: state,
                  root: ShareRootSummary(id: "r1", title: "Root", status: "OPEN"))
    }

    private func panel(_ kind: ShareRootKind, _ link: ShareLink?, counts: ShareCounts? = nil) -> SharePanel {
        var panel = SharePanel(kind: kind)
        panel.loaded(ShareLinkRead(link: link, counts: counts))
        return panel
    }

    private func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    // MARK: Access

    func testItLoadsBeforeItSaysAnything() {
        var panel = SharePanel(kind: .task)
        XCTAssertEqual(panel.phase, .loading)
        panel.loadFailed("The server couldn’t be reached.")
        XCTAssertEqual(panel.phase, .failed("The server couldn’t be reached."))
        panel.loaded(ShareLinkRead(link: nil))
        XCTAssertEqual(panel.phase, .ready)
    }

    func testWithNoLinkOnlyYouCanOpenItAndAnyoneOpensOneWithTheDefaults() {
        let panel = panel(.project, nil)
        XCTAssertEqual(panel.access, .onlyYou)
        XCTAssertEqual(panel.accessDetail, SharePanelCopy.privateDetail)
        XCTAssertEqual(panel.step(to: .anyoneWithTheLink), .open(PutShareLinkRequest()))
        XCTAssertEqual(panel.step(to: .onlyYou), .nothing)
        XCTAssertNil(panel.publicURL(base: URL(string: "https://orbitd.io")!))
        XCTAssertNil(panel.viewsLine(now: now))
    }

    func testWithALinkOpenOnlyYouAsksBeforeTurningItOff() {
        let panel = panel(.task, link(.task))
        XCTAssertEqual(panel.access, .anyoneWithTheLink)
        XCTAssertEqual(panel.accessDetail, "Anyone with the link can view — no sign-in. They can’t change anything.")
        XCTAssertEqual(panel.step(to: .onlyYou), .confirmTurnOff, "turning it off is never one tap")
        XCTAssertEqual(panel.step(to: .anyoneWithTheLink), .nothing)
        XCTAssertEqual(panel.publicURL(base: URL(string: "https://orbitd.io")!)?.absoluteString,
                       "https://orbitd.io/s/Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa")
    }

    func testASessionVisitorCannotReplyEither() {
        XCTAssertEqual(panel(.session, link(.session)).accessDetail,
                       "Anyone with the link can view — no sign-in. They can’t reply or change anything.")
    }

    func testALinkPastItsExpiryReadsAsTheEndedLinkItIs() {
        let panel = panel(.task, link(.task, state: .ended))
        XCTAssertNil(panel.link)
        XCTAssertEqual(panel.access, .onlyYou)
        XCTAssertEqual(panel.step(to: .anyoneWithTheLink), .open(PutShareLinkRequest()), "opening makes a new one")
    }

    func testAPausedLinkIsStillTheOpenLink() {
        XCTAssertEqual(panel(.session, link(.session, state: .paused)).access, .anyoneWithTheLink)
    }

    func testTurningOffForgetsTheLinkAndTheExpiryPickedForIt() {
        var panel = panel(.project, link(.project))
        _ = panel.chooseExpiry("7", now: now)
        panel.turnedOff()
        XCTAssertNil(panel.link)
        XCTAssertNil(panel.expiryChoice)
        XCTAssertEqual(panel.access, .onlyYou)
    }

    func testEachKindHasItsOwnTitle() {
        XCTAssertEqual(ShareRootKind.allCases.map { SharePanel(kind: $0).title },
                       ["Share session", "Share task", "Share project"])
    }

    // MARK: Includes

    func testASessionOffersMessagesAndToolCallsWithTheirCounts() {
        let rows = panel(.session, link(.session, include: ShareInclude(toolOutput: false)),
                         counts: ShareCounts(messages: 77, toolCalls: 1)).layers
        XCTAssertEqual(rows.map(\.name), ["Messages", "Tool calls and output"])
        XCTAssertEqual(rows.map(\.count), ["77 messages", "1 call"])
        XCTAssertEqual(rows.map(\.layer), [nil, .toolOutput])
        XCTAssertEqual(rows.map(\.isOn), [true, false])
        XCTAssertEqual(rows.map(\.isEditable), [false, true], "Messages is always included")
        XCTAssertEqual(rows[1].detail, "Commands, file reads and what they returned. Off shows only which tools ran.")
    }

    func testATaskOffersOverviewCommentsAndConversationsAndWarnsOnlyOnceConversationsIsOn() {
        let counts = ShareCounts(comments: 29, files: 2, transcripts: 14)
        let off = panel(.task, link(.task, include: ShareInclude(commentsAndFiles: false, conversations: false)),
                        counts: counts).layers
        XCTAssertEqual(off.map(\.name), ["Overview", "Comments & files", "Conversations"])
        XCTAssertEqual(off.map(\.count), ["Always", "29 comments · 2 files", "14 transcripts"])
        XCTAssertEqual(off.map(\.detail), ["Description, acceptance, dependencies and runs",
                                           "Written by agents and people",
                                           "Can include command output and file contents."])
        XCTAssertEqual(off.map(\.isNested), [false, false, false])
        XCTAssertEqual(off.map(\.warns), [false, false, false], "a risk is not said in amber while it is off")

        let on = panel(.task, link(.task, include: ShareInclude(commentsAndFiles: true, conversations: true)),
                       counts: ShareCounts(comments: 1, files: 0, transcripts: 1)).layers
        XCTAssertEqual(on.map(\.count), ["Always", "1 comment", "1 transcript"], "no files, no file count")
        XCTAssertEqual(on.map(\.warns), [false, false, true])
    }

    func testAProjectNestsCommentsAndConversationsUnderTaskPages() {
        let counts = ShareCounts(tasks: 12, comments: 29, files: 0, runs: 13, transcripts: 14)
        let rows = panel(.project, link(.project, include: ShareInclude(taskPages: true, commentsAndFiles: false,
                                                                        conversations: true)),
                         counts: counts).layers
        XCTAssertEqual(rows.map(\.name), ["Overview", "Task pages", "Comments & files", "Conversations"])
        XCTAssertEqual(rows.map(\.count), ["Always", "12 tasks", "29 comments", "14 transcripts"])
        XCTAssertEqual(rows.map(\.isNested), [false, false, true, true])
        XCTAssertEqual(rows.map(\.isIdle), [false, false, false, false])
        XCTAssertEqual(rows.map(\.isEditable), [false, true, true, true])
        XCTAssertEqual(rows[3].detail, "13 runs and the coordinator. Can include command output and file contents.")
        XCTAssertEqual(rows[3].warns, true)
        XCTAssertEqual(rows[0].detail, "Goal, work overview, acceptance criteria and task graph")
        XCTAssertEqual(rows[1].detail, "Description, acceptance and runs for each task")
    }

    func testWithTaskPagesOffTheLayersUnderItShareNothingAndCannotBePressed() {
        let rows = panel(.project, link(.project, include: ShareInclude(taskPages: false, commentsAndFiles: true,
                                                                        conversations: true)),
                         counts: ShareCounts(tasks: 3, comments: 0, files: 0, runs: 1, transcripts: 1)).layers
        XCTAssertEqual(rows.map(\.isIdle), [false, false, true, true])
        XCTAssertEqual(rows.map(\.isEditable), [false, true, false, false])
        XCTAssertEqual(rows.map(\.isOn), [true, false, true, true], "their own switches keep what was chosen")
        XCTAssertEqual(rows[3].warns, false, "nothing below an off layer is shared, so there is no risk to say")
        XCTAssertEqual(rows[3].detail, "1 run. Can include command output and file contents.",
                       "no coordinator: as many transcripts as runs")
    }

    func testBeforeTheCountsAreReadNoCountIsGuessed() {
        let rows = panel(.project, link(.project)).layers
        XCTAssertEqual(rows.map(\.count), [nil, nil, nil, nil])
        XCTAssertEqual(rows[3].detail, SharePanelCopy.conversationsRisk)
    }

    func testASwitchSavesItsOwnLayerOnly() {
        var panel = panel(.project, link(.project))
        XCTAssertEqual(panel.toggle(.taskPages, on: false),
                       PutShareLinkRequest(include: ShareInclude(taskPages: false)))
        XCTAssertEqual(panel.toggle(.commentsAndFiles, on: true).expiresAt, .keep)
    }

    func testAPressedSwitchShowsAtOnceAndTheAnswerOrARefusalSettlesIt() {
        let before = link(.project, include: ShareInclude(taskPages: true, commentsAndFiles: false,
                                                          conversations: false))
        var panel = panel(.project, before)
        _ = panel.toggle(.taskPages, on: false)
        XCTAssertEqual(panel.layers.map(\.isOn), [true, false, false, false], "the switch moves when pressed")
        XCTAssertEqual(panel.layers.map(\.isIdle), [false, false, true, true], "and what sits under it greys out")

        panel.saveFailed()
        XCTAssertEqual(panel.layers.map(\.isOn), [true, true, false, false], "a refusal puts it back")
        XCTAssertEqual(panel.pending, ShareInclude())

        _ = panel.toggle(.conversations, on: true)
        panel.saved(link(.project, include: ShareInclude(taskPages: true, commentsAndFiles: false,
                                                         conversations: true)))
        XCTAssertEqual(panel.pending, ShareInclude(), "the answer replaces what was pending")
        XCTAssertEqual(panel.layers.map(\.isOn), [true, true, false, true])
    }

    func testARefusedExpiryGoesBackToWhatTheLinkSays() {
        var panel = panel(.task, link(.task, expiresAt: "2026-10-02T12:00:00.000Z"))
        _ = panel.chooseExpiry("30", now: now)
        XCTAssertEqual(panel.expirySelection, "30")
        panel.saveFailed()
        XCTAssertEqual(panel.expirySelection, "until")
    }

    func testASavedLinkReplacesTheOneShown() {
        var panel = panel(.session, link(.session, include: ShareInclude(toolOutput: true)))
        panel.saved(link(.session, include: ShareInclude(toolOutput: false)))
        XCTAssertEqual(panel.layers.map(\.isOn), [true, false])
    }

    // MARK: Expires

    func testANewLinkNeverExpiresAndOffersTheFourChoices() {
        let panel = panel(.task, link(.task))
        XCTAssertEqual(panel.expirySelection, "never")
        XCTAssertEqual(panel.expiryOptions.map(\.label), ["Never", "1 day", "7 days", "30 days"])
        XCTAssertNil(panel.expiryHint)
    }

    func testPickingADurationSendsTheInstantAndThenSaysTheDay() throws {
        var panel = panel(.task, link(.task))
        let body = try XCTUnwrap(panel.chooseExpiry("7", now: now))
        let sevenDays = iso(now.addingTimeInterval(7 * 86_400))
        XCTAssertEqual(body, PutShareLinkRequest(expiresAt: .set(sevenDays)))
        XCTAssertEqual(sevenDays, "2026-10-02T12:00:00.000Z")
        XCTAssertEqual(panel.expirySelection, "7", "it says how long, as picked")
        panel.saved(link(.task, expiresAt: sevenDays))
        XCTAssertEqual(panel.expiryHint, "Stops working Oct 2")
        XCTAssertEqual(panel.expiryOptions.count, 4)
    }

    func testNeverClearsTheExpiry() throws {
        var panel = panel(.task, link(.task, expiresAt: "2026-10-02T12:00:00.000Z"))
        XCTAssertEqual(try XCTUnwrap(panel.chooseExpiry("never", now: now)), PutShareLinkRequest(expiresAt: .clear))
        XCTAssertNil(panel.chooseExpiry("until", now: now), "the until row only shows what is saved")
    }

    func testALinkReopenedWithAnExpiryShowsTheDayItStops() {
        let panel = panel(.project, link(.project, expiresAt: "2026-10-02T12:00:00.000Z"))
        XCTAssertEqual(panel.expirySelection, "until")
        XCTAssertEqual(panel.untilLabel, "Until Oct 2")
        XCTAssertEqual(panel.expiryOptions.map(\.label), ["Never", "1 day", "7 days", "30 days", "Until Oct 2"])
        XCTAssertNil(panel.expiryHint, "the selection already says the day")
    }

    // MARK: visits, and the ⋯ menus

    func testHowOftenItWasOpened() {
        XCTAssertEqual(panel(.task, link(.task)).viewsLine(now: now), "Not opened yet")
        XCTAssertEqual(panel(.task, link(.task, viewCount: 1, lastViewedAt: iso(now.addingTimeInterval(-12 * 60))))
                        .viewsLine(now: now), "Viewed once · last 12m ago")
        XCTAssertEqual(panel(.project, link(.project, viewCount: 14,
                                            lastViewedAt: iso(now.addingTimeInterval(-2 * 3600))))
                        .viewsLine(now: now), "Viewed 14 times · last 2h ago")
        XCTAssertEqual(panel(.session, link(.session, viewCount: 3)).viewsLine(now: now), "Viewed 3 times")
    }

    func testTheMenuSaysWhetherALinkIsOpenOnceItKnows() {
        XCTAssertNil(SharePanel.menuStatus(nil), "nothing is said before the link has been read")
        XCTAssertEqual(SharePanel.menuStatus(ShareLinkRead(link: nil)), "Only you")
        XCTAssertEqual(SharePanel.menuStatus(ShareLinkRead(link: link(.project))), "Live link")
        XCTAssertEqual(SharePanel.menuStatus(ShareLinkRead(link: link(.task, state: .ended))), "Only you")
        XCTAssertEqual(SharePanel.menuStatus(ShareLinkRead(link: link(.session, state: .paused))), "Live link")
    }
}
