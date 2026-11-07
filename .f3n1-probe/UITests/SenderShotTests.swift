import XCTest

// TEMPORARY evidence probe (never merged): a Feishu group member's turn drawn as `From Feishu · <name>` in
// the iPhone app (task 34tKGg8Mi2jmMzS3l3yeY, docs/feishu-bot-design.md §8.2), against stub.py. The words
// are looked for on screen; a sender the app does not draw is a failure, not a note.
final class SenderShotTests: ProbeCase {
    private func open(_ session: String?, until words: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            + (session.map { ["-probe.session", $0] } ?? [])
        app.launch()
        if !appears(app, words, timeout: 60) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed")
        }
        settle(3)
        return app
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            write(app.debugDescription, "missing-text-\(name).txt")
            XCTFail("\(name): nothing says \(text)")
        }
    }

    private func labels(_ app: XCUIApplication, _ name: String) {
        let texts = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
        note("\(name) texts: " + texts.prefix(80).joined(separator: " ¦ "))
    }

    /// The session list: each row says who sent the message it previews.
    func test1TheRowsNameTheSender() {
        let app = open(nil, until: "From Feishu · Li Lei:", "list")
        expectText(app, ["From Feishu · Li Lei: Can you also check why the export failed last night?",
                         "From Feishu: Please rerun the export for October.",
                         "You: Bump the runner to 0.1.240 and tag it.",
                         "Orbit: Your background job finished: nightly export dry run (exit 0)."], "list")
        labels(app, "list")
        shot("ios-01-session-list")
        tree(app, "list")
    }

    /// The conversation: the bubble is headed with who sent it; the owner's earlier bubble is not.
    func test2TheBubbleIsHeadedWithTheSender() {
        let app = open("F1", until: "From Feishu · Li Lei", "console")
        expectText(app, ["From Feishu · Li Lei", "failed last night", "Add a retry to the nightly export job."], "console")
        labels(app, "console")
        shot("ios-02-console-bubble")
        tree(app, "console")
    }

    /// No name from Feishu: the line says Feishu alone.
    func test3NoNameSaysFeishuAlone() {
        let app = open("F2", until: "Please rerun the export for October.", "console-unnamed")
        expectText(app, ["From Feishu"], "console-unnamed")
        if containing(app, "From Feishu · ").exists { XCTFail("console-unnamed: a name was drawn where Feishu gave none") }
        shot("ios-03-console-unnamed")
    }
}
