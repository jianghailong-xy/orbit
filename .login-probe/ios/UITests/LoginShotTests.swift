import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each screen of a Codex pool of one's own and its
// "Sign in with ChatGPT" sheet, walk the whole sign-in against the probe's stand-in server with real
// taps, swipe the account out, and photograph every step. Every test keeps going after a miss, so one
// run brings back every picture it can.
final class LoginShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func launch(_ screen: String, dark: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen] + (dark ? ["-dark"] : [])
        app.launchEnvironment["TZ"] = "Europe/Berlin"
        app.launch()
        Thread.sleep(forTimeInterval: 2.5)
        return app
    }

    private func shoot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.8)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        do {
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        } catch {
            print("could not write \(name): \(error)")
        }
    }

    private func note(_ line: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("report.txt")
        let text = ((try? String(contentsOf: url, encoding: .utf8)) ?? "") + line + "\n"
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func missing(_ what: String, _ app: XCUIApplication) {
        XCTFail("no \(what); buttons: \(app.buttons.allElementsBoundByIndex.map(\.label))")
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    /// The press with these words that is on top: with the sheet up, the page's own button of the same
    /// name is still in the tree underneath it.
    @discardableResult
    private func tap(_ label: String, in app: XCUIApplication, timeout: TimeInterval = 8) -> Bool {
        let query = app.buttons.matching(identifier: label)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let button = query.allElementsBoundByIndex.last(where: { $0.exists && $0.isHittable }) {
                button.tap()
                return true
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        missing(label.replacingOccurrences(of: " ", with: "-"), app)
        return false
    }

    private func wait(for text: String, in app: XCUIApplication, timeout: TimeInterval = 15) -> Bool {
        let found = app.staticTexts[text].waitForExistence(timeout: timeout)
        if !found { missing("text-\(text.prefix(24).replacingOccurrences(of: " ", with: "-"))", app) }
        return found
    }

    // MARK: Settings → Providers, and the pool's page in each state

    func test1ProvidersAndThePage() {
        _ = launch("providers")
        shoot("01-1-providers")
        _ = launch("pool")
        shoot("01-2-pool")
        _ = launch("pool-spent")
        shoot("01-3-pool-spent")
        _ = launch("pool-out")
        shoot("01-4-pool-signed-out")
        _ = launch("pool-none")
        shoot("01-5-pool-none")
    }

    // MARK: every step of the sheet, still

    func test2TheSheetsSteps() {
        let steps = ["consent", "code", "done", "expired", "failed", "dup", "taken", "again", "again-code"]
        for (n, screen) in steps.enumerated() {
            _ = launch(screen)
            shoot("02-\(n + 1)-\(screen)")
        }
    }

    // MARK: the whole sign-in, live

    func test3SignInWithChatGPT() {
        let app = launch("flow")
        guard tap("Sign in with ChatGPT", in: app) else { return }
        Thread.sleep(forTimeInterval: 1)
        shoot("03-1-flow-notice")
        guard tap("Sign in with ChatGPT", in: app) else { return }
        guard wait(for: "Waiting for you to approve it…", in: app) else { return }
        shoot("03-2-flow-code")
        if tap("Copy code", in: app) {
            shoot("03-3-flow-copied")
        }
        guard wait(for: "wikova@orbitd.io is in My Codex", in: app) else { return }
        shoot("03-4-flow-done")
        guard tap("Done", in: app) else { return }
        let server = app.staticTexts["probe-server"]
        if server.waitForExistence(timeout: 5) {
            note("flow: \(server.label)")
        }
        shoot("03-5-flow-page-after")
    }

    func test4SignInAgain() {
        let app = launch("flow-again")
        shoot("04-1-signed-out-page")
        guard tap("Sign in again", in: app) else { return }
        shoot("04-2-again-notice")
        guard tap("Sign in with ChatGPT", in: app) else { return }
        guard wait(for: "Waiting for you to approve it…", in: app) else { return }
        shoot("04-3-again-code")
        guard wait(for: "wikova@orbitd.io is in My Codex", in: app) else { return }
        shoot("04-4-again-done")
    }

    // MARK: the account signed out with a swipe

    func test5SwipeToSignOut() {
        let app = launch("pool")
        let row = app.collectionViews.cells.containing(.staticText, identifier: "wikova@orbitd.io").firstMatch
        guard row.waitForExistence(timeout: 10) else { return missing("account-row", app) }
        row.swipeLeft()
        shoot("05-1-swipe")
        guard tap("Sign out", in: app, timeout: 5) else { return }
        shoot("05-2-sign-out-confirm")
    }

    // MARK: dark

    func test6Dark() {
        _ = launch("pool", dark: true)
        shoot("06-1-pool-dark")
        _ = launch("code", dark: true)
        shoot("06-2-code-dark")
        _ = launch("providers", dark: true)
        shoot("06-3-providers-dark")
    }
}
