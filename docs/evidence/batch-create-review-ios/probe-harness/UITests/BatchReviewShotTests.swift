import XCTest

// TEMPORARY evidence probe (never merged): photographs the batch-create review on the iPhone, then opens
// a task's page the way a person does (a tap on its row) and photographs that.
final class BatchReviewShotTests: XCTestCase {

    override func setUp() {
        continueAfterFailure = true
    }

    func testTheReviewAndATaskPage() {
        // The three independent tasks of the owner's screenshot; then the made-up batch with levels.
        drive("real3", wait: "3 need a manual start", open: "管理员共享模型提供方的 API key")
        drive("diamond", wait: "1 starts running within the minute", open: "开放注册 e2e")
    }

    private func drive(_ state: String, wait: String, open title: String) {
        let app = XCUIApplication()
        app.launchArguments = ["-probe.state", state]
        app.launch()
        if !appears(app, wait, timeout: 45) {
            attach(app.debugDescription, "\(state)-missing.txt")
            XCTFail("\(state): \(wait) never showed")
        }
        settle(2)
        shot("\(state)-1-review")
        attach(app.debugDescription, "\(state)-1-review-tree.txt")

        // The review scrolls under its action bar: show the end of it too.
        app.swipeUp()
        settle(1.5)
        shot("\(state)-2-review-scrolled")
        app.swipeDown()
        settle(1.5)

        let row = element(app, containing: title)
        if row.waitForExistence(timeout: 10) {
            if !row.isHittable { app.swipeUp(); settle(1) }
            row.tap()
        } else {
            XCTFail("\(state): no row containing \(title)")
        }
        settle(2)
        shot("\(state)-3-task-page")
        attach(app.debugDescription, "\(state)-3-task-page-tree.txt")
        app.swipeUp()
        settle(1.5)
        shot("\(state)-4-task-page-scrolled")
        app.terminate()
    }

    private func element(_ app: XCUIApplication, containing words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    private func appears(_ app: XCUIApplication, _ words: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if element(app, containing: words).exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    private func settle(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(data: XCUIScreen.main.screenshot().pngRepresentation,
                                       uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attach(_ text: String, _ name: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
