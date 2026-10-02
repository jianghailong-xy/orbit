import XCTest

// TEMPORARY evidence probe (see ../../README.md): photograph the Move panel's Move to Another
// Workspace (docs/session-folders-move-design.md §4, §5.2–5.4) — the workspaces a session can go to
// and the ones greyed with the server's reasons, the whole group greyed for a session that can't
// leave, a workspace's page with its folders, the two confirmations (End and Move, Move), End and
// Move's progress, the toast and the list without the row, New Folder… on a workspace's page, End
// and Move giving up on a session that never ends, and a move the server refuses. Soft failures:
// whatever cannot be found is noted next to the pictures and the run moves on. Each test resets the
// fixture API first.
final class WorkspaceMoveShotTests: XCTestCase {
    /// Idle, not ended, with three unmerged files: End and Move.
    private let idle = "审查导入逻辑避免侵入用户身份"
    /// Running: the whole group is greyed.
    private let running = "iOS 会话列表左滑按钮"
    /// Idle Codex session: the same runner only.
    private let codex = "发布 0.1.172"
    /// Idle, but its runner never ends it.
    private let stuck = "排查推送延迟"
    /// Completed, merged changes: Move.
    private let completed = "修复登录后的跳转"
    /// Completed; the workspace it is moved to was disabled meanwhile.
    private let refused = "整理设置页文案"
    private var notes: [String] = []

    private typealias Gesture = (name: String, perform: (XCUIElement) -> Void)

