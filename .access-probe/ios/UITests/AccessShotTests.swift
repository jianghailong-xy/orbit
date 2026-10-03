import XCTest

// TEMPORARY evidence probe (see ../../README.md): open the Codex pool's page as its owner and as somebody he
// added, and the Providers page, photograph each from top to bottom, and press the page's own buttons —
// "Add account", the Just me / Me and people I add switch — to photograph what they open. Every test keeps
// going after a miss, so one run brings back every picture it can.
final class AccessShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func launch(_ screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen]
        app.launchEnvironment["TZ"] = "Asia/Shanghai"
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

    private func missing(_ what: String, _ app: XCUIApplication) {
        XCTFail("no \(what); buttons: \(app.buttons.allElementsBoundByIndex.map(\.label))")
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    /// The press with these words that is on top: with a sheet up, the page's own button of the same name is
    /// still in the tree underneath it.
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

    /// A page from its top to its foot, a screenful at a time.
    private func scrollThrough(_ name: String, _ app: XCUIApplication, screens: Int) {
        shoot("\(name)-1")
        for at in 2...screens {
            app.swipeUp(velocity: .slow)
            shoot("\(name)-\(at)")
        }
    }

    func test1TheProvidersPage() {
        _ = launch("providers")
        shoot("01-providers")
    }

    /// His page once shared: whose sessions each account runs, who can use it on what, the rule and the lock;
    /// then what "Add account" asks first, and the question before going back to Just me.
    func test2HisPageShared() {
        var app = launch("owner")
        scrollThrough("02-owner", app, screens: 4)

        app = launch("owner")
        if tap("Add account", in: app) {
            shoot("03-add-account")
            if tap("Continue", in: app) {
                shoot("03-add-account-sign-in")
            }
        }

        // One screenful down: the switch is mid-screen there, clear of the bar that would take the tap.
        app = launch("owner")
        app.swipeUp(velocity: .slow)
        if tap("Just me", in: app) {
            shoot("04-make-it-just-mine")
        }
    }

    /// His page while it is his alone, and what Share says before anybody is added — with no key yet, and
    /// with one.
    func test3HisPageAlone() {
        var app = launch("alone")
        scrollThrough("05-alone", app, screens: 2)
        if tap("Me and people I add", in: app) {
            shoot("06-share-no-key")
        }
        app = launch("alone-key")
        app.swipeUp(velocity: .slow)
        if tap("Me and people I add", in: app) {
            shoot("06-share")
        }
    }

    /// Shared before it has an API key: none of them can start a session yet, said at the card's foot.
    func test4NoKeyYet() {
        let app = launch("no-key")
        scrollThrough("07-no-key", app, screens: 3)
    }

    /// The same pool as Zhang Min reads it: his ChatGPT accounts one locked line, its keys hers to run on.
    func test5SomebodyHeAdded() {
        let app = launch("member")
        scrollThrough("08-member", app, screens: 3)
    }
}
