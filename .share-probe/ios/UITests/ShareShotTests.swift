import XCTest

// TEMPORARY evidence probe (see ../../README.md): open each page's ⋯ menu, press what it offers, open
// the Share panel, and photograph every step. A step that finds nothing writes the screen's element
// tree next to the pictures and the test carries on where it can, so one run returns everything it
// can see.
final class ShareShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    // MARK: the project page: ⋯ menu, Copy as Markdown, the panel, the question before turning off

    func test1TheProjectMenuAndItsPanel() throws {
        let app = launch("project")
        let more = app.navigationBars.firstMatch.buttons["More"]
        guard found(more, "the project's ⋯ button", in: app, timeout: 60) else { return }
        pause(2)
        shoot("01-ios-project-page")

        more.tap()
        if found(app.buttons["Copy Link"], "Copy Link in the project menu", in: app) {
            found(item("Share…", in: app), "Share… in the project menu", in: app)
            found(app.buttons["Copy as Markdown"], "Copy as Markdown in the project menu", in: app)
            pause(1.5)
            shoot("02-ios-project-menu")
            report("project menu buttons: " + labels(app.buttons))
            app.buttons["Copy as Markdown"].tap()
            settle(app.staticTexts["pasteboard"], "label BEGINSWITH %@", "# Claude 账号池", in: app)
            pause(1)
            shoot("03-ios-project-markdown-copied")
            report("pasteboard after Copy as Markdown:\n" + app.staticTexts["pasteboard"].label)
        }

        more.tap()
        let share = item("Share…", in: app)
        guard found(share, "Share… (second opening)", in: app) else { return }
        share.tap()
        guard found(app.buttons["Share Link…"], "the project panel's Share Link…", in: app) else { return }
        pause(2)
        shoot("04-ios-project-share-panel")
        report("project panel switches: " + labels(app.switches))
        report("project panel texts: " + labels(app.staticTexts))

        // Access → Only you asks before anything is turned off.
        let access = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Access")).firstMatch
        if found(access, "the Access picker", in: app) {
            access.tap()
            let onlyYou = app.buttons["Only you"]
            if found(onlyYou, "Only you in the Access menu", in: app) {
                pause(1)
                shoot("05-ios-project-access-menu")
                onlyYou.tap()
                if found(app.buttons["Turn off"], "the Turn off question", in: app) {
                    pause(1)
                    shoot("06-ios-project-turn-off-question")
                    report("turn-off question texts: " + labels(app.staticTexts))
                    let cancel = app.buttons["Cancel"]
                    if cancel.exists { cancel.tap() } else {
                        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
                    }
                    pause(1)
                    found(app.buttons["Share Link…"], "the link, still open after Cancel", in: app)
                }
            }
        }

        // Down to Live, Expires and the visits line.
        app.swipeUp()
        pause(1.5)
        shoot("07-ios-project-share-panel-bottom")
        report("project panel bottom texts: " + labels(app.staticTexts))
    }

    // MARK: the task page: ⋯ menu, Copy Link, the panel

    func test2TheTaskMenuAndItsPanel() throws {
        let app = launch("task")
        let more = app.navigationBars.firstMatch.buttons["Task actions"]
        guard found(more, "the task's ⋯ button", in: app, timeout: 60) else { return }
        pause(2)
        more.tap()
        guard found(app.buttons["Copy Link"], "Copy Link in the task menu", in: app) else { return }
        found(item("Share…", in: app), "Share… in the task menu", in: app)
        found(app.buttons["Copy as Markdown"], "Copy as Markdown in the task menu", in: app)
        found(app.buttons["Delete task"], "Delete task in the task menu", in: app)
        pause(1.5)
        shoot("08-ios-task-menu")
        report("task menu buttons: " + labels(app.buttons))

        app.buttons["Copy Link"].tap()
        settle(app.staticTexts["pasteboard"], "label == %@", "https://orbitd.io/tasks/34UozoiaJIsxCZj728bfe", in: app)
        XCTAssertFalse(app.otherElements["ActivityListView"].waitForExistence(timeout: 2),
                       "Copy Link opens no system share sheet")
        pause(1)
        shoot("09-ios-task-link-copied")

        more.tap()
        let share = item("Share…", in: app)
        guard found(share, "Share… (second opening)", in: app) else { return }
        share.tap()
        guard found(app.buttons["Share Link…"], "the task panel's Share Link…", in: app) else { return }
        pause(2)
        shoot("10-ios-task-share-panel")
        report("task panel switches: " + labels(app.switches))
        app.swipeUp()
        pause(1.5)
        shoot("11-ios-task-share-panel-bottom")
        report("task panel bottom texts: " + labels(app.staticTexts))
    }

    // MARK: the session page: the panel before and after a link is made

    func test3TheSessionPanelMakesALink() throws {
        let app = launch("session")
        let share = app.navigationBars.firstMatch.buttons["Share session"]
        guard found(share, "the session's Share button", in: app, timeout: 60) else { return }
        share.tap()
        let access = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Access")).firstMatch
        guard found(access, "the session panel's Access picker", in: app) else { return }
        pause(2)
        shoot("12-ios-session-share-panel-private")
        report("session panel (private) texts: " + labels(app.staticTexts))

        access.tap()
        let anyone = app.buttons["Anyone with the link"]
        guard found(anyone, "Anyone with the link in the Access menu", in: app) else { return }
        anyone.tap()
        guard found(app.buttons["Share Link…"], "the session's new link", in: app) else { return }
        pause(2)
        shoot("13-ios-session-share-panel-live")
        report("session panel (live) switches: " + labels(app.switches))
    }

    // MARK: helpers

    private func launch(_ probe: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-probe", probe]
        app.launch()
        return app
    }

    /// A menu item by the start of its label: an item with a line under it may read "Share…, Live link".
    private func item(_ title: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    @discardableResult
    private func found(_ element: XCUIElement, _ what: String, in app: XCUIApplication,
                       timeout: TimeInterval = 15) -> Bool {
        if element.waitForExistence(timeout: timeout) { return true }
        XCTFail("not found: \(what)")
        let name = "missing-" + what.lowercased().filter { $0.isLetter || $0.isNumber || $0 == " " }
            .replacingOccurrences(of: " ", with: "-")
        write(Data(app.debugDescription.utf8), "\(name).txt")
        shoot(name)
        return false
    }

    private func settle(_ element: XCUIElement, _ format: String, _ value: String, in app: XCUIApplication) {
        let done = expectation(for: NSPredicate(format: format, value), evaluatedWith: element)
        if XCTWaiter().wait(for: [done], timeout: 10) != .completed {
            XCTFail("\(element) never read \(format) \(value); it reads \(element.exists ? element.label : "nothing")")
            write(Data(app.debugDescription.utf8), "unsettled-\(value.prefix(12)).txt")
        }
    }

    private func labels(_ query: XCUIElementQuery) -> String {
        query.allElementsBoundByIndex.map { element in
            let value = (element.value as? String).map { "=\($0)" } ?? ""
            return element.label + value
        }.joined(separator: " | ")
    }

    private func pause(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func report(_ line: String) {
        print("REPORT: \(line)")
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("report.txt")
        let data = Data((line + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    private func shoot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        write(png, "\(name).png")
    }

    private func write(_ data: Data, _ file: String) {
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        do {
            try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file))
        } catch {
            print("could not write \(file): \(error)")
        }
    }
}
