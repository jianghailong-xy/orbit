import XCTest

// TEMPORARY evidence probe (see ../README.md). Drives the iPhone app's real shared sources against
// stub.py and photographs the five screens of docs/mocks/landing-measured (contract revision 42 part
// two, as the owner ruled D1–D9). Every state a picture is meant to show is asserted, so a run that
// never reached it fails rather than leaving a picture of something else; what each press sent is
// read back from the stub. run.sh runs the whole class twice: SHOT_LOOK=light, then dark.
final class LandingMeasuredShotTests: ProbeCase {

    private var look: String { ProcessInfo.processInfo.environment["SHOT_LOOK"] ?? "light" }

    private func picture(_ app: XCUIApplication, _ name: String) {
        shot(app, "\(name)-\(look)")
    }

    private func expect(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 15) {
        if appears(app, words, timeout: timeout) {
            note("\(name): shows \(words.debugDescription)")
        } else {
            write(app.debugDescription, "missing-\(name)-\(look).txt")
            XCTFail("\(name): \(words.debugDescription) never showed")
        }
    }

    private func expectNo(_ app: XCUIApplication, _ words: String, _ name: String) {
        if element(app, containing: words).exists {
            write(app.debugDescription, "unexpected-\(name)-\(look).txt")
            XCTFail("\(name): \(words.debugDescription) is on screen")
        } else {
            note("\(name): no \(words.debugDescription)")
        }
    }

    private func identified(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// The decoded bodies the stub was sent at this door.
    private func bodies(_ door: String) -> [String] {
        requestsLog().split(separator: "\n").map(String.init).filter { $0.contains("BODY \(door)") }
    }

    // MARK: ① the start card for a request with no line (D1, D8)

    func test1TheStartCardForARequestWithNoLine() throws {
        let app = launch("session:C5", until: "Start this project?", "01")
        // The card is a preview in the transcript; its review page is the card.
        let preview = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "View details")).firstMatch
        if preview.waitForExistence(timeout: 20) {
            bring(app, preview, between: 120, and: 760, "01-preview")
            press(preview)
            settle(1.5)
        } else {
            note("01: no preview button; the card is drawn whole")
        }
        let lands = identified(app, "start-lands-when-commits")
        expect(app, "Lands on the project’s branch when a task commits", "01-card", timeout: 20)
        bring(app, lands, between: 260, and: 620, "01-lands")
        expect(app, "Merge check", "01-card")
        expect(app, "At most", "01-card")
        expectNo(app, "Tasks land on", "01-card")
        expectNo(app, "Main branch", "01-card")
        expectNo(app, "Leave blank to use merge check", "01-card")
        picture(app, "01-start-card")

