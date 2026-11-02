import XCTest

// TEMPORARY evidence probe (never merged): the conversation's Recap card with its one ⋯ at the end of its last line
// (docs/mocks/session-recap-display/07-last-line, the owner's B, 2026-11-02), in the iPhone and Mac apps' own
// consoles, against .rcp-probe/stub.py. Each launch opens one conversation at rest. The card is found by the label
// its paragraph reads ("Recap, <time>, <recap>"), the ⋯ by its name, "Recap actions". Each picture's frames are in
// the notes beside it, and where the ⋯ sits against the paragraph is checked, not eyeballed.
final class RecapShotTests: ProbeCase {
    private let long = "已删10个旧模型仓库"
    private let medium = "120 个已完成任务的 worktree 已删"
    private let english = "Fixed the login redirect"
    private let more = "Recap actions"
    private let refresh = "Refresh recap"
    private let hide = "Hide recap"

    /// Launch onto one conversation. en_US and Asia/Shanghai, as the stub's times are written for.
    private func open(_ session: String, dark: Bool = false, extra: [String] = [], _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", session,
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + (dark ? ["-dark"] : []) + extra
        app.launchEnvironment["TZ"] = "Asia/Shanghai"
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(name): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        settle(3)
        return app
    }

    /// The card's paragraph: the one element that reads "Recap, <time>, <recap>" — its label on the iPhone, its
    /// value on the Mac, where a SwiftUI text's words are its value (round 1 looked for a label there and missed it).
    private func card(_ app: XCUIApplication, _ recap: String, _ name: String) -> XCUIElement? {
        #if os(macOS)
        let query = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH 'Recap, ' AND value CONTAINS %@", recap))
        #else
        let query = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Recap, ' AND label CONTAINS %@", recap))
        #endif
        guard query.firstMatch.waitForExistence(timeout: 45) else {
            write(app.debugDescription, "missing-card-\(name).txt")
            XCTFail("\(name): no Recap card holding \(recap)")
            return nil
        }
        settle(1)
        note("\(name): card \(describe(query.firstMatch))")
        return query.firstMatch
    }

    private func dots(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR title == %@", more, more)).firstMatch
    }

    /// The ⋯ against the paragraph: its middle on the last line (a line is `line` pt), and at the line's end,
    /// hanging past it, where the column of ↻ and × used to start beside the first line.
    private func measure(_ paragraph: XCUIElement, _ dots: XCUIElement, line: CGFloat, _ name: String) {
        guard dots.exists else {
            XCTFail("\(name): no \(more)")
            return
        }
        let p = paragraph.frame, d = dots.frame
        let lines = Int((p.height / line).rounded())
        note("\(name): paragraph \(p) (\(lines) line(s) of \(line) pt), ⋯ \(d)")
        XCTAssertLessThan(abs(d.midY - (p.maxY - line / 2)), line / 2,
                          "\(name): the ⋯ is not on the last line: paragraph \(p), ⋯ \(d)")
        XCTAssertGreaterThan(d.maxX, p.maxX, "\(name): the ⋯ does not reach the line's end: paragraph \(p), ⋯ \(d)")
        XCTAssertLessThan(p.maxX - d.midX, 30, "\(name): the ⋯ is not at the line's end: paragraph \(p), ⋯ \(d)")
    }

    /// Refresh and Hide are the menu's, not buttons of their own beside the recap.
    private func noLooseButtons(_ app: XCUIApplication, _ name: String) {
        for word in [refresh, hide] where app.buttons[word].exists {
            write(app.debugDescription, "loose-\(name).txt")
            XCTFail("\(name): \(word) is a button of its own, outside the ⋯'s menu")
        }
    }

    #if os(iOS)
    private func phone(_ session: String, _ recap: String, dark: Bool = false, _ name: String) {
        let app = open(session, dark: dark, name)
        guard let paragraph = card(app, recap, name) else { shot("ios-\(name)"); return }
        let found = dots(app)
        XCTAssertTrue(found.waitForExistence(timeout: 10), "\(name): no \(more)")
        measure(paragraph, found, line: 20, name)
        noLooseButtons(app, name)
        shot("ios-\(name)")
        tree(app, name)
    }

    // MARK: iPhone · the card with its ⋯ on the last line

