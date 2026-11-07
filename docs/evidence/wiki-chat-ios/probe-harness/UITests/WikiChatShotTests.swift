import XCTest
#if os(iOS)
import UIKit
#endif

// TEMPORARY evidence probe (never merged): the wiki chat in the iPhone and Mac apps' own Wiki against .c11-probe/stub.py
// (task 34se1Wpwmw3db4PGWDHLa, docs/wiki-chat-design.md §9, board docs/mocks/wiki/42-wiki-chat ⑤). Each launch opens
// the document of board 42 ⑤ at its section 3 with the stub at one stage (see stub.py):
//
//   ask      the button at rest; Ask on the paragraph, a sentence tapped, the half sheet with the page and the quote
//            as chips — and the page behind it dragged, which must scroll (presentationBackgroundInteraction)
//   card     the button's amber 1; the chat at full height, ending on the card: Apply full width on top, Edit and
//            Discard sharing the row under it
//   updated  the chat folded away: the button's check, the floating line, Updated beside §3, the new sentence; then
//            See changes
//   working  the button's ring
//
// On a Mac the panel is the third column beside the page (the inspector), opened by the same button; a paragraph's
// right click offers Ask. A state the stub never drove, or a check that does not hold, fails the test; the pictures
// are taken anyway.
final class WikiChatShotTests: ProbeCase {
    #if os(iOS)
    /// A phone shows the panel as a sheet; an iPad, at a regular width, as the third column beside the page.
    private var phone: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    private var platform: String { phone ? "ios" : "ipad" }
    #else
    private let phone = false
    private let platform = "mac"
    #endif

    private let paragraphWords = "Runner 每 30 秒发送一次心跳"
    private let pageWords = "心跳机制用于控制面探测失联的 runner"
    private let chatTitle = "Runner 离线判定的原因"

    // MARK: the cases

