import XCTest

// TEMPORARY evidence probe (see ../../README.md): the REAL Orbit iOS app — its own `@main`, sign-in,
// session list and coordinator conversation, with nothing copied or re-drawn — signed in to the stub
// on 127.0.0.1:8787 (../../stub.py). These tests photograph what task T11 changed, over the same
// three item states T10 photographed on the web: the session row's short `need`, the "waiting
// below" bar with the cards scrolled away, and the card in each of its three states — plus the
// reason field the owner's own ending opens.
//
// Every text on screen is written to the report beside the pictures (`texts(...)`), which is how
// the copy is read back for the side-by-side with the web's.
final class T11ShotTests: XCTestCase {
    private let instance = "http://127.0.0.1:8787"
    private let project = "Ship a decision with every exception"

    private let escalated = "Nothing on the project branch reaches main until this check passes"
    private let handling = "A repair task is already handling this item"
    private let handedOver = "The coordinator handed this item over with this note"

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
        note("TEXTS \(label): " + all.prefix(140).joined(separator: " ¦ "))
    }

    /// The stub back to its first state: every walk starts from the three items still open.
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

    /// The login page: Email, Password and Sign In, with the server off the page (it is the launch
    /// argument's `-orbit.instance`, which the app restores at launch).
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
    /// own page first ("Project · 1 sessions", then a Coordinator section).
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

    /// Drag the transcript by `dy` points — negative reads further down (newer), positive reads
    /// back up — held at the end so it does not coast past where it was taken. From the left
    /// quarter: the jump-to-latest disc floats at the bottom centre, and a press that starts on it
    /// is the disc's, not the list's.
    private func drag(_ app: XCUIApplication, by dy: CGFloat) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: dy < 0 ? 0.72 : 0.3))
        let end = start.withOffset(CGVector(dx: 0, dy: dy))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.4)
        Thread.sleep(forTimeInterval: 0.8)
    }

    /// Scroll until `element`'s top sits just under the navigation bar and the conversation's
    /// pinned strips below it.
    private func bringToTop(_ element: XCUIElement, _ app: XCUIApplication, top: CGFloat = 205) {
        for _ in 0..<10 {
            guard element.exists else { return }
            let y = element.frame.minY
            note("bringToTop \(element.label.prefix(24)): y=\(Int(y))")
            if abs(y - top) < 30 { return }
            drag(app, by: max(-420, min(420, top - y)))
        }
    }

    /// The session row says WHY ("Escalated to you · Checks failed"), and the conversation's three
    /// states each open with what has to happen next: the sentence, the fix already filed under it,
    /// and the doors — each with its one line of consequence, the Check row, and the log under it.
    func test1TheRowAndTheThreeCardStates() {
        reset()
        let app = launch()
        signIn(app)

        // ① the session row's short need, beside the needs-you bar.
        let row = containing(app, "Escalated to you")
        if !row.firstMatch.waitForExistence(timeout: 40) { missing("session-row-need", app) }
        Thread.sleep(forTimeInterval: 2.0)
        texts("session-list", app)
        shoot("01-session-row-escalated-to-you-need", settle: 1.5)

        guard openSession(app, project) else { return }
        // The cards are delivered at the tail (their own clock ran minutes ago), so opening the
        // conversation lands on the last of them. Read back up to the very top first: every row is
        // realized then, and each card can be walked down to by name.
        Thread.sleep(forTimeInterval: 3.0)
        for _ in 0..<8 { drag(app, by: 380) }
        texts("conversation-landed", app)
        shoot("02-conversation-as-it-opens", settle: 1.0)

        for (name, text) in [("03-card-escalated", escalated),
                             ("04-card-coordinator-fixing-it", handling),
                             ("05-card-handed-over", handedOver)] {
            let sentence = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
            if !sentence.waitForExistence(timeout: 20) { missing(name, app); continue }
            bringToTop(sentence, app)
            texts(name, app)
            shoot(name, settle: 1.0)
            // The whole card, one screen down: the doors, their consequences and the fact block.
            drag(app, by: -320)
            texts("\(name)-lower", app)
            shoot("\(name)-lower", settle: 1.0)
        }

        // The owner's own ending: the reason field, kept empty, with its confirm waiting for one.
        // Found by walking down the cards until one of the links is on screen — every card draws
        // one, and the top-most is usually scrolled past.
        if let mark = hittableButton("Mark as handled", app, walking: true) {
            bringToTop(mark, app, top: 360)
            mark.tap()
            let title = app.staticTexts["Mark this item as handled?"]
            if title.waitForExistence(timeout: 10) {
                Thread.sleep(forTimeInterval: 1.0)
                texts("mark-handled-panel", app)
                shoot("06-mark-as-handled-reason-field", settle: 1.5)
                if let back = hittableButton("Back", app, timeout: 5) { back.tap() }
            } else {
                missing("mark-handled-panel", app)
            }
        }
    }

    /// The first button wearing `label` that is on screen, reading further down the transcript to
    /// find it when the cards above the fold are the ones that carry it.
    private func hittableButton(_ label: String, _ app: XCUIApplication, timeout: TimeInterval = 10,
                                walking: Bool = false) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label == %@", label))
        guard query.firstMatch.waitForExistence(timeout: timeout) else {
            missing("card-\(label)", app)
            return nil
        }
        for step in 0..<(walking ? 24 : 12) {
            if let element = query.allElementsBoundByIndex.first(where: { $0.isHittable && $0.frame.minY > 110 }) {
                return element
            }
            if walking, step % 2 == 1 { drag(app, by: -260) }
            Thread.sleep(forTimeInterval: 0.5)
        }
        missing("card-\(label)-hittable", app)
        return nil
    }

    /// With the cards scrolled away BELOW, the bar over the transcript says how many are waiting
    /// below — and the copy on every one of those screens is in the report beside the pictures.
    func test2WaitingBelow() {
        reset()
        let app = launch()
        signIn(app)
        guard openSession(app, project) else { return }
        Thread.sleep(forTimeInterval: 4.0)

        // Read back up until a MESSAGE is at the top of the viewport and the cards are under it:
        // the direction word is the reader's own place, which only the transcript can report.
        for _ in 0..<3 { drag(app, by: 300) }
        Thread.sleep(forTimeInterval: 1.5)
        texts("waiting-below", app)
        shoot("08-waiting-below", settle: 1.5)
    }
}