    func test1LongRecap() { phone("R1", long, "01-long") }

    func test2MediumRecap() { phone("R2", medium, "02-medium") }

    func test3EnglishRecap() { phone("R3", english, "03-english") }

    func test4DarkLongRecap() { phone("R1", long, dark: true, "04-long-dark") }

    // MARK: iPhone · the ⋯ opens Refresh recap and Hide recap; Hide takes the card away

    func test5TheMenuAndHide() {
        let app = open("R1", "05-menu")
        guard card(app, long, "05-menu") != nil else { shot("ios-05-menu"); return }
        let found = dots(app)
        guard found.waitForExistence(timeout: 10) else { XCTFail("05-menu: no \(more)"); shot("ios-05-menu"); return }
        found.tap()
        let refreshItem = app.buttons[refresh], hideItem = app.buttons[hide]
        XCTAssertTrue(refreshItem.waitForExistence(timeout: 10), "05-menu: the menu holds no \(refresh)")
        XCTAssertTrue(hideItem.exists, "05-menu: the menu holds no \(hide)")
        // Read after the menu has finished opening: in round 9 asking `isHittable` while it still animated failed the test
        // ("Activation point invalid") before it could press anything.
        settle(1.5)
        note("05-menu: \(describe(refreshItem)) · \(describe(hideItem))")
        shot("ios-05-menu")
        tree(app, "05-menu")
        guard hideItem.exists else { return }
        hideItem.tap()
        settle(2)
        let gone = !app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH 'Recap, ' AND label CONTAINS %@", long)).firstMatch.exists
        note("05-hidden: card \(gone ? "gone" : "STILL THERE")")
        XCTAssertTrue(gone, "05-hidden: Hide recap left the card")
        shot("ios-06-hidden")
    }

    // MARK: iPhone · recaps of eleven lengths: each row's frames, for the pixels to be read against beside the picture

    private func phoneSweep(_ kind: String) {
        let name = "sweep-\(kind)"
        let app = open("R1", extra: ["-probe.sweep", kind], name)
        let all = app.buttons.matching(NSPredicate(format: "label == %@", more))
        var table: [String] = []
        for row in 1...11 {
            let paragraph = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Recap, \(row), ")).firstMatch
            guard paragraph.waitForExistence(timeout: row == 1 ? 45 : 5) else {
                XCTFail("\(name): no row \(row)")
                continue
            }
            let p = paragraph.frame
            let lines = Int((p.height / 20).rounded())
            guard let d = all.allElementsBoundByIndex.map(\.frame).first(where: { abs($0.midY - (p.maxY - 10)) < 10 }) else {
                XCTFail("\(name): row \(row) has no ⋯ on its last line: paragraph \(p)")
                table.append("row \(row): lines \(lines) paragraph \(p) ⋯ MISSING")
                continue
            }
            table.append("row \(row): lines \(lines) paragraph \(p) ⋯ \(d)")
        }
        note(table.joined(separator: "\n"))
        write(table.joined(separator: "\n"), "ios-\(name).txt")
        shot("ios-\(name)")
    }

    func test6SweepIdeographs() { phoneSweep("cjk") }

    func test6SweepWords() { phoneSweep("latin") }

    // MARK: iPhone · a tap at each distance from the ⋯'s middle: how far does its target really reach?

