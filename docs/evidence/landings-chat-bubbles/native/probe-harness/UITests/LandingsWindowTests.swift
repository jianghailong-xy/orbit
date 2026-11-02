import XCTest

// TEMPORARY evidence probe (see ../../README.md): the project's Landings window drawn as a chat (owner
// 2026-11-02, docs/mocks/landings-chat-bubbles, option C) on the real iPhone and Mac apps, against
// stub.py. The frames:
//   a  (iPhone, light and dark) the window at its bottom: today's group, the Now chip, Orbit's last
//      two messages (the waiting card and the checking card) and the read-only bar;
//   b  (iPhone) scrolled up: yesterday's chip and its groups, one avatar beside each landing and the
//      merge into main that followed it;
//   c  (iPhone) a bubble pressed: its record opens under it;
//   d  (iPhone) a long press on a bubble: the bubble lifts, the old landing page's ⋯ rows;
//   e  (iPhone + Mac) a landing session's id opens the window on that landing: opened and outlined.
// A state the stub never drove fails the test, and every picture and tree is kept anyway.
final class LandingsWindowTests: ProbeCase {
    private static let footer = "Orbit runs these landings — "
    private static let waiting = "T5 orbit doctor reports the runner's own binary"
    private static let checking = "T6 upgrade keeps each account's service running"
    private static let today = "T3 sudo hints name the binary's real path"

    #if os(iOS)
    /// a → b in one launch: the window at its bottom, then scrolled up to yesterday's groups.
    func testIPhoneTheWindowAtItsBottomAndScrolledUp() {
        let app = launch(until: Self.checking, extra: ["-probe.page", "window"], "window")
        XCTAssertTrue(appears(app, Self.footer, timeout: 20), "the read-only bar never showed")
        XCTAssertTrue(appears(app, Self.waiting, timeout: 20), "the waiting card")
        XCTAssertTrue(appears(app, Self.today, timeout: 10), "today's bubble")
        settle(2)
        XCTAssertTrue(element(app, containing: "Now").exists, "the Now chip")
        XCTAssertTrue(app.buttons["Open Coordinator"].exists, "the waiting card's doors")
        XCTAssertTrue(app.buttons["landings-row:LT3"].exists, "today's landing is a pressable bubble")
        XCTAssertFalse(app.textFields.count > 0 || app.textViews.count > 0, "nothing to type here")
        note("a: bubble LT3 at \(app.buttons["landings-row:LT3"].frame), merge LM4 at \(app.buttons["landings-row:LM4"].frame)")
        write(app.debugDescription, "ios-a-window-bottom-tree.txt")
        shot(app, "ios-a-window-bottom")

        // b: up to yesterday — its chip, and the groups a landing and its merge make.
        for _ in 0..<2 { app.swipeDown(velocity: .slow) }
        settle(1.5)
        if !element(app, containing: "Yesterday").exists { app.swipeDown(velocity: .slow); settle(1.5) }
        XCTAssertTrue(element(app, containing: "Yesterday").exists, "yesterday's chip")
        XCTAssertTrue(element(app, containing: "T2 host setup refuses a binary it did not install").exists)
        note("b: LY1 at \(app.buttons["landings-row:LY1"].frame), LM2 at \(app.buttons["landings-row:LM2"].frame)")
        write(app.debugDescription, "ios-b-history-tree.txt")
        shot(app, "ios-b-history")
        app.terminate()
    }

    /// a, dark: the same bottom of the window in the dark appearance.
    func testIPhoneTheWindowAtItsBottomInTheDark() {
        let app = launch(until: Self.checking, dark: true, extra: ["-probe.page", "window"], "window-dark")
        XCTAssertTrue(appears(app, Self.footer, timeout: 20))
        settle(2)
        shot(app, "ios-a-window-bottom-dark")
        app.terminate()
    }

