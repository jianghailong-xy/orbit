import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each conversation, scroll the card through,
// open the Tasks land on menu and pick from it, press Start and Confirm, and photograph every step.
// Every test keeps going after a miss, so one run brings back every picture it can.
final class StartShotTests: XCTestCase {
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
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true,
                                            encoding: .utf8)
        }
    }

    /// The hittable element whose label begins with these words, scrolling down to it if it is not
    /// on screen yet.
    @discardableResult
    private func tap(_ label: String, in app: XCUIApplication, scrolls: Int = 6) -> Bool {
        let predicate = NSPredicate(format: "label BEGINSWITH %@", label)
        for attempt in 0...scrolls {
            let found = app.descendants(matching: .any).matching(predicate)
                .allElementsBoundByIndex.last(where: { $0.exists && $0.isHittable
                    && ($0.elementType == .button || $0.elementType == .menuItem
                        || $0.elementType == .switch || $0.elementType == .other) })
            if let element = found {
                element.tap()
                return true
            }
            if attempt < scrolls { app.swipeUp(velocity: .slow) }
        }
        missing(label.replacingOccurrences(of: " ", with: "-"), app)
        return false
    }

    private func read(_ id: String, in app: XCUIApplication) -> String {
        let element = app.staticTexts[id]
        return element.waitForExistence(timeout: 5) ? element.label : "(\(id): absent)"
    }

    /// The whole card, top to bottom, a screen at a time.
    private func scrollThrough(_ app: XCUIApplication, _ name: String, screens: Int = 5) {
        shoot("\(name)-1")
        for index in 2...screens {
            app.swipeUp(velocity: .slow)
            shoot("\(name)-\(index)")
        }
    }

    // MARK: which way of writing a menu item draws its second line

    func test0MenuVariants() {
        let names = ["R1 card row", "R3 leading", "R5 buttons", "B1 card row"]
        // A fresh launch per menu: closing one by tapping "outside" could press another.
        for (index, name) in names.enumerated() {
            let app = launch("menus")
            if index == 0 { shoot("00-menus") }
            guard tap(name, in: app, scrolls: 0) else { continue }
            let slug = "00-menu-\(index + 1)-\(name.replacingOccurrences(of: " ", with: "-"))"
            shoot("\(slug)-a")
            // The same open menu a few seconds on: does its second line arrive late?
            Thread.sleep(forTimeInterval: 2.7)
            shoot("\(slug)-b")
        }
    }

    // MARK: Start this project?

    func test1TheStartCardTopToBottom() {
        let app = launch("start")
        note("start · header: \(read("probe-subtitle", in: app))")
        scrollThrough(app, "01-start")
    }

    func test2TasksLandOnIsTheNativeMenu() {
        let app = launch("start")
        // The menu's own label: the line chosen, with the up-down chevron.
        guard tap("A project branch", in: app) else { return }
        shoot("02-1-menu-open")
        Thread.sleep(forTimeInterval: 2.7)
        shoot("02-1-menu-open-later")
        if tap("Directly into main", in: app, scrolls: 0) {
            shoot("02-2-main-chosen")
            // Automatic's sentence follows the line: the merge half now says main always asks.
            let hint = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@",
                                                             "Merging into main always asks you"))
            note("main chosen · Automatic says the main sentence: \(hint.count > 0)")
        }
    }

    func test3AMissingMergeCheckIsAmber() {
        let app = launch("start-nocheck")
        app.swipeUp(velocity: .slow)
        app.swipeUp(velocity: .slow)
        shoot("03-1-no-merge-check")
        app.swipeUp(velocity: .slow)
        shoot("03-2-no-merge-check")
    }

    func test4StartPostsOnceAndLeavesTheReceipt() {
        let app = launch("start")
        guard tap("Start the project", in: app, scrolls: 8) else { return }
        let receipt = app.staticTexts["Decision recorded"].waitForExistence(timeout: 8)
        note("start pressed · receipt drawn: \(receipt)")
        note("start pressed · \(read("probe-body", in: app))")
        note("started · header: \(read("probe-subtitle", in: app))")
        app.swipeDown(velocity: .fast)
        shoot("04-1-started")
        app.swipeUp(velocity: .slow)
        shoot("04-2-started")
    }

    func test5ChatAboutThisArmsTheComposer() {
        let app = launch("start")
        guard tap("Chat about this", in: app, scrolls: 8) else { return }
        note("chat pressed · \(read("probe-composer", in: app))")
        shoot("05-chat")
    }

    // MARK: Confirm the new criteria?

    func test6TheChangeCardAndItsReceipt() {
        let app = launch("change")
        scrollThrough(app, "06-change", screens: 2)
        guard tap("Confirm 5 criteria", in: app, scrolls: 4) else { return }
        let receipt = app.staticTexts["Decision recorded"].waitForExistence(timeout: 8)
        note("confirm pressed · receipt drawn: \(receipt)")
        let line = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@",
                                                         "You confirmed")).firstMatch
        note("confirmed · \(line.exists ? line.label : "(no receipt line)")")
        app.swipeDown(velocity: .fast)
        shoot("07-confirmed")
    }

    func test8DirectlyIntoMain() {
        let app = launch("start-main")
        app.swipeUp(velocity: .slow)
        shoot("11-1-main")
        app.swipeUp(velocity: .slow)
        shoot("11-2-main")
    }

    // MARK: dark

    func test7Dark() {
        let start = launch("start", dark: true)
        scrollThrough(start, "08-start-dark", screens: 3)
        let change = launch("change", dark: true)
        shoot("09-change-dark")
        let started = launch("started", dark: true)
        _ = started.staticTexts["Decision recorded"].waitForExistence(timeout: 5)
        shoot("10-started-dark")
    }
}
