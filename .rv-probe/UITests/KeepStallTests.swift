import XCTest

#if os(iOS)
// TEMPORARY probe (never merged), task 34tKCNy9aN3Itk5SgIoIl: why the iPhone app sometimes sends nothing for 10-12 s
// after a challenge's Keep. Twenty trials per lane, each the way the stalled runs pressed Keep (ReviewShotTests'
// test3 and press(), unchanged in what they ask of the app): launch afresh against a reset stub, wait for the four
// entry reads, [open Retire…, read the dialog, Cancel], bring Keep into view, tap it, then the same screenshots and
// queries the stalled runs made. Half the trials ask the host's capture.py for its video and screenshots around the
// press, half do not; half open and cancel the Retire… dialog first. The two lanes run the same plan with the capture
// flipped, so every mode is pressed ten times in all.
//
// Just before each tap the test opens a window on the app's StallWatch (SHOTS_DIR/stallwatch-window.req): the app
// writes its main thread's stack every 100 ms for 22 s to SHOTS_DIR/stallwatch-<trial>.log. After the trial the test
// reads the stub's log for the gap between the decide's answer and the app's next request, and writes one line to
// SHOTS_DIR/trials.log. A trial whose gap is over 3 s keeps its pictures and element trees; the others keep one shot.
final class KeepStallTests: ProbeCase {
    private let entries = ["34tET9EjbYwX7laXtwrTg", "34tET9eT3M4Rq8I65iwj9", "34tET9jXOfPPMzGxWA6Sp", "34tET9mMkTx1nAiAnY9Da"]
    private let titles = ["部署生产走 orbit-prod 升级流程，无需所有者确认",
                          "session.sum_cache_read 是 int4，大会话会溢出卡死 turn-complete",
                          "session sum_* 列是 int4，长会话 cache read 累加会溢出",
                          "Claims feature deferred to wiki-claims-replay branch"]
    private let waitsNote = "Agents stop getting this entry until you answer."
    private let answers = ["Keep", "Amend\u{2026}", "Retire\u{2026}"]

    /// (capture, dialog) per trial for lane a; lane b flips the capture. Five rounds of the four modes, each round in
    /// another order.
    private let planA: [(Bool, Bool)] = [
        (false, false), (true, true), (true, false), (false, true),
        (true, false), (false, true), (false, false), (true, true),
        (false, true), (true, false), (true, true), (false, false),
        (true, true), (false, false), (false, true), (true, false),
        (false, false), (true, true), (true, false), (false, true),
    ]

    private var lane: String { ProcessInfo.processInfo.environment["LANE"] ?? "a" }
    private var shotsDir: String? { ProcessInfo.processInfo.environment["SHOTS_DIR"] }
    /// Pictures and trees held until the trial knows whether it stalled.
    private var held: [(String, Data)] = []
    private var heldTexts: [(String, String)] = []

    func test01() { trial(1) }
    func test02() { trial(2) }
    func test03() { trial(3) }
    func test04() { trial(4) }
    func test05() { trial(5) }
    func test06() { trial(6) }
    func test07() { trial(7) }
    func test08() { trial(8) }
    func test09() { trial(9) }
    func test10() { trial(10) }
    func test11() { trial(11) }
    func test12() { trial(12) }
    func test13() { trial(13) }
    func test14() { trial(14) }
    func test15() { trial(15) }
    func test16() { trial(16) }
    func test17() { trial(17) }
    func test18() { trial(18) }
    func test19() { trial(19) }
    func test20() { trial(20) }

    // MARK: one trial

    private func trial(_ k: Int) {
        let (planned, dialog) = planA[k - 1]
        let capture = lane == "b" ? !planned : planned
        let tag = String(format: "%@%02d-%@-%@", lane, k, capture ? "cap" : "nocap", dialog ? "dialog" : "plain")
        held = []
        heldTexts = []
        note("\(tag): lane \(lane), capture \(capture ? "on" : "off"), Retire… dialog first: \(dialog)")
        let app = open(tag)
        waitForEntryReads(app, tag)
        if dialog { retireThenCancel(app, tag) }
        press(app, tag: tag, capture: capture)
    }

