import XCTest

// TEMPORARY evidence probe (never merged): the iPhone app against stub.py (task I1, mocks 31 ② ④ ⑤).
// One space (today's orbit, port 8765) and three (orbit, wikova, wikids — port 8766): the drawer's
// Wiki number, the Wiki bar's Activity badge, Activity's amber banners and Review's head, read off
// the screen and held to one another; the space beside the title, a label alone and a menu among
// several; and the shots to compare with the mocks.
final class WikiShotsTests: XCTestCase {
    private var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    /// Today's real case (mocks 31 ② and ④ top): one space with one proposal and its documents being
    /// written. Drawer 1 = badge 1 = Activity's amber 1 = Review's 1; the space is a label, no menu.
    func testOneSpace() {
        let app = launch(port: 8765)
        guard openWiki(app, expecting: 1, shot: "01-one-drawer") else { return }
        let space = app.staticTexts["The codebase this wiki describes"]
        XCTAssertTrue(space.waitForExistence(timeout: 20), "one space: its name as a label")
        XCTAssertEqual(space.value as? String, "orbit", "called by its repository's last segment")
        XCTAssertFalse(app.buttons["The codebase this wiki describes"].exists, "one space: no menu to open")
        settle(2)
        shot("02-one-home-head")
        tree(app, "one-home")

        openActivity(app, expecting: 1)
        XCTAssertTrue(waitLabel(app, "1 proposal to review"), "the first banner: the proposals alone, singular")
        XCTAssertTrue(waitLabel(app, "Writing documents · 5 of 35"), "the plan's blue banner as the home draws it")
        XCTAssertTrue(waitLabel(app, "4 new since you last looked"), "Recently changed counts what came after the stamp")
        settle(2)
        shot("03-one-activity")
        tree(app, "one-activity")
        app.swipeUp()
        settle(1.5)
        shot("04-one-activity-scrolled")

        app.swipeDown()
        settle(1)
        tapLabel(app, "1 proposal to review")
        XCTAssertTrue(waitLabel(app, "1 proposal from 1 session", begins: true), "Review's head says the banner's number")
        settle(2)
        shot("05-one-review")
        tree(app, "one-review")
    }

    /// Several spaces (mocks 31 ④ bottom and ⑤): orbit 1 proposal, wikova 2 proposals and a plan draft
    /// waiting, wikids nothing. Drawer 4 = badge 4 = Activity's amber 3 + 1; the first banner and Review's
    /// head 3. The Wiki opens orbit — the space of the workspace the reader came from — though wikova has
    /// more documents written.
    func testThreeSpaces() {
        let app = launch(port: 8766)
        guard openWiki(app, expecting: 4, shot: "11-three-drawer") else { return }
        let space = app.buttons["The codebase this wiki describes"]
        XCTAssertTrue(space.waitForExistence(timeout: 20), "several spaces: a menu")
        XCTAssertEqual(space.value as? String, "orbit", "the space bound to orbit-develop opens, not the most written")
        settle(2)
        shot("12-three-home-head")
        tree(app, "three-home")

        space.tap()
        let manage = app.buttons["Manage spaces"]
        XCTAssertTrue(manage.waitForExistence(timeout: 10), "the menu ends with Manage spaces")
        for line in ["github.com/jianghailong-xy/orbit", "github.com/jianghailong-xy/wikova", "No documents yet"] {
            XCTAssertTrue(waitLabel(app, line, timeout: 5, contains: true), "a menu row says \(line)")
        }
        settle(1.5)
        shot("13-three-space-menu")
        tree(app, "three-space-menu")
        // Close the menu on the large title, which presses nothing if the tap goes through.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.177)).tap()
        settle(1.5)
        XCTAssertFalse(manage.exists, "the menu closed")

        openActivity(app, expecting: 4)
        XCTAssertTrue(waitLabel(app, "3 proposals to review · 2 in wikova"), "every space's proposals, wikova's share said")
        XCTAssertTrue(waitLabel(app, "Writing documents · 5 of 35"), "orbit's plan, blue")
        XCTAssertTrue(waitLabel(app, "Plan draft ready to confirm · in wikova"), "wikova's plan waits: amber, named")
        settle(2)
        shot("14-three-activity")
        tree(app, "three-activity")

        tapLabel(app, "3 proposals to review · 2 in wikova")
        XCTAssertTrue(waitLabel(app, "3 proposals from 2 sessions", begins: true), "Review over every space: 3")
        settle(2)
        shot("15-three-review")
        tree(app, "three-review")
    }

    // MARK: the way in

    private func launch(port: Int) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:\(port)", "-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        return app
    }

    /// The drawer from orbit-develop's list: its Wiki row says the number waiting, then opens the Wiki.
    private func openWiki(_ app: XCUIApplication, expecting waiting: Int, shot name: String) -> Bool {
        let hamburger = app.buttons["Open navigation"].firstMatch
        guard hamburger.waitForExistence(timeout: 60) else {
            tree(app, "no-hamburger-\(name)")
            XCTFail("the shell never drew its drawer button")
            return false
        }
        settle(3)
        hamburger.tap()
        let said = "\(waiting) waiting on you"
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Wiki", said)).firstMatch
        guard row.waitForExistence(timeout: 20) else {
            tree(app, "no-wiki-row-\(name)")
            XCTFail("the drawer drew no Wiki row saying \(said)")
            return false
        }
        note("drawer row: \(describe(row))")
        settle(1.5)
        shot(name)
        tree(app, "drawer-\(name)")
        row.tap()
        return true
    }

    /// The bar's Activity button wears the drawer's number; pressing it opens Activity under Review's bar.
    private func openActivity(_ app: XCUIApplication, expecting waiting: Int) {
        let activity = app.buttons["Activity"].firstMatch
        guard activity.waitForExistence(timeout: 20) else {
            tree(app, "no-activity-button")
            return XCTFail("the Wiki's bar has no Activity button")
        }
        XCTAssertEqual(activity.value as? String, "\(waiting) waiting on you", "the badge is the drawer's number")
        note("activity button: \(describe(activity))")
        activity.tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Activity"].waitForExistence(timeout: 20)
                        || app.staticTexts["Activity"].waitForExistence(timeout: 5), "Activity's title")
    }

    // MARK: helpers

    private func waitLabel(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 20,
                           begins: Bool = false, contains: Bool = false) -> Bool {
        let format = contains ? "label CONTAINS %@" : begins ? "label BEGINSWITH %@" : "label == %@"
        let found = app.descendants(matching: .any).matching(NSPredicate(format: format, text)).firstMatch
        let ok = found.waitForExistence(timeout: timeout)
        note("\(ok ? "found" : "MISSING") \(text.debugDescription): \(describe(found))")
        return ok
    }

    private func tapLabel(_ app: XCUIApplication, _ text: String) {
        let found = app.buttons.matching(NSPredicate(format: "label == %@", text)).firstMatch
        guard found.waitForExistence(timeout: 10) else { return XCTFail("nothing to press says \(text)") }
        found.tap()
    }

    private func describe(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        return "\(element.elementType.rawValue) label=\"\(element.label)\" value=\"\(element.value ?? "")\" "
            + "id=\"\(element.identifier)\" frame=\(element.frame)"
    }

    private func settle(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func note(_ line: String) {
        notes.append(line)
    }

    private func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    private func write(_ text: String, _ file: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