        let go = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Start the project")).firstMatch
        guard go.waitForExistence(timeout: 10) else { return XCTFail("01: no Start the project") }
        press(go)
        settle(3)
        let sent = bodies("/api/projects/P5/start")
        note("start bodies: \(sent)")
        XCTAssertFalse(sent.isEmpty, "Start sent nothing")
        XCTAssertTrue(sent.allSatisfy { !$0.contains("\"line\"") }, "Start sent a line: \(sent)")
        XCTAssertTrue(sent.contains { $0.contains("\"requestId\": \"I5\"") }, "Start did not answer the request: \(sent)")
    }

    // MARK: ② a started project with no line (D2)

    func test2AStartedProjectWithNoLineDrawsNoLanding() throws {
        let app = launch("sessions:P1", until: "Move cron jobs off the old VM", "02")
        expect(app, "Delete unused staging buckets", "02-page")
        expect(app, "Two tasks running", "02-page")
        settle(2)
        XCTAssertFalse(identified(app, "landings-row").exists, "a Landings row is drawn for a project with no line")
        expectNo(app, "Waiting for a runner", "02-page")
        expectNo(app, "Landing ·", "02-page")
        picture(app, "02-project-no-line")
    }

    // MARK: ③ the landing check, who set it, and No check (D3, D4, D9)

    func test3TheLandingCheckWithWhoSetItAndNoCheck() throws {
        let app = launch("project:P2", until: "Rotate staging credentials", "03")
        let mode = identified(app, "landing-check-mode")
        bring(app, mode, between: 160, and: 420, "03-mode")
        expect(app, "npm run check:landing", "03b")
        // The stub stamps it 12 minutes before the launch; a slow pass can read it a minute later.
        XCTAssertTrue(appears(app, "set 12m ago", timeout: 5) || appears(app, "set 13m ago", timeout: 5)
                      || appears(app, "set 14m ago", timeout: 5), "03b: no \"set 12m ago\" time")
        XCTAssertTrue(identified(app, "provenance-coordinator").exists, "03b: no Coordinator badge")
        expect(app, "Changes the coordinator makes are listed under Coordinator’s changes.", "03b")
        expect(app, "3 changes", "03b")
        picture(app, "03b-landing-check-coordinator")

        let none = app.buttons["No check"]
        guard none.waitForExistence(timeout: 10) else { return XCTFail("03c: no No check segment") }
        press(none)
        settle(3)
        let sent = bodies("/api/projects/P2/integration")
        note("integration bodies: \(sent)")
        XCTAssertTrue(sent.contains { $0.hasSuffix("{\"landingCheck\": \"NONE\"}") }, "No check wrote \(sent)")
        expect(app, "Tasks land with only their own acceptance.", "03c")
        XCTAssertTrue(identified(app, "provenance-you").waitForExistence(timeout: 10), "03c: no You badge")
        // Who can set it, under No check (web's LANDING_CHECK_ORIGIN_NOTES; kept from main's second port).
        let who = identified(app, "landing-check-who-can-set")
        bring(app, who, between: 160, and: 760, "03c-who")
        XCTAssertTrue(who.exists, "03c: no Who can set it under No check")
        expect(app, "No card, while the merge check exists.", "03c")
        XCTAssertTrue(identified(app, "who-can-set-start").exists, "03c: the legend has no Set at start badge")
        bring(app, identified(app, "landing-check-mode"), between: 160, and: 420, "03c-mode")
        picture(app, "03c-no-check")
    }

    // MARK: ④ a task's exemption, on its page and in its landing (D5)

    func test4aTheExemptionOnTheTaskPage() throws {
        let app = launch("task:T1", until: "Move cron jobs off the old VM", "04a")
        let row = identified(app, "task-landing-exemption")
        bring(app, row, between: 140, and: 700, "04a-row")
        expect(app, "Exempt", "04a")
        expect(app, "Only moves cron entries; the landing check needs a database", "04a")
        expect(app, "marked 20m ago", "04a", timeout: 20)
        XCTAssertTrue(identified(app, "provenance-coordinator").exists, "04a: no Coordinator badge")
        expect(app, "Remove exemption", "04a")
        picture(app, "04a-task-exempt")

        let remove = identified(app, "remove-exemption")
        guard remove.exists else { return XCTFail("04a: no Remove exemption") }
        press(remove)
        settle(3)
        let sent = bodies("/api/tasks/T1")
        note("task bodies: \(sent)")
        XCTAssertTrue(sent.contains { $0.hasSuffix("{\"landingCheckExempt\": false}") }, "Remove exemption wrote \(sent)")
        XCTAssertTrue(waitUntil(15) { !self.identified(app, "task-landing-exemption").exists },
                      "the exemption is still drawn after Remove exemption")
        picture(app, "04a-task-exemption-removed")
    }

    /// An exempt task with no landing yet still has its Landing section, for the exemption alone; who
    /// marked it is the project's record (c4, approved on a card 7 minutes ago).
    func test4cAnExemptTaskWithNoLandingYet() throws {
        let app = launch("task:T2", until: "Restart the staging services", "04c")
        let row = identified(app, "task-landing-exemption")
        bring(app, row, between: 140, and: 700, "04c-row")
        guard row.exists else { return XCTFail("04c: no exemption row") }
        expect(app, "Exempt", "04c")
        expect(app, "Restarts services only; nothing the landing check builds changes.", "04c")
        XCTAssertTrue(identified(app, "provenance-card").waitForExistence(timeout: 20), "04c: no Approved on a card badge")
        expect(app, "Approved on a card", "04c")
        XCTAssertTrue(appears(app, "marked 7m ago", timeout: 5) || appears(app, "marked 8m ago", timeout: 5),
                      "04c: no \"marked 7m ago\" time")
        expect(app, "Remove exemption", "04c")
        expectNo(app, "Landed", "04c")
        picture(app, "04c-task-exempt-no-landing")
    }

    func test4bTheLandingReadsTheCheckSkipped() throws {
        let app = launch("landing:L1", until: "Task acceptance", "04b")
        expect(app, "Landing check · Skipped", "04b")
        expect(app, "Exempt: Only moves cron entries", "04b")
        expect(app, "Merge check before main", "04b")
        expect(app, "Still runs", "04b")
        let skipped = element(app, containing: "Landing check · Skipped")
        bring(app, skipped, between: 160, and: 700, "04b-step")
        picture(app, "04b-landing-skipped")
        press(skipped)
        settle(1.5)
        expect(app, "Landing check skipped · this task is exempt", "04b-open")
        settle(2)
        // The skipped check never ran: its open line reads no output inline (web's TimelineLine).
        let logReads = requestsLog().split(separator: "\n").filter { $0.contains("/landing/log") && $0.contains("check=2") }
        XCTAssertTrue(logReads.isEmpty, "04b: the skipped check read its output inline: \(logReads)")
        picture(app, "04b-landing-skipped-open")
    }

    // MARK: ⑤ the coordinator's changes and the owner's revert (D6, D7)

    func test5TheCoordinatorsChangesAndTheOwnersRevert() throws {
        let app = launch("project:P3", until: "Rotate staging credentials", "05")
        let entry = identified(app, "coordinator-changes-entry")
        bring(app, entry, between: 160, and: 700, "05-entry")
        guard entry.exists else { return XCTFail("05: no Coordinator's changes row") }
        press(entry)
        expect(app, "What the coordinator changed on its own", "05b", timeout: 20)
        expect(app, "This project only changes infrastructure", "05b")
        expect(app, "Check exempt · Move cron jobs…", "05b")
        // The exemption row opens its task, as the web's list links it (kept from main's second port).
        XCTAssertTrue(identified(app, "open-task-c2").waitForExistence(timeout: 10), "05b: the exemption row opens no task")
        expect(app, "Your change · nothing to revert", "05b")
        picture(app, "05b-changes")

        let revert = identified(app, "revert-c1")
        guard revert.waitForExistence(timeout: 10) else { return XCTFail("05c: no Revert on c1") }
        press(revert)
        expect(app, "Revert this change?", "05c", timeout: 15)
        expect(app, "The coordinator can no longer change this field without a card.", "05c")
        settle(1)
        picture(app, "05c-revert-confirm")

        let confirm = identified(app, "revert-confirm")
        guard confirm.exists else { return XCTFail("05c: no Revert in the confirmation") }
        press(confirm)
        settle(3)
        let sent = requestsLog().split(separator: "\n").filter { $0.contains("BODY /api/projects/P3/setting-changes/c1/revert") }
        XCTAssertFalse(sent.isEmpty, "the confirmation's Revert sent nothing")
        expect(app, "Reverted by you", "05d", timeout: 20)
        XCTAssertFalse(identified(app, "revert-c1").exists, "c1 still offers Revert after it was reverted")
        picture(app, "05d-reverted")
    }
}
