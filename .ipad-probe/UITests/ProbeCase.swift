import XCTest

// TEMPORARY evidence probe (see ../README.md): helpers. Soft failures — whatever cannot be found is
// noted next to the pictures and the run moves on, so one pass collects everything it can.
class ProbeCase: XCTestCase {
    let conversation = "整理 release notes"
    let folder = "Release"
    let project = "Runner 自动升级与回滚"
    let folderBack = "Back to the workspace's sessions"
    var notes: [String] = []

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        let file = name.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        write(notes.joined(separator: "\n"), "\(file)-notes.txt")
        XCUIDevice.shared.orientation = .portrait
    }

    // MARK: launching

    func launch(scene: String, sidebar: Bool, orientation: UIDeviceOrientation) -> XCUIApplication {
        XCUIDevice.shared.orientation = orientation
        settle(1)
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.scene", scene, "-probe.sidebar", sidebar ? "1" : "0"]
        app.launch()
        return app
    }

    /// The workspace's session list beside the conversation.
    func waitList(_ app: XCUIApplication) {
        if !labelled(app, conversation).waitForExistence(timeout: 60) {
            note("the session list never showed \(conversation)")
            tree(app, "missing-list")
        }
        settle(2.5)
    }

    // MARK: what is on screen

    /// Anything whose label begins with these words — a row's combined label starts with its title.
    func labelled(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", words)).firstMatch
    }

    /// The sidebar column is on screen: the drawer's Settings disc is there and can be pressed.
    func sidebarShowing(_ app: XCUIApplication) -> Bool {
        let gear = app.buttons["Settings"]
        guard gear.exists else { return false }
        let f = gear.frame
        return f.maxX > 1 && f.minX < app.windows.firstMatch.frame.maxX && gear.isHittable
    }

    /// The navigation bar holding this element — the bar of the column it is in.
    func bar(holding element: XCUIElement, in app: XCUIApplication) -> CGRect? {
        guard element.exists else { return nil }
        let mid = CGPoint(x: element.frame.midX, y: element.frame.midY)
        return app.navigationBars.allElementsBoundByIndex.map(\.frame)
            .filter { $0.contains(mid) }
            .min { $0.width < $1.width }
    }

    func describe(_ e: XCUIElement) -> String {
        guard e.exists else { return "(missing)" }
        return "\(e.elementType.rawValue) label=\"\(e.label)\" id=\"\(e.identifier)\" frame=\(e.frame) hittable=\(e.isHittable)"
    }

    /// Every navigation bar and the buttons along the top of the window, for measuring the columns.
    func frames(_ app: XCUIApplication, _ name: String) {
        note("[\(name)] window \(app.windows.firstMatch.frame)")
        for (i, bar) in app.navigationBars.allElementsBoundByIndex.enumerated() {
            note("[\(name)] bar \(i) id=\"\(bar.identifier)\" frame=\(bar.frame)")
        }
        let top = app.buttons.allElementsBoundByIndex.filter { $0.exists && $0.frame.minY < 110 }
        for b in top { note("[\(name)] top button \(describe(b))") }
        note("[\(name)] sidebar showing: \(sidebarShowing(app))")
        let gear = app.buttons["Settings"]
        if gear.exists { note("[\(name)] Settings disc \(describe(gear))") }
    }

    /// The leading swipe actions a row may have opened under the finger (Complete / Pin).
    func rowActions(_ app: XCUIApplication, _ name: String) {
        for label in ["Complete", "Pin", "Unpin"] {
            let b = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
            if b.exists { note("[\(name)] row action showing: \(describe(b))") }
        }
    }

    // MARK: gestures

    /// A finger's drag along a horizontal line, in window points from the window's top-left.
    func drag(_ app: XCUIApplication, fromX: CGFloat, toX: CGFloat, atY: CGFloat, _ name: String) {
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        let y = window.frame.height * atY
        note("[\(name)] drag from (\(Int(fromX)), \(Int(y))) to (\(Int(toX)), \(Int(y)))")
        origin.withOffset(CGVector(dx: fromX, dy: y))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: toX, dy: y)),
                   withVelocity: XCUIGestureVelocity(900), thenHoldForDuration: 0.05)
    }

    /// The system's sidebar button — the one way to bring the column back today.
    func tapSidebarButton(_ app: XCUIApplication, _ name: String) {
        let query = app.buttons.matching(NSPredicate(
            format: "label CONTAINS[c] 'sidebar' OR identifier CONTAINS[c] 'sidebar'"))
        let all = query.allElementsBoundByIndex
        note("[\(name)] sidebar buttons: \(all.map(describe))")
        guard let button = all.first(where: { $0.isHittable }) else {
            note("[\(name)] no sidebar button to press")
            tree(app, "missing-sidebar-button-\(name)")
            return
        }
        button.tap()
        settle(2)
    }

    func tapButton(_ app: XCUIApplication, _ label: String, _ name: String) {
        let button = app.buttons[label]
        guard button.waitForExistence(timeout: 8) else {
            note("[\(name)] no \(label) button")
            tree(app, "missing-\(name)")
            return
        }
        note("[\(name)] pressing \(describe(button))")
        button.tap()
        settle(2)
    }

    func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    // MARK: output

    func tree(_ app: XCUIApplication, _ name: String) {
        write(app.debugDescription, "tree-\(name).txt")
    }

    func note(_ line: String) {
        notes.append(line)
    }

    func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    func write(_ text: String, _ file: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        try? text.write(to: URL(fileURLWithPath: dir).appendingPathComponent(file), atomically: true, encoding: .utf8)
    }
}
