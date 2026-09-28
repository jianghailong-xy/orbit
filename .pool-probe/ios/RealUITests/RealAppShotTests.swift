import XCTest

// TEMPORARY evidence probe (see ../../README.md): the REAL Orbit iOS app — its own `@main`, its own
// sign-in, navigation and views, with nothing copied or re-drawn — signing in to the stub server on
// 127.0.0.1:8787 and starting a session on the shared pool. The stub writes the POST /api/sessions
// body it receives to the shots directory, which is what proves the session was created on
// `team-codex`; these tests take the pictures around it.
final class RealAppShotTests: XCTestCase {
    private let instance = "http://127.0.0.1:8787"

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

    private func shoot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.8)
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
            try? app.debugDescription.write(toFile: "\(dir)/missing-real-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    /// The launch-time notification permission alert (`AppModel.bootstrap` asks on the first launch).
    /// It is a springboard alert, so it is answered there and never lands on a capture.
    private func allowNotifications() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<8 {
            let allow = springboard.buttons["Allow"]
            if allow.waitForExistence(timeout: 5) {
                allow.tap()
                note("notification permission: allowed")
                return
            }
        }
        note("notification permission: no alert seen")
    }

    /// The real app, on the real sign-in screen, pointed at the stub. One file per scheme is enough:
    /// no token is in the Keychain, so it starts signed out.
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", instance]
        app.launchEnvironment["TZ"] = "Europe/Berlin"
        app.launch()
        allowNotifications()
        return app
    }

    private func signIn(_ app: XCUIApplication) -> Bool {
        let email = app.textFields["Email"]
        guard email.waitForExistence(timeout: 30) else {
            missing("sign-in-email", app)
            return false
        }
        // The instance rides in as a launch argument (the `-orbit.instance` defaults key); this is the
        // fallback for a build that did not take it, so the run cannot hinge on that one mechanism.
        let instanceField = app.textFields["Instance URL (e.g. orbit.example.com)"]
        if instanceField.waitForExistence(timeout: 5), (instanceField.value as? String ?? "").isEmpty {
            instanceField.tap()
            instanceField.typeText(instance)
            note("sign-in: typed the instance URL")
        } else {
            note("sign-in: instance prefilled with \(instanceField.value as? String ?? "—")")
        }
        email.tap()
        email.typeText("wikova@example.com")
        let password = app.secureTextFields["Password"]
        if password.waitForExistence(timeout: 5) {
            password.tap()
            password.typeText("probe-password")
        } else {
            missing("sign-in-password", app)
        }
        app.buttons["Sign in"].tap()
        return true
    }

    /// The workspace's own toolbar action (`AgentPanes`), which pushes the real new-session draft.
    private func openDraft(_ app: XCUIApplication) -> Bool {
        let new = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Start a new session'")).firstMatch
        guard new.waitForExistence(timeout: 30) else {
            missing("new-session-button", app)
            return false
        }
        note("new-session button: \(new.label)")
        new.tap()
        return true
    }

    private func providerButton(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Provider:'")).firstMatch
    }

    /// The shared pool's row in the picker: the sheet's row is a plain Button over the mark and the
    /// name, so its label carries the name — and the hero behind it reads "Provider: …", which is
    /// what the second clause excludes.
    private func poolRow(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND NOT (label BEGINSWITH 'Provider:')",
                                         name)).firstMatch
    }

    private func openPicker(_ app: XCUIApplication) -> Bool {
        let hero = providerButton(app)
        guard hero.waitForExistence(timeout: 30) else {
            missing("hero-provider-button", app)
            return false
        }
        note("hero: \(hero.label)")
        hero.tap()
        let title = app.staticTexts["Who runs this?"]
        if !title.waitForExistence(timeout: 10) { missing("picker-sheet", app) }
        return true
    }

    private func closePicker(_ app: XCUIApplication) {
        let done = app.buttons["Done"].firstMatch
        if done.waitForExistence(timeout: 8) { done.tap() } else { missing("picker-done", app) }
    }

    /// Everything the picker drew for the pool: the row's own words and the badge's VoiceOver label
    /// (which is what says "keys" rather than "accounts").
    private func readPoolRow(_ app: XCUIApplication) {
        let row = poolRow(app, "Team Codex")
        note(row.exists ? "picker row: \(row.label)" : "picker row: Team Codex NOT FOUND")
        let badge = app.descendants(matching: .any).matching(NSPredicate(format: "label == '5 keys'")).firstMatch
        note(badge.exists ? "mark badge: '5 keys' (the poolUnit badge's VoiceOver label)"
                          : "mark badge: '5 keys' NOT FOUND")
    }

    /// Send, whose glyph carries no label of its own in the app — found by the frame it occupies at
    /// the toolbar's right end (32pt, bottom-right) rather than by a name the app never set.
    private func sendButton(_ app: XCUIApplication) -> XCUIElement? {
        let named = ["Send", "Arrow Up Circle Fill", "Up Circle Fill", "arrow.up.circle.fill"]
        for name in named where app.buttons[name].exists {
            note("send button: matched \(name)")
            return app.buttons[name]
        }
        let buttons = app.buttons.allElementsBoundByIndex.filter { $0.isHittable }
        let centred = buttons.compactMap { el -> (XCUIElement, CGRect)? in
            let f = el.frame
            guard f.minY > app.frame.height * 0.7, f.width <= 44, f.height <= 44 else { return nil }
            return (el, f)
        }.max { $0.1.minX < $1.1.minX }
        note("send button: \(centred.map { "frame \($0.1)" } ?? "not found") (of \(buttons.count) hittable buttons)")
        return centred?.0
    }

    // MARK: the journey

    func test1PickerHeroAndComposer() {
        let app = launch()
        guard signIn(app) else { return }
        Thread.sleep(forTimeInterval: 4)
        guard openDraft(app) else { return }
        Thread.sleep(forTimeInterval: 2)
        guard openPicker(app) else { return }
        shoot("10-real-picker-team-codex-listed")
        readPoolRow(app)

        let row = poolRow(app, "Team Codex")
        guard row.waitForExistence(timeout: 8) else {
            missing("real-pool-row", app)
            closePicker(app)
            return
        }
        row.tap()
        Thread.sleep(forTimeInterval: 1.5)
        let hero = providerButton(app)
        note(hero.waitForExistence(timeout: 10) ? "hero after pick: \(hero.label)" : "hero after pick: NOT FOUND")
        shoot("11-real-hero-team-codex")

        // Reopened on the pool: this is the picker as it reads with `currentSlug: "team-codex"`.
        guard openPicker(app) else { return }
        shoot("12-real-picker-current-team-codex")
        closePicker(app)

        let key = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'orbit-org-1'")).firstMatch
        note(key.waitForExistence(timeout: 10)
             ? "composer account label: \(key.label) frame=\(key.frame)"
             : "composer account label: NOT FOUND")
        shoot("13-real-composer-pool-key")

        let input = app.textViews.firstMatch
        if input.waitForExistence(timeout: 10) {
            input.tap()
            input.typeText("Ship the shared pool")
            shoot("14-real-composer-typed")
        } else {
            missing("composer-input", app)
        }
        if let send = sendButton(app) {
            send.tap()
        } else {
            missing("send-button", app)
        }
        shoot("15-real-after-send")
        Thread.sleep(forTimeInterval: 4)
        shoot("16-real-after-send-settled")

        // The same row on a phone held sideways, where the model control stops taking the room the
        // account's label needs. Last, so nothing else depends on the rotation.
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2.5)
        shoot("17-real-composer-landscape")
        XCUIDevice.shared.orientation = .portrait
    }

    /// The picker in dark. Only run in the dark pass — the appearance is the simulator's, which a test
    /// cannot set, so `run.sh` selects this one with `-only-testing` after `simctl ui … appearance dark`.
    func test2PickerDark() {
        let app = launch()
        guard signIn(app) else { return }
        Thread.sleep(forTimeInterval: 4)
        guard openDraft(app) else { return }
        Thread.sleep(forTimeInterval: 2)
        guard openPicker(app) else { return }
        shoot("20-real-picker-dark")
        readPoolRow(app)
        closePicker(app)
        shoot("21-real-composer-dark")
    }
}
