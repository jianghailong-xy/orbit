import XCTest
#if os(iOS)
import UIKit
#endif

// TEMPORARY evidence probe (never merged): the Scheduled page's chat in the iPhone, iPad and Mac apps against stub.py
// (task 354CXjOML0uOFkSP36f4M, docs/scheduled-chat-design.md §6, board docs/mocks/scheduled-chat/01-board-4.png).
//
//   iPhone  ① the toolbar's Chat button on Scheduled; ② the chat as a sheet (medium, then large) with the change line,
//           Undo and the Run now button; ③ the schedule's name opens that schedule's sheet with ‹ Chat, which goes back
//           to the conversation; the chat never opens by itself; a new chat shows Orbit's opening
//   iPad    the button opens a third column beside the list; the name opens the schedule; open is remembered on the
//           device, closed too
//   Mac     the button opens a third column beside the inspector; remembered per device; never open the first time
//
// A state the stub never drove, or a check that does not hold, fails the test; the pictures are taken anyway.
final class ScheduledChatShotTests: ProbeCase {
    #if os(iOS)
    private var phone: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    private var platform: String { phone ? "ios" : "ipad" }
    #else
    private let phone = false
    private let platform = "mac"
    #endif

    private let listWords = "Codex stable check"
    private let askWords = "Move the audit to 07:00"

    private func open(_ stage: String, _ name: String, fresh: Bool = true) -> XCUIApplication {
        resetStub()
        if stage != "chat" { setStub("{\"stage\": \"\(stage)\"}") }
        return launch("scheduled", reset: false, fresh: fresh, until: listWords, name)
    }

    private func chatButton(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "scheduled-chat-button").firstMatch
    }

    private func press(_ element: XCUIElement) {
        #if os(macOS)
        element.click()
        #else
        element.tap()
        #endif
    }

    /// The chat is showing: its panel is in the tree (a sheet at medium height opens scrolled to the conversation's
    /// end, so the first turn's words may be above the fold).
    private func chatShows(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let panel = app.descendants(matching: .any).matching(identifier: "scheduled-chat-panel").firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if panel.exists { return true }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return false
    }

    // MARK: iPhone (board 4 ① ② ③)

    func testPhoneSheetNameOpensTheScheduleAndChatGoesBack() throws {
        // `phone` is false on a Mac, so the Mac skips these too.
        guard phone else { throw XCTSkip("iPhone only") }
        let tag = "\(platform)-sheet"
        let app = open("chat", tag)
        let button = chatButton(app)
        note("\(tag): button \(describe(button))")
        XCTAssertTrue(button.waitForExistence(timeout: 15), "\(tag): the toolbar has the Chat button")
        XCTAssertFalse(chatShows(app, timeout: 3), "\(tag): the chat never opens by itself")
        shot("ios-1-toolbar-button")

        press(button)
        XCTAssertTrue(chatShows(app, timeout: 20), "\(tag): the button opens the chat")
        settle(2)
        shot("ios-2-sheet-medium")

        // Drag the sheet to its large detent: the Run now button after the second answer comes into view.
        let window = app.windows.firstMatch
        let grip = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.47))
        grip.press(forDuration: 0.1, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)))
        settle(1.5)
        let runNow = app.buttons.matching(identifier: "scheduled-run-now-button").firstMatch
        if !runNow.waitForExistence(timeout: 8) { tree(app, "\(tag)-no-run-now") }
        XCTAssertTrue(runNow.exists, "\(tag): the answer's Run now link is drawn as a button")
        shot("ios-2b-sheet-large")

        let name = app.buttons.matching(identifier: "schedule-record-name").firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 10), "\(tag): the change line names its schedule as a link")
        let undo = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "schedule-record-undo-")).firstMatch
        XCTAssertTrue(undo.exists, "\(tag): the change line has Undo")
        note("\(tag): name \(describe(name)); undo \(describe(undo))")
        press(name)

        let back = app.buttons.matching(identifier: "schedule-back-to-chat").firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 15), "\(tag): the schedule's sheet opens with ‹ Chat")
        XCTAssertTrue(appears(app, "Nightly dependency audit", timeout: 10), "\(tag): it is the named schedule's sheet")
        XCTAssertFalse(app.buttons.matching(identifier: "scheduled-run-now-button").firstMatch.exists,
                       "\(tag): the chat's sheet folded first")
        settle(1.5)
        shot("ios-3-schedule-sheet-chat-back")

        press(back)
        XCTAssertTrue(chatShows(app, timeout: 15), "\(tag): ‹ Chat goes back to the conversation")
        XCTAssertFalse(back.exists, "\(tag): the schedule's sheet went")
        settle(1.5)
        shot("ios-4-back-in-the-chat")
    }

    func testPhoneNewChatShowsOrbitsOpening() throws {
        // `phone` is false on a Mac, so the Mac skips these too.
        guard phone else { throw XCTSkip("iPhone only") }
        let tag = "\(platform)-new"
        let app = open("new", tag)
        press(chatButton(app))
        XCTAssertTrue(appears(app, "You have 4 scheduled tasks", timeout: 20), "\(tag): Orbit's opening")
        XCTAssertTrue(appears(app, "Runs in", timeout: 5), "\(tag): Runs in for a new chat")
        settle(2)
        shot("ios-5-new-chat-opening")
    }

    // MARK: iPad and Mac (board 4, right-hand notes)

    func testColumnOpensBesideAndIsRememberedOnTheDevice() throws {
        guard !phone else { throw XCTSkip("iPad and Mac only") }
        let tag = "\(platform)-column"
        var app = open("chat", tag)
        XCTAssertFalse(chatShows(app, timeout: 4), "\(tag): never open the first time")
        #if os(macOS)
        // A row's inspector first, so the chat is the third column beside it.
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Nightly dependency audit")).firstMatch
        if row.waitForExistence(timeout: 10) { row.click(); settle(1.5) } else { note("\(tag): no row to select") }
        #endif
        shot("\(platform)-1-before")

        press(chatButton(app))
        XCTAssertTrue(chatShows(app, timeout: 20), "\(tag): the button opens the third column")
        settle(2.5)
        shot("\(platform)-2-third-column")

        let name = app.buttons.matching(identifier: "schedule-record-name").firstMatch
        if name.waitForExistence(timeout: 10) {
            press(name)
            settle(2)
            note("\(tag): the chat still shows after the name: \(chatShows(app, timeout: 3))")
            XCTAssertFalse(app.buttons.matching(identifier: "schedule-back-to-chat").firstMatch.exists,
                           "\(tag): no ‹ Chat beside a column")
            shot("\(platform)-3-name-opens-schedule")
            #if os(iOS)
            let close = app.buttons["Close"]
            if close.waitForExistence(timeout: 5) { close.tap(); settle(1.5) }
            #endif
        } else {
            XCTFail("\(tag): the change line names its schedule as a link")
        }

        // Left open: the next launch on this device shows it again.
        app.terminate()
        app = open("chat", "\(tag)-relaunch-open", fresh: false)
        XCTAssertTrue(chatShows(app, timeout: 20), "\(tag): open is remembered on the device")
        shot("\(platform)-4-remembered-open")

        // Closed with the button: the next launch does not show it.
        press(chatButton(app))
        settle(1.5)
        app.terminate()
        app = open("chat", "\(tag)-relaunch-closed", fresh: false)
        XCTAssertFalse(chatShows(app, timeout: 6), "\(tag): closed is remembered too")
        shot("\(platform)-5-remembered-closed")
    }
}