    private func open(_ tag: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.page", "review", "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        if let dir = shotsDir {
            app.launchEnvironment["STALLWATCH_LOG"] = dir + "/stallwatch-\(tag).log"
            app.launchEnvironment["STALLWATCH_DIR"] = dir
        }
        app.launch()
        dismissSystemPrompts()
        if !seen(app, "1 of 4", timeout: 60) {
            write(app.debugDescription, "missing-\(tag).txt")
            XCTFail("\(tag): 1 of 4 never showed — the app did not render the stub's state")
        }
        settle(2)
        return app
    }

    /// As ReviewShotTests: Amend… enabled once the first card's entry was read, then all four entry reads in the log.
    private func waitForEntryReads(_ app: XCUIApplication, _ tag: String) {
        let amend = button(app, exactly: answers[1])
        var deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !(amend.exists && amend.isEnabled) { settle(1) }
        if !(amend.exists && amend.isEnabled) { note("\(tag): Amend… never enabled: \(facts(amend))") }
        deadline = Date().addingTimeInterval(20)
        var missing = entries
        while Date() < deadline {
            let log = requestsLog()
            missing = entries.filter { !log.contains("GET /api/wiki/entries/\($0)") }
            if missing.isEmpty { break }
            settle(1)
        }
        note("\(tag): entry reads not yet in the stub's log: \(missing.isEmpty ? "none" : missing.joined(separator: ", "))")
        settle(1)
    }

    /// As ReviewShotTests' test3 up to the Keep: Retire… opens the dialog, its texts are read, Cancel closes it.
    private func retireThenCancel(_ app: XCUIApplication, _ tag: String) {
        bringFoot(app, tag)
        for label in answers { note("\(tag) before: \(label): \(facts(button(app, exactly: label)))") }
        let retire = button(app, exactly: answers[2])
        guard retire.exists else { XCTFail("\(tag): no Retire…"); return }
        retire.tap()
        let alert = app.alerts.firstMatch
        guard alert.waitForExistence(timeout: 10) else {
            XCTFail("\(tag): Retire… opened no dialog")
            return
        }
        settle(1.5)
        note("\(tag): dialog: \(facts(alert))")
        for one in alert.staticTexts.allElementsBoundByIndex { note("\(tag): dialog text: \(facts(one))") }
        for one in alert.textFields.allElementsBoundByIndex { note("\(tag): dialog field: \(facts(one))") }
        for one in alert.buttons.allElementsBoundByIndex { note("\(tag): dialog button: \(facts(one))") }
        let writesBefore = decideLines().count
        hold(text: app.debugDescription, "tree-\(tag)-dialog.txt")
        snap("\(tag)-04-dialog")
        let cancel = alert.buttons.matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
        if cancel.exists { cancel.tap() } else { XCTFail("\(tag): the dialog has no Cancel") }
        settle(1.5)
        note("\(tag): after Cancel: a dialog still up: \(app.alerts.firstMatch.exists); decides sent: \(decideLines().count - writesBefore)")
        snap("\(tag)-05-after-cancel")
    }

