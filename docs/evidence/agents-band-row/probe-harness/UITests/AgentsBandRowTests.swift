import XCTest

// TEMPORARY evidence probe (never merged). The Agents row in the parking strip above the composer, with
// the owner's example: a run going on DeepSeek V4.1 Flash 1017 (the session is on Opus 5.5) and one failed.
final class AgentsBandRowTests: ProbeCase {
    func testRunningOnAnotherModelWithAFailure() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/band")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
        let app = launch(until: "I'll hand this to a SubAgent", extra: ["-probe.page", "chat"], "ios-band")
        if !appears(app, "1 failed", timeout: 20) { XCTFail("the Agents row never showed 1 failed") }
        settle(1.5)
        shot(app, "ios-1-agents-row")
        write(app.debugDescription, "tree-ios-band.txt")
        app.terminate()
    }
}
