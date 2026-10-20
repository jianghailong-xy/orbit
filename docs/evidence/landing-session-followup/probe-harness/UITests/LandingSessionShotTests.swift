import XCTest

// TEMPORARY evidence probe (see ../README.md), copied from docs/evidence/landing-session-native for
// task 34jBwFmcEPK012TsNL0Lc. It photographs what that task changed, on the iPhone and the Mac,
// against stub.py: the Landings group's Earlier row (mockup v4 04), the round line by job kind
// (`round 1 of 3` for a LAND_TASK, `round 1` for the two merge kinds) on the landing page (05), the
// sessions page (04) and the X-E5 card (06), the landing page's Abandon in its light secondary style
// (05), and the Work overview's Landing card for a lone merge job (04). Every check the stub serves
// has a count of 1, so a LAND_TASK's `of 3` can only come from its kind.
final class LandingSessionShotTests: ProbeCase {
    #if os(iOS)
    // MARK: - 04, the Landings group's Earlier row

    func testIPhoneEarlierRowLeavesOutAZeroCount() {
        // live: the only older landing had nothing to land.
        earlier("live", says: "Earlier · 1 nothing to land", shot: "ios-04-earlier-nothing")
        earlier("earlier-landed", says: "Earlier · 1 landed", shot: "ios-04-earlier-landed")
        earlier("earlier-both", says: "Earlier · 1 landed · 1 nothing to land", shot: "ios-04-earlier-both")
    }

    func testIPhoneNoEarlierRowWhenBothCountsAreZero() {
        setMode("earlier-none")
        let app = launch(until: "Landings", extra: ["-probe.page", "sessions"], "earlier-none")
        XCTAssertTrue(appears(app, "Checks failed", timeout: 20), "the group's waiting landing never showed")
        bring(app, element(app, containing: "Landings"), between: 90, and: 520, "earlier-none")
        XCTAssertFalse(appears(app, "Earlier", timeout: 4),
                       "an older landing that was cancelled is neither landed nor nothing to land")
        shot(app, "ios-04-earlier-none")
        app.terminate()
    }

    private func earlier(_ mode: String, says line: String, shot name: String) {
        setMode(mode)
        let app = launch(until: "Landings", extra: ["-probe.page", "sessions"], "earlier-\(mode)")
        bring(app, element(app, containing: "Landings"), between: 90, and: 520, name)
        XCTAssertTrue(appears(app, line, timeout: 20), "\(mode): the fold never read `\(line)`")
        XCTAssertFalse(appears(app, "· 0 ", timeout: 2), "\(mode): the fold still writes a zero count")
        shot(app, name)
        app.terminate()
        settle(1)
    }

    // MARK: - 05, the landing session page: the round line and Abandon

    func testIPhoneTaskSegmentTimedOut() {
        setMode("task-timeout")
        let app = launch(until: "Timed out", extra: ["-probe.page", "landing"], "landing-task")
        XCTAssertTrue(appears(app, "Runner wikova took it at", timeout: 20),
                      "the task segment never said where the runner stopped")
        XCTAssertTrue(appears(app, "claim 1 · round 1 of 3", timeout: 20),
                      "a LAND_TASK's claim runs at most 3 rounds (J5), whatever its check count")
        XCTAssertTrue(appears(app, "Retry", timeout: 20), "a retryable task attempt offers Retry")
        XCTAssertTrue(appears(app, "Abandon", timeout: 20), "and Abandon, in the light secondary style")
        shot(app, "ios-05-i-task-timeout")
        // The server's ROUND line further down the timeline.
        bring(app, element(app, containing: "Round 1 of 3"), between: 120, and: 700, "task-round")
        shot(app, "ios-05-i-task-timeline")
        app.terminate()
    }

    func testIPhoneCheckTimeoutCard() {
        setMode("timeout")
        let app = launch(until: "Timed out", extra: ["-probe.page", "landing"], "landing-check-timeout")
        XCTAssertTrue(appears(app, "claim 1 · round 1", timeout: 20), "the claim line never named its round")
        XCTAssertFalse(appears(app, "round 1 of", timeout: 3), "a merge check has one round: no `of`")
        XCTAssertTrue(appears(app, "Re-run the check", timeout: 20), "a timed-out check offers Re-run the check")
        XCTAssertTrue(appears(app, "Abandon", timeout: 20), "and Abandon, in the light secondary style")
        shot(app, "ios-05-e-check-timeout")
        app.terminate()
    }

    func testIPhoneLandingPageLiveCheck() {
        setMode("live")
        let app = launch(until: "Run by Orbit", extra: ["-probe.page", "landing"], "landing-live")
        XCTAssertTrue(appears(app, "checking", timeout: 20), "the status card never showed its step")
        XCTAssertFalse(appears(app, "round 1 of", timeout: 3), "a merge check has one round: no `of`")
        shot(app, "ios-05-a-live")
        app.terminate()
    }

    // MARK: - 04, the sessions page's round lines