    /// As ReviewShotTests' press(): bring Keep into view, [the host's capture], tap, then the same pictures and reads.
    private func press(_ app: XCUIApplication, tag: String, capture: Bool) {
        bringFoot(app, tag)
        let target = button(app, exactly: answers[0])
        guard target.exists else {
            XCTFail("\(tag): the card has no Keep")
            return finish(tag, capture: capture, t0: 0, t1: 0)
        }
        let frame = target.frame
        let finger = CGPoint(x: frame.midX, y: frame.midY)
        note("\(tag): the finger: \(finger), the centre of Keep \(frame)")
        note("\(tag) before: pager: \(facts(pagerText(app)))")
        snap("\(tag)-06-0-before")
        if capture {
            let running = askCapture(tag)
            note("\(tag): the host's capture \(running ? "was running" : "had NOT started") before the press")
        }
        openWatchWindow(tag)
        let t0 = epochMS()
        target.tap()
        let t1 = epochMS()
        note("\(tag): tap() called at \(t0) ms, returned at \(t1) ms (+\(t1 - t0) ms)")
        snap(String(format: "%@-06-xc-%05lldms", tag, epochMS() - t0))
        let toast = toastElement(app)
        let toastLine = toast.exists ? facts(toast) : "(not in the tree when XCUITest looked)"
        note("\(tag): +\(epochMS() - t0) ms: the toast: \(toastLine)")
        while epochMS() - t0 < 6500 {
            snap(String(format: "%@-06-xc-%05lldms", tag, epochMS() - t0))
        }
        let at = epochMS() - t0
        note("\(tag): +\(at) ms: pager: \(facts(pagerText(app)))")
        for (index, title) in titles.enumerated() {
            note("\(tag): +\(at) ms: card \(index + 1)'s title: \(facts(text(app, "==", title)))")
        }
        note("\(tag): +\(at) ms: challenged line: \(facts(text(app, "BEGINSWITH", "Challenged")))")
        for label in answers {
            let one = button(app, exactly: label)
            note("\(tag) after: \(label): \(facts(one)) under the finger: \(one.exists && one.frame.contains(finger))")
        }
        hold(text: app.debugDescription, "tree-\(tag)-after.txt")
        snap("\(tag)-06-9-after")
        if capture { waitCapture(tag) }
        finish(tag, capture: capture, t0: t0, t1: t1)
    }

    /// The gap between the decide's answer and the app's next request, from the stub's log; one line in trials.log;
    /// the held pictures and trees written out when the gap is over 3 s.
    private func finish(_ tag: String, capture: Bool, t0: Int64, t1: Int64) {
        let lines = requestsLog().split(separator: "\n").map(String.init)
        var answeredAt: Int64?
        var nextAt: Int64?
        var nextLine = ""
        for line in lines {
            guard let stamp = Self.stamp(line), stamp >= t0, t0 > 0 else { continue }
            if answeredAt == nil {
                if line.contains("\"POST /api/wiki/changesets/"), line.contains("/decide ") { answeredAt = stamp }
                continue
            }
            if line.hasPrefix("    ") || line.contains("/__reset") { continue }
            nextAt = stamp
            nextLine = line
            break
        }
        let gap = answeredAt.flatMap { a in nextAt.map { Double($0 - a) / 1000 } }
        let gapText = gap.map { String(format: "%.3f", $0) } ?? "?"
        note("\(tag): decide answered at \(answeredAt.map(String.init) ?? "?"), the app's next request at "
             + "\(nextAt.map(String.init) ?? "?") (\(nextLine)): gap \(gapText) s")
        let stalled = (gap ?? 0) > 3
        if stalled || gap == nil {
            // At most eight of the pictures, spread over the trial, so a few stalls do not flood the results.
            let step = max(1, (held.count + 7) / 8)
            for (index, shot) in held.enumerated() where index % step == 0 || index == held.count - 1 { keep(shot.1, shot.0) }
            for (name, text) in heldTexts { try? text.write(toFile: (shotsDir ?? "") + "/" + name, atomically: true, encoding: .utf8) }
        } else if let last = held.last {
            keep(last.1, last.0)
        }
        let row = "\(tag) lane=\(lane) capture=\(capture ? "on" : "off") dialog=\(tag.hasSuffix("dialog")) "
            + "t0=\(t0) t1=\(t1) tapMs=\(t1 - t0) answered=\(answeredAt.map(String.init) ?? "?") "
            + "next=\(nextAt.map(String.init) ?? "?") gap=\(gapText)\(stalled ? " STALL" : "")\n"
        if let dir = shotsDir, let data = row.data(using: .utf8) {
            let path = dir + "/trials.log"
            if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
            if let handle = FileHandle(forWritingAtPath: path) {
                handle.seekToEndOfFile()
                handle.write(data)
                handle.closeFile()
            }
        }
        held = []
        heldTexts = []
    }