    private let gestures: [Gesture] = [
        ("drag-from-edge", { cell in
            let start = cell.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: -260, dy: 0)),
                        withVelocity: XCUIGestureVelocity(300), thenHoldForDuration: 0.4)
        }),
        ("drag-from-middle", { cell in
            let start = cell.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -240, dy: 0)),
                        withVelocity: .fast, thenHoldForDuration: 0.1)
        }),
        ("swipeLeft", { $0.swipeLeft() }),
    ]

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
    }

    // MARK: the flows

    /// End and Move, start to finish: the list, the panel's workspaces (open, offline, greyed), a
    /// workspace's page, the confirmation, the progress while the session ends, the toast, and the
    /// list without the row.
    func test1EndAndMove() {
        let app = launch(dark: true)
        shot("01-list-before")
        openPanel(app, idle, "02")
        workspaces(app, "02-panel-workspaces")
        open(app, "wikova-develop", "03-page-same-runner")
        option(app, "Bugs").tap(); settle()
        confirmation(app, "Move to wikova-develop?", "04-confirm-end-and-move")
        alertButton(app, "End and Move")
        let ending = app.staticTexts["Ending the session…"]
        if ending.waitForExistence(timeout: 5) { shot("05-ending-the-session") } else { note("no Ending… line") }
        toast(app, "Moved to wikova-develop", "06-toast-moved", wait: 20)
        settle(1)
        XCTAssertFalse(row(app, idle, quiet: true).exists, "the row left the list")
        note("the row is \(row(app, idle, quiet: true).exists ? "still" : "no longer") in the list")
        shot("07-list-after")
        app.terminate()
    }

    /// A running session can't leave: the whole group is greyed, with why under it.
    func test2RunningSessionGreysTheGroup() {
        let app = launch(dark: true)
        openPanel(app, running, "08")
        workspaces(app, "08-panel-session-cannot-move")
        let why = app.staticTexts["Stop the session first."]
        XCTAssertTrue(why.waitForExistence(timeout: 5), "the group says why")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "wikova-develop")).firstMatch.exists,
                       "no workspace opens")
        app.terminate()
    }

    /// A Codex session: only the same runner's workspace opens; the others say why not.
    func test3CodexSession() {
        let app = launch(dark: true)
        openPanel(app, codex, "09")
        workspaces(app, "09-panel-codex")
        app.terminate()
    }

    /// An ended session moves with Move: another runner's page says the conversation is rebuilt, and
    /// the confirmation says so; the Completed list loses the row.
    func test4CompletedMove() {
        let app = launch(dark: true)
        scope(app, "Completed")
        shot("10-completed-before")
        openPanel(app, completed, "11")
        workspaces(app, "11-panel-completed")
        open(app, "site", "12-page-other-runner")
        option(app, "No Folder").tap(); settle()
        confirmation(app, "Move to site?", "13-confirm-move")
        alertButton(app, "Move")
        toast(app, "Moved to site", "14-toast-moved-completed", wait: 15)
        settle(1)
        XCTAssertFalse(row(app, completed, quiet: true).exists, "the row left the Completed list")
        shot("15-completed-after")
        app.terminate()
    }

    /// New Folder… on a workspace's page: the folder is made there, and the confirmation names its
    /// workspace; cancelled, the page lists the new folder.
    func test5NewFolderThere() {
        let app = launch(dark: true)
        openPanel(app, idle, "16")
        workspaces(app, "16-panel")
        open(app, "wikova-develop", "16-page")
        option(app, "New Folder…").tap(); settle()
        enter(app, "Audit")
        shot("16-new-folder-name")
        alertButton(app, "Create")
        confirmation(app, "Move to wikova-develop?", "17-confirm-new-folder")
        alertButton(app, "Cancel")
        settle(1)
        shot("18-page-with-new-folder")
        app.terminate()
    }

    /// End and Move on a session whose runner never ends it: after the wait it gives up and says so.
    func test6EndAndMoveGivesUp() {
        let app = launch(dark: true)
        openPanel(app, stuck, "19")
        workspaces(app, "19-panel")
        open(app, "wikova-develop", "19-page")
        option(app, "No Folder").tap(); settle()
        confirmation(app, "Move to wikova-develop?", "19-confirm")
        alertButton(app, "End and Move")
        if app.staticTexts["Ending the session…"].waitForExistence(timeout: 5) { shot("19-ending") }
        let failed = app.alerts["Couldn’t Move Session"]
        if !failed.waitForExistence(timeout: 100) {
            note("no failure alert after the wait")
            write(app.debugDescription, "missing-timeout-alert.txt")
        }
        XCTAssertTrue(failed.exists, "End and Move gives up and says so")
        settle(0.6)
        shot("20-end-and-move-gave-up")
        note("failure alert: \(failed.staticTexts.allElementsBoundByIndex.map(\.label))")
        alertButton(app, "OK")
        settle(2)
        shot("21-page-after-giving-up")
        app.terminate()
    }

    /// A move the server refuses — the workspace was disabled after the panel was drawn — says the
    /// server's reason, and the panel then greys that workspace.
    func test7RefusedMove() {
        let app = launch(dark: true)
        scope(app, "Completed")
        openPanel(app, refused, "22")
        workspaces(app, "22-panel")
        open(app, "site", "22-page")
        option(app, "No Folder").tap(); settle()
        confirmation(app, "Move to site?", "22-confirm")
        alertButton(app, "Move")
        let failed = app.alerts["Couldn’t Move Session"]
        XCTAssertTrue(failed.waitForExistence(timeout: 15), "the refusal is said")
        settle(0.6)
        shot("23-move-refused")
        note("refusal alert: \(failed.staticTexts.allElementsBoundByIndex.map(\.label))")
        alertButton(app, "OK")
        settle(2)
        shot("24-page-after-refusal")
        goBack(app, from: "site")
        settle(2)
        workspaces(app, "25-panel-after-refusal")
        app.terminate()
    }

    /// The panel in light mode.
    func test8Light() {
        let app = launch(dark: false)
        openPanel(app, idle, "26")
        workspaces(app, "26-panel-light")
        open(app, "wikova-develop", "27-page-light")
        option(app, "Infra").tap(); settle()
        confirmation(app, "Move to wikova-develop?", "28-confirm-light")
        alertButton(app, "Cancel")
        app.terminate()
    }

    // MARK: helpers

    private func launch(dark: Bool) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765"] + (dark ? ["-dark"] : [])
        app.launch()
        if !row(app, idle, quiet: true).waitForExistence(timeout: 60) {
            note("the list never appeared")
            write(app.debugDescription, "missing-list.txt")
        }
        settle(1.5)
        return app
    }

    /// Swipe the row open and tap its Move.
    private func openPanel(_ app: XCUIApplication, _ title: String, _ name: String) {
        for gesture in gestures {
            gesture.perform(row(app, title))
            settle(1.2)
            if app.buttons["Move"].exists {
                note("\(name): opened by \(gesture.name)")
                break
            }
            note("\(name): \(gesture.name) left it shut")
        }
        tap(app, "Move")
        let title = app.navigationBars["Move"]
        if !title.waitForExistence(timeout: 10) {
            note("\(name): no Move panel")
            write(app.debugDescription, "missing-panel-\(name).txt")
        }
    }

    /// The panel's second group, once the server's answer is in: the sheet pulled up to its large
    /// detent so the whole group shows, then photographed, with the rows' labels noted.
    private func workspaces(_ app: XCUIApplication, _ name: String) {
        let header = app.staticTexts["Move to Another Workspace"]
        if !header.waitForExistence(timeout: 15) { note("\(name): no Move to Another Workspace") }
        let bar = app.navigationBars["Move"]
        if bar.exists {
            let grab = bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            grab.press(forDuration: 0.1, thenDragTo: grab.withOffset(CGVector(dx: 0, dy: -500)),
                       withVelocity: XCUIGestureVelocity(600), thenHoldForDuration: 0.3)
        }
        settle(1.5)
        shot(name)
        write(app.debugDescription, "tree-\(name).txt")
        // One query per name: walking every element of the tree for its label took minutes a call.
        let names = ["wikova-develop", "site", "wikids", "docs", "archive"]
        let opens = names.map { workspace in
            "\(workspace): \(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", workspace)).count > 0 ? "opens" : "greyed")"
        }
        note("\(name) rows: \(opens.joined(separator: " | "))")
    }

    /// Open a workspace's page from the panel's second group.
    /// A tap that doesn't open the page (round 2 lost one) is tapped again once.
    private func open(_ app: XCUIApplication, _ workspace: String, _ name: String) {
        let bar = app.navigationBars[workspace]
        for attempt in 1...2 {
            option(app, workspace).tap()
            if bar.waitForExistence(timeout: 6) { break }
            note("\(name): tap \(attempt) on \(workspace) opened no page")
        }
        if !bar.exists {
            note("\(name): no page for \(workspace)")
            write(app.debugDescription, "missing-page-\(name).txt")
        }
        settle(1.2)
        shot(name)
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func confirmation(_ app: XCUIApplication, _ title: String, _ name: String) {
        let alert = app.alerts[title]
        if !alert.waitForExistence(timeout: 10) {
            note("\(name): no alert \(title)")
            write(app.debugDescription, "missing-\(name).txt")
        }
        XCTAssertTrue(alert.exists, "\(name): \(title)")
        settle(0.8)
        shot(name)
        note("\(name): \(alert.staticTexts.allElementsBoundByIndex.map(\.label)) buttons: \(alert.buttons.allElementsBoundByIndex.map(\.label))")
    }

    /// Put the fixture API back as it starts, asked up to three times.
    private func resetStub() {
        for attempt in 1...3 {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__reset")!)
            request.httpMethod = "POST"
            request.timeoutInterval = 10
            let answered = DispatchSemaphore(value: 0)
            let status = StatusBox()
            URLSession.shared.dataTask(with: request) { _, response, _ in
                status.code = (response as? HTTPURLResponse)?.statusCode
                answered.signal()
            }.resume()
            _ = answered.wait(timeout: .now() + 15)
            if status.code == 200 { return }
            note("reset \(attempt): \(status.code.map(String.init) ?? "no answer")")
        }
    }

    private final class StatusBox: @unchecked Sendable {
        var code: Int?
    }

    /// The hittable button whose label starts with `name` — the panel's or page's row, not the list's.
    private func option(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name))
        guard query.firstMatch.waitForExistence(timeout: 5) else {
            note("no button starting \(name)")
            return query.firstMatch
        }
        let matches = query.allElementsBoundByIndex
        return matches.first(where: { $0.isHittable }) ?? matches.first ?? query.firstMatch
    }

    /// Back from a workspace's page to the panel: the page's own navigation bar's back button.
    private func goBack(_ app: XCUIApplication, from page: String) {
        let button = app.navigationBars[page].buttons.firstMatch
        if button.waitForExistence(timeout: 10) { button.tap() } else { note("no back button") }
        settle()
    }

    /// The toast: wait for it, photograph it at once.
    private func toast(_ app: XCUIApplication, _ text: String, _ name: String, wait: TimeInterval) {
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        if !card.waitForExistence(timeout: wait) {
            note("\(name): no toast saying \(text)")
            write(app.debugDescription, "missing-\(name).txt")
        }
        XCTAssertTrue(card.exists, "the toast says \(text)")
        settle(0.4)
        shot(name)
    }

    private func enter(_ app: XCUIApplication, _ text: String) {
        let alert = app.alerts.firstMatch
        if !alert.waitForExistence(timeout: 5) {
            note("no prompt to type \(text) into")
            return
        }
        let field = alert.textFields.firstMatch
        field.tap()
        let tip = app.buttons["Continue"]
        if tip.waitForExistence(timeout: 2) { tip.tap(); settle(0.5) }
        field.typeText(text)
        settle(0.8)
    }

    private func alertButton(_ app: XCUIApplication, _ label: String) {
        let button = app.alerts.firstMatch.buttons[label]
        guard button.waitForExistence(timeout: 5) else {
            note("no \(label) in the alert")
            write(app.debugDescription, "missing-alert-\(label).txt")
            return
        }
        button.tap()
        settle(0.3)
    }

    /// Switch the list's tab from the compact list's options menu.
    private func scope(_ app: XCUIApplication, _ title: String) {
        let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Session scope")).firstMatch
        guard menu.waitForExistence(timeout: 5) else {
            note("no scope menu")
            write(app.debugDescription, "missing-scope.txt")
            return
        }
        menu.tap(); settle()
        tap(app, title)
        settle(2)
    }

    private func row(_ app: XCUIApplication, _ title: String, quiet: Bool = false) -> XCUIElement {
        let cell = app.cells.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        if cell.exists || quiet { return cell }
        note("no cell for \(title); using its button")
        return app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    private func tap(_ app: XCUIApplication, _ label: String) {
        let button = app.buttons[label]
        guard button.waitForExistence(timeout: 5) else {
            note("no \(label) button to tap")
            write(app.debugDescription, "missing-\(label).txt")
            return
        }
        button.tap()
        settle()
    }

    private func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func note(_ line: String) {
        notes.append(line)
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
