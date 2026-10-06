import XCTest

// TEMPORARY evidence probe (never merged): the iPhone app against stub.py. A project's sessions
// page that the workspace list's project row pushed must leave the left edge to the system
// back-swipe, which returns to the list. The same page opened from the drawer's project row is the
// project's own page: it leads with the drawer's hamburger, and the edge swipe opens the drawer.
final class SwipeBackTests: XCTestCase {
    private let title = "Swipe probe project"
    private var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    // MARK: the two entrances

    func testAListRowsProjectPageSwipesBackToTheList() {
        let app = launch()
        let row = listRow(app)
        guard row.waitForExistence(timeout: 60) else {
            tree(app, "no-list-row")
            return XCTFail("the workspace list never showed the project row")
        }
        settle(1.5)
        shot("01-workspace-list")
        note("list row: \(describe(row))")

        row.tap()
        let header = pageHeader(app)
        guard header.waitForExistence(timeout: 20) else {
            tree(app, "no-page-after-row")
            return XCTFail("the project row did not open the project's sessions page")
        }
        settle(1.5)
        shot("02-page-pushed-from-list")
        tree(app, "page-pushed-from-list")
        note("header: \(describe(header))")
        let leading = app.buttons.allElementsBoundByIndex.filter { $0.exists && $0.frame.minY < 140 && $0.frame.minX < 80 }
        note("leading bar buttons: \(leading.map(describe))")
        XCTAssertFalse(app.buttons["Open navigation"].exists,
                       "a list row's project page leads with the back button, not the drawer's hamburger")

        edgeSwipe(app)
        XCTAssertTrue(gone(header, timeout: 10), "the edge swipe popped the project's sessions page")
        XCTAssertTrue(listRow(app).waitForExistence(timeout: 10), "and landed back on the workspace's list")
        settle(1)
        shot("03-after-edge-swipe")
        tree(app, "after-edge-swipe-from-list-page")
    }

    func testTheDrawersProjectPageKeepsTheHamburgerAndTheEdgeOpensTheDrawer() {
        let app = launch()
        guard listRow(app).waitForExistence(timeout: 60) else {
            tree(app, "no-list-row-drawer-test")
            return XCTFail("the workspace list never showed the project row")
        }
        settle(1)
        app.buttons["Open navigation"].firstMatch.tap()
        let drawerRow = app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
        guard drawerRow.waitForExistence(timeout: 20) else {
            tree(app, "no-drawer-row")
            return XCTFail("the drawer never listed the open project")
        }
        settle(1)
        shot("04-drawer")
        drawerRow.tap()
        let header = pageHeader(app)
        guard header.waitForExistence(timeout: 20) else {
            tree(app, "no-page-after-drawer-row")
            return XCTFail("the drawer's project row did not open the project's sessions page")
        }
        settle(1.5)
        shot("05-page-opened-from-drawer")
        tree(app, "page-opened-from-drawer")
        XCTAssertTrue(app.buttons["Open navigation"].exists, "the drawer's project page leads with the hamburger")

        let before = header.frame.minX
        edgeSwipe(app)
        settle(1.5)
        shot("06-edge-swipe-on-drawer-page")
        XCTAssertTrue(header.exists, "the edge swipe did not pop the drawer's project page")
        note("header minX before \(before), after \(header.frame.minX)")
        XCTAssertGreaterThan(header.frame.minX, before + 100, "the edge swipe opened the drawer over it")
    }

    /// A member that lives in another workspace (orbit-macos), opened from the project's page that
    /// orbit-develop's list pushed: two back-swipes retrace the way in, to orbit-develop's list.
    func testBackFromAnotherWorkspacesMemberRetracesToTheEntryWorkspace() {
        let app = launch()
        let row = listRow(app)
        guard row.waitForExistence(timeout: 60) else {
            tree(app, "no-list-row-member-test")
            return XCTFail("the workspace list never showed the project row")
        }
        XCTAssertTrue(labelled(app, "A loose session").exists, "entered from orbit-develop's list")
        settle(1)
        row.tap()
        guard pageHeader(app).waitForExistence(timeout: 20) else {
            tree(app, "no-page-member-test")
            return XCTFail("the project row did not open the project's sessions page")
        }
        let member = labelled(app, "Member in orbit-macos")
        guard member.waitForExistence(timeout: 20) else {
            tree(app, "no-member-row")
            return XCTFail("the project's page never listed the orbit-macos member")
        }
        settle(1)
        member.tap()
        XCTAssertTrue(gone(pageHeader(app), timeout: 10), "the member's conversation is pushed over the project's page")
        settle(2)
        shot("07-member-from-other-workspace")
        tree(app, "member-console")

        edgeSwipe(app)
        XCTAssertTrue(pageHeader(app).waitForExistence(timeout: 10), "the first swipe returns to the project's page")
        settle(1.5)
        shot("08-back-on-project-page")
        edgeSwipe(app)
        XCTAssertTrue(gone(pageHeader(app), timeout: 10), "the second swipe leaves the project's page")
        XCTAssertTrue(labelled(app, "A loose session").waitForExistence(timeout: 10),
                      "and lands on orbit-develop's list, where the project's page was entered")
        XCTAssertFalse(labelled(app, "Loose session in orbit-macos").exists, "not on the member's workspace's list")
        settle(1)
        shot("09-back-on-entry-workspace")
        tree(app, "after-member-round-trip")
    }

    // MARK: helpers

    /// Anything whose label begins with these words — a row's combined label starts with its title.
    private func labelled(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", words)).firstMatch
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        return app
    }

    /// The workspace list's project row: its combined label starts with the title and goes on (the
    /// progress chip, the second line). The drawer's row is the title alone.
    private func listRow(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", title, title)).firstMatch
    }

    /// The project's sessions page's header: its title over "Project · <n> sessions".
    private func pageHeader(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Project · ")).firstMatch
    }

    /// A rightward drag from the screen's very left edge, the system back-swipe's start.
    private func edgeSwipe(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.55))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.55))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.05)
    }

    private func gone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !element.exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    private func describe(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        return "\(element.elementType.rawValue) label=\"\(element.label)\" id=\"\(element.identifier)\" "
            + "frame=\(element.frame) hittable=\(element.isHittable)"
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
        let attachment = XCTAttachment(data: XCUIScreen.main.screenshot().pngRepresentation,
                                       uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    private func write(_ text: String, _ file: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
