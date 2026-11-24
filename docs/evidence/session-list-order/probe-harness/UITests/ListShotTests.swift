import XCTest

// TEMPORARY evidence probe (see ../README.md). The workspace's session list on the iPhone against
// stub.py: five running sessions and one asking the owner a question. Two launches: the list as the
// stub first serves it (`list-1`), then after activity only — five sessions streamed, previews
// changed, nothing the owner would notice (POST /__tick) — on a fresh launch (`list-2`).
// Whether the rows kept their order between the two pictures is the point.
final class ListShotTests: ProbeCase {
    private let first = "UI copy check"

    func testIPhoneListKeepsItsOrderThroughActivity() {
        var app = launch(until: first, "list-1")
        shot(app, "list-1")
        write(app.debugDescription, "tree-list-1.txt")
        app.terminate()

        post("__tick")
        settle(1)
        app = relaunch(until: first, "list-2")
        shot(app, "list-2")
        write(app.debugDescription, "tree-list-2.txt")
        write(requestsLog(), "requests.log")
    }

    /// The same launch without putting the stub back first: the tick has to survive.
    private func relaunch(until label: String, _ name: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        if !appears(app, label, timeout: 45) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed")
        }
        settle(2)
        return app
    }

    private func post(_ path: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/\(path)")!)
        request.httpMethod = "POST"
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 15)
    }
}
