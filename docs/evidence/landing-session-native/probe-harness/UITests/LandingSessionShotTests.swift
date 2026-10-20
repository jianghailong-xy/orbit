import XCTest

// TEMPORARY evidence probe (see ../README.md). The landing session page (mockup v4 05), the project
// sessions page and its entrances (04), the task page and the source conversation (06), photographed
// on the iPhone and the Mac against stub.py. The stub's mode is set before each launch; the probe's
// `-probe.page` decides what it opens.
final class LandingSessionShotTests: ProbeCase {
    #if os(iOS)
    // MARK: - 05, the landing session page

    func testIPhoneLandingPageLiveAndSettled() {
        setMode("live")
        var app = launch(until: "Run by Orbit", extra: ["-probe.page", "landing"], "landing-live")
        XCTAssertTrue(appears(app, "checking", timeout: 20), "the status card never showed its step")
        XCTAssertTrue(appears(app, "Merges on its own when it passes.", timeout: 20),
                      "the checking card never said what a passing check does")
        XCTAssertTrue(appears(app, "Merge check · live", timeout: 20),
                      "the running check's dark output block has no header row")
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
        let more = app.buttons["landing-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 20), "the page's ⋯ never showed")
        press(more)
        XCTAssertTrue(appears(app, "· nothing was pushed", timeout: 20),
                      "the timed-out menu never opened on Abandon")
        XCTAssertTrue(appears(app, "Re-run the check", timeout: 20),
                      "the menu never offered Re-run the check")
        shot(app, "ios-05-e-timeout-menu")
        app.terminate()
    }

    func testIPhoneTaskSegmentTimedOut() {
        setMode("task-timeout")
        let app = launch(until: "Timed out", extra: ["-probe.page", "landing"], "landing-task")
        XCTAssertTrue(appears(app, "Runner wikova took it at", timeout: 20),
                      "the task segment never said where the runner stopped")
        XCTAssertTrue(appears(app, "Retry", timeout: 20), "a retryable task attempt offers Retry")
        XCTAssertTrue(appears(app, "Abandon", timeout: 20), "and Abandon")
        shot(app, "ios-05-i-task-timeout")
        app.terminate()
    }

    // MARK: - 04, the entrances

    func testIPhoneLandingCardOneJobCarriesItsFoot() {
        setMode("one-job")
        let app = launch(until: "Open landing", extra: ["-probe.page", "sessions"], "card-one")
        XCTAssertTrue(appears(app, "Ledger migration order", timeout: 20),
                      "the card never named the one job")
        bring(app, element(app, containing: "Open landing"), between: 90, and: 640, "card-one")
        shot(app, "ios-04-b1-card-one-job")
        app.terminate()
    }

    func testIPhoneLandingCardSeveralJobsAndTheJobsList() {
        setMode("two-jobs")
        var app = launch(until: "Landing 2 jobs", extra: ["-probe.page", "sessions"], "card-two")
        XCTAssertTrue(appears(app, "Merge check", timeout: 20), "the merge job's row never showed")
        bring(app, element(app, containing: "Landing 2 jobs"), between: 90, and: 520, "card-two")
        shot(app, "ios-04-b2-card-several-jobs")
        // The whole card still opens the jobs in flight (方案 A).
        press(element(app, containing: "Landing 2 jobs"))
        XCTAssertTrue(appears(app, "2 jobs in flight", timeout: 20), "the jobs list never opened")
        shot(app, "ios-04-a2-jobs-list")
        app.terminate()
    }

    func testIPhoneMergeRoundRowAndQueuedJobs() {
        setMode("merge-two")
        let app = launch(until: "Merge check", extra: ["-probe.page", "sessions"], "merge-two")
        XCTAssertTrue(appears(app, "+1 job queued", timeout: 20),
                      "the round never said how many jobs it stands for")
        XCTAssertTrue(appears(app, "All jobs", timeout: 20), "nor offered the list")
        shot(app, "ios-04-b4-merge-row-queued")
        app.terminate()
    }

    func testIPhoneConfirmedFoot() {
        setMode("confirmed")
        let app = launch(until: "Cancel", extra: ["-probe.page", "sessions"], "confirmed")
        XCTAssertTrue(appears(app, "Open landing", timeout: 20),
                      "the CONFIRMED card's foot never named the round's landing")
        shot(app, "ios-04-c2-confirmed")
        app.terminate()
    }

    func testIPhoneCancellingMerge() {
        setMode("cancelling")
        let app = launch(until: "Cancelling the merge", extra: ["-probe.page", "sessions"], "cancelling")
        XCTAssertTrue(appears(app, "Stops at the runner’s next report", timeout: 20),
                      "the cancelling card never said what the stop does")
        XCTAssertTrue(appears(app, "Cancel requested", timeout: 20),
                      "the cancelled press is still a press")
        shot(app, "ios-04-c3-cancelling")
        app.terminate()
    }

    func testIPhoneCheckTimeoutCard() {
        setMode("timeout")
        let app = launch(until: "Re-run the check", extra: ["-probe.page", "sessions"], "timeout-check")
        XCTAssertTrue(appears(app, "Timed out", timeout: 20), "the check card never said it timed out")
        shot(app, "ios-04-c5-check-timeout")
        app.terminate()
    }

    func testIPhoneMergeTimeoutCard() {
        setMode("land-timeout")
        let app = launch(until: "Abandon", extra: ["-probe.page", "sessions"], "timeout-merge")
        XCTAssertTrue(appears(app, "Timed out", timeout: 20), "the merge card never said it timed out")
        XCTAssertFalse(appears(app, "Re-run the check", timeout: 3),
                       "a stopped merge has no re-run — only the end")
        shot(app, "ios-04-c6-merge-timeout")
        app.terminate()
    }

    func testIPhoneReceiptFoot() {
        setMode("receipt")
        let app = launch(until: "Merged into main", extra: ["-probe.page", "sessions"], "receipt")
        // The merged row is in the timeline, below the cards: a lazy list has not built it until
        // something scrolls to it.
        let row = element(app, containing: "Merged into main")
        bring(app, row, between: 120, and: 640, "receipt")
        press(row)
        XCTAssertTrue(appears(app, "Open landing", timeout: 20),
                      "the receipt's foot never named the round's landing")
        shot(app, "ios-04-c7-receipt")
        app.terminate()
    }

    func testIPhoneLandingsGroup() {
        setMode("live")
        let app = launch(until: "Landings", extra: ["-probe.page", "sessions"], "sessions-group")
        XCTAssertTrue(appears(app, "Checks failed", timeout: 20),
                      "the waiting landing never named its holder")
        XCTAssertTrue(appears(app, "Earlier", timeout: 20), "the fold never showed")
        bring(app, element(app, containing: "Landings"), between: 90, and: 520, "sessions-group")
        shot(app, "ios-04-c1-landings-group")
        app.terminate()
    }

    // MARK: - 06, the task page, the transcript and the owner card

    func testIPhoneTaskPageLandingSection() {
        setMode("live")
        let app = launch(until: "generation 3", extra: ["-probe.page", "task"], "task-landing")
        XCTAssertTrue(appears(app, "Landing", timeout: 20), "the Landing section never showed")
        XCTAssertTrue(appears(app, "Queue wait", timeout: 20), "the facts never showed")
        shot(app, "ios-06-task-landing")
        app.terminate()
    }

    func testIPhoneSourceConversationsLabel() {
        setMode("live")
        let app = launch(until: "Landing · checking", extra: ["-probe.page", "chat"], "source-label")
        bring(app, element(app, containing: "Landing · checking"), between: 100, and: 700, "source-label")
        shot(app, "ios-06-source-label")
        app.terminate()
    }

    func testIPhoneDeliveryCardsLandingLink() {
        setMode("delivery")
        let app = launch(until: "Open the landing", extra: ["-probe.page", "chat"], "delivery")
        XCTAssertTrue(appears(app, "Open the failed session", timeout: 20),
                      "the delivery card never showed its two older links")
        shot(app, "ios-06-b-delivery")
        app.terminate()
    }

    func testIPhoneOwnersXE5LandingCard() {
        setMode("lease")
        let app = launch(until: "Now yours", extra: ["-probe.page", "owner"], "owner-card")
        XCTAssertTrue(appears(app, "no report from the runner", timeout: 20),
                      "the X-E5 heading never showed")
        XCTAssertTrue(appears(app, "Abandon", timeout: 20), "the lead door never showed")
        XCTAssertTrue(appears(app, "Open landing", timeout: 20), "the reading door never showed")
        XCTAssertTrue(appears(app, "Mark as handled", timeout: 20),
                      "the server's X-E5 cell takes the owner's own ending")
        for row in ["Landing", "Runner", "Step"] {
            XCTAssertTrue(appears(app, row, timeout: 20), "the lease block never drew `\(row)`")
        }
        XCTAssertTrue(appears(app, "generation 3", timeout: 20), "the landing row never named it")
        XCTAssertFalse(appears(app, "came to the owner at", timeout: 2),
                       "an item escalated at birth has no window to name")
        shot(app, "ios-06-xe5-card")
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
        XCTAssertFalse(appears(app, "Ledger migration order", timeout: 2),
                       "a merge job lands no task — the card attributes none")
        XCTAssertFalse(appears(app, "onto project/P1", timeout: 2),
                       "and names no branch, because it is not one of the project's landings")
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
