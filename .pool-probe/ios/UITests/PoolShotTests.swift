import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each screen of Settings → Providers and a shared
// pool's page, scroll through it, swipe a key, and photograph every step. Every test keeps going after
// a miss, so one run brings back every picture it can.
final class PoolShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func launch(_ screen: String, dark: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen] + (dark ? ["-dark"] : [])
        // The mock's clock: Berlin, where the month's caps come back on Thursday at 02:00.
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

    /// A slow swipe, so a list moves about one screen and settles rather than flinging.
    private func scroll(_ element: XCUIElement) {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.82))
        let end = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
    }

    private func missing(_ what: String, _ app: XCUIApplication) {
        XCTFail("no \(what); buttons: \(app.buttons.allElementsBoundByIndex.map(\.label))")
        if let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] {
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    // MARK: Settings → Providers

    func test1Providers() {
        let app = launch("providers")
        shoot("01-1-providers")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            scroll(list)
            shoot("01-2-providers")
        }
    }

    // MARK: the pool's page, as its admin and as a member

    func test2PoolAsAdmin() {
        let app = launch("pool")
        shoot("02-1-pool-admin")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            for step in 2...4 {
                scroll(list)
                shoot("02-\(step)-pool-admin")
            }
        }
    }

    func test3PoolAsMember() {
        let app = launch("pool-member")
        shoot("03-1-pool-member")
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 10) {
            for step in 2...4 {
                scroll(list)
                shoot("03-\(step)-pool-member")
            }
        }
    }

    // MARK: Add a key, and replacing a refused key

    func test4AddAKey() {
        for (n, screen) in ["add-consent", "add-form", "add-done", "add-dup", "replace"].enumerated() {
            _ = launch(screen)
            shoot("04-\(n + 1)-\(screen)")
        }
    }

    // MARK: a key taken out with a swipe

    func test5SwipeToRemove() {
        let app = launch("pool")
        let row = app.collectionViews.cells.containing(.staticText, identifier: "orbit-org-1").firstMatch
        guard row.waitForExistence(timeout: 10) else { return missing("key-row", app) }
        row.swipeLeft()
        shoot("05-1-swipe-own-key")
        let remove = app.buttons["Remove"].firstMatch
        if remove.waitForExistence(timeout: 5) {
            remove.tap()
            shoot("05-2-remove-confirm")
        } else {
            missing("remove-button", app)
        }
        let other = launch("pool").collectionViews.cells.containing(.staticText, identifier: "orbit-org-2").firstMatch
        if other.waitForExistence(timeout: 10) {
            other.swipeLeft()
            shoot("05-3-swipe-others-key")
        }
    }

    // MARK: an admin's say over a member, with a swipe

    func test7SwipeAMember() {
        let app = launch("pool")
        let list = app.collectionViews.firstMatch
        guard list.waitForExistence(timeout: 10) else { return missing("list", app) }
        scroll(list)
        scroll(list)
        let row = app.collectionViews.cells.containing(.staticText, identifier: "Zhang Min").firstMatch
        guard row.waitForExistence(timeout: 5) else { return missing("member-row", app) }
        row.swipeLeft()
        shoot("07-1-swipe-member")
        let remove = app.buttons["Remove from pool"].firstMatch
        if remove.waitForExistence(timeout: 5) {
            remove.tap()
            shoot("07-2-remove-member-confirm")
        } else {
            missing("remove-member-button", app)
        }
    }

    // MARK: the account pool's page, and the pool page in dark

    func test6ClaudePoolAndDark() {
        _ = launch("claude-pool")
        shoot("06-1-claude-pool")
        _ = launch("pool", dark: true)
        shoot("06-2-pool-admin-dark")
        _ = launch("providers", dark: true)
        shoot("06-3-providers-dark")
    }
}
