import XCTest

// TEMPORARY evidence probe (never merged): the Mac app against stub.py (task I2, mock 32 after — the Mac's three
// columns are the iPad's): the source list's Wiki opens the directory in the middle column and the content home
// in the detail pane; a document from the column fills the detail pane.
final class WikiMacShotsTests: WikiShotsCase {

    func testTheDirectoryBesideTheContent() {
        let app = launch(port: 8765)
        guard let wiki = appears(app, "Wiki", timeout: 60, contains: false) else {
            return XCTFail("the source list drew no Wiki row")
        }
        note("source list row: \(describe(wiki))")
        settle(2)
        wiki.click()
        for item in ["Browse by category", "A–Z index", "Plan"] {
            XCTAssertTrue(waitLabel(app, item, contains: true), "the directory column lists \(item)")
        }
        XCTAssertTrue(waitLabel(app, "35 documents · 5 written", timeout: 30), "the detail pane is the home")
        XCTAssertTrue(absent(app, "Pick an entry, or open Review."), "no empty detail pane")
        settle(2.5)
        shot("41-mac-wiki")
        if let doc = button(app, containing: "Session 运行与恢复") {
            note("column row: \(describe(doc))")
            doc.click()
            XCTAssertTrue(waitLabel(app, "会话运行模型与长连接：总览", timeout: 30, contains: true), "the document's page")
            settle(2)
            shot("42-mac-doc")
        } else {
            XCTFail("the column lists no 3.1")
        }
    }
}
