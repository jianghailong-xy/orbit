import XCTest

// TEMPORARY evidence probe (never merged): the iPhone app against stub.py (task I2, mocks 30 ③, 31 ① ③ ⑥ ⑦).
// Today's orbit (port 8765): the home is the documents — the line under the head, grouped cards of numbered
// rows with two lines of lead, what is not written folded into a row, Browse · A–Z at the foot — and nothing of
// how the wiki is kept. Three spaces (8766): orbit with principles, then wikids, a new space. The slow stub
// (8767): the head at once, grey bars until the home's reads answer.
final class WikiPhoneShotsTests: WikiShotsCase {

    /// Mock 30 ③ and, scrolled, 31 ①.
    func testTheHomeIsTheDocuments() {
        let app = launch(port: 8765)
        guard openWiki(app, expecting: 1, shot: "01-phone-drawer") else { return }
        XCTAssertTrue(waitLabel(app, "35 documents · 5 written"), "the line under the head says what the space holds")
        let space = app.staticTexts["The codebase this wiki describes"]
        XCTAssertTrue(space.waitForExistence(timeout: 10), "one space: its name as a label")
        XCTAssertEqual(space.value as? String, "orbit")
        XCTAssertTrue(waitLabel(app, "产品概览与架构"), "the first category's head")
        XCTAssertTrue(waitLabel(app, "产品定位与核心能力", contains: true), "1.1, with its lead")
        XCTAssertTrue(waitLabel(app, "Orbit 是自托管的 coding agent 控制台", contains: true), "the lead under the title")
        XCTAssertTrue(waitLabel(app, "+1 not written yet", contains: true), "the rest of the category, folded")
        // Nothing of how the wiki is kept: that is Activity's.
        for gone in ["1 proposal to review", "Writing documents · 5 of 35", "Recent decisions", "Recently changed",
                     "Agents used the wiki"] {
            XCTAssertTrue(absent(app, gone), "the home says \(gone)")
        }
        XCTAssertTrue(absent(app, "11,457 entries", contains: true), "the status line is Activity's")
        let activity = app.buttons["Activity"].firstMatch
        XCTAssertEqual(activity.value as? String, "1 waiting on you", "the bar's badge is the drawer's number")
        settle(2)
        shot("02-phone-home")
        tree(app, "phone-home")

        // The folded row opens to its titles, in grey with Not written yet.
        if let folded = button(app, containing: "+1 not written yet") {
            folded.tap()
            XCTAssertTrue(waitLabel(app, "自部署与首次运行", contains: true), "1.3 listed once its row is opened")
            settle(1.5)
            shot("03-phone-home-unfolded")
            folded.tap()
            settle(1)
        } else {
            XCTFail("no folded row to open")
        }

        // Down to the foot (mock 31 ①): every category not written yet one row, then Browse · A–Z.
        for _ in 0..<8 {
            if element(app, "Browse by category", contains: true).isHittable { break }
            app.swipeUp()
            settle(0.8)
        }
        XCTAssertTrue(waitLabel(app, "Browse by category", contains: true), "the home ends on Browse by category")
        XCTAssertTrue(waitLabel(app, "A–Z index", contains: true), "and the A–Z index")
        XCTAssertTrue(waitLabel(app, "2 documents · Not written yet", contains: true), "10's two documents, one row")
        settle(1.5)
        shot("04-phone-home-foot")
        tree(app, "phone-home-foot")
    }

    /// Mock 31 ③, then 31 ⑥: orbit's principles over its documents; wikids, a new space, says how it gets some.
    func testPrinciplesThenANewSpace() {
        let app = launch(port: 8766)
        guard openWiki(app, expecting: 4, shot: "11-phone-drawer-three") else { return }
        XCTAssertTrue(waitLabel(app, "Principles"), "the principles' band")
        XCTAssertTrue(waitLabel(app, "All 6 ›", contains: true), "the first three, then the way to all six")
        XCTAssertTrue(waitLabel(app, "协调会话间要交换可复核一手证据", contains: true), "oldest recorded first")
        XCTAssertTrue(absent(app, "时钟永远不启动 agent 工作", contains: true), "the fourth waits behind All 6 ›")
        XCTAssertTrue(waitLabel(app, "35 documents · 5 written"))
        settle(2)
        shot("12-phone-principles")
        tree(app, "phone-principles")

        let space = app.buttons["The codebase this wiki describes"]
        XCTAssertTrue(space.waitForExistence(timeout: 10), "several spaces: a menu")
        space.tap()
        let wikids = app.buttons.matching(NSPredicate(format: "label == %@", "wikids")).firstMatch
        guard wikids.waitForExistence(timeout: 10) else { return XCTFail("the menu lists no wikids") }
        wikids.tap()
        XCTAssertTrue(waitLabel(app, "No documents yet", timeout: 30), "the line says the space has none")
        XCTAssertTrue(waitLabel(app, "This wiki has no documents yet.", begins: true), "the one card (mock 31 ⑥)")
        XCTAssertTrue(waitLabel(app, "Set up maintenance"), "and the way to set it up")
        XCTAssertTrue(absent(app, "Browse by category", contains: true), "nothing listed, nothing to browse")
        settle(2)
        shot("13-phone-new-space")
        tree(app, "phone-new-space")
    }

    /// Mock 31 ⑦: the head drawn from the spaces list at once; the line and the documents grey until they answer.
    func testTheHeadComesFirstThenTheDocuments() {
        let app = launch(port: 8767)
        guard openWiki(app, expecting: 1, shot: "21-phone-drawer-slow") else { return }
        let space = app.staticTexts["The codebase this wiki describes"]
        XCTAssertTrue(space.waitForExistence(timeout: 10), "the head is there before the home's reads answer")
        XCTAssertTrue(absent(app, "35 documents · 5 written"), "the line is a grey bar while its read is out")
        XCTAssertTrue(absent(app, "产品概览与架构"), "the documents are grey bars too")
        shot("22-phone-loading")
        tree(app, "phone-loading")
        XCTAssertTrue(waitLabel(app, "35 documents · 5 written", timeout: 60), "then the content, in place")
        XCTAssertTrue(waitLabel(app, "产品概览与架构"))
        settle(1.5)
        shot("23-phone-loaded")
    }

    // MARK: the way in

    /// The drawer from orbit-develop's list: its Wiki row says the number waiting, then opens the Wiki.
    private func openWiki(_ app: XCUIApplication, expecting waiting: Int, shot name: String) -> Bool {
        let hamburger = app.buttons["Open navigation"].firstMatch
        guard hamburger.waitForExistence(timeout: 60) else {
            tree(app, "no-hamburger-\(name)")
            XCTFail("the shell never drew its drawer button")
            return false
        }
        settle(3)
        hamburger.tap()
        let said = "\(waiting) waiting on you"
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Wiki", said)).firstMatch
        guard row.waitForExistence(timeout: 20) else {
            tree(app, "no-wiki-row-\(name)")
            XCTFail("the drawer drew no Wiki row saying \(said)")
            return false
        }
        note("drawer row: \(describe(row))")
        settle(1)
        shot(name)
        press(row)
        return true
    }
}
