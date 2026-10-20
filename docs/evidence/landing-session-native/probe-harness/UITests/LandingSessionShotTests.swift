import XCTest

// TEMPORARY evidence probe (see ../README.md). The landing session page (mockup v4 05), the project
// sessions page with its Landings group (04), the task page's Landing section and the source
// conversation's derived label (06), photographed on the iPhone and the Mac against stub.py. The
// stub's mode is set before each launch; the probe's `-probe.page` decides what it opens.
final class LandingSessionShotTests: ProbeCase {
    #if os(iOS)
    func testIPhoneLandingPageLiveAndSettled() {
        setMode("live")
        var app = launch(until: "Run by Orbit", extra: ["-probe.page", "landing"], "landing-live")
        XCTAssertTrue(appears(app, "checking", timeout: 20), "the status card never showed its step")
        shot(app, "ios-05-a-live")
        app.terminate()
        settle(1)

        setMode("settled")
        app = launch(until: "Merged into main", extra: ["-probe.page", "landing"], "landing-settled")
        XCTAssertTrue(appears(app, "Now on main", timeout: 20), "the outcome never named the tasks")
        XCTAssertTrue(appears(app, "This landing is complete", timeout: 20),
                      "the settled footer never showed")
        shot(app, "ios-05-c-merged")
        app.terminate()
    }

    func testIPhoneLandingMenuOnATimedOutRound() {
        setMode("timeout")
        let app = launch(until: "Timed out", extra: ["-probe.page", "landing"], "landing-timeout")
        XCTAssertTrue(appears(app, "No report for 23m", timeout: 20), "the timeout line never showed")
        // The page's own ⋯, by its identifier: the console's session menu is not drawn on a
        // landing session, so this is the only one.
        let more = app.buttons["landing-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 20), "the page's ⋯ never showed")
        press(more)
        // The menu's Abandon row carries "Ends this attempt · nothing was pushed"; the card's own
        // Abandon consequence says "Ends this attempt. Nothing was pushed, and nothing is queued
        // again." The mid-dot clause is the menu's alone, so its appearance is the menu being open.
        XCTAssertTrue(appears(app, "· nothing was pushed", timeout: 20),
                      "the timed-out menu never opened on Abandon")
        XCTAssertTrue(appears(app, "Re-run the check", timeout: 20),
                      "the menu never offered Re-run the check")
        shot(app, "ios-05-e-timeout-menu")
        app.terminate()
    }

    func testIPhoneProjectSessionsLandingsGroup() {
        setMode("live")
        let app = launch(until: "Landings", extra: ["-probe.page", "sessions"], "sessions-group")
        XCTAssertTrue(appears(app, "Checks failed", timeout: 20),
                      "the waiting landing never named its holder")
        XCTAssertTrue(appears(app, "Earlier", timeout: 20), "the fold never showed")
        bring(app, element(app, containing: "Landings"), between: 90, and: 520, "sessions-group")
        shot(app, "ios-04-c1-landings-group")
        app.terminate()
    }

    func testIPhoneTaskPageLandingSection() {
        setMode("live")
        let app = launch(until: "generation 3", extra: ["-probe.page", "task"], "task-landing")
        XCTAssertTrue(appears(app, "Landing", timeout: 20), "the Landing section never showed")
        XCTAssertTrue(appears(app, "Queue wait", timeout: 20), "the facts never showed")
        shot(app, "ios-06-task-landing")
        app.terminate()
    }

    func testIPhoneOwnersXE5LandingCard() {
        setMode("lease")
        let app = launch(until: "Now yours", extra: ["-probe.page", "owner"], "owner-card")
        XCTAssertTrue(appears(app, "no report from the runner", timeout: 20),
                      "the X-E5 heading never showed")
        XCTAssertTrue(appears(app, "Abandon", timeout: 20), "the lead door never showed")
        XCTAssertTrue(appears(app, "Open landing", timeout: 20), "the reading door never showed")
        shot(app, "ios-06-xe5-card")
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
    func testMacLandingPage() {
        setMode("live")
        let app = launch(until: "Run by Orbit", extra: ["-probe.page", "landing"], "mac-landing")
        XCTAssertTrue(appears(app, "checking", timeout: 20), "the status card never showed its step")
        shot(app, "mac-05-a-live")
        app.terminate()
    }

    func testMacWorkOverviewDrawsTheMergeJob() {
        setMode("live")
        let app = launch(until: "Merge check", extra: ["-probe.page", "overview"], "mac-overview")
        XCTAssertTrue(appears(app, "Merge check", timeout: 20),
                      "the Work overview never drew the merge job in flight")
        shot(app, "mac-04-work-overview-merge-job")
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
