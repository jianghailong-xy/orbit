import XCTest

// TEMPORARY evidence probe (owner, 2026-11-15: 「3d 和倒三角的位置」). On the session list, with two
// waiting, it photographs the needs-you capsule folded, then presses it and photographs it unfolded,
// so the folded ⌄ and the unfolded ↑ can be compared with the age beside them, on the tree before
// and after the change. Each launch fails the test when the capsule never says what the stub served.
final class NeedsYouShotTests: ProbeCase {
    #if os(iOS)
    func testIPhoneFoldAndUnfoldOnTheSessionList() {
        for dark in [true, false] {
            let name = "ios-list-\(dark ? "dark" : "light")"
            setMode("live")
            let app = launch(until: "Question from coordinator", dark: dark, extra: ["-probe.page", "list"], name)
            let bar = app.buttons.matching(identifier: "needs-you-bar").firstMatch
            XCTAssertTrue(waitUntil(20) { bar.exists }, "\(name): no needs-you capsule")
            XCTAssertTrue(appears(app, "Rebuild the wiki articles report", timeout: 20), "\(name): the rows never showed")
            note("\(name)-folded: capsule `\(bar.label)` at \(bar.frame)")
            settle(1.5)
            shot(app, "\(name)-folded")
            press(bar)
            let collapse = app.buttons["Collapse"]
            XCTAssertTrue(waitUntil(10) { collapse.exists }, "\(name): the press never unfolded the capsule")
            settle(1.5)
            for (i, b) in app.buttons.matching(identifier: "needs-you-bar").allElementsBoundByIndex.enumerated() {
                note("\(name)-unfolded: capsule \(i) `\(b.label)` at \(b.frame)")
            }
            if collapse.exists { note("\(name)-unfolded: Collapse at \(collapse.frame)") }
            shot(app, "\(name)-unfolded")
            app.terminate()
        }
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
