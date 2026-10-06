import XCTest

// TEMPORARY evidence probe (never merged): the iPhone app against stub.py, which holds every
// `?projectId=` read PROBE_DELAY seconds. Opens project P1 (Open members in two workspaces, two
// Completed members no Open list holds), then P2 (nothing Completed), then P1 again, and records the
// page's header ("<title>, Project · N sessions") from the moment the tap returns: every value it
// shows, with shots on arrival, at arrival + 1 s and at the first count, until the read's count
// arrives. On P1's first visit it stays 20 s more, so the stub's log shows what the page's polls ask
// for. Times are the test runner's wall clock (HH:mm:ss.SSS), the same clock the stub logs with.
final class ProjectPageOpenTimingTests: XCTestCase {
    private let p1 = "Google 账号登录与开放注册"
    private let p2 = "Open-only probe project"
    private var notes: [String] = []
    private let wall: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        write(notes.joined(separator: "\n"), "timeline.txt")
    }

    func testOpeningTheProjectPage() {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        guard listRow(app, p1).waitForExistence(timeout: 60), listRow(app, p2).waitForExistence(timeout: 20) else {
            tree(app, "no-list-rows")
            return XCTFail("the workspace list never showed both project rows")
        }
        settle(3)
        shot("00-list")
        open(app, p1, "p1-first", final: 5, stay: 20)
        back(app, p1)
        open(app, p2, "p2-first", final: 2, stay: 0)
        back(app, p2)
        open(app, p1, "p1-again", final: 5, stay: 0)
    }

    /// One visit: tap the row and read the header from the moment the tap returns (XCUITest returns
    /// once the app is idle, i.e. with the page pushed): every distinct value with its time, a shot on
    /// arrival, at arrival + 1 s and at the first count, until the read's count (`final`) is up.
    private func open(_ app: XCUIApplication, _ title: String, _ name: String, final: Int, stay: TimeInterval) {
        let row = listRow(app, title)
        guard row.waitForExistence(timeout: 20) else {
            tree(app, "\(name)-no-row")
            return XCTFail("\(name): no list row for \(title)")
        }
        mark("\(name) tap")
        let t0 = Date()
        row.tap()
        let arrival = Date()
        mark(String(format: "%@ tap returned +%.2fs", name, arrival.timeIntervalSince(t0)))
        shot("\(name)-arrival")
        var last: String?? = .none
        var firstCount: (at: TimeInterval, n: Int)?
        var atOne: Int?
        var shotOne = false
        var sawZero = false
        var finalAt: TimeInterval?
        while Date().timeIntervalSince(arrival) < 40 {
            let since = Date().timeIntervalSince(arrival)
            let label = header(app, title)
            let empty = app.staticTexts["No sessions"].exists
            let n = label.flatMap(count)
            if last == nil || last! != label || empty {
                note(String(format: "%@ arrival+%.2fs header=%@%@", name, since, label ?? "(none)",
                            empty ? " [No sessions]" : ""))
                last = .some(label)
            }
            if n == 0 || empty { sawZero = true }
            if firstCount == nil, let n {
                firstCount = (since, n)
                shot("\(name)-first-count")
            }
            if !shotOne, since >= 1.0 {
                shotOne = true
                atOne = n
                shot("\(name)-arrival+1s")
            }
            if n == final, shotOne {
                finalAt = since
                break
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        mark("\(name) read answered")
        shot("\(name)-final")
        note(String(format: "%@ SUMMARY first-count=%@ at-arrival+1s=%@ final=%ld reached=%@ saw-0-sessions=%@", name,
                    firstCount.map { String(format: "%ld at arrival+%.2fs", $0.n, $0.at) } ?? "never",
                    atOne.map(String.init) ?? "none",
                    final, finalAt.map { String(format: "arrival+%.2fs", $0) } ?? "never",
                    sawZero ? "yes" : "no"))
        XCTAssertNotNil(finalAt, "\(name): the page never showed its read's \(final) sessions")
        if stay > 0 {
            mark("\(name) polls-from")
            settle(stay)
            mark("\(name) polls-to")
            shot("\(name)-after-polls")
        }
    }

    private func back(_ app: XCUIApplication, _ title: String) {
        let button = app.navigationBars.buttons["BackButton"].exists
            ? app.navigationBars.buttons["BackButton"] : app.navigationBars.buttons.element(boundBy: 0)
        button.tap()
        _ = listRow(app, title).waitForExistence(timeout: 10)
        settle(2)
    }

    // MARK: helpers

    /// The page's header: the title and its subtitle, combined into one element in the navigation bar.
    private func header(_ app: XCUIApplication, _ title: String) -> String? {
        let inBar = app.navigationBars.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", title, "Project")).firstMatch
        if inBar.exists { return inBar.label }
        let anywhere = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND (label CONTAINS %@ OR label ENDSWITH %@)",
                                  title, "Project ·", "Project")).firstMatch
        return anywhere.exists ? anywhere.label : nil
    }

    /// N in "Project · N sessions"; nil while the subtitle says "Project" alone.
    private func count(_ label: String) -> Int? {
        guard let range = label.range(of: #"Project · (\d+) sessions"#, options: .regularExpression) else { return nil }
        return Int(label[range].filter(\.isNumber))
    }

    /// The workspace list's project row: its combined label starts with the title and goes on (the
    /// progress chip, the second line). The drawer's row is the title alone.
    private func listRow(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", title, title)).firstMatch
    }

    private func settle(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func mark(_ what: String) {
        notes.append("\(wall.string(from: Date())) MARK \(what)")
    }

    private func note(_ line: String) {
        notes.append("\(wall.string(from: Date())) \(line)")
    }

    private func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
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
