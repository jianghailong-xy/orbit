import XCTest

// TEMPORARY evidence probe (never merged). The bottom session search on an iOS 26 iPhone, owner board
// docs/mocks/ios-search-mode-like-notes: search mode ends only at the X. Each step is photographed
// and the tree around the bottom bar is written down; the stub's requests.log carries every tap's
// view chain (TapLogger) so the X's make-up is on record.
final class SearchModeTests: ProbeCase {
    #if os(iOS)
    private func open(_ name: String, short: Bool = false) -> XCUIApplication {
        setMode(short ? "short" : "live")
        let app = launch(until: "Rebuild the wiki articles report", extra: ["-probe.page", "list"], name)
        let field = app.searchFields.firstMatch
        XCTAssertTrue(waitUntil(15) { field.exists }, "\(name): no search field")
        field.tap()
        settle(1.5)
        state(app, "\(name)-a-opened")
        return app
    }

    /// What the screen says about search mode: keyboard, field, and every button low on the screen.
    @discardableResult
    private func state(_ app: XCUIApplication, _ name: String) -> (keyboard: Bool, close: XCUIElement?) {
        shot(app, name)
        let keyboard = app.keyboards.count > 0
        let field = app.searchFields.firstMatch
        var lines = ["\(name): keyboard=\(keyboard) field.exists=\(field.exists)"
                     + (field.exists ? " frame=\(field.frame) value=`\(field.value ?? "")`" : "")]
        let low = app.buttons.allElementsBoundByIndex.filter { $0.exists && $0.frame.minY > 500 && $0.frame.minY < 1000 }
        for b in low { lines.append("  button `\(b.label)` id=`\(b.identifier)` frame=\(b.frame)") }
        lines.forEach(note)
        write(app.debugDescription, "\(name)-tree.txt")
        return (keyboard, closeButton(app))
    }

    /// The X beside the bottom field: a button labelled exactly `close` (round 1's tree).
    private func closeButton(_ app: XCUIApplication) -> XCUIElement? {
        let x = app.buttons.matching(NSPredicate(format: "label ==[c] 'close'")).firstMatch
        return x.exists && x.isHittable ? x : nil
    }

    /// A real finger drag over the rows above the keyboard.
    private func drag(_ app: XCUIApplication, from: CGFloat, to: CGFloat) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to)),
                   withVelocity: .fast, thenHoldForDuration: 0.1)
    }

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }

    /// ③ A scroll lowers the keyboard; search mode stays, X and all.
    func test1ScrollKeepsSearchMode() {
        let app = open("scroll")
        drag(app, from: 0.45, to: 0.15)
        settle(2)
        let s = state(app, "scroll-b-after-swipe")
        XCTAssertFalse(s.keyboard, "scroll: the keyboard stayed up")
        XCTAssertNotNil(s.close, "scroll: search mode ended (no X)")
        drag(app, from: 0.3, to: 0.8)
        settle(2)
        let t = state(app, "scroll-c-back-up")
        XCTAssertNotNil(t.close, "scroll back up: search mode ended (no X)")
        app.terminate()
    }

    /// ③ A tap on the list's background lowers the keyboard; search mode stays.
    func test2TapElsewhereKeepsSearchMode() {
        // A short list, so there is empty list below its last row to tap.
        let app = open("tap", short: true)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.53)).tap()
        settle(2)
        let s = state(app, "tap-b-after-tap")
        XCTAssertFalse(s.keyboard, "tap: the keyboard stayed up")
        XCTAssertNotNil(s.close, "tap: search mode ended (no X)")
        app.terminate()
    }

    /// ⑤ The X ends search mode — with the keyboard up, and again with it down.
    func test3CloseEndsSearchMode() {
        let app = open("close")
        guard let x = closeButton(app) else { XCTFail("close: no X while searching"); return }
        note("close: X is `\(x.label)` id=`\(x.identifier)` at \(x.frame)")
        x.tap()
        settle(2)
        let s = state(app, "close-b-after-x-keyboard-up")
        XCTAssertNil(s.close, "close (keyboard up): search mode came back after the X")

        let field = app.searchFields.firstMatch
        field.tap()
        settle(1.5)
        drag(app, from: 0.45, to: 0.15)
        settle(2)
        state(app, "close-c-scrolled")
        guard let x2 = closeButton(app) else { XCTFail("close: no X after the scroll"); return }
        x2.tap()
        settle(2)
        let t = state(app, "close-d-after-x-keyboard-down")
        XCTAssertNil(t.close, "close (keyboard down): search mode came back after the X")
        app.terminate()
    }

    /// ④ A query survives a scroll, a result opened and the way back.
    func test4QuerySurvivesAPush() {
        let app = open("query")
        app.typeText("ledger")
        settle(2)
        state(app, "query-b-typed")
        drag(app, from: 0.45, to: 0.15)
        settle(2)
        let s = state(app, "query-c-scrolled")
        XCTAssertNotNil(s.close, "query: search mode ended on the scroll")
        // A hit clear of the needs-you capsule at the top.
        let hits = app.buttons.matching(NSPredicate(format: "label CONTAINS 'in message'"))
        let hit = hits.allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > 250 && $0.frame.maxY < 800 } ?? hits.firstMatch
        if waitUntil(5, { hit.exists && hit.isHittable }) {
            hit.tap()
            settle(3)
            state(app, "query-d-opened")
            let back = app.navigationBars.buttons.firstMatch
            if back.exists { back.tap() } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
            }
            settle(3)
            let t = state(app, "query-e-back")
            XCTAssertEqual(app.searchFields.firstMatch.value as? String, "ledger", "query: the query did not survive the push")
            XCTAssertNotNil(t.close, "query: search mode ended across the push")
            if let x = t.close {
                x.tap()
                settle(2)
                let u = state(app, "query-f-after-x")
                XCTAssertNil(u.close, "query: search mode came back after the X")
                XCTAssertFalse((app.searchFields.firstMatch.value as? String ?? "").contains("ledger"), "query: the X left the query")
            }
        } else {
            XCTFail("query: no hit to open")
        }
        app.terminate()
    }

    /// ② A row opened from an empty search, then back: search mode is still there.
    func test5EmptySearchSurvivesAPush() {
        let app = open("push")
        let row = app.staticTexts["Wiki page creation flow"].firstMatch
        if waitUntil(5, { row.exists && row.isHittable }) { row.tap() } else { XCTFail("push: no row"); return }
        settle(3)
        state(app, "push-b-opened")
        let back = app.navigationBars.buttons.firstMatch
        if back.exists { back.tap() }
        settle(3)
        let t = state(app, "push-c-back")
        XCTAssertFalse(t.keyboard, "push: the keyboard came back with the list")
        XCTAssertNotNil(t.close, "push: search mode ended across the push")
        app.terminate()
    }
    #endif
}