    /// c: a bubble pressed opens its record under it — the landing's own timeline and its two ways out.
    func testIPhoneABubbleOpensToItsRecord() {
        let app = launch(until: Self.today, extra: ["-probe.page", "window"], "window-open")
        settle(2)
        let bubble = app.buttons["landings-row:LT3"]
        XCTAssertTrue(bubble.waitForExistence(timeout: 10))
        press(bubble)
        XCTAssertTrue(appears(app, "Landed on project/P1", timeout: 15), "the bubble's record")
        let links = element(app, containing: "Open Task ›")
        if links.exists { bring(app, links, between: 300, and: 760, "c-links") }
        settle(1)
        note("c: bubble at \(bubble.frame)")
        write(app.debugDescription, "ios-c-bubble-open-tree.txt")
        shot(app, "ios-c-bubble-open")
        app.terminate()
    }

    /// d: a long press on a bubble lifts it and holds the old landing page's ⋯ rows.
    func testIPhoneALongPressOnABubbleShowsItsDoors() {
        let app = launch(until: Self.today, extra: ["-probe.page", "window"], "window-press")
        settle(2)
        var opened = false
        for attempt in 1...3 where !opened {
            let bubble = app.buttons["landings-row:LT3"]
            bubble.press(forDuration: 1.4)
            opened = element(app, containing: "Open Source Session").waitForExistence(timeout: 5)
            note("d: long press \(attempt) at \(bubble.frame): menu \(opened ? "up" : "not up")")
            if !opened { settle(1) }
        }
        settle(1)
        XCTAssertTrue(opened, "the bubble's menu")
        for word in ["Open Task", "Open Coordinator"] {
            XCTAssertTrue(element(app, containing: word).exists, "the menu offers \(word)")
        }
        write(app.debugDescription, "ios-d-bubble-menu-tree.txt")
        shot(app, "ios-d-bubble-menu")
        app.terminate()
    }

    /// e: an Open landing › / orbit-session: id opens the window on that landing — scrolled to, opened
    /// and outlined for 1.5 s. The pictures are taken the moment it shows.
    func testIPhoneALandingsIdOpensTheWindowOnIt() {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES", "-probe.page", "focus"]
        app.launch()
        dismissSystemPrompts()
        let record = "Rerun by the coordinator"
        if !waitUntil(45, { self.element(app, containing: record).exists }) {
            write(app.debugDescription, "missing-ios-e.txt")
            XCTFail("the landing the window was opened on never opened")
        }
        for index in 1...3 {
            shot(app, "ios-e-focused-\(index)")
            settle(0.35)
        }
        XCTAssertTrue(element(app, containing: "Generation 2").exists, "both generations in its record")
        write(app.debugDescription, "ios-e-focused-tree.txt")
        settle(2)
        shot(app, "ios-e-focused-after")
        app.terminate()
    }
    #endif

    #if os(macOS)
    /// e (Mac): the Mac's own window, opened on a landing's id: the chat in the detail pane, the
    /// landing opened, the bar in the composer's place.
    func testMacALandingsIdOpensTheWindowOnIt() {
        let app = launch(until: "Rerun by the coordinator", extra: ["-probe.page", "focus"], "mac-focus")
        shot(app, "mac-window-focused")
        XCTAssertTrue(appears(app, Self.footer, timeout: 15), "the window's bar")
        XCTAssertTrue(appears(app, "T2 host setup refuses a binary it did not install", timeout: 10))
        // The bar is inside the window: its minimum height never pushes the content past the screen.
        let window = app.windows.firstMatch.frame
        let open = app.buttons["Open coordinator"]
        XCTAssertTrue(open.exists, "the bar's Open coordinator")
        note("mac: window \(window), Open coordinator \(open.frame)")
        XCTAssertLessThanOrEqual(open.frame.maxY, window.maxY, "the bar stands inside the window")
        write(app.debugDescription, "mac-window-tree.txt")
        settle(2)
        shot(app, "mac-window")
        app.terminate()
    }
    #endif
}
