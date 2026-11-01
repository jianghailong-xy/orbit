import XCTest

// TEMPORARY evidence probe (never merged): a wiki document's diagram, drawn in the iPhone and Mac apps' own Wiki against
// .wdg-probe/stub.py (task 34noHca21KQGtUeAq3gJN). Each launch opens one of the stub's three documents — the shared
// fixture's, with one diagram block after its first section's paragraph: `diagram-fits`, `diagram-wide`,
// `diagram-broken`. A drawn diagram is the one element named "Diagram" (WikiDocCopy.diagram, the web figure's
// aria-label). While Mermaid draws, it stands at the web's 120 pt plus the figure's padding (144 pt); once drawn, at the
// diagram's own height plus that padding — so its frame says whether, and how big, it was drawn. A figure that never
// shows, a page that does not move under a drag or wheel started on the diagram, a wide diagram that does not move
// sideways, or a broken source drawn as a figure instead of shown as code fails the test; the pictures are taken anyway.
final class DiagramShotTests: ProbeCase {
    private let figureName = "Diagram"
    /// The figure while Mermaid draws: the web's 120 px, and 12 pt of padding above and below.
    private let drawingHeight: CGFloat = 144
    /// Words only the broken source holds.
    private let brokenWords = "Lease expired"

    #if os(iOS)
    private let platform = "ios"
    #else
    private let platform = "mac"
    #endif

    // MARK: the cases

    func testFitsLight() { fits(dark: false) }

    func testFitsDark() { fits(dark: true) }

    func testWideScrollsSideways() {
        let tag = "\(platform)-wide-light"
        let app = open("diagram-wide", dark: false, tag)
        guard let figure = drawn(app, tag) else { return shot(tag) }
        XCTAssertLessThan(figure.frame.height, 300, "\(tag): a one-row flowchart drew taller than the figure allows")
        shot(tag)
        let before = figure.screenshot().pngRepresentation
        shot(figure, "\(tag)-figure")
        #if os(iOS)
        figure.swipeLeft()
        #else
        let middle = figure.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        middle.hover()
        middle.scroll(byDeltaX: -300, deltaY: 0)
        #endif
        settle(1.5)
        let after = figure.screenshot().pngRepresentation
        note("\(tag): after the sideways move: \(describe(figure))")
        shot("\(tag)-scrolled")
        shot(figure, "\(tag)-figure-scrolled")
        XCTAssertNotEqual(before, after, "\(tag): a sideways move on the diagram did not move it")
        passThrough(app, figure, tag)
    }

    func testBrokenShowsItsSourceAsCode() {
        let tag = "\(platform)-broken-light"
        let app = open("diagram-broken", dark: false, tag)
        let code = codeText(app)
        let (top, bottom) = band(app)
        bring(app, code, between: top, and: bottom, missingIsAbove: false, "\(tag)-code")
        guard code.waitForExistence(timeout: 30) else {
            write(app.debugDescription, "missing-code-\(tag).txt")
            XCTFail("\(tag): the source Mermaid rejects never showed as code")
            return shot(tag)
        }
        settle(2)
        let figures = figuresNamed(app).count
        note("\(tag): the source as code: \(describe(code)); elements named \(figureName): \(figures)")
        XCTAssertEqual(figures, 0, "\(tag): a source Mermaid rejects still stands as a figure")
        shot(tag)
        shot(code, "\(tag)-code")
        // Not asserted: the code block's sideways scroll view is the page's own, from before this task.
        let above = code.frame.minY
        let middle = code.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        #if os(iOS)
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: -120)),
                     withVelocity: .slow, thenHoldForDuration: 0.6)
        #else
        middle.hover()
        middle.scroll(byDeltaX: 0, deltaY: -60)
        #endif
        settle(1.5)
        note("\(tag): a vertical move started on the code block took its top from \(above) to \(code.exists ? "\(code.frame.minY)" : "(gone)")")
    }

    /// The broken source's code block: a label on the iPhone, a value on the Mac.
    private func codeText(_ app: XCUIApplication) -> XCUIElement {
        #if os(iOS)
        return containing(app, brokenWords)
        #else
        return app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", brokenWords)).firstMatch
        #endif
    }

    // MARK: steps

    private func fits(dark: Bool) {
        let tag = "\(platform)-diagram-\(dark ? "dark" : "light")"
        let app = open("diagram-fits", dark: dark, tag)
        guard let figure = drawn(app, tag) else { return shot(tag) }
        XCTAssertGreaterThan(figure.frame.height, 300, "\(tag): the figure did not take the diagram's own height")
        XCTAssertEqual(figuresNamed(app).count, 1, "\(tag): one diagram block, one figure")
        shot(tag)
        shot(figure, "\(tag)-figure")
        if !dark { passThrough(app, figure, tag) }
    }

    private func open(_ slug: String, dark: Bool, _ tag: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.slug", slug, "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            + (dark ? ["-dark"] : [])
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(tag): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        // The page's own words once the document is read: its reader-and-scope block.
        if !appears(app, "Question", timeout: 45) {
            write(app.debugDescription, "missing-page-\(tag).txt")
            XCTFail("\(tag): the document page never showed — the app did not render the stub's document")
        }
        settle(2)
        return app
    }

    private func figuresNamed(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR title == %@", figureName, figureName))
    }

    /// Where a picture wants the figure: under the bar, above the tab bar or the window's bottom edge.
    private func band(_ app: XCUIApplication) -> (CGFloat, CGFloat) {
        let window = app.windows.firstMatch.frame
        #if os(iOS)
        return (window.minY + 120, window.maxY - 100)
        #else
        return (window.minY + 70, window.maxY - 10)
        #endif
    }

    /// The figure, on screen, once its height has left the drawing height and held still for two reads.
    private func drawn(_ app: XCUIApplication, _ tag: String) -> XCUIElement? {
        let figure = figuresNamed(app).firstMatch
        let (top, bottom) = band(app)
        bring(app, figure, between: top, and: bottom, missingIsAbove: false, "\(tag)-figure")
        guard figure.waitForExistence(timeout: 20) else {
            write(app.debugDescription, "missing-figure-\(tag).txt")
            XCTFail("\(tag): no element named \(figureName) — the diagram block was not drawn as a figure")
            return nil
        }
        var last = figure.frame.height
        var still = 0
        let deadline = Date().addingTimeInterval(40)
        while still < 2, Date() < deadline {
            settle(1)
            let height = figure.frame.height
            still = height == last && height != drawingHeight ? still + 1 : 0
            last = height
        }
        if last == drawingHeight { note("\(tag): the figure still stands at the drawing height after 40 s") }
        bring(app, figure, between: top, and: bottom, missingIsAbove: false, "\(tag)-drawn")
        note("\(tag): drawn figure: \(describe(figure))")
        tree(app, tag)
        return figure
    }

    /// A vertical drag (iPhone) or wheel (Mac) that starts on the diagram moves the page: the web view is a picture.
    private func passThrough(_ app: XCUIApplication, _ figure: XCUIElement, _ tag: String) {
        let before = figure.frame.minY
        let middle = figure.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        #if os(iOS)
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: -120)),
                     withVelocity: .slow, thenHoldForDuration: 0.6)
        #else
        middle.hover()
        middle.scroll(byDeltaX: 0, deltaY: -60)
        #endif
        settle(1.5)
        let after = figure.exists ? figure.frame.minY : .nan
        note("\(tag): a vertical move started on the diagram took its top from \(before) to \(after)")
        XCTAssertLessThan(after, before - 20, "\(tag): the page did not move under a drag or wheel started on the diagram")
    }
}
