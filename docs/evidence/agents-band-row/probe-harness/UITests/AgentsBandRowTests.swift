import XCTest

// TEMPORARY evidence probe (never merged). The Agents row in the parking strip above the composer, with
// the owner's example: a run going on DeepSeek V4.1 Flash 1017 (the session is on Opus 5.5) and one failed.
final class AgentsBandRowTests: ProbeCase {
    private func run(_ mode: String, _ name: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
        // The transcript draws a typographic apostrophe: wait on words without one.
        let app = launch(until: "hand this to a SubAgent", extra: ["-probe.page", "chat"], "ios-\(mode)")
        if !appears(app, "1 failed", timeout: 20) { XCTFail("\(mode): the Agents row never showed 1 failed") }
        settle(1.5)
        shot(app, name)
        write(app.debugDescription, "tree-ios-\(mode).txt")
        app.terminate()
    }

    func testLongTitle() { run("band", "ios-1-agents-row") }
    func testShortTitle() { run("band-short", "ios-2-agents-row-short-title") }
}
