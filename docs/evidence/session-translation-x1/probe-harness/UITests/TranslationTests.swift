import XCTest

// TEMPORARY evidence probe (never merged). Translation X1: Settings › Sessions › Translation on an iOS
// iPhone (board docs/mocks/session-translation, frames 2 and 7), against stub.py serving the /users/me
// answers a real apiserver built from the project branch gave: off by default, on after the Web
// turned it on (account-wide), and a server without DEEPSEEK_API_KEY.
final class TranslationTests: ProbeCase {
    private func setMode(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__mode/\(mode)")!)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }

    private let hint = "Agents read and write in English; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are."
    private let footnote = "Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a conversation stays as it was."
    private let notice = "This server has no DeepSeek key, so it can't translate. Whoever runs it sets DEEPSEEK_API_KEY and restarts it."

    /// Open Settings › Sessions in this mode and bring the Translation group into view.
    private func open(_ mode: String) -> (XCUIApplication, XCUIElement) {
        setMode(mode)
        let app = launch(until: "Default permission", mode)
        let toggle = app.switches["settings.translation.enabled"]
        XCTAssertTrue(waitUntil(20) { toggle.exists || self.element(app, containing: "Translate conversations").exists },
                      "\(mode): no Translation switch")
        bring(app, element(app, containing: "Agents work in"), between: 120, and: 700, mode)
        settle(1.5)
        return (app, toggle)
    }

    private func record(_ app: XCUIApplication, _ toggle: XCUIElement, _ name: String) {
        let labels = ["Translation", "Translate conversations", "Your language", "Agents work in", "English",
                      "Chinese (Simplified)", "Session orchestration", "Default permission", "Session recaps"]
        for words in labels {
            let e = element(app, containing: words)
            note("\(name): \"\(words)\" exists=\(e.exists)" + (e.exists ? " y=\(Int(e.frame.minY))" : ""))
        }
        note("\(name): footer hint+footnote exists=\(element(app, containing: hint + " " + footnote).exists)")
        note("\(name): notice exists=\(element(app, containing: notice).exists)")
        note("\(name): switch exists=\(toggle.exists) value=\(String(describing: toggle.exists ? toggle.value : nil)) enabled=\(toggle.exists ? toggle.isEnabled : false)")
        write(app.debugDescription, "\(name)-tree.txt")
        shot(app, name)
    }

    /// Frame 7, a fresh account on a server with a key: off by default; then turned on from the phone.
    func test1OffByDefault() {
        let (app, toggle) = open("off")
        record(app, toggle, "ios-translation-off")
        XCTAssertEqual(toggle.value as? String, "0", "off by default")
        XCTAssertTrue(toggle.isEnabled)
        XCTAssertFalse(element(app, containing: notice).exists)
        for words in ["Your language", "Agents work in", "Chinese (Simplified)", "English"] {
            XCTAssertTrue(element(app, containing: words).exists, words)
        }
        // The phone writes the account's switch: the stub logs the PATCH body.
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        settle(2)
        let log = requestsLog()
        let patched = log.contains("\"translationEnabled\":true")
        note("ios-translation-off: PATCH translationEnabled true logged=\(patched)")
        XCTAssertTrue(patched, "the phone's press reaches PATCH /users/me/preferences")
        record(app, toggle, "ios-translation-after-press")
        // Your language: the pushed list of the seven.
        let row = element(app, containing: "Your language")
        if row.exists {
            press(row)
            settle(1.5)
            for lang in ["Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean", "Spanish", "French", "German"] {
                let e = element(app, containing: lang)
                note("language list: \(lang) exists=\(e.exists)")
                XCTAssertTrue(e.exists, lang)
            }
            note("language list: hint exists=\(element(app, containing: "What you write in, and what replies are shown in.").exists)")
            shot(app, "ios-translation-languages")
        }
    }

    /// Account-wide: the Web turned it on; the phone reads it through /users/me.
    func test2SharedFromWeb() {
        let (app, toggle) = open("on")
        record(app, toggle, "ios-translation-on-from-web")
        XCTAssertEqual(toggle.value as? String, "1", "on, as the Web left it")
    }

    /// Frame 2: the server has no DeepSeek key.
    func test3NoKey() {
        let (app, toggle) = open("nokey")
        record(app, toggle, "ios-translation-nokey")
        XCTAssertTrue(element(app, containing: notice).exists, "frame 2 notice")
        XCTAssertFalse(toggle.isEnabled, "switch disabled")
        XCTAssertEqual(toggle.value as? String, "0", "drawn off whatever the preference says")
    }
}
