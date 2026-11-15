import XCTest

// TEMPORARY evidence probe (see ../README.md). It photographs the needs-you capsule the owner picked
// on 2026-10-21 (docs/mocks/needs-you-capsule, A) in the real iPhone shell against stub.py, light and
// dark: over an ordinary conversation while a coordinator elsewhere waits on a question (the owner's
// own screenshot, redrawn), on the session list, and inside the coordinator's conversation pointing at
// its own card. Each launch fails the test when the capsule never says what the stub served.
final class NeedsYouShotTests: ProbeCase {
    #if os(iOS)
    /// 2026-11-15 (the owner's beta.6 screenshot): the capsule over the session list was squeezed to its
    /// glyph and an ellipsis, folded and unfolded, because what it hangs from had no width. Folded it
    /// spans the list less its margins; pressed with two waiting, each unfolded capsule does too.
    func testIPhoneCapsuleOnTheSessionList() {
        for dark in [false, true] {
            let name = "ios-list-\(dark ? "dark" : "light")"
            setMode("live")
            let app = launch(until: "Rebuild the wiki articles report", dark: dark, extra: ["-probe.page", "list"], name)
            let bar = capsule(app)
            XCTAssertTrue(waitUntil(20) { bar.exists }, "\(name): no needs-you capsule")
            guard bar.exists else { app.terminate(); continue }
            note("\(name) folded: `\(bar.label)` at \(bar.frame)")
            XCTAssertGreaterThan(bar.frame.width, 300, "\(name): the folded capsule is squeezed (\(bar.frame))")
            settle()
            shot(app, name + "-folded")
            // The glass (2026-11-15, 10-glass): rows scrolled up behind the card should show through it, blurred.
            let list = app.collectionViews.firstMatch
            if list.exists {
                let from = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
                from.press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)))
                settle(1.2)
                shot(app, name + "-scrolled")
                let back = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
                back.press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
                settle(1.2)
            }
            press(bar)
            XCTAssertTrue(waitUntil(10) { app.buttons.matching(identifier: "needs-you-bar").count >= 2 },
                          "\(name): pressing two waiting never unfolded them")
            settle()
            let stack = app.buttons.matching(identifier: "needs-you-bar").allElementsBoundByIndex
            for (index, one) in stack.enumerated() {
                note("\(name) unfolded #\(index): `\(one.label)` at \(one.frame)")
                XCTAssertGreaterThan(one.frame.width, 300, "\(name): unfolded capsule \(index) is squeezed (\(one.frame))")
            }
            let tops = stack.map(\.frame.minY).sorted()
            XCTAssertGreaterThanOrEqual((tops.last ?? 0) - (tops.first ?? 0), 60,
                                        "\(name): the unfolded cards sit on top of each other (\(tops))")
            shot(app, name + "-unfolded")
            app.terminate()
        }
    }

    // MARK: -

    private func capsule(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "needs-you-bar").firstMatch
    }

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }
    #endif
}
