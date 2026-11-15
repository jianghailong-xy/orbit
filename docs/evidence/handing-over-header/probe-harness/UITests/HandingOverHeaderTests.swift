import XCTest

// TEMPORARY evidence probe (never merged). The outgoing coordinator's conversation while its handoff
// note is being written (board 02-2): the Mac header band leads with "Handing over"; the same
// conversation with no handoff keeps its run word; the iPhone draws the handoff row and the locked
// composer (its nav bar carries no run state). `-probe.page owner` opens coordinator session C1.
final class HandingOverHeaderTests: ProbeCase {
    #if os(macOS)
    /// The header band's one text: "run word · lifecycle · when" (Mac text is in `value`).
    private func header(_ app: XCUIApplication, beginning words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", words)).firstMatch
    }

    func testMacHeaderWhileWritingTheNote() {
        setMode("handoff-writing")
        let app = launch(until: "Writing the handoff note", extra: ["-probe.page", "owner"], "mac-writing")
        let band = header(app, beginning: "Handing over · ")
        if !waitUntil(30, { band.exists }) {
            write(app.debugDescription, "missing-header-mac-writing.txt")
            XCTFail("the header band never led with \"Handing over · \"")
        } else {
            note("mac-writing header: \(String(describing: band.value ?? ""))")
        }
        XCTAssertTrue(appears(app, "Coordinator", timeout: 10), "the Coordinator badge never showed")
        settle(1)
        shot(app, "mac-writing")
        write(app.debugDescription, "tree-mac-writing.txt")
        app.terminate()
    }

    func testMacHeaderWithNoHandoff() {
        setMode("plain")
        let app = launch(until: "Checkout redesign", extra: ["-probe.page", "owner"], "mac-plain")
        let band = header(app, beginning: "Waiting")
        if !waitUntil(30, { band.exists }) {
            write(app.debugDescription, "missing-header-mac-plain.txt")
            XCTFail("the header band never showed its run word")
        } else {
            note("mac-plain header: \(String(describing: band.value ?? ""))")
        }
        XCTAssertFalse(header(app, beginning: "Handing over").exists,
                       "a coordinator with no handoff must not read Handing over")
        settle(1)
        shot(app, "mac-no-handoff")
        write(app.debugDescription, "tree-mac-no-handoff.txt")
        app.terminate()
    }
    #endif

    #if os(iOS)
    func testIPhoneWhileWritingTheNote() {
        setMode("handoff-writing")
        let app = launch(until: "Writing the handoff note", extra: ["-probe.page", "owner"], "ios-writing")
        XCTAssertTrue(appears(app, "Handing over to a new coordinator", timeout: 20),
                      "the locked composer never said it is handing over")
        settle(1)
        shot(app, "ios-writing")
        write(app.debugDescription, "tree-ios-writing.txt")
        app.terminate()
    }
    #endif

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }
}
