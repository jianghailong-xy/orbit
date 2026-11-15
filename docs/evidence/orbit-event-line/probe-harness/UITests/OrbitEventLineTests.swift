import XCTest

// TEMPORARY evidence probe (never merged). Conversation S4 with a turn Orbit opened carrying only a block
// no client knows (<orbit-future-thing>), then a turn the owner typed with the same block attached.
// The first is the left-side "From Orbit" line with the raw block under Details; the second keeps the
// owner's bubble and its "Orbit attached: context" line.
final class OrbitEventLineTests: ProbeCase {
    #if os(macOS)
    private let os = "mac"
    #else
    private let os = "ios"
    #endif

    private func expect(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 15) {
        if appears(app, words, timeout: timeout) {
            note("\(name): shows \(words)")
        } else {
            write(app.debugDescription, "missing-\(name)-\(words.prefix(20)).txt")
            XCTFail("\(name): \(words) never showed")
        }
    }

    func testFromOrbitLine() {
        setMode("oe")
        let app = launch(until: "From Orbit", extra: ["-probe.page", "chat"], "\(os)-oe")
        let name = "\(os)-oe"
        expect(app, "Noted. Carrying on with the card fix.", name)
        expect(app, "Ship it", name)
        expect(app, "Orbit attached: context", name)
        // Folded, the raw block is not on screen.
        XCTAssertFalse(element(app, containing: "Something the control plane will say").exists, "\(name): raw block shown folded")
        settle(1)
        shot(app, "\(os)-1-from-orbit")
        write(app.debugDescription, "tree-\(name).txt")
        press(element(app, containing: "From Orbit"))
        settle(1.5)
        expect(app, "What the agent read", name)
        expect(app, "Something the control plane will say one day.", name)
        shot(app, "\(os)-2-from-orbit-details")
        write(app.debugDescription, "tree-\(name)-open.txt")
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
