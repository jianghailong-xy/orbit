import XCTest

// TEMPORARY evidence probe (see ../../README.md): the REAL Orbit iOS app — its own `@main`, sign-in,
// session list, drawer, project list, project page and coordinator conversation, with nothing copied
// or re-drawn — signed in to the stub on 127.0.0.1:8787 (../../stub.py). These tests walk what task ⑥
// adds the way an owner would and photograph each state; every write a press makes is recorded by
// the stub in writes.jsonl beside the pictures.
final class DoneShotTests: XCTestCase {
    private let instance = "http://127.0.0.1:8787"

    private let asked = "项目启动重做"
    private let working = "Runner 页整页改版"
    private let landing = "Automatic 项目里由协调者判任务完成"
    private let doneTitle = "项目进度改版"
    private let orbitTitle = "iOS 设置 sheet 改版"

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

    private func shoot(_ name: String, settle: TimeInterval = 1.5) {
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

    /// Every text on screen, for the report — read from one snapshot of the tree.
    private func texts(_ label: String, _ app: XCUIApplication) {
        guard let root = try? app.snapshot() else {
            note("TEXTS \(label): (no snapshot)")
            return
        }
        var all: [String] = []
        func walk(_ node: XCUIElementSnapshot) {
            if node.elementType == .staticText || node.elementType == .button, !node.label.isEmpty {
                all.append(node.label)
            }
            node.children.forEach(walk)
        }
        walk(root)
        note("TEXTS \(label): " + all.prefix(120).joined(separator: " ¦ "))
    }

    /// The stub back to its first state: every walk starts from the request still open.
    private func reset() {
        var request = URLRequest(url: URL(string: "\(instance)/api/__probe/reset")!)
        request.httpMethod = "POST"
        let done = expectation(description: "reset")
        URLSession.shared.dataTask(with: request) { _, _, error in
            if let error { print("PROBE: reset failed: \(error)") }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
    }

    private func allowNotifications() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<4 {
            let allow = springboard.buttons["Allow"]
            if allow.waitForExistence(timeout: 3) {
                allow.tap()
                note("notification permission: allowed")
                return
            }
        }
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", instance]
        app.launchEnvironment["TZ"] = "Europe/Berlin"
        app.launch()
        allowNotifications()
        return app
    }

    /// The login page as fdeb033ad drew it: Email, Password and Sign In, with the server off the page
    /// (it is the launch argument's `-orbit.instance`, which the app restores at launch). The email
    /// field carries a prompt, so it is found as the page's only text field, not by its label.
    private func signIn(_ app: XCUIApplication) {
        let welcome = app.staticTexts["Welcome back"]
        guard welcome.waitForExistence(timeout: 30) else {
            note("sign-in: already signed in")
            return
        }
        let email = app.textFields.firstMatch
        if email.waitForExistence(timeout: 5) {
            email.tap()
            email.typeText("wikova@example.com")
        } else {
            missing("sign-in-email", app)
        }
        let password = app.secureTextFields.firstMatch
        if password.waitForExistence(timeout: 5) {
            password.tap()
            password.typeText("probe-password")
        } else {
            missing("sign-in-password", app)
        }
        let submit = app.buttons["Sign In"]
        if submit.waitForExistence(timeout: 5) { submit.tap() } else { missing("sign-in-button", app) }
        note("sign-in: submitted")
    }

    private func button(_ app: XCUIApplication, beginsWith prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func hittable(_ query: XCUIElementQuery, _ what: String, _ app: XCUIApplication,
                          timeout: TimeInterval = 20) -> XCUIElement? {
        guard query.firstMatch.waitForExistence(timeout: timeout) else {
            missing(what, app)
            return nil
        }
        for _ in 0..<12 {
            if let element = query.allElementsBoundByIndex.first(where: { $0.isHittable }) { return element }
            Thread.sleep(forTimeInterval: 0.5)
        }
        missing("\(what)-hittable", app)
        return nil
    }

    private func containing(_ app: XCUIApplication, _ text: String) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", text))
    }

    /// The workspace's session list is where the app lands; open the conversation named `title`.
    /// Since main grouped the list by project, a coordinator conversation's row opens its project's
    /// own page first ("Project · 1 sessions", then a Coordinator section): the conversation is the
    /// row there that names the project and its Coordinator role.
    private func openSession(_ app: XCUIApplication, _ title: String) -> Bool {
        let groupPage = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", " sessions")).firstMatch
        let conversation = app.buttons["Session actions"]
        for attempt in 0..<3 {
            guard let row = hittable(containing(app, title), "session-\(title.prefix(6))", app, timeout: 40) else {
                return false
            }
            note("session row (try \(attempt + 1)): \(row.label)")
            row.tap()
            if groupPage.waitForExistence(timeout: 6) {
                // The row reads "<project>, 5m ago, Project coordinator, <last words>".
                let inner = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS[c] %@",
                                                             title, "project coordinator"))
                guard let session = hittable(inner, "coordinator-row-\(title.prefix(6))", app, timeout: 15) else {
                    return false
                }
                note("coordinator row: \(session.label)")
                session.tap()
                return true
            }
            if conversation.exists { return true }
            // Still on the list: the tap was swallowed while the list settled. Try again.
        }
        missing("open-\(title.prefix(6))", app)
        return false
    }

    /// A fresh launch on the session list — signed in still, the token kept in the Keychain — for a
    /// walk that opens a second conversation.
    private func relaunch(_ app: XCUIApplication) -> XCUIApplication {
        app.terminate()
        let fresh = launch()
        signIn(fresh)
        return fresh
    }

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
        for attempt in 0..<16 where !projects.isHittable {
            if attempt == 8 { drawer.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        projects.tap()
        if !app.staticTexts["Projects"].waitForExistence(timeout: 20) { missing("projects-title", app) }
        Thread.sleep(forTimeInterval: 2.0)
        return true
    }

    private func openProject(_ app: XCUIApplication, _ title: String) -> Bool {
        guard let row = hittable(containing(app, title), "project-\(title.prefix(6))", app) else { return false }
        note("project row: \(row.label)")
        row.tap()
        return true
    }

    private func back(_ app: XCUIApplication) {
        let first = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
        if first.waitForExistence(timeout: 5) { first.tap() } else { missing("back", app) }
        Thread.sleep(forTimeInterval: 1.0)
    }

    private func swipeSheet(_ app: XCUIApplication) {
        let scroll = app.scrollViews.allElementsBoundByIndex.last ?? app.scrollViews.firstMatch
        scroll.swipeUp(velocity: .slow)
        Thread.sleep(forTimeInterval: 0.8)
    }

    // MARK: the walks

    /// Drag the transcript by `dy` points — negative reads further down — held at the end so it does
    /// not coast past where it was taken. From the left quarter: the jump-to-latest disc floats at the
    /// bottom centre, and a press that starts on it is the disc's, not the list's.
    private func drag(_ app: XCUIApplication, by dy: CGFloat) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: dy < 0 ? 0.72 : 0.3))
        let end = start.withOffset(CGVector(dx: 0, dy: dy))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.4)
        Thread.sleep(forTimeInterval: 0.8)
    }

    /// Scroll until `element`'s top sits just under the navigation bar and the conversation's two
    /// pinned strips (the open-question bar and the sticky question) below it.
    private func bringToTop(_ element: XCUIElement, _ app: XCUIApplication, top: CGFloat = 205) {
        for _ in 0..<10 {
            guard element.exists else { return }
            let y = element.frame.minY
            note("bringToTop \(element.label.prefix(24)): y=\(Int(y))")
            if abs(y - top) < 30 { return }
            drag(app, by: max(-420, min(420, top - y)))
        }
    }

    /// A button inside the card, not the navigation bar's namesake above it.
    private func cardButton(_ label: String, _ app: XCUIApplication, timeout: TimeInterval = 10) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label == %@", label))
        guard query.firstMatch.waitForExistence(timeout: timeout) else {
            missing("card-\(label)", app)
            return nil
        }
        for _ in 0..<12 {
            if let element = query.allElementsBoundByIndex.first(where: { $0.isHittable && $0.frame.minY > 110 }) {
                return element
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        missing("card-\(label)-hittable", app)
        return nil
    }

    /// The coordinator conversation: its row says Ready to close, and the card is drawn WHOLE in the
    /// transcript where it arrived (mock ⑤ ②, the phone's long screenshot) — photographed top to
    /// bottom as the reader scrolls it. Not yet… asks what is missing in place, Back returns, and
    /// Record as done leaves the receipt in place of the card.
    func test1TheConversationsCard() {
        reset()
        let app = launch()
        signIn(app)
        if !containing(app, asked).firstMatch.waitForExistence(timeout: 40) { missing("session-list", app) }
        texts("session-list", app)
        shoot("01-session-list-ready-to-close", settle: 2.5)

        guard openSession(app, asked) else { return }
        let heading = app.staticTexts["Is this project done?"]
        if !heading.waitForExistence(timeout: 40) { missing("done-card-inline", app) }
        Thread.sleep(forTimeInterval: 3.0)
        texts("conversation-landed", app)
        shoot("02-conversation-as-it-opens", settle: 1.0)

        bringToTop(heading, app)
        texts("card-top", app)
        shoot("03-card-top-coordinators-call", settle: 1.0)
        drag(app, by: -300)
        note("after drag 1: heading y=\(Int(heading.frame.minY))")
        texts("card-middle", app)
        shoot("04-card-what-orbit-cant-prove", settle: 1.0)
        drag(app, by: -300)
        note("after drag 2: heading y=\(Int(heading.frame.minY))")
        texts("card-bottom", app)
        shoot("05-card-orbit-checked-and-answers", settle: 1.0)

        if let notYet = cardButton("Not yet…", app) {
            notYet.tap()
            let field = app.textFields["What’s missing before it’s done?"]
            if field.waitForExistence(timeout: 5) {
                Thread.sleep(forTimeInterval: 1.0)
                drag(app, by: -200)
                texts("not-yet", app)
                shoot("06-card-not-yet-asks-whats-missing", settle: 1.0)
            } else {
                missing("not-yet-field", app)
            }
            if let back = cardButton("Back", app, timeout: 5) {
                back.tap()
                Thread.sleep(forTimeInterval: 1.0)
            }
        }

        if let record = cardButton("Record as done", app, timeout: 5) {
            record.tap()
            let receipt = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@",
                                                               "You recorded this project done")).firstMatch
            if !receipt.waitForExistence(timeout: 20) { missing("receipt-in-place", app) }
            Thread.sleep(forTimeInterval: 2.0)
            let done = app.staticTexts["This project is done"]
            if done.exists { bringToTop(done, app, top: 260) }
            texts("conversation-receipt", app)
            shoot("07-conversation-receipt-in-place", settle: 1.5)
        }
    }

    /// Record as done straight from the card as the conversation opens — no scrolling, no Not yet… —
    /// to tell the press itself from the steps walked before it in `test1`.
    func test1bRecordStraightAway() {
        reset()
        let app = launch()
        signIn(app)
        guard openSession(app, asked) else { return }
        if !app.staticTexts["Is this project done?"].waitForExistence(timeout: 40) { missing("done-card-inline-b", app) }
        Thread.sleep(forTimeInterval: 3.0)
        guard let record = cardButton("Record as done", app) else { return }
        record.tap()
        let receipt = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@",
                                                           "You recorded this project done")).firstMatch
        if !receipt.waitForExistence(timeout: 20) { missing("receipt-b", app) }
        texts("receipt-b", app)
        shoot("08-receipt-after-straight-record", settle: 1.5)
    }

    /// The project page: Ready to close beside the status, the request's row in Open items, Review
    /// opening the same card over the page, and who recorded it afterwards — plus the projects list's
    /// own words for done projects, and the owner's own Record as done… on a project nobody asked
    /// about.
    func test2TheProjectPage() {
        reset()
        let app = launch()
        signIn(app)
        guard openProjects(app) else { return }
        texts("list", app)
        shoot("10-projects-list")
        let show = app.buttons["Show"]
        if show.waitForExistence(timeout: 5) {
            show.tap()
            Thread.sleep(forTimeInterval: 1.0)
            app.collectionViews.firstMatch.swipeUp(velocity: .slow)
            texts("list-completed", app)
            shoot("11-projects-list-completed-who-recorded-it")
            app.collectionViews.firstMatch.swipeDown(velocity: .slow)
        } else {
            missing("list-show-completed", app)
        }

        guard openProject(app, asked) else { return }
        if !app.staticTexts["Ready to close"].waitForExistence(timeout: 20) { missing("page-ready-to-close", app) }
        texts("page", app)
        shoot("12-project-page-ready-to-close", settle: 2.0)

        guard let needs = hittable(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "needs you")),
                                   "page-needs-you", app) else { return }
        needs.tap()
        if !app.staticTexts["Is this project done?"].waitForExistence(timeout: 15) { missing("open-items-done-row", app) }
        texts("open-items", app)
        shoot("13-open-items-ready-to-close-row", settle: 2.0)

        let review = app.buttons["Review"]
        guard review.waitForExistence(timeout: 10) else {
            missing("open-items-review", app)
            return
        }
        review.tap()
        if !app.buttons["Record as done"].waitForExistence(timeout: 20) { missing("page-card-record", app) }
        texts("page-card", app)
        shoot("14-page-done-card", settle: 2.0)
        swipeSheet(app)
        shoot("15-page-done-card-gaps")
        swipeSheet(app)
        shoot("16-page-done-card-answers")
        let record = app.buttons["Record as done"]
        if record.waitForExistence(timeout: 5) {
            record.tap()
            if !app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "You recorded this project done"))
                .firstMatch.waitForExistence(timeout: 20) {
                missing("page-receipt", app)
            }
            texts("page-receipt", app)
            shoot("17-page-done-card-receipt", settle: 2.0)
        }
        let done = app.buttons["Done"]
        if done.waitForExistence(timeout: 5) { done.tap() } else { missing("page-card-done", app) }
        Thread.sleep(forTimeInterval: 2.0)
        texts("page-after", app)
        shoot("18-project-page-recorded-by-you", settle: 2.0)
        back(app)

        // Nobody asked: the owner's own Record as done… in Open items, opening the same card.
        guard openProject(app, working) else { return }
        let items = app.buttons["Open items"]
        if items.waitForExistence(timeout: 15) {
            items.tap()
            if !app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Record as done…"))
                .firstMatch.waitForExistence(timeout: 10) {
                missing("own-done-row", app)
            }
            texts("own-open-items", app)
            shoot("19-open-items-own-record-as-done", settle: 2.0)
            let own = button(app, beginsWith: "Record as done…")
            if own.exists {
                own.tap()
                if !app.staticTexts["Is this project done?"].waitForExistence(timeout: 15) { missing("own-card", app) }
                texts("own-card", app)
                shoot("20-own-done-card-orbit-fills-in", settle: 2.0)
                swipeSheet(app)
                shoot("21-own-done-card-answers")
                let cancel = app.buttons["Cancel"]
                if cancel.exists { cancel.tap() }
            }
        } else {
            missing("open-items-toolbar", app)
        }
    }

    /// The two DONE projects' conversations, read back as a reload finds them: the owner's DONE keeps
    /// its receipt; a DONE Orbit recorded itself is the Why-not-done card's terminal state — "This
    /// project is done", recorded by Orbit (the coordinator's ruling and the web, 2026-10-06).
    func test4DoneConversationsAfterAReload() {
        reset()
        let app = launch()
        signIn(app)
        guard openSession(app, orbitTitle) else { return }
        if !app.staticTexts["This project is done"].waitForExistence(timeout: 40) { missing("orbit-done-terminal", app) }
        texts("orbit-done", app)
        shoot("32-orbit-done-terminal-state", settle: 3.0)
        let again = relaunch(app)
        guard openSession(again, doneTitle) else { return }
        if !again.staticTexts["This project is done"].waitForExistence(timeout: 40) { missing("owner-done-receipt", again) }
        texts("owner-done", again)
        shoot("33-owner-done-receipt-after-reload", settle: 3.0)
    }

    /// "Why is this project not done?" in two coordinator conversations: work nobody has (Ask the
    /// coordinator to handle it) and a landing in flight (the coordinator is on it).
    func test3WhyNotDone() {
        reset()
        let app = launch()
        signIn(app)
        guard openSession(app, working) else { return }
        if !app.staticTexts["Why is this project not done?"].waitForExistence(timeout: 40) { missing("why-working", app) }
        texts("why-working", app)
        shoot("30-why-not-done-ask-the-coordinator", settle: 3.0)
        let again = relaunch(app)
        guard openSession(again, landing) else { return }
        if !again.staticTexts["Why is this project not done?"].waitForExistence(timeout: 40) { missing("why-landing", again) }
        texts("why-landing", again)
        shoot("31-why-not-done-coordinator-is-on-it", settle: 3.0)
    }
}