    func test9TheTargetOnAPhone() {
        let app = open("R1", "target")
        guard card(app, long, "target") != nil else { return }
        let found = dots(app)
        guard found.waitForExistence(timeout: 10) else { XCTFail("target: no \(more)"); return }
        let f = found.frame
        var table = ["\(ProcessInfo.processInfo.environment["PROBE_TREE"] ?? "fix"): ⋯ frame \(f)"]
        let window = app.windows.firstMatch
        for (place, dx, dy): (String, CGFloat, CGFloat) in [("middle", 0, 0), ("up 6", 0, -6), ("down 6", 0, 6), ("up 9", 0, -9), ("down 9", 0, 9),
                                                           ("up 12", 0, -12), ("down 12", 0, 12), ("up 15", 0, -15), ("down 15", 0, 15),
                                                           ("up 20", 0, -20), ("down 20", 0, 20), ("left 12", -12, 0), ("right 12", 12, 0)] {
            window.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: f.midX + dx, dy: f.midY + dy)).tap()
            settle(1)
            let opened = app.buttons[refresh].exists
            table.append("\(place): \(opened ? "opens" : "nothing")")
            if opened {
                // Away from the menu, over the page's empty middle.
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.72)).tap()
                settle(1)
            }
        }
        note(table.joined(separator: "\n"))
        write(table.joined(separator: "\n"), "ios-target.txt")
        // The 30 by 32 pt the label asks for: not only the line's 18.
        for place in ["middle", "up 12", "down 12", "left 12", "right 12"] {
            XCTAssertTrue(table.contains("\(place): opens"), "target: a tap at \(place) opened nothing: \(table)")
        }
    }
    #endif

    #if os(macOS)
    /// Which tree this build is: `fix` (the ⋯), or `base` (main's ↻ and ×, for the comparison).
    private var isBase: Bool { ProcessInfo.processInfo.environment["PROBE_TREE"] == "base" }

    private func named(_ app: XCUIApplication, _ word: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR title == %@", word, word)).firstMatch
    }

    /// Where the ⋯ is drawn, whatever the accessibility tree says of it: the console is the window's last column, its
    /// words end 25 pt short of the window's edge, and the ⋯'s glyph is centred 7 pt short of the words' end, on the
    /// middle of the last line (a line is 16 pt). Read off round 3's picture and tree.
    private func whereTheDotsAre(_ app: XCUIApplication, _ paragraph: XCUIElement) -> XCUICoordinate {
        let window = app.windows.firstMatch, w = window.frame, p = paragraph.frame
        return window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: w.width - 32, dy: p.maxY - 8 - w.minY))
    }

    private func menuItem(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.menuItems.matching(NSPredicate(format: "title == %@", title)).firstMatch
    }

    // MARK: Mac · at rest the line ends in the words; under the pointer the ⋯; pressed where it is drawn, its menu

    func test7MacHoverAndMenu() throws {
        try XCTSkipIf(isBase, "the base tree has no ⋯")
        let app = open("R1", "mac")
        guard let paragraph = card(app, long, "mac") else { shot("mac-01-rest"); return }
        // A screen reader has no pointer: the tree holds the ⋯ at rest as well as under the pointer.
        note("mac-rest: ⋯ \(describe(dots(app)))")
        XCTAssertTrue(dots(app).exists, "mac-rest: the accessibility tree has no \(more) at rest")
        shot("mac-01-rest")
        paragraph.hover()
        settle(1)
        let found = dots(app)
        note("mac-hover: ⋯ \(describe(found))")
        XCTAssertTrue(found.exists, "mac-hover: the accessibility tree has no \(more) under the pointer")
        if found.exists { measure(paragraph, found, line: 16, "mac-hover") }
        noLooseButtons(app, "mac-hover")
        shot("mac-02-hover")
        tree(app, "mac-hover")
        // Pressed where it is drawn, as a pointer would.
        let press = whereTheDotsAre(app, paragraph)
        press.hover()
        settle(0.5)
        press.click()
        settle(1)
        let refreshItem = menuItem(app, refresh), hideItem = menuItem(app, hide)
        XCTAssertTrue(refreshItem.waitForExistence(timeout: 10), "mac-menu: pressing the ⋯ opened no \(refresh)")
        XCTAssertTrue(hideItem.exists, "mac-menu: the menu holds no \(hide)")
        note("mac-menu: \(describe(refreshItem)) · \(describe(hideItem))")
        // A menu is a window of its own: the screen, not the app's window.
        screen("mac-03-menu")
        tree(app, "mac-menu")
        guard hideItem.exists else { return }
        hideItem.click()
        settle(2)
        let gone = !app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH 'Recap, ' AND value CONTAINS %@", long)).firstMatch.exists
        note("mac-hidden: card \(gone ? "gone" : "STILL THERE")")
        XCTAssertTrue(gone, "mac-hidden: Hide recap left the card")
        shot("mac-04-hidden")
    }

    func test8MacEnglishRecap() throws {
        try XCTSkipIf(isBase, "the base tree has no ⋯")
        let app = open("R3", "mac-english")
        guard let paragraph = card(app, english, "mac-english") else { shot("mac-05-english"); return }
        paragraph.hover()
        settle(1)
        shot("mac-05-english")
    }

    // MARK: Mac · main's ↻ and × under the same test: did the tree ever hold them?

    func test9TheOldButtonsInTheTree() throws {
        try XCTSkipUnless(isBase, "only the base tree has them")
        let app = open("R1", "base")
        guard let paragraph = card(app, long, "base") else { shot("base-01-rest"); return }
        note("base-rest: refresh \(describe(named(app, refresh))) · hide \(describe(named(app, hide)))")
        shot("base-01-rest")
        paragraph.hover()
        settle(1)
        note("base-hover: refresh \(describe(named(app, refresh))) · hide \(describe(named(app, hide)))")
        shot("base-02-hover")
        tree(app, "base-hover")
    }

    // MARK: Mac · recaps of eleven lengths: the tree gives the frame of the room the words leave, so the check is numbers

    private func macSweep(_ kind: String) throws {
        try XCTSkipIf(isBase, "the base tree has no ⋯")
        let name = "sweep-\(kind)"
        let app = open("R1", extra: ["-probe.sweep", kind], name)
        let all = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", more))
        var table: [String] = []
        for row in 1...11 {
            let paragraph = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "Recap, \(row), ")).firstMatch
            guard paragraph.waitForExistence(timeout: row == 1 ? 45 : 5) else {
                XCTFail("\(name): no row \(row)")
                continue
            }
            paragraph.hover()
            settle(0.6)
            let p = paragraph.frame
            let room = paragraph.children(matching: .other).allElementsBoundByIndex.map(\.frame).last
            let lines = Int((p.height / 16).rounded())
            guard let room, let d = all.allElementsBoundByIndex.map(\.frame).first(where: { abs($0.midY - (p.maxY - 8)) < 12 }) else {
                XCTFail("\(name): row \(row): room or ⋯ missing: paragraph \(p)")
                continue
            }
            // The words end where the room starts; the ⋯'s glyph, about 16 pt wide, starts 8 pt left of its middle.
            let gap = d.midX - 8 - room.minX
            table.append("row \(row): lines \(lines) paragraph \(p) room \(room) ⋯ \(d) gap \(gap)")
            // Not asserted that the room is on the ⋯'s line: round 7's row 4 drew its last word and the ⋯ on line 3 while the
            // tree reported the room on line 2, so the words' distance from the ⋯ is read off the pictures (sweep_gaps.py).
            shot("mac-\(name)-\(row)")
        }
        note(table.joined(separator: "\n"))
        write(table.joined(separator: "\n"), "mac-\(name).txt")
    }

    func test6SweepIdeographs() throws { try macSweep("cjk") }

    func test6SweepWords() throws { try macSweep("latin") }

    // MARK: Mac · the shipped overlay plus one of the real card's differences per row: which one takes it out of the tree?

    func test10TheFactorsInTheTree() throws {
        try XCTSkipIf(isBase, "one build of the page is enough")
        let app = open("R1", extra: ["-probe.variants"], "factors")
        var table: [String] = []
        for number in 0...8 {
            let tag = "F\(number)"
            let paragraph = app.staticTexts.matching(NSPredicate(format: "value == %@ OR label == %@", "Paragraph \(tag)", "Paragraph \(tag)")).firstMatch
            guard paragraph.waitForExistence(timeout: 10) else {
                table.append("\(tag): no paragraph")
                continue
            }
            let rest = named(app, "Control \(tag)").exists
            paragraph.hover()
            settle(0.8)
            table.append("\(tag): at rest \(rest ? "in the tree" : "absent"), under the pointer \(describe(named(app, "Control \(tag)")))")
        }
        // The real RecapCardView on this page.
        let real = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH 'Recap, '")).firstMatch
        if real.waitForExistence(timeout: 10) {
            let rest = named(app, more).exists
            real.hover()
            settle(0.8)
            table.append("real card: at rest \(rest ? "in the tree" : "absent"), under the pointer \(describe(named(app, more)))")
            shot("factors-real-hover")
            tree(app, "factors-real-hover")
        } else {
            table.append("real card: not on the page")
        }
        note(table.joined(separator: "\n"))
        write(table.joined(separator: "\n"), "factors.txt")
        shot("factors")
    }
    #endif
}
