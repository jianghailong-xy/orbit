import XCTest

// TEMPORARY evidence probe (see ../README.md). It photographs the needs-you capsule the owner picked
// on 2026-10-21 (docs/mocks/needs-you-capsule, A) in the real iPhone shell against stub.py, light and
// dark: over an ordinary conversation while a coordinator elsewhere waits on a question (the owner's
// own screenshot, redrawn), on the session list, and inside the coordinator's conversation pointing at
// its own card. Each launch fails the test when the capsule never says what the stub served.
final class NeedsYouShotTests: ProbeCase {
    #if os(iOS)
    /// The owner's case: reading one conversation while the project's coordinator waits on a question.
    /// The capsule says what (the kind's word), where (the project), and that one more waits behind it.
    func testIPhoneCapsuleOverAConversation() {
        for dark in [false, true] {
            let name = "ios-chat-\(dark ? "dark" : "light")"
            setMode("live")
            let app = launch(until: "Question from coordinator", dark: dark, extra: ["-probe.page", "chat"], name)
            check(capsule(app), says: ["Question from coordinator", "落地会话：每次落地都有自己的会话、实时输出和 owner 门", "+1"],
                  name)
            XCTAssertTrue(appears(app, "导出好了", timeout: 20), "\(name): the conversation never showed its tail")
            shot(app, name)
            app.terminate()
        }
    }

    /// The session list carries the same capsule under its nav bar.
    func testIPhoneCapsuleOnTheSessionList() {
        for dark in [false, true] {
            let name = "ios-list-\(dark ? "dark" : "light")"
            setMode("live")
            let app = launch(until: "Question from coordinator", dark: dark, extra: ["-probe.page", "list"], name)
            check(capsule(app), says: ["Question from coordinator", "落地会话", "+1"], name)
            XCTAssertTrue(appears(app, "Rebuild the wiki articles report", timeout: 20), "\(name): the rows never showed")
            shot(app, name)
            app.terminate()
        }
    }

    /// Inside the coordinator's own conversation the capsule points at the card waiting there — one
    /// line, its chevron the way the card lies — and the question elsewhere is not what it says.
    func testIPhoneCapsuleInsideTheConversation() {
        for dark in [false, true] {
            let name = "ios-owner-\(dark ? "dark" : "light")"
            setMode("lease")
            let app = launch(until: "1 waiting", dark: dark, extra: ["-probe.page", "owner"], name)
            check(capsule(app), says: ["1 waiting"], name)
            XCTAssertFalse(capsule(app).label.contains("Question from coordinator"),
                           "\(name): the conversation's own card wins over the question elsewhere")
            shot(app, name)
            app.terminate()
        }
    }

    // MARK: -

    private func capsule(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "needs-you-bar").firstMatch
    }

    private func check(_ capsule: XCUIElement, says words: [String], _ name: String) {
        XCTAssertTrue(waitUntil(20) { capsule.exists }, "\(name): no needs-you capsule")
        guard capsule.exists else { return }
        note("\(name): capsule `\(capsule.label)` at \(capsule.frame)")
        for word in words {
            XCTAssertTrue(capsule.label.contains(word), "\(name): the capsule never says `\(word)` (`\(capsule.label)`)")
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
