import XCTest

// TEMPORARY evidence probe (see ../README.md), task 34vcF5ruSIhVT0TeMblMY (Translation X3): one translated
// conversation on the iPhone and the Mac against stub.py, which replays what the real apiserver answered for a real
// translated session (board frames 4–6 and 8). Every claim is a note (`shown` / `MISSING`) and an assertion; the
// pictures are kept either way.
final class TranslationShotTests: ProbeCase {
    private func claim(_ what: String, _ holds: Bool, file: StaticString = #filePath, line: UInt = #line) {
        note("\(holds ? "shown" : "MISSING"): \(what)")
        XCTAssertTrue(holds, what, file: file, line: line)
    }

    private func openConversation(_ name: String) -> XCUIApplication {
        let app = launch(until: "Chinese → English", extra: ["-probe.session", "T1"], name)
        settle(2)
        return app
    }

    /// The conversation opens at its tail: drag (iOS) or scroll (macOS) back to its top, where the first message is.
    private func toTop(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        #if os(iOS)
        let steps = 6
        #else
        let steps = 20
        #endif
        for _ in 0..<steps {
            #if os(iOS)
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 420)),
                        withVelocity: .fast, thenHoldForDuration: 0.3)
            #else
            let point = window.coordinate(withNormalizedOffset: CGVector(dx: macScrollX, dy: 0.5))
            point.hover()
            point.scroll(byDeltaX: 0, deltaY: 40)
            #endif
            settle(0.6)
        }
        settle(1)
    }

    func testATranslatedConversation() {
        let app = openConversation("conversation")
        toTop(app)
        shot(app, "04-conversation-translated")
        write(app.debugDescription, "tree-04-conversation-translated.txt")
        claim("the owner's message shows what they wrote", element(app, containing: "登录页在 Safari 上点 Google 登录没反应").exists)
        claim("…and not the English the agent got", !element(app, containing: "does nothing in Safari").exists)
        claim("reply 1 shows its translation", element(app, containing: "我先看一下登录页里 Google 登录按钮的处理逻辑").exists)
        claim("…not its English", !element(app, containing: "I'll check how the login page").exists)
        claim("Translated · Show original under them", element(app, containing: "Translated").exists
              && !buttons(app, beginning: "Show original").isEmpty)
        claim("the tool calls are drawn as they are (LoginPage.tsx)", element(app, containing: "LoginPage.tsx").exists)
        claim("the composer tag reads Chinese → English", element(app, containing: "Chinese → English").exists)

        bring(app, element(app, containing: "原因找到了"), between: 160, and: 520, "found-it")
        settle(1)
        shot(app, "05-conversation-reply-code")
        write(app.debugDescription, "tree-05-conversation-reply-code.txt")
        claim("reply 2 shows its translation", element(app, containing: "原因找到了").exists)
        claim("its inline code is untouched (signInWithPopup)", element(app, containing: "signInWithPopup").exists)
        claim("its code block is untouched (useEffect(() => { void loadGoogleScript(); }, []);)",
              element(app, containing: "void loadGoogleScript()").exists)

        // The tail, as frame 6 draws it: a translated reply, a failed one, and the two held messages.
        bring(app, element(app, containing: "Couldn't translate this reply"), between: 200, and: 640, "tail")
        settle(1)
        shot(app, "06-conversation-states")
        write(app.debugDescription, "tree-06-conversation-states.txt")
        claim("the second message shows what the owner wrote", element(app, containing: "好的，改吧").exists)
        claim("reply 3 shows its translation", element(app, containing: "我会把脚本加载移到").exists)
        claim("Couldn't translate this reply · Retry, with the English shown",
              element(app, containing: "Couldn't translate this reply").exists
              && element(app, containing: "Done. The popup now opens").exists)
        claim("Couldn't translate, so it wasn't sent · Retry · Send as written",
              element(app, containing: "Couldn't translate, so it wasn't sent").exists
              && !buttons(app, beginning: "Send as written").isEmpty)
        claim("Translating… on the message still being translated", element(app, containing: "Translating…").exists)
    }

    func testThinkingIsNotTranslated() {
        let app = openConversation("thinking")
        toTop(app)
        let thought = buttons(app, beginning: "Thought").first ?? element(app, containing: "Thought")
        if thought.exists { press(thought); settle(1) }
        shot(app, "07-thinking-open")
        write(app.debugDescription, "tree-07-thinking-open.txt")
        claim("the thinking reads as the engine wrote it", element(app, containing: "Likely a popup blocker issue").exists)
    }

    func testShowOriginalFlipsOneMessage() {
        let app = openConversation("show-original")
        toTop(app)
        for round in 1...2 {
            guard let button = buttons(app, beginning: "Show original").first(where: { $0.exists && $0.isHittable }) else {
                note("round \(round): no Show original on screen")
                break
            }
            note("round \(round): pressing Show original at \(button.frame)")
            press(button)
            settle(1)
        }
        settle(1)
        shot(app, "08-conversation-show-original")
        write(app.debugDescription, "tree-08-conversation-show-original.txt")
        claim("the message flipped to the English the agent got", element(app, containing: "does nothing in Safari").exists)
        claim("…saying Sent to the agent in English · Show translation",
              element(app, containing: "Sent to the agent in English").exists
              && !buttons(app, beginning: "Show translation").isEmpty)
        claim("a reply flipped to its original, saying Original",
              element(app, containing: "I'll check how the login page").exists
              || element(app, containing: "Found it: Safari blocks popups").exists)
        claim("a message not pressed stays translated", element(app, containing: "好的，改吧").exists)
    }

    func testReplyRetryTranslatesIt() {
        resetStub()
        let app = openConversation("retry")
        bring(app, element(app, containing: "Couldn't translate this reply"), between: 200, and: 640, "retry-row")
        settle(1)
        let retry = buttons(app, beginning: "Retry").first(where: { $0.exists && $0.isHittable })
        claim("the failed reply has a Retry", retry != nil)
        if let retry { press(retry) }
        let swapped = appears(app, "改好了。现在点击会同步打开弹窗", timeout: 20)
        settle(1)
        shot(app, "09-reply-retried")
        write(app.debugDescription, "tree-09-reply-retried.txt")
        claim("Retry asked the server (POST …/events/13/translation/retry)",
              requestsLog().contains("/api/sessions/T1/events/13/translation/retry"))
        claim("the live translation replaced the English", swapped)
        claim("…and the failure line is gone", !element(app, containing: "Couldn't translate this reply").exists)
    }

    func testStreamingReplyCarriesTheChip() {
        resetStub()
        setStub(#"{"streaming": true}"#)
        let app = launch(until: "Chinese → English", extra: ["-probe.session", "T1"], reset: false, "streaming")
        let chip = appears(app, "Translates when the reply is done", timeout: 20)
        bring(app, element(app, containing: "Translates when the reply is done"), between: 200, and: 640, "stream-chip")
        shot(app, "10-streaming-chip")
        write(app.debugDescription, "tree-10-streaming-chip.txt")
        claim("the streaming reply carries Translates when the reply is done", chip)
        claim("the streamed English is what is shown", element(app, containing: "Merging the branch").exists)
    }
}