    /// Board 42 ⑤, first phone: Ask on a paragraph, one sentence tapped; the half sheet with the page and the quote;
    /// the page behind it still scrolls.
    func testHalfSheetAskAndThePageBehindScrolls() {
        let tag = "\(platform)-1-half-sheet"
        let app = open("ask", tag)
        let fab = fabButton(app)
        note("\(tag): the button at rest: \(describe(fab))")
        XCTAssertEqual(fab.exists ? fab.label : "(missing)", "Chat", "\(tag): the button at rest says Chat")
        shot("\(platform)-0-page-at-rest")
        shot(fab, "\(platform)-fab-idle")

        // Ask on the paragraph: a long press on a phone, a right click on a Mac. Found by its first sentence, which only
        // the page holds (the quote chip will hold the second).
        let paragraph = words(app, pageWords)
        guard paragraph.waitForExistence(timeout: 20) else {
            tree(app, "\(tag)-no-paragraph")
            return XCTFail("\(tag): the paragraph never showed")
        }
        #if os(iOS)
        paragraph.press(forDuration: 1.3)
        let ask = button(app, beginning: "Ask")
        #else
        paragraph.rightClick()
        let ask = app.menuItems["Ask"]
        #endif
        guard ask.waitForExistence(timeout: 10) else {
            shot("\(tag)-no-menu")
            tree(app, "\(tag)-no-menu")
            return XCTFail("\(tag): the paragraph offered no Ask")
        }
        shot("\(platform)-1a-paragraph-menu")
        press(ask)
        settle(1.5)

        // The Ask sheet, in the panel: the paragraph's sentences, one tapped.
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", paragraphWords)).firstMatch
        guard row.waitForExistence(timeout: 15) else {
            shot("\(tag)-no-rows")
            tree(app, "\(tag)-no-rows")
            return XCTFail("\(tag): the Ask sheet never listed the paragraph's sentences")
        }
        press(row)
        settle(0.8)
        shot("\(platform)-1b-ask-sheet")
        let done = app.buttons["wiki-chat-ask-done"]
        XCTAssertTrue(done.exists && done.isEnabled, "\(tag): Ask is pressable once a sentence is picked")
        press(done)
        settle(2)

        // The half sheet: the empty chat, the page chip and the quote chip. A compact column's chip — a phone's sheet,
        // an iPad's third column — says the sentences alone (board 42 ⑤); a Mac's adds the sources.
        #if os(iOS)
        let chipWords = "1 sentence"
        #else
        let chipWords = "1 sentence · 2 sources"
        #endif
        XCTAssertTrue(appears(app, chipWords, timeout: 15), "\(tag): the quote chip never showed")
        XCTAssertTrue(appears(app, "3.1 §3", timeout: 5), "\(tag): the page chip never showed")
        let head = panelHead(app, "New chat")
        note("\(tag): the panel's head: \(describe(head))")
        let screen = app.windows.firstMatch.frame
        if head.exists && phone {
            let at = (head.frame.minY - screen.minY) / screen.height
            note("\(tag): the head stands at \(String(format: "%.2f", at)) of the screen's height")
            XCTAssertTrue(at > 0.3 && at < 0.7, "\(tag): the sheet is not at half height (its head at \(at))")
        } else if head.exists {
            // The third column: the panel stands on the right, the page beside it (docs/wiki-design.md §12.3.5).
            let at = (head.frame.minX - screen.minX) / screen.width
            note("\(tag): the panel's head starts at \(String(format: "%.2f", at)) of the window's width")
            XCTAssertGreaterThan(at, 0.45, "\(tag): the panel is not a column on the right")
        } else {
            XCTFail("\(tag): the panel's head never showed")
        }
        shot("\(platform)-1c-half-sheet-quote")

        #if os(iOS)
        // The page behind the half sheet — or beside the column — scrolls under a drag: the paragraph moves.
        let before = paragraph.exists ? paragraph.frame.minY : .nan
        let top = XCUIScreen.main.screenshot().pngRepresentation
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: phone ? 0.55 : 0.3, dy: 0.34))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -120)),
                    withVelocity: .slow, thenHoldForDuration: 0.6)
        settle(1.2)
        let after = paragraph.exists ? paragraph.frame.minY : .nan
        note("\(tag): a drag on the page behind the half sheet took the paragraph from \(before) to \(after)")
        XCTAssertTrue(before.isFinite && after.isFinite && after < before - 30,
                      "\(tag): the page behind the half sheet did not scroll (\(before) → \(after))")
        XCTAssertNotEqual(top, XCUIScreen.main.screenshot().pngRepresentation, "\(tag): nothing moved on screen")
        XCTAssertTrue(head.exists, "\(tag): the drag on the page dismissed the sheet")
        shot("\(platform)-1d-page-behind-scrolled")
        #endif
    }

    /// Board 42 ⑤, second phone: the amber 1; the chat at full height ending on the card — Apply full width on top,
    /// Edit and Discard sharing the row under it.
    func testFullSheetCard() {
        let tag = "\(platform)-2-card"
        let app = open("card", tag)
        let fab = fabButton(app)
        XCTAssertTrue(waitForLabel(fab, "1 needs you", timeout: 20), "\(tag): the button never said 1 needs you: \(describe(fab))")
        shot(fab, "\(platform)-fab-needs-you")
        shot("\(platform)-2a-page-needs-you")
        press(fab)
        // Round 6 lost this tap once on a busy simulator: pressed once more if nothing opened, and said so.
        if !appears(app, "DRAFT · ADD DECISION", timeout: 12), fab.exists, fab.isHittable {
            note("\(tag): the button's first press opened nothing; pressed again")
            press(fab)
        }
        guard appears(app, "DRAFT · ADD DECISION", timeout: 40) else {
            shot("\(tag)-no-card")
            tree(app, "\(tag)-no-card")
            return XCTFail("\(tag): the chat never drew the card")
        }
        settle(1.5)
        #if os(iOS)
        // Full height: the sheet's head dragged to the top (a phone's; the iPad's column is the window's height already).
        let head = words(app, chatTitle)
        if head.exists && phone {
            // From the head row's empty middle, not its title, which is the history menu's button.
            let window = app.windows.firstMatch
            let row = (head.frame.midY - window.frame.minY) / window.frame.height
            let grip = window.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: row))
            grip.press(forDuration: 0.15, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.04)),
                       withVelocity: .slow, thenHoldForDuration: 0.4)
            settle(1.5)
            note("\(tag): the panel's head after the drag: \(describe(head))")
            let screen = app.windows.firstMatch.frame
            XCTAssertLessThan((head.frame.minY - screen.minY) / screen.height, 0.2, "\(tag): the sheet did not go to full height")
        } else if !head.exists {
            XCTFail("\(tag): the panel's head never showed")
        }
        #endif
        let apply = app.buttons["wiki-chat-card-apply"]
        let edit = app.buttons["wiki-chat-card-edit"]
        let discard = app.buttons["wiki-chat-card-discard"]
        note("\(tag): Apply \(describe(apply)); Edit \(describe(edit)); Discard \(describe(discard))")
        if apply.exists && edit.exists && discard.exists {
            XCTAssertLessThanOrEqual(apply.frame.maxY, edit.frame.minY + 1, "\(tag): Apply is not above Edit")
            XCTAssertEqual(edit.frame.minY, discard.frame.minY, accuracy: 2, "\(tag): Edit and Discard do not share a row")
            XCTAssertGreaterThan(apply.frame.width, edit.frame.width * 1.6, "\(tag): Apply is not full width")
        } else {
            XCTFail("\(tag): the card's buttons are missing")
        }
        // The web card's face (board 42 ②): the entry's title, its Decision and the Why, the sources, and the sections
        // the press rewrites, each a link.
        for words in ["Runner 离线判定留三次心跳的余量", "Decision", "连续丢三次心跳才判离线。", "Why",
                      "要扛住一次网关重启，一次抖动不该让 Resume 失效。", "Your message in this chat",
                      "runner-presence.ts L30–31 · 99cd3c4"] {
            XCTAssertTrue(appears(app, words, timeout: 5), "\(tag): the card does not say \(words)")
        }
        XCTAssertTrue(app.buttons["7.1 §2"].exists, "\(tag): the card's Rewrites row has no 7.1 §2 link")
        // The page beside an iPad's or a Mac's panel marks the section the open card would rewrite (board 42 ②).
        let would = app.descendants(matching: .any).matching(identifier: "wiki-section-would-rewrite").firstMatch
        note("\(tag): the would-rewrite mark: \(describe(would))")
        if !phone {
            XCTAssertTrue(would.exists && would.frame.width > 0,
                          "\(tag): the page beside the panel does not mark §3 as the card would rewrite it")
        }
        #if os(macOS)
        // The source list folds while the chat is a column: the directory, the page and the chat share the window.
        let sidebar = app.outlines.matching(NSPredicate(format: "label == %@", "Sidebar")).firstMatch
        note("\(tag): the source list beside the chat: \(describe(sidebar))")
        XCTAssertFalse(sidebar.exists && sidebar.frame.width > 1, "\(tag): the source list did not fold beside the chat's column")
        #endif
        shot("\(platform)-2b-full-sheet-card")
    }

    /// Board 42 ⑤, third phone: folded away after the rewrite came out — the button's check, the floating line, Updated
    /// beside §3 and the new sentence; then See changes.
    func testFoldedAwayAfterTheRewrite() {
        let tag = "\(platform)-3-updated"
        let app = open("updated", tag)
        XCTAssertTrue(appears(app, "Wiki updated · 3.1 §3", timeout: 30), "\(tag): the floating line never showed")
        XCTAssertTrue(appears(app, "留三次余量是为了扛住一次网关重启", timeout: 10), "\(tag): the new sentence is not on the page")
        let updated = app.descendants(matching: .any).matching(identifier: "wiki-section-updated").firstMatch
        note("\(tag): Updated beside the section: \(describe(updated))")
        XCTAssertTrue(updated.exists, "\(tag): no Updated beside §3")
        let fab = fabButton(app)
        XCTAssertTrue(waitForLabel(fab, "Wiki updated", timeout: 10), "\(tag): the button does not say Wiki updated: \(describe(fab))")
        shot(fab, "\(platform)-fab-updated")
        shot("\(platform)-3a-folded-updated")
        let see = app.buttons.matching(NSPredicate(format: "label == %@", "See changes")).firstMatch
        guard see.waitForExistence(timeout: 10) else { return XCTFail("\(tag): the floating line has no See changes") }
        press(see)
        XCTAssertTrue(appears(app, "After chat Runner 离线判定的原因", timeout: 20), "\(tag): See changes never read the version")
        settle(1)
        shot("\(platform)-3b-see-changes")
        // Only the sentence the write added is listed; the ones it kept are left out, as the web's See changes does.
        XCTAssertTrue(appears(app, "1 sentence changed", timeout: 5), "\(tag): See changes does not say how many sentences changed")
        // Updated beside the section opens the same comparison, as the web's Updated does.
        let done = app.buttons["Done"].firstMatch
        guard done.waitForExistence(timeout: 5) else { return XCTFail("\(tag): See changes has no Done") }
        press(done)
        settle(1)
        guard updated.waitForExistence(timeout: 10) else { return XCTFail("\(tag): Updated is gone after See changes") }
        press(updated)
        XCTAssertTrue(appears(app, "After chat Runner 离线判定的原因", timeout: 20), "\(tag): Updated did not open See changes")
        settle(1)
        shot("\(platform)-3c-updated-opens-see-changes")
    }

    /// The button's fourth look: a ring while a turn runs.
    func testWorkingLook() {
        let tag = "\(platform)-4-working"
        let app = open("working", tag)
        let fab = fabButton(app)
        XCTAssertTrue(waitForLabel(fab, "Working…", timeout: 20), "\(tag): the button never said Working…: \(describe(fab))")
        settle(0.4)
        shot(fab, "\(platform)-fab-working")
        shot("\(platform)-4a-page-working")
    }

    // MARK: C19 — the panel's composer is the Console's (board 43, task 34tEzSSp0Ii1rRpbXxRbi)

    /// Board 43 ②: a new chat — Runs in holding the workspace alone, then the Console's composer card with the page and
    /// the selection leading its attachment row (each with its cross), the words, and the toolbar (+, the mode, the
    /// model, Send). Half height, then full height on a phone; the third column on an iPad and a Mac.
    func testC19NewChatComposer() {
        let tag = "\(platform)-c19-1-new"
        let app = open("ask", tag)
        guard askOnParagraph(app, tag) else { return }
        let runsIn = exactly(app, "Runs in")
        let workspace = app.buttons["Workspace"].firstMatch
        let page = pageCross(app).firstMatch
        let quote = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove Runner")).firstMatch
        let mode = toolbarButton(app, "Auto")
        let model = toolbarButton(app, "Opus 5.5")
        guard page.waitForExistence(timeout: 15) else {
            shot("\(tag)-no-chips")
            tree(app, "\(tag)-no-chips")
            return XCTFail("\(tag): the page chip's cross never showed in the composer")
        }
        settle(1.5)
        for (name, element) in [("Runs in", runsIn), ("workspace", workspace), ("page ×", page), ("quote ×", quote),
                                ("mode", mode), ("model", model)] {
            note("\(tag): \(name): \(describe(element))")
        }
        XCTAssertTrue(runsIn.exists, "\(tag): a new chat shows no Runs in")
        XCTAssertTrue(workspace.exists, "\(tag): Runs in names no workspace")
        XCTAssertTrue(quote.exists, "\(tag): the selection's chip has no cross")
        XCTAssertTrue(mode.exists, "\(tag): the composer's toolbar has no mode (Auto)")
        XCTAssertTrue(model.exists, "\(tag): the composer's toolbar has no model (Opus 5.5)")
        XCTAssertTrue(appears(app, "1 sentence", timeout: 5), "\(tag): the quote chip lost its count")
        if runsIn.exists && workspace.exists && page.exists && quote.exists && mode.exists {
            // Runs in stands over the conversation, alone on its line: the mode is the toolbar's, under the chips.
            XCTAssertLessThan(runsIn.frame.maxY, page.frame.minY, "\(tag): Runs in is not above the composer")
            XCTAssertGreaterThan(mode.frame.minY, workspace.frame.maxY + 40, "\(tag): the mode stands on Runs in's line")
            // The chips are the attachment row of the composer card: above its toolbar, on one row.
            XCTAssertLessThan(page.frame.maxY, mode.frame.minY, "\(tag): the page chip is not above the toolbar")
            XCTAssertEqual(page.frame.midY, quote.frame.midY, accuracy: 4, "\(tag): the page and the selection are not one row")
            XCTAssertLessThan(mode.frame.minY - page.frame.maxY, 140, "\(tag): the chips are not in the composer card")
        }
        shot("\(platform)-c19-1a-new-chat-half")
        #if os(iOS)
        if phone {
            fullHeight(app, "New chat", tag)
            shot("\(platform)-c19-1b-new-chat-full")
        }
        #endif
        // A cross takes its chip off: what the row shows is what the message sends.
        press(quote)
        settle(1)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove Runner")).firstMatch.exists,
                       "\(tag): the selection's cross left its chip")
        XCTAssertTrue(page.exists, "\(tag): the selection's cross took the page too")
        shot("\(platform)-c19-1c-quote-crossed")
    }

    /// Board 43 ⑤: a chat whose turn runs — no workspace shown, the page chip in the composer's row, and Send is Stop.
    func testC19RunningChatComposer() {
        let tag = "\(platform)-c19-2-running"
        let app = open("working", tag)
        let fab = fabButton(app)
        XCTAssertTrue(waitForLabel(fab, "Working…", timeout: 20), "\(tag): the button never said Working…: \(describe(fab))")
        press(fab)
        let page = pageCross(app).firstMatch
        guard page.waitForExistence(timeout: 40) else {
            shot("\(tag)-no-composer")
            tree(app, "\(tag)-no-composer")
            return XCTFail("\(tag): the running chat's composer never showed the page chip")
        }
        let stop = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "stop")).firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 20), "\(tag): a running turn's composer has no Stop")
        settle(1.5)
        note("\(tag): Stop: \(describe(stop)); page ×: \(describe(page))")
        XCTAssertFalse(exactly(app, "Runs in").exists, "\(tag): a chat that runs shows Runs in")
        XCTAssertFalse(app.buttons["Workspace"].exists, "\(tag): a chat that runs shows its workspace")
        XCTAssertTrue(toolbarButton(app, "Auto").exists || toolbarButton(app, "Default").exists,
                      "\(tag): the running chat's toolbar has no mode")
        if stop.exists { XCTAssertGreaterThan(stop.frame.minY, page.frame.maxY, "\(tag): Stop is not on the toolbar under the chips") }
        shot("\(platform)-c19-2a-running-half")
        #if os(iOS)
        if phone {
            fullHeight(app, chatTitle, tag)
            shot("\(platform)-c19-2b-running-full")
        }
        #endif
    }

    /// Board 43 ④: a chat with an open card asks what to change in the draft, in the Console's composer.
    func testC19CardOpenComposer() {
        let tag = "\(platform)-c19-3-card"
        let app = open("card", tag)
        let fab = fabButton(app)
        XCTAssertTrue(waitForLabel(fab, "1 needs you", timeout: 20), "\(tag): the button never said 1 needs you")
        press(fab)
        guard appears(app, "DRAFT · ADD DECISION", timeout: 40) else {
            shot("\(tag)-no-card")
            return XCTFail("\(tag): the chat never drew the card")
        }
        settle(1.5)
        let placeholder = "Reply, or say what to change in the draft"
        let input = app.textViews.firstMatch
        note("\(tag): the composer's field: \(describe(input)) placeholder=\(input.exists ? (input.placeholderValue ?? "nil") : "-")")
        let field = app.textFields.firstMatch
        XCTAssertTrue(appears(app, placeholder, timeout: 10) || (input.exists && (input.placeholderValue ?? "").contains(placeholder))
                      || (field.exists && (field.placeholderValue ?? "").contains(placeholder)),
                      "\(tag): the composer does not ask what to change in the draft")
        XCTAssertTrue(pageCross(app).exists, "\(tag): the page chip is not in the composer's row")
        XCTAssertFalse(exactly(app, "Runs in").exists, "\(tag): a chat that runs shows Runs in")
        shot("\(platform)-c19-3a-card-open")
    }

    /// Ask on the paragraph, its second sentence tapped: the panel opens on a new chat with the page and the quote.
    private func askOnParagraph(_ app: XCUIApplication, _ tag: String) -> Bool {
        let paragraph = words(app, pageWords)
        guard paragraph.waitForExistence(timeout: 20) else {
            tree(app, "\(tag)-no-paragraph")
            XCTFail("\(tag): the paragraph never showed")
            return false
        }
        #if os(iOS)
        paragraph.press(forDuration: 1.3)
        let ask = button(app, beginning: "Ask")
        #else
        paragraph.rightClick()
        let ask = app.menuItems["Ask"]
        #endif
        guard ask.waitForExistence(timeout: 10) else {
            shot("\(tag)-no-menu")
            XCTFail("\(tag): the paragraph offered no Ask")
            return false
        }
        press(ask)
        settle(1.5)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", paragraphWords)).firstMatch
        guard row.waitForExistence(timeout: 15) else {
            shot("\(tag)-no-rows")
            XCTFail("\(tag): the Ask sheet never listed the paragraph's sentences")
            return false
        }
        press(row)
        settle(0.8)
        press(app.buttons["wiki-chat-ask-done"])
        settle(2)
        return true
    }

    /// The page chip's cross, whichever section of 3.1 the page shows (a Mac's page may not reach §3).
    private func pageCross(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove 3.1 §")).firstMatch
    }

    /// A control of the composer's toolbar by its words: a menu's button, or its text.
    private func toolbarButton(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        let button = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        if button.waitForExistence(timeout: 5) { return button }
        let menu = app.menuButtons.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        if menu.exists { return menu }
        return app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", words, words)).firstMatch
    }

    #if os(iOS)
    /// A phone's sheet dragged to full height by its head row's empty middle (its title is the history menu's button).
    private func fullHeight(_ app: XCUIApplication, _ title: String, _ tag: String) {
        let head = words(app, title)
        guard head.exists else { return XCTFail("\(tag): the panel's head never showed") }
        let window = app.windows.firstMatch
        let row = (head.frame.midY - window.frame.minY) / window.frame.height
        let grip = window.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: row))
        grip.press(forDuration: 0.15, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.04)),
                   withVelocity: .slow, thenHoldForDuration: 0.4)
        settle(1.5)
        note("\(tag): the panel's head after the drag: \(describe(head))")
        XCTAssertLessThan((head.frame.minY - window.frame.minY) / window.frame.height, 0.2, "\(tag): the sheet did not go to full height")
    }
    #endif

    // MARK: steps

    private func open(_ stage: String, _ tag: String) -> XCUIApplication {
        resetStub()
        setStub("{\"stage\": \"\(stage)\"}")
        let app = XCUIApplication()
        // The document's stamp from an earlier look (UserDefaults' argument domain): a section written since wears Updated.
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh", "-ApplePersistenceIgnoreState", "YES",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
                               "-orbit.wiki.seen.orbit.doc.session-runtime", "1000"]
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !app.windows.firstMatch.waitForExistence(timeout: 20) {
            note("\(tag): no window after launch; File > New Window")
            app.typeKey("n", modifierFlags: .command)
        }
        #endif
        // The document's own head: its reader-and-scope block, at the page's top. A simulator's first launch of the
        // app can take two minutes before its first request (round 4's iPad).
        if !appears(app, "Question", timeout: 150) {
            tree(app, "\(tag)-no-page")
            XCTFail("\(tag): the document never showed — the app did not render the stub's document")
        }
        settle(2.5)
        // The Mac's source list stays as the app keeps it: the app folds it itself while the chat is a column.
        // Section 3 of the board, its heading near the top of the page — not the Mac directory column's row, whose
        // title is the fixture's longer one. The page opens there; a Mac's heading sits right under the toolbar.
        let heading = sectionThree(app)
        let window = app.windows.firstMatch.frame
        #if os(macOS)
        let bandTop = window.minY + 30
        #else
        let bandTop = window.minY + 60
        #endif
        // Under a phone's half sheet the page chip reads its section off a line 45% down; a page shown whole, 30%
        // (`WikiChatLogic.readingLine`): the heading stands above either.
        bring(app, heading, between: bandTop, and: window.minY + window.height * (phone ? 0.4 : 0.25), missingIsAbove: false,
              "\(tag)-section-3")
        settle(1)
        return app
    }

    private func fabButton(_ app: XCUIApplication) -> XCUIElement {
        let fab = app.buttons.matching(identifier: "wiki-chat-fab").firstMatch
        if !fab.waitForExistence(timeout: 20) { tree(app, "no-fab") }
        return fab
    }

    private func waitForLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if element.exists && element.label == label { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    /// A text by its words: a label on the iPhone, a value on the Mac (where a SwiftUI Text's words are its value).
    private func words(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        #if os(iOS)
        return app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        #else
        return app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", words, words)).firstMatch
        #endif
    }

    /// Board 42 ⑤'s section 3 heading on the page.
    private func sectionThree(_ app: XCUIApplication) -> XCUIElement {
        let words = "turn 投递与 inbox 领取"
        #if os(macOS)
        // The heading's text exactly: the CONTAINS query below found nothing on a Mac in round 6, though the text was there.
        return exactly(app, words)
        #else
        return app.staticTexts.matching(NSPredicate(
            format: "(value CONTAINS %@ OR label CONTAINS %@) AND NOT (value CONTAINS %@ OR label CONTAINS %@)",
            words, words, "long-poll", "long-poll")).firstMatch
        #endif
    }

    /// The panel's title: a text on a phone, the history menu's button on a Mac.
    private func panelHead(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        #if os(macOS)
        for candidate in [app.menuButtons[title], app.popUpButtons[title], app.buttons[title]] where candidate.exists {
            return candidate
        }
        return exactly(app, title)
        #else
        return words(app, title)
        #endif
    }

    /// A text whose words are exactly these.
    private func exactly(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        #if os(iOS)
        return app.staticTexts.matching(NSPredicate(format: "label == %@", words)).firstMatch
        #else
        return app.staticTexts.matching(NSPredicate(format: "value == %@ OR label == %@", words, words)).firstMatch
        #endif
    }

    private func press(_ element: XCUIElement) {
        #if os(iOS)
        element.tap()
        #else
        element.click()
        #endif
    }
}
