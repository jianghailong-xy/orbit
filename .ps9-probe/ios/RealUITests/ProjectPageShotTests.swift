import XCTest

// TEMPORARY evidence probe (see ../../README.md): the REAL Orbit iOS app — its own `@main`, sign-in,
// drawer, project list and project page, with nothing copied or re-drawn — signed in to the stub on
// 127.0.0.1:8787 (../../stub.py). These tests walk the project list and the project page the way an
// owner would and photograph each state task ⑨ adds; every write a press makes is recorded by the
// stub in writes.jsonl beside the pictures.
final class ProjectPageShotTests: XCTestCase {
    private let instance = "http://127.0.0.1:8787"

    private let ready = "Runner 页整页改版（iOS/macOS + web）"
    private let own = "Team 功能：个人 Team 当 owner"
    private let run = "Automatic 项目里由协调者判任务完成"
    private let paused = "iOS 设置 sheet 改版"

    override func setUp() {
        continueAfterFailure = true
    }

    private var shotsDir: String? { ProcessInfo.processInfo.environment["SHOTS_DIR"] }

    private func note(_ line: String) {
        print("PROBE: \(line)")
        guard let dir = shotsDir else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("report.txt")
        let text = line + "\n"
        if let fh = try? FileHandle(forWritingTo: url) {
            fh.seekToEndOfFile()
            fh.write(Data(text.utf8))
            try? fh.close()
        } else {
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    private func shoot(_ name: String, settle: TimeInterval = 1.2) {
        Thread.sleep(forTimeInterval: settle)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = shotsDir else { return }
        do {
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
            note("capture \(name)")
        } catch {
            note("could not write \(name): \(error)")
        }
    }

    private func missing(_ what: String, _ app: XCUIApplication) {
        note("MISSING \(what)")
        if let dir = shotsDir {
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    /// Every text on screen, for the report: what the page said, beside the picture of it.
    /// Read from one snapshot of the tree: resolving elements one index at a time races a screen
    /// that is still drawing (the conversation, as it loads), and fails the test over a report line.
    private func texts(_ label: String, _ app: XCUIApplication) {
        guard let root = try? app.snapshot() else {
            note("TEXTS \(label): (no snapshot)")
            return
        }
        var all: [String] = []
        func walk(_ node: XCUIElementSnapshot) {
            if node.elementType == .staticText, !node.label.isEmpty { all.append(node.label) }
            node.children.forEach(walk)
        }
        walk(root)
        note("TEXTS \(label): " + all.prefix(80).joined(separator: " ¦ "))
    }

    private func allowNotifications() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<6 {
            let allow = springboard.buttons["Allow"]
            if allow.waitForExistence(timeout: 4) {
                allow.tap()
                note("notification permission: allowed")
                return
            }
        }
        note("notification permission: no alert seen")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", instance]
        app.launchEnvironment["TZ"] = "Europe/Berlin"
        app.launch()
        allowNotifications()
        return app
    }

    /// The real sign-in screen, pointed at the stub; a second pass on the same simulator finds the
    /// session the first one left in the Keychain and starts signed in.
    private func signIn(_ app: XCUIApplication) {
        let email = app.textFields["Email"]
        guard email.waitForExistence(timeout: 30) else {
            note("sign-in: no sign-in screen (already signed in)")
            return
        }
        let instanceField = app.textFields["Instance URL (e.g. orbit.example.com)"]
        if instanceField.waitForExistence(timeout: 5), (instanceField.value as? String ?? "").isEmpty {
            instanceField.tap()
            instanceField.typeText(instance)
        }
        email.tap()
        email.typeText("wikova@example.com")
        let password = app.secureTextFields["Password"]
        if password.waitForExistence(timeout: 5) {
            password.tap()
            password.typeText("probe-password")
        }
        app.buttons["Sign in"].tap()
    }

    private func button(_ app: XCUIApplication, beginsWith prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func button(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// The drawer's Projects row, then the index.
    private func openProjects(_ app: XCUIApplication) -> Bool {
        let drawer = app.buttons["Open navigation"]
        guard drawer.waitForExistence(timeout: 40) else {
            missing("drawer-button", app)
            return false
        }
        drawer.tap()
        let projects = button(app, beginsWith: "Projects")
        guard projects.waitForExistence(timeout: 10) else {
            missing("drawer-projects-row", app)
            return false
        }
        // The drawer slides in: its rows exist before they can be pressed.
        for attempt in 0..<16 where !projects.isHittable {
            if attempt == 8 { drawer.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        note("drawer projects row: \(projects.label)")
        shoot("00-drawer-projects-count", settle: 1.5)
        projects.tap()
        let header = app.staticTexts["Needs attention"]
        if !header.waitForExistence(timeout: 20) { missing("list-needs-attention", app) }
        return true
    }

    /// The index's row for `title` — the one on screen: the drawer, closed, holds a row with the same
    /// title that is not hittable.
    private func openProject(_ app: XCUIApplication, _ title: String) -> Bool {
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title))
        guard rows.firstMatch.waitForExistence(timeout: 20) else {
            missing("row-\(title.prefix(8))", app)
            return false
        }
        for _ in 0..<10 {
            if let row = rows.allElementsBoundByIndex.first(where: { $0.isHittable }) {
                note("row: \(row.label)")
                row.tap()
                return true
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        missing("row-hittable-\(title.prefix(8))", app)
        return false
    }

    private func back(_ app: XCUIApplication) {
        let bar = app.navigationBars.firstMatch
        let first = bar.buttons.element(boundBy: 0)
        if first.waitForExistence(timeout: 5) { first.tap() } else { missing("back", app) }
        Thread.sleep(forTimeInterval: 1.0)
    }

    /// Scroll the page until `label` is on screen, then drag it to just under the bar, so the block
    /// it heads is photographed from its head down.
    private func scroll(_ app: XCUIApplication, to label: String, limit: Int = 10) -> Bool {
        let list = app.collectionViews.firstMatch
        let target = app.staticTexts[label]
        for _ in 0..<limit {
            if target.exists, target.isHittable { break }
            list.swipeUp(velocity: .slow)
        }
        guard target.exists else {
            missing("scroll-\(label)", app)
            return false
        }
        let from = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.0)).withOffset(CGVector(dx: 0, dy: 150))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
        Thread.sleep(forTimeInterval: 0.8)
        return true
    }

    /// Drag `element` to `y` points from the top of the screen: the page's bar is translucent and
    /// a press on a row under it lands on the bar.
    private func bring(_ app: XCUIApplication, _ element: XCUIElement, toY y: CGFloat) {
        guard element.exists else { return }
        // Never start a drag at an edge: from the bottom band a drag up is the system's own gesture
        // (it opened the app switcher, 2026-09-30), from the top one it is the bar's or the status
        // bar's. The list's own swipes start in its middle.
        let list = app.collectionViews.firstMatch
        for _ in 0..<4 where element.frame.midY > app.frame.height * 0.78 {
            list.swipeUp(velocity: .slow)
            Thread.sleep(forTimeInterval: 0.6)
        }
        for _ in 0..<4 where element.frame.midY < 150 {
            list.swipeDown(velocity: .slow)
            Thread.sleep(forTimeInterval: 0.6)
        }
        let from = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.0)).withOffset(CGVector(dx: 0, dy: y))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
        Thread.sleep(forTimeInterval: 0.8)
    }

    // MARK: the tests

    func test1ListAndTheStartRows() {
        let app = launch()
        signIn(app)
        guard openProjects(app) else { return }
        texts("list", app)
        shoot("01-list-needs-you-ready-to-start")

        // A project whose coordinator asked: Not started, the line the start decides, and Start this
        // project? leading Needs you.
        guard openProject(app, ready) else { return }
        if !app.staticTexts["Not started"].waitForExistence(timeout: 20) { missing("ready-not-started", app) }
        texts("ready", app)
        shoot("02-ready-not-started-open-items")
        _ = scroll(app, to: "Work overview", limit: 4)
        texts("ready-overview", app)
        shoot("03-ready-work-overview-starts-when-you-start")
        back(app)

        // A project nobody asked about: the owner's own Start…, opening the start card over the page.
        guard openProject(app, own) else { return }
        if !app.staticTexts["Not started"].waitForExistence(timeout: 20) { missing("own-not-started", app) }
        texts("own", app)
        shoot("04-own-start-row-not-asked-yet")
        let start = button(app, beginsWith: "Start…")
        if start.waitForExistence(timeout: 10) {
            start.tap()
            if !app.staticTexts["Start this project?"].waitForExistence(timeout: 20) { missing("own-start-card", app) }
            texts("own-start-card", app)
            shoot("05-own-start-card-sheet", settle: 2.0)
            let sheet = app.scrollViews.firstMatch
            sheet.swipeUp(velocity: .slow)
            texts("own-start-card-2", app)
            shoot("06-own-start-card-sheet-how-it-runs")
            sheet.swipeUp(velocity: .slow)
            shoot("07-own-start-card-sheet-bottom")
            let cancel = app.buttons["Cancel"]
            if cancel.exists { cancel.tap() } else { missing("own-start-cancel", app) }
            Thread.sleep(forTimeInterval: 1.0)
        } else {
            missing("own-start-row", app)
        }
        back(app)
    }

    func test2HowItRuns() {
        let app = launch()
        signIn(app)
        guard openProjects(app) else { return }

        // Started, integrating since 2h ago: the line locked, with the reason.
        guard openProject(app, run) else { return }
        if scroll(app, to: "How it runs") {
            texts("run-how-it-runs", app)
            shoot("08-run-how-it-runs-locked")
            bring(app, app.staticTexts["Escalate after"], toY: 420)
            shoot("09-run-how-it-runs-lower")
        }
        let escalate = button(app, beginsWith: "Escalate after")
        if escalate.waitForExistence(timeout: 5) {
            bring(app, app.staticTexts["Escalate after"], toY: 420)
            note("escalate button: \(escalate.label)")
            escalate.tap()
            let four = app.buttons["4 hours"]
            if four.waitForExistence(timeout: 8) {
                shoot("10-run-escalate-after-menu", settle: 3.0)
                four.tap()
                shoot("11-run-escalate-after-4-hours", settle: 2.5)
            } else {
                missing("escalate-4-hours", app)
            }
        } else {
            missing("escalate-button", app)
        }
        let check = button(app, beginsWith: "Merge check")
        if check.waitForExistence(timeout: 5) {
            bring(app, check, toY: 420)
            check.tap()
            shoot("12-run-merge-check-editor", settle: 2.0)
            let cancel = app.buttons["Cancel"]
            if cancel.exists { cancel.tap() }
            Thread.sleep(forTimeInterval: 1.0)
        } else {
            missing("merge-check-row", app)
        }
        back(app)

        // Started, nothing landed, paused: the line still open, the merge check amber, Resume.
        guard openProject(app, paused) else { return }
        if scroll(app, to: "How it runs") {
            texts("paused-how-it-runs", app)
            shoot("13-paused-how-it-runs-line-open")
        }
        let resume = app.buttons["Resume project"]
        if resume.waitForExistence(timeout: 5) {
            bring(app, resume, toY: 560)
            texts("paused-how-it-runs-lower", app)
            shoot("14-paused-merge-check-amber-resume")
            // Settled first: a press on a list still decelerating from the drag only stops it.
            Thread.sleep(forTimeInterval: 1.5)
            resume.tap()
            if !app.buttons["Pause project"].waitForExistence(timeout: 8) {
                note("resume: the first press did not take; pressing again")
                app.buttons["Resume project"].tap()
                if !app.buttons["Pause project"].waitForExistence(timeout: 10) { missing("pause-after-resume", app) }
            }
            shoot("15-paused-after-resume", settle: 2.0)
        } else {
            missing("resume-button", app)
        }
        // Automatic off, then one more at a time: two writes, each at its own door.
        let automatic = app.switches["Automatic"]
        if automatic.waitForExistence(timeout: 5) {
            bring(app, app.staticTexts["Automatic"], toY: 260)
            let before = automatic.value as? String
            automatic.tap()
            Thread.sleep(forTimeInterval: 2.5)
            var after = automatic.value as? String
            if after == before, automatic.isHittable {
                automatic.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5)).tap()
                Thread.sleep(forTimeInterval: 2.5)
                after = automatic.value as? String
            }
            note("automatic switch: \(before ?? "?") -> \(after ?? "?")")
        } else {
            missing("automatic-switch", app)
        }
        let increment = app.steppers.firstMatch.buttons.element(boundBy: 1)
        if increment.waitForExistence(timeout: 5) {
            increment.tap()
            Thread.sleep(forTimeInterval: 2.5)
        } else {
            missing("stepper", app)
        }
        bring(app, app.staticTexts["Automatic"], toY: 260)
        texts("paused-after-writes", app)
        shoot("16-paused-automatic-off-at-most-3", settle: 2.0)
        back(app)
    }

    func test3ReviewLandsOnTheStartCard() {
        let app = launch()
        signIn(app)
        guard openProjects(app) else { return }
        guard openProject(app, ready) else { return }
        let review = app.buttons["Review"]
        guard review.waitForExistence(timeout: 20) else {
            missing("review-button", app)
            return
        }
        review.tap()
        if !app.buttons["Start the project"].waitForExistence(timeout: 40) {
            missing("console-start-card", app)
        }
        texts("review-console", app)
        shoot("17-review-lands-on-the-start-card", settle: 3.0)
        // Back up the conversation to the card's head: the question, who asked, and the seal.
        let head = app.staticTexts["Start this project?"]
        for _ in 0..<3 where !(head.exists && head.isHittable && head.frame.minY > 200) {
            app.swipeDown(velocity: .slow)
            Thread.sleep(forTimeInterval: 0.8)
        }
        shoot("18-review-start-card-head", settle: 1.5)
    }
}
