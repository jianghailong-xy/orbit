import XCTest

// TEMPORARY evidence probe (see ../README.md), copied from docs/evidence/landing-session-followup for
// task 34jQkOSz5CENWMRYAWVHC. It drives the real iPhone and Mac apps against stub.py and photographs
// what that task fixed:
//   ① a merge check that ended READY: its result line `Ready to merge into main` draws ✓;
//   ② a failed check's output loads inline under its line, with no press on `Log ›`;
//   ③ (iPhone) the Earlier fold opens when the empty middle of its row is pressed.
// A state the stub never drove fails the test, and every picture is kept anyway.
final class LandingPageFixesTests: ProbeCase {
    #if os(iOS)
    func testIPhoneMergeCheckThatEndedReadyDrawsACheckmark() {
        setMode("ready")
        let app = launch(until: "Ready to merge into main", extra: ["-probe.page", "landing"], "ready")
        bring(app, element(app, containing: "Ready to merge into main"), between: 260, and: 720, "ready")
        shot(app, "ios-1-ready-result")
        assertMarks(app, "ready")
        app.terminate()
    }

    func testIPhoneFailedCheckOutputLoadsInline() {
        setMode("failed")
        let app = launch(until: "Task acceptance failed", extra: ["-probe.page", "landing"], "failed")
        XCTAssertTrue(appears(app, Self.tail, timeout: 30), "the failed check's tail never loaded inline")
        bring(app, element(app, containing: Self.tail), between: 200, and: 760, "failed")
        shot(app, "ios-2-failed-inline")
        assertTheLogWasRead("failed")
        app.terminate()
    }

    /// The bare fold over a cancelled, a handled and a declined landing (stub mode `earlier-bare`),
    /// pressed on the empty middle of its row: right of its word, left of its chevron.
    func testIPhoneEarlierFoldOpensFromTheEmptyMiddleOfItsRow() {
        setMode("earlier-bare")
        let app = launch(until: "Landings", extra: ["-probe.page", "sessions"], "fold")
        XCTAssertTrue(appears(app, "Checks failed", timeout: 20), "the group's waiting landing never showed")
        bring(app, element(app, containing: "Landings"), between: 90, and: 520, "fold")
        XCTAssertTrue(appears(app, "Earlier", timeout: 20), "the bare fold never showed")
        XCTAssertFalse(appears(app, "Retire the v1 ledger", timeout: 2), "the fold starts closed")
        // The fold is the widest hittable button whose label carries the word: the whole row.
        let fold = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Earlier")).allElementsBoundByIndex
            .filter { $0.exists && $0.isHittable }
            .max(by: { $0.frame.width < $1.frame.width })
        let word = app.staticTexts.matching(NSPredicate(format: "label == %@", "Earlier")).allElementsBoundByIndex
            .first(where: { $0.exists && $0.isHittable })
        guard let fold else {
            write(app.debugDescription, "fold-missing.txt")
            shot(app, "ios-3-fold-missing")
            return XCTFail("the fold's button is not on the page")
        }
        let row = fold.frame
        // Without the word's own frame, the word still ends well left of the row's centre.
        let wordEnd = word?.frame.maxX ?? (row.minX + row.width * 0.3)
        let x = (wordEnd + row.maxX - 32) / 2
        let y = row.midY
        note("fold row \(row), word \(word.map { "\($0.frame)" } ?? "not in the tree"), press at (\(x), \(y))")
        write("x=\(x) y=\(y) row=\(row) word=\(word.map { "\($0.frame)" } ?? "none")", "ios-3-press.txt")
        XCTAssertGreaterThan(x, wordEnd + 24, "the press is clear of the word")
        XCTAssertLessThan(x, row.maxX - 48, "and clear of the chevron")
        shot(app, "ios-3-fold-before")
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
        for title in ["Retire the v1 ledger", "Webhook retry cap", "main · #2"] {
            XCTAssertTrue(appears(app, title, timeout: 20), "the fold never opened onto `\(title)`")
        }
        settle(1)
        shot(app, "ios-3-fold-after")
        app.terminate()
    }
    #endif

    #if os(macOS)
    func testMacMergeCheckThatEndedReadyDrawsACheckmark() {
        setMode("ready")
        let app = launch(until: "Ready to merge into main", extra: ["-probe.page", "landing"], "mac-ready")
        bring(app, element(app, containing: "Ready to merge into main"), between: 200, and: 680, "mac-ready")
        shot(app, "mac-1-ready-result")
        assertMarks(app, "mac-ready")
        app.terminate()
    }

    func testMacFailedCheckOutputLoadsInline() {
        setMode("failed")
        let app = launch(until: "Task acceptance failed", extra: ["-probe.page", "landing"], "mac-failed")
        XCTAssertTrue(appears(app, Self.tail, timeout: 30), "the failed check's tail never loaded inline")
        bring(app, element(app, containing: Self.tail), between: 200, and: 700, "mac-failed")
        shot(app, "mac-2-failed-inline")
        assertTheLogWasRead("mac-failed")
        app.terminate()
    }
    #endif

    /// A line of the failing tail the stub's landing log serves for check 1 (`failing_log`).
    private static let tail = "AssertionError: expected"

    /// The result line's mark, and the passed check's above it, read off the tree by position.
    private func assertMarks(_ app: XCUIApplication, _ name: String) {
        let result = mark(app, beside: "Ready to merge into main")
        let check = mark(app, beside: "Merge check passed")
        note("\(name): result line mark \(result ?? "none"), check line mark \(check ?? "none")")
        XCTAssertEqual(result, "✓", "a merge check that ended READY draws ✓ on its result line")
        XCTAssertEqual(check, "✓", "the passed check keeps its ✓")
        if result != "✓" || check != "✓" { write(app.debugDescription, "\(name)-tree.txt") }
    }

    /// The inline tail came from the page's own read of the failed check's log: no `Log ›` was pressed.
    private func assertTheLogWasRead(_ name: String) {
        let reads = requestsLog().components(separatedBy: "\n").filter { $0.contains("/landing/log") }
        note("\(name): landing log reads\n" + reads.joined(separator: "\n"))
        XCTAssertTrue(reads.contains { $0.contains("check=1") }, "the page never read the failed check's log")
    }

    /// The glyph drawn on the same row as these words, left of them: the timeline's mark.
    private func mark(_ app: XCUIApplication, beside words: String) -> String? {
        let line = element(app, containing: words)
        guard line.exists else { return nil }
        let text = line.frame
        var best: (glyph: String, distance: CGFloat)?
        for glyph in ["✓", "✗", "↻", "≡", "↗", "↩"] {
            #if os(macOS)
            let query = app.staticTexts.matching(NSPredicate(format: "value == %@", glyph))
            #else
            let query = app.staticTexts.matching(NSPredicate(format: "label == %@", glyph))
            #endif
            for candidate in query.allElementsBoundByIndex where candidate.exists {
                let frame = candidate.frame
                // Left of the words, and on their first line (the row aligns on the first baseline).
                let distance = abs(frame.midY - (text.minY + min(text.height, 22) / 2))
                guard frame.maxX <= text.minX + 1, text.minX - frame.maxX < 40, distance < 12 else { continue }
                if best == nil || distance < best!.distance { best = (glyph, distance) }
            }
        }
        return best?.glyph
    }

    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }
}
