import XCTest

// TEMPORARY evidence probe (never merged): the managed runner's states in the iPhone app and the Mac
// app, one launch per state. Every state is a server state sample from
// src/shared/src/managed-runner-states.fixture.json, which stub.py serves; each test picks its scenario
// on the stub before launching. A state the app never draws fails its test, so a green run holds a
// picture of every state. Retry and Set up are pressed, and the stub's log shows what they sent.
final class ManagedShotTests: ProbeCase {
    /// Pick the stub's scenario, launch on `surface`, wait for `until`, photograph it as `name`.
    @discardableResult
    private func photograph(_ scenario: String, _ surface: String, until: String, _ name: String,
                            keepOpen: Bool = false) -> XCUIApplication {
        setStub("{\"scenario\": \"\(scenario)\"}")
        let app = launch(surface, reset: false, fresh: true, until: until, name)
        settle(1.5)
        shot(name)
        if !keepOpen { app.terminate() }
        return app
    }

    /// What the stub has logged, read over HTTP: the Mac test runner cannot read the host's files.
    private func stubLog() -> String {
        let answered = DispatchSemaphore(value: 0)
        let box = TextBox()
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:8765/__log")!) { data, _, _ in
            if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                box.text = object["log"] as? String ?? ""
            }
            answered.signal()
        }.resume()
        _ = answered.wait(timeout: .now() + 10)
        return box.text
    }

    final class TextBox: @unchecked Sendable {
        var text = ""
    }

    private func press(_ element: XCUIElement) {
        #if os(iOS)
        element.tap()
        #else
        element.click()
        #endif
    }

    /// Without the capability the status must never be read: no managed UI rests on a guess.
    private func expectNoStatusRead(_ scenario: String) {
        let reads = stubLog().split(separator: "\n").filter { $0.contains("[\(scenario)]") && $0.contains("GET /api/managed-runner") }
        note("\(scenario): status reads \(reads.count)")
        XCTAssertTrue(reads.isEmpty, "\(scenario): the app read the managed runner's status without the capability")
    }

    func test01CapabilityMissing() {
        photograph("capability-missing", "compose", until: "Send a task to get started", "01-capability-missing")
        expectNoStatusRead("capability-missing")
    }

    func test02CapabilityOff() {
        photograph("capability-off", "compose", until: "Send a task to get started", "02-capability-off")
        expectNoStatusRead("capability-off")
    }

    func test03Preparing() {
        photograph("preparing", "compose", until: "Preparing your managed runner", "03-preparing")
    }

    func test04WaitingCapacity() {
        photograph("waiting-capacity", "compose", until: "Waiting for capacity", "04-waiting-capacity")
    }

    func test05Available() {
        let app = photograph("available", "compose", until: "Send a task to get started", "05-available", keepOpen: true)
        XCTAssertFalse(containing(app, "Managed runner").exists, "a ready managed runner shows no banner")
        app.terminate()
    }

    func test06Sleeping() {
        photograph("sleeping", "console", until: "Managed runner asleep", "06-sleeping")
    }

    func test07Waking() {
        photograph("waking", "console", until: "Waking your managed runner", "07-waking")
    }

    func test08FailedRetry() {
        let app = photograph("failed-retry", "compose", until: "Managed runner failed", "08-failed-retry", keepOpen: true)
        let retry = button(app, beginning: "Retry")
        note("retry: \(describe(retry))")
        if retry.exists {
            press(retry)
            if appears(app, "Preparing your managed runner", timeout: 30) { shot("08b-after-retry") }
        }
        let sent = stubLog().split(separator: "\n").filter { $0.contains("BODY retry") }
        note("retry sent: \(sent)")
        XCTAssertTrue(sent.contains { $0.contains("\"revision\":9") || $0.contains("\"revision\": 9") },
                      "Retry posts the revision it read")
        app.terminate()
    }

    func test09ModelUnavailable() {
        photograph("model-unavailable", "compose", until: "Your managed runner needs a model", "09-model-unavailable")
    }

    func test10NotEligible() {
        photograph("not-eligible", "runners", until: "No managed runner", "10-not-eligible")
    }

    func test11SetUp() {
        let app = photograph("set-up", "runners", until: "Set up a managed runner", "11-set-up", keepOpen: true)
        let setUp = button(app, beginning: "Set up")
        note("set up: \(describe(setUp))")
        if setUp.exists {
            press(setUp)
            if appears(app, "Preparing your managed runner", timeout: 30) { shot("11b-after-set-up") }
        }
        XCTAssertTrue(stubLog().contains("BODY ensure"), "Set up posts the ensure")
        app.terminate()
    }

    func test12Removed() {
        photograph("removed", "compose", until: "Managed runner removed", "12-removed")
    }
}