    private static func stamp(_ line: String) -> Int64? {
        guard let open = line.firstIndex(of: "["), let close = line[open...].firstIndex(of: "]") else { return nil }
        return Int64(line[line.index(after: open)..<close])
    }

    // MARK: pictures

    /// A screenshot the way the stalled runs took one after the press; held until the trial knows if it stalled.
    private func snap(_ name: String) {
        held.append((name, XCUIScreen.main.screenshot().pngRepresentation))
    }

    private func hold(text: String, _ name: String) {
        heldTexts.append((name, text))
    }

    private func keep(_ png: Data, _ name: String) {
        guard let dir = shotsDir else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    // MARK: the app's watchdog and the host's capture

    private func openWatchWindow(_ tag: String) {
        guard let dir = shotsDir else { return }
        try? tag.write(toFile: dir + "/stallwatch-window.req", atomically: true, encoding: .utf8)
        let taken = dir + "/stallwatch-window-\(tag).taken"
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline, !FileManager.default.fileExists(atPath: taken) { Thread.sleep(forTimeInterval: 0.05) }
        note("\(tag): the app's watch window \(FileManager.default.fileExists(atPath: taken) ? "opened" : "did NOT open within 3 s")")
    }

    private func epochMS() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private func askCapture(_ name: String) -> Bool {
        guard let dir = shotsDir else { return false }
        let base = URL(fileURLWithPath: dir)
        try? String(epochMS()).write(to: base.appendingPathComponent("capture-\(name).req"), atomically: true, encoding: .utf8)
        let started = base.appendingPathComponent("capture-\(name).started").path
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: started) {
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func waitCapture(_ name: String) {
        guard let dir = shotsDir else { return }
        let done = URL(fileURLWithPath: dir).appendingPathComponent("capture-\(name).done").path
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline, !FileManager.default.fileExists(atPath: done) { Thread.sleep(forTimeInterval: 0.5) }
        note("capture \(name): \(FileManager.default.fileExists(atPath: done) ? "done" : "not done after 45 s")")
    }

    // MARK: finding (as ReviewShotTests, iPhone only)

    @discardableResult
    private func bringFoot(_ app: XCUIApplication, _ tag: String) -> XCUIElement {
        let foot = text(app, "==", waitsNote)
        let window = app.windows.firstMatch.frame
        bring(app, foot, between: window.minY + 120, and: window.maxY - 110, missingIsAbove: false, "\(tag)-foot")
        settle(1.2)
        return foot
    }

    private func toastElement(_ app: XCUIApplication) -> XCUIElement {
        let words = NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Kept", "Retired")
        return app.descendants(matching: .any).matching(words).firstMatch
    }

    private func decideLines() -> [String] {
        requestsLog().split(separator: "\n").filter { $0.contains("/decide body:") }.map(String.init)
    }

    private func seen(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if text(app, "CONTAINS", words).exists { return true }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return false
    }

    private func text(_ app: XCUIApplication, _ comparison: String, _ words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label \(comparison) %@", words)).firstMatch
    }

    private func pagerText(_ app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^[0-9]+ of [0-9]+$")).firstMatch
    }

    private func button(_ app: XCUIApplication, exactly label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func facts(_ element: XCUIElement) -> String {
        guard element.exists else { return "(missing)" }
        let value = element.value.map { "\($0)" } ?? ""
        return "type=\(element.elementType.rawValue) label=\"\(element.label)\" id=\"\(element.identifier)\" "
            + "value=\"\(value)\" frame=\(element.frame) enabled=\(element.isEnabled) hittable=\(element.isHittable)"
    }
}
#endif
