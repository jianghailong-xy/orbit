import XCTest

// TEMPORARY evidence probe (see ../README.md), copied from docs/evidence/landing-page-fixes for task
// 34jTrtQ1h6ufNX0JSKuLA. It drives the real iPhone and Mac apps against stub.py and photographs the
// landing page's status card:
//   ① a merge check (CHECK_PROMOTION) that ended READY: the card says `Passed the check · waiting for
//     the owner`, and nothing on the page says `Stopped · not landed`;
//   ② (iPhone) a task landing the owner stopped (CANCELLED): its card still says `Stopped · not landed`.
// A state the stub never drove fails the test, and every picture and tree is kept anyway.
final class LandingReadyCardTests: ProbeCase {
    #if os(iOS)
    func testIPhoneMergeCheckThatEndedReadyWritesNoStoppedLine() {
        setMode("ready")
        let app = launch(until: Self.passed, extra: ["-probe.page", "landing"], "ready")
        assertTheReadyCard(app, "ios-1-ready-card")
        shot(app, "ios-1-ready-card")
        app.terminate()
    }

    func testIPhoneCancelledLandingStillSaysItStopped() {
        setMode("cancelled")
        let app = launch(until: "Stop requested", extra: ["-probe.page", "landing"], "cancelled")
        assertTheStoppedCard(app, "ios-2-cancelled-card", firstLine: "Queued to land on project/P1")
        shot(app, "ios-2-cancelled-card")
        app.terminate()
    }
    #endif

    #if os(macOS)
    func testMacMergeCheckThatEndedReadyWritesNoStoppedLine() {
        setMode("ready")
        let app = launch(until: Self.passed, extra: ["-probe.page", "landing"], "mac-ready")
        assertTheReadyCard(app, "mac-1-ready-card")
        shot(app, "mac-1-ready-card")
        app.terminate()
    }
    #endif

    private static let passed = "Passed the check · waiting for the owner"
    private static let stopped = "Stopped · not landed"

    /// The head says the check passed and waits for the owner, and no text on the page says it stopped.
    private func assertTheReadyCard(_ app: XCUIApplication, _ name: String) {
        XCTAssertTrue(appears(app, "Ready to merge into main", timeout: 20), "the round's timeline never showed")
        settle(1)
        let head = ["Merge check", "Ready", Self.passed].map { words in
            "\(words): \(texts(app, exactly: words).map { "\($0.frame)" }.joined(separator: ", "))"
        }
        let stopped = texts(app, containing: Self.stopped)
        note("\(name): head\n  " + head.joined(separator: "\n  "))
        note("\(name): texts containing `\(Self.stopped)`: \(stopped.count)")
        write(app.debugDescription, "\(name)-tree.txt")
        XCTAssertFalse(texts(app, exactly: Self.passed).isEmpty, "the card never said the check passed")
        XCTAssertEqual(stopped.count, 0, "a merge check that ended READY writes no `\(Self.stopped)`")
    }

    /// A landing that really stopped: the card, above the timeline's first line, still says so.
    private func assertTheStoppedCard(_ app: XCUIApplication, _ name: String, firstLine: String) {
        XCTAssertTrue(appears(app, firstLine, timeout: 20), "the timeline never showed")
        settle(1)
        let line = texts(app, exactly: firstLine).first
        let limit = line?.frame.minY ?? .greatestFiniteMagnitude
        let all = texts(app, exactly: Self.stopped)
        let inCard = all.filter { $0.frame.minY < limit }
        note("\(name): `\(Self.stopped)` at \(all.map { "\($0.frame)" }.joined(separator: ", ")); "
            + "the timeline starts at y=\(limit); \(inCard.count) in the card")
        write(app.debugDescription, "\(name)-tree.txt")
        // The head's detail and the line under it (the timeline's own result line says it too).
        XCTAssertGreaterThanOrEqual(inCard.count, 2, "a stopped landing's card still says `\(Self.stopped)`")
    }

    /// Text elements that say exactly these words (iOS by `label`, Mac by `value`).
    private func texts(_ app: XCUIApplication, exactly words: String) -> [XCUIElement] {
        #if os(macOS)
        let predicate = NSPredicate(format: "value == %@", words)
        #else
        let predicate = NSPredicate(format: "label == %@", words)
        #endif
        return app.staticTexts.matching(predicate).allElementsBoundByIndex.filter { $0.exists }
    }

    /// Any element whose label carries these words, and on the Mac any text whose value does (a
    /// control's value need not be a string, so only texts are asked for theirs).
    private func texts(_ app: XCUIApplication, containing words: String) -> [XCUIElement] {
        var found = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words))
            .allElementsBoundByIndex.filter { $0.exists }
        #if os(macOS)
        found += app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", words))
            .allElementsBoundByIndex.filter { $0.exists }
        #endif
        return found
    }

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }
}
