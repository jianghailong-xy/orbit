import XCTest

// TEMPORARY evidence probe (never merged): coordinator questions that have ended, in the iPhone app's own
// coordinator conversation, against .cqa-probe/stub.py (docs/mocks/coordinator-question-answered/). Each
// launch opens one conversation; the record cards are found by their own words, opened with the app's own
// tap, and photographed with their View details sheets. A record the app does not draw is a failure, not a
// note — and so is a sheet that does not replay the question and every option.
final class AnsweredShotTests: ProbeCase {
    private let restartLead = "灰度回退之后的收尾都做完了"
    private let exportLead = "灰度跑完之后"
    private let recommended = "现在重开，接受这个代价（推荐）"

    /// Launch onto one conversation and wait for `words`.
    private func open(_ session: String, until words: String, _ name: String,
                      reset: Bool = true) -> XCUIApplication {
        if reset { resetStub() }
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.session", session,
                               "-ApplePersistenceIgnoreState", "YES", "-probe.fresh"]
        app.launchEnvironment["TZ"] = "Asia/Shanghai"
        app.launch()
        if !appears(app, words, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed — the app did not draw the stub's record")
        }
        settle(3)
        return app
    }

    /// The record card whose words include `words` — the card is one button, View details and all.
    private func card(_ app: XCUIApplication, _ words: String, _ name: String) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@",
                                                     "View details", words))
        guard query.firstMatch.waitForExistence(timeout: 20) else {
            write(app.debugDescription, "missing-card-\(name).txt")
            XCTFail("\(name): no record card with \(words)")
            return nil
        }
        let found = query.firstMatch
        note("\(name): card \(describe(found))")
        return found
    }

    /// Open the card's sheet and wait for its footer.
    private func details(_ app: XCUIApplication, _ card: XCUIElement, footer: String, _ name: String) -> Bool {
        if !card.isHittable { bring(app, card, between: 140, and: 700, missingIsAbove: true, name) }
        card.tap()
        guard appears(app, footer, timeout: 15) else {
            write(app.debugDescription, "missing-sheet-\(name).txt")
            XCTFail("\(name): the sheet never said \(footer)")
            return false
        }
        settle(1.5)
        return true
    }

    private func close(_ app: XCUIApplication) {
        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) { close.tap() } else { note("no Close button") }
        settle(1.2)
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            write(app.debugDescription, "missing-text-\(name).txt")
            XCTFail("\(name): nothing says \(text)")
        }
    }

    /// Every label on screen, for the notes beside the picture.
    private func labels(_ app: XCUIApplication, _ name: String) {
        let texts = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) texts: " + texts.prefix(80).joined(separator: " ¦ "))
        let buttons = app.buttons.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) buttons: " + buttons.prefix(40).joined(separator: " ¦ "))
    }

    // MARK: 1 · two answers in the conversation, and the sheet of the first

    func test1TwoAnswersAndTheSheet() {
        let app = open("C1", until: recommended, "two")
        guard let first = card(app, restartLead, "two-first"), card(app, exportLead, "two-second") != nil else {
            shot("ios-01-two-answered")
            return
        }
        expectText(app, ["Answered", "批准经现有 SSH 取文件（推荐）", "View details"], "two")
        labels(app, "two")
        shot("ios-01-two-answered")
        tree(app, "two")

        guard details(app, first, footer: "Answered by you", "sheet") else { return }
        expectText(app, ["FROM COORDINATOR", "asked 08:10", "等新一轮刚开始时再切", "先不重开", "Recommended",
                         "不专门挑时间", "Answered by you · 08:29", "Delivered to the current coordinator"], "sheet")
        labels(app, "sheet")
        shot("ios-02-sheet")
        tree(app, "sheet")
        // The rest of the question and its last option, as a reader scrolls the sheet; the footer stays.
        app.swipeUp(velocity: .slow)
        settle(1.2)
        shot("ios-02b-sheet-scrolled")
        close(app)
    }

    // MARK: 2 · an option and a note

    func test2OptionAndNote() {
        let app = open("C2", until: "等新一轮刚开始时再切", "note")
        guard let found = card(app, "今晚 22 点以后再切", "note") else { shot("ios-03-note"); return }
        labels(app, "note")
        shot("ios-03-note")
        guard details(app, found, footer: "Answered by you", "note-sheet") else { return }
        app.swipeUp(velocity: .slow)
        settle(1.2)
        expectText(app, ["Your note", "今晚 22 点以后再切，白天有人在用。", "Delivered to the current coordinator"],
                   "note-sheet")
        labels(app, "note-sheet")
        shot("ios-03b-note-sheet")
        close(app)
    }

    // MARK: 3 · the Other row

    func test3Other() {
        let app = open("C3", until: "先别取文件", "other")
        guard let found = card(app, "先别取文件", "other") else { shot("ios-04-other"); return }
        labels(app, "other")
        shot("ios-04-other")
        guard details(app, found, footer: "Answered by you", "other-sheet") else { return }
        app.swipeUp(velocity: .slow)
        settle(1.2)
        expectText(app, ["Other — say it in my own words", "先别取文件，等我明天看过导出脚本再说。"], "other-sheet")
        labels(app, "other-sheet")
        shot("ios-04b-other-sheet")
        close(app)
    }

    // MARK: 4 · a question with no options, answered yesterday

    func test4NoOptions() {
        let app = open("C4", until: "夜里跑", "free")
        guard let found = card(app, "夜里跑", "free") else { shot("ios-05-no-options"); return }
        labels(app, "free")
        shot("ios-05-no-options")
        guard details(app, found, footer: "Answered by you", "free-sheet") else { return }
        expectText(app, ["Your answer", "夜里跑，出了问题等我早上看。"], "free-sheet")
        labels(app, "free-sheet")
        shot("ios-05b-no-options-sheet")
        close(app)
    }

    // MARK: 5 · no coordinator has had the answer yet

    func test5Waiting() {
        let app = open("C5", until: "Waiting for this project", "waiting")
        guard let found = card(app, restartLead, "waiting") else { shot("ios-06-waiting"); return }
        labels(app, "waiting")
        shot("ios-06-waiting")
        guard details(app, found, footer: "Answered by you", "waiting-sheet") else { return }
        expectText(app, ["Waiting for this project’s next coordinator"], "waiting-sheet")
        labels(app, "waiting-sheet")
        shot("ios-06b-waiting-sheet")
        close(app)
    }

    // MARK: 6 · withdrawn

    func test6Withdrawn() {
        let app = open("C6", until: "Withdrawn", "withdrawn")
        guard let found = card(app, "The coordinator withdrew it", "withdrawn") else { shot("ios-07-withdrawn"); return }
        expectText(app, ["灰度已经回退，这一步不需要了。"], "withdrawn")
        labels(app, "withdrawn")
        shot("ios-07-withdrawn")
        guard details(app, found, footer: "Withdrawn by the coordinator", "withdrawn-sheet") else { return }
        expectText(app, ["批准经现有 SSH 取文件（推荐）", "改用任务评论传", "不做真实数据对照"], "withdrawn-sheet")
        if containing(app, "Answered by you").exists { XCTFail("withdrawn-sheet: says Answered by you") }
        labels(app, "withdrawn-sheet")
        shot("ios-07b-withdrawn-sheet")
        close(app)
    }

    // MARK: 7 · answered here, with the app's own Send answer — and still there after a relaunch

    func test7AnsweredHereAndAfterRelaunch() {
        let app = open("C7", until: "View details & act", "live")
        labels(app, "live-open")
        shot("ios-08-open-question")
        let question = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "View details & act")).firstMatch
        guard question.exists else { XCTFail("live: no open question card"); return }
        question.tap()
        guard appears(app, "Send answer", timeout: 15) else {
            write(app.debugDescription, "missing-live-sheet.txt")
            XCTFail("live: the question's sheet never offered Send answer")
            return
        }
        settle(1)
        // The second option, so the record says the owner's press and not the recommendation.
        let second = app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND NOT (label CONTAINS %@)",
                                                      "等新一轮刚开始时再切", "View details")).firstMatch
        if second.waitForExistence(timeout: 5) {
            if !second.isHittable { bring(app, second, between: 140, and: 640, missingIsAbove: false, "live-option") }
            second.tap()
        } else {
            write(app.debugDescription, "missing-live-option.txt")
            XCTFail("live: no second option to pick")
        }
        settle(0.8)
        shot("ios-08b-picked")
        let send = app.buttons["Send answer"]
        guard send.exists else { XCTFail("live: no Send answer"); return }
        send.tap()
        // The sheet stays open on the question and becomes its record: drawn from what was sent, then
        // replaced by the server's copy of the same record.
        guard appears(app, "Answered by you", timeout: 20) else {
            write(app.debugDescription, "missing-live-record.txt")
            XCTFail("live: the sheet never became the record of the answer")
            return
        }
        settle(1.5)
        expectRequest("/api/projects/P7/open-items/Q8/answer", "live")
        labels(app, "live-sheet")
        shot("ios-08c-answered-sheet")
        close(app)
        guard card(app, "等新一轮刚开始时再切", "live-record") != nil else { shot("ios-08d-answered-card"); return }
        if app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "View details & act")).firstMatch.exists {
            XCTFail("live: the question card is still drawn beside its record")
        }
        labels(app, "live-record")
        shot("ios-08d-answered-card")

        // A relaunch — no memory of the press — reads the record back from the server.
        app.terminate()
        let again = open("C7", until: "等新一轮刚开始时再切", "relaunch", reset: false)
        if card(again, "等新一轮刚开始时再切", "relaunch") == nil { return }
        if again.buttons.matching(NSPredicate(format: "label CONTAINS %@", "View details & act")).firstMatch.exists {
            XCTFail("relaunch: an answered question came back as a question")
        }
        labels(again, "relaunch")
        shot("ios-09-after-relaunch")
    }
}
