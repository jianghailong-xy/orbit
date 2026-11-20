import XCTest

// TEMPORARY evidence probe (never merged). Conversation S4 with one background SubAgent, drawn as ONE card
// from start to end (board docs/mocks/subagent-card-and-end-line): running, done, interrupted (folded and
// opened), stopped, and its end turn still queued. In every ended mode but the queued one the stub also
// serves the turn the control plane opened for the end, which must draw nothing.
final class SubagentCardEndTests: ProbeCase {
    #if os(macOS)
    private let os = "mac"
    #else
    private let os = "ios"
    #endif

    /// What the old end line or a fallback for the end turn would have shown.
    private let endTurnWords = ["SubAgent finished", "SubAgent did not finish", "From Orbit", "Orbit attached",
                                "The control plane opened this turn", "the user did not say it",
                                "call delegate with resume"]

    private func open(_ mode: String, until words: String) -> XCUIApplication {
        setMode(mode)
        return launch(until: words, extra: ["-probe.page", "chat"], "\(os)-\(mode)")
    }

    private func expect(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 15) {
        if appears(app, words, timeout: timeout) {
            note("\(name): shows \(words)")
        } else {
            write(app.debugDescription, "missing-\(name)-\(words.prefix(20)).txt")
            XCTFail("\(name): \(words) never showed")
        }
    }

    private func expectNoEndTurn(_ app: XCUIApplication, _ name: String) {
        for words in endTurnWords {
            XCTAssertFalse(element(app, containing: words).exists, "\(name): the end turn draws \(words)")
        }
    }

    func testRunning() {
        let app = open("sa-running", until: "Find every caller of pollQuota")
        let name = "\(os)-running"
        expect(app, "Sonnet 5.5", name)
        settle(1)
        shot(app, "\(os)-1-running")
        write(app.debugDescription, "tree-\(name).txt")
        app.terminate()
    }

    func testDone() {
        let app = open("sa-done", until: "Deploy 6bb50a957 to production")
        let name = "\(os)-done"
        expect(app, "3 services", name)
        expect(app, "The deploy is out", name)
        expectNoEndTurn(app, name)
        XCTAssertFalse(element(app, containing: "interrupted").exists)
        settle(1)
        shot(app, "\(os)-2-done-wake-draws-nothing")
        write(app.debugDescription, "tree-\(name).txt")
        app.terminate()
    }

    func testInterrupted() {
        let app = open("sa-interrupted", until: "Update client tests")
        let name = "\(os)-interrupted"
        expect(app, "interrupted", name)
        expect(app, "The runner hosting it stopped", name)
        expect(app, "9 files left uncommitted", name)
        expect(app, "Nothing was committed before the interruption", name)
        expectNoEndTurn(app, name)
        settle(1)
        shot(app, "\(os)-3-interrupted-folded")
        write(app.debugDescription, "tree-\(name).txt")
        let show = buttons(app, beginning: "Show files").first ?? element(app, containing: "Show files")
        press(show)
        settle(1.5)
        expect(app, "in the working tree:", name)
        expect(app, "6 more", name)
        expect(app, "What the agent read", name)
        expect(app, "Run 34y5PintrRUNid0000003", name)
        expectNoEndTurn(app, name)
        shot(app, "\(os)-4-interrupted-opened")
        write(app.debugDescription, "tree-\(name)-open.txt")
        app.terminate()
    }

    func testStopped() {
        let app = open("sa-stopped", until: "Sweep stale worktrees")
        let name = "\(os)-stopped"
        expect(app, "stopped", name)
        expect(app, "Stopped by the agent.", name)
        expect(app, "2 files left uncommitted", name)
        expectNoEndTurn(app, name)
        settle(1)
        shot(app, "\(os)-5-stopped")
        write(app.debugDescription, "tree-\(name).txt")
        app.terminate()
    }

    func testQueued() {
        let app = open("sa-queued", until: "Update client tests")
        let name = "\(os)-queued"
        expect(app, "Waiting for the agent to read it", name)
        expect(app, "Don't send", name)
        expectNoEndTurn(app, name)
        settle(1)
        shot(app, "\(os)-6-queued")
        write(app.debugDescription, "tree-\(name).txt")
        app.terminate()
    }

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }
}