    func testIPhoneLandingCardOneTaskJob() {
        setMode("one-job")
        let app = launch(until: "Open landing", extra: ["-probe.page", "sessions"], "card-one")
        XCTAssertTrue(appears(app, "Ledger migration order", timeout: 20), "the card never named the one job")
        XCTAssertTrue(appears(app, "round 1 of 3", timeout: 20),
                      "a LAND_TASK's head says `round 1 of 3`, whatever its check count")
        XCTAssertTrue(appears(app, "Nothing to do", timeout: 20), "a task landing keeps its sentence")
        bring(app, element(app, containing: "Open landing"), between: 90, and: 640, "card-one")
        shot(app, "ios-04-b1-card-task")
        app.terminate()
    }

    func testIPhoneMergeCheckRow() {
        setMode("live")
        let app = launch(until: "Merge check", extra: ["-probe.page", "sessions"], "merge-check")
        XCTAssertFalse(appears(app, "round 1 of", timeout: 3), "a merge check has one round: no `of`")
        shot(app, "ios-04-b4-merge-check")
        app.terminate()
    }

    // MARK: - 06, the X-E5 card's Step row and the source label

    func testIPhoneXE5StepRowByJobKind() {
        setMode("lease")
        var app = launch(until: "Now yours", extra: ["-probe.page", "owner"], "xe5-check")
        XCTAssertTrue(appears(app, "checking · claim 1 · round 1", timeout: 20), "the Step row never showed")
        XCTAssertFalse(appears(app, "round 1 of", timeout: 3), "a merge check has one round: no `of`")
        XCTAssertTrue(appears(app, "Abandon", timeout: 20), "the lead solid door never showed")
        shot(app, "ios-06-xe5-check")
        app.terminate()
        settle(1)

        setMode("lease-task")
        app = launch(until: "Now yours", extra: ["-probe.page", "owner"], "xe5-task")
        XCTAssertTrue(appears(app, "rebasing · claim 1 · round 1 of 3", timeout: 20),
                      "a LAND_TASK's Step row says `round 1 of 3`, whatever its check count")
        shot(app, "ios-06-xe5-task")
        app.terminate()
    }

    func testIPhoneSourceConversationsLabel() {
        setMode("live")
        let app = launch(until: "Landing · checking", extra: ["-probe.page", "chat"], "source-label")
        bring(app, element(app, containing: "Landing · checking"), between: 100, and: 700, "source-label")
        shot(app, "ios-06-source-label")
        app.terminate()
    }
    #endif

    #if os(macOS)
    func testMacWorkOverviewLoneMergeCheck() {
        overview("live", word: "Merge check", shot: "mac-04-overview-merge-check")
    }

    func testMacWorkOverviewLoneMergeToMain() {
        overview("confirmed", word: "Merge to main", shot: "mac-04-overview-merge-to-main")
    }

    func testMacWorkOverviewTaskLandingKeepsItsSentence() {
        setMode("one-job")
        let app = launch(until: "Ledger migration order", extra: ["-probe.page", "overview"], "mac-overview-task")
        XCTAssertTrue(appears(app, "Nothing to do", timeout: 20), "a task landing keeps its sentence")
        XCTAssertTrue(appears(app, "round 1 of 3", timeout: 20),
                      "a LAND_TASK's head says `round 1 of 3`, whatever its check count")
        shot(app, "mac-04-overview-task")
        app.terminate()
    }

    private func overview(_ mode: String, word: String, shot name: String) {
        setMode(mode)
        let app = launch(until: word, extra: ["-probe.page", "overview"], "mac-overview-\(mode)")
        XCTAssertTrue(appears(app, word, timeout: 20), "the Work overview never drew the merge job in flight")
        XCTAssertFalse(appears(app, "Nothing to do", timeout: 3),
                       "a merge job lands no task: its card says no task-landing sentence")
        XCTAssertFalse(appears(app, "round 1 of", timeout: 2), "a merge job has one round: no `of`")
        shot(app, name)
        app.terminate()
        settle(1)
    }

    func testMacLandingPageTaskTimedOut() {
        setMode("task-timeout")
        let app = launch(until: "Timed out", extra: ["-probe.page", "landing"], "mac-landing-task")
        XCTAssertTrue(appears(app, "round 1 of 3", timeout: 20), "the claim line never named its round")
        XCTAssertTrue(appears(app, "Abandon", timeout: 20), "the status card's Abandon never showed")
        shot(app, "mac-05-i-task-timeout")
        app.terminate()
    }

    func testMacLandingPageCheckTimedOut() {
        setMode("timeout")
        let app = launch(until: "Timed out", extra: ["-probe.page", "landing"], "mac-landing-check")
        XCTAssertTrue(appears(app, "Re-run the check", timeout: 20), "a timed-out check offers Re-run the check")
        XCTAssertFalse(appears(app, "round 1 of", timeout: 3), "a merge check has one round: no `of`")
        shot(app, "mac-05-e-check-timeout")
        app.terminate()
    }
    #endif

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }
}
