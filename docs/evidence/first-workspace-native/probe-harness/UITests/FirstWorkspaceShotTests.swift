import XCTest

// Evidence probe (see ../README.md): a machine's first workspace, driven as a person drives it against
// stub.py, on the real shells. A word missing from the screen, a press that goes nowhere or a request the
// app didn't make fails the test; each scene is photographed for the comparison with board 03.
final class FirstWorkspaceShotTests: ProbeCase {
    private let message = "Fix the flaky login test in tests/auth — it fails about one run in five on CI."
    private let waiting = "Waiting for orbit@austin — sends once both steps are done"
    private let found = "Found · git repository · main"

    private var isPad: Bool {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad
        #else
        false
        #endif
    }

    private var isPhone: Bool {
        #if os(iOS)
        !isPad
        #else
        false
        #endif
    }

    /// Each platform's pictures under their own names.
    private func name(_ scene: String) -> String {
        #if os(iOS)
        isPad ? "ipad-\(scene)" : scene
        #else
        "mac-\(scene)"
        #endif
    }

    private func expect(_ app: XCUIApplication, _ words: String, _ scene: String, timeout: TimeInterval = 15) {
        if !appears(app, words, timeout: timeout) {
            write(app.debugDescription, "missing-\(scene).txt")
            XCTFail("\(scene): \"\(words)\" never showed")
        }
    }

    private func absent(_ app: XCUIApplication, _ words: String, _ scene: String) {
        if element(app, containing: words).exists {
            write(app.debugDescription, "present-\(scene).txt")
            XCTFail("\(scene): \"\(words)\" shows, and must not")
        }
    }

    /// The first button with these words that can take a press, brought on screen first.
    private func tapButton(_ app: XCUIApplication, _ words: String, _ scene: String) {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR title BEGINSWITH %@", words, words))
        let button = query.firstMatch
        guard button.waitForExistence(timeout: 15) else {
            write(app.debugDescription, "no-button-\(scene).txt")
            return XCTFail("\(scene): no \"\(words)\" to press")
        }
        bring(app, button, between: 90, and: bandBottom, "\(scene)-button")
        press(button)
        settle(1)
    }

    /// Above the composer, where a press lands on what it means to.
    private var bandBottom: CGFloat {
        #if os(iOS)
        isPad ? 660 : 730
        #else
        640
        #endif
    }

    /// A text view on a phone; on a Mac a vertical TextField, with the card's fields beside it.
    private func composer(_ app: XCUIApplication) -> XCUIElement {
        #if os(macOS)
        return app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "Send orbit@austin a task…")).firstMatch
        #else
        let views = app.textViews.allElementsBoundByIndex.filter { $0.exists }
        return views.max(by: { $0.frame.minY < $1.frame.minY }) ?? app.textViews.firstMatch
        #endif
    }

    /// The text field holding these words. By its type: a value predicate over every element of a Mac
    /// window times the query out.
    private func field(_ app: XCUIApplication, holding words: String) -> XCUIElement {
        let holding = NSPredicate(format: "value CONTAINS %@", words)
        #if os(macOS)
        return app.textFields.matching(holding).firstMatch
        #else
        return app.textViews.matching(holding).firstMatch
        #endif
    }

    private func sendButton(_ app: XCUIApplication) -> XCUIElement {
        for words in ["Send", "Up Arrow", "arrow.up.circle.fill", "Arrow Up Circle"] {
            let hit = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", words, words)).firstMatch
            if hit.exists { return hit }
        }
        return app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'up' AND NOT (label CONTAINS[c] 'set up')")).firstMatch
    }

    /// Type into the composer and press Send, with the keyboard down again.
    private func send(_ app: XCUIApplication, _ text: String, _ scene: String) {
        let field = composer(app)
        guard field.waitForExistence(timeout: 15) else {
            write(app.debugDescription, "no-composer-\(scene).txt")
            return XCTFail("\(scene): no composer")
        }
        press(field)
        settle(0.8)
        field.typeText(text)
        settle(0.8)
        let button = sendButton(app)
        if !button.exists { write(app.debugDescription, "no-send-\(scene).txt") }
        press(button)
        settle(1.5)
    }

    private func openTheDrawer(_ app: XCUIApplication) {
        #if os(iOS)
        if isPhone {
            press(app.buttons["Open navigation"])
            settle(1.5)
        }
        #endif
    }

    private func lowerKeyboard(_ app: XCUIApplication) {
        #if os(iOS)
        guard app.keyboards.firstMatch.exists else { return }
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 400)),
                    withVelocity: .fast, thenHoldForDuration: 0.3)
        settle(1)
        #endif
    }

    /// The lines of the log with this in them, since this launch put the stub back: the log is the
    /// whole pass's.
    private func requests(_ line: String) -> [String] {
        let sinceReset = requestsLog().components(separatedBy: "POST /__reset").last ?? ""
        return sinceReset.components(separatedBy: "\n").filter { $0.contains(line) }
    }

    /// One POST /sessions made the workspace: the machine and the folder named, no workspace.
    private func checkTheCreate(_ folder: String, _ scene: String, provider: String = "claude") {
        let creates = requests("BODY /api/sessions {")
        XCTAssertEqual(creates.count, 1, "\(scene): one send, one create: \(creates)")
        guard let body = creates.first else { return }
        note("\(scene): \(body)")
        for piece in ["\"assignedRunnerId\": \"austin\"", "\"engine\": \"claude\"", "\"provider\": \"\(provider)\"",
                      "\"newWorkspace\": \(folder)", "\"prompt\": \"\(message)\""] {
            XCTAssertTrue(body.contains(piece), "\(scene): the create lacks \(piece): \(body)")
        }
        XCTAssertFalse(body.contains("\"agentId\""), "\(scene): no workspace is named: \(body)")
    }

    // MARK: board 03 ① ②: the drawer's row and the card

    func test0TheCardIsWhereAnEmptyAccountLands() throws {
        let app = launch(until: "Set up orbit@austin", name("card"))
        expect(app, found, "card-found", timeout: 30)
        for words in ["Pick where it works and sign in a coding CLI.", "Where on orbit@austin should sessions work?",
                      "/home/orbit/code/app", "Where you ran orbit register", "A new folder",
                      "Another folder on orbit@austin", "Use This Folder", "Sign in Claude Code on orbit@austin",
                      "Sessions run on the coding CLIs signed in on that machine", "Sign In", "Use Codex instead"] {
            expect(app, words, "card")
        }
        absent(app, "Use an API Key", "card")
        expect(app, "Nothing is created until you send", "card-foot")
        #if os(macOS)
        XCTAssertTrue(composer(app).waitForExistence(timeout: 10), "the composer says who it sends to")
        #else
        expect(app, "Send orbit@austin a task…", "card-placeholder")
        expect(app, "New session", "card-title")
        #endif
        expect(app, "Opus 5.5", "card-model")
        // Beside the card there is nothing to press: the page is that session.
        absent(app, "Start a session", "card-column")
        shot(app, name("01-card"))

        #if os(iOS)
        if isPhone {
            press(app.buttons["Open navigation"])
            settle(1.5)
            expect(app, "Set up orbit@austin", "drawer")
            let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Set up orbit@austin")).firstMatch
            XCTAssertTrue(row.exists, "the drawer has the row")
            let new = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "New session")).firstMatch
            XCTAssertTrue(new.exists && new.isEnabled, "New session is no longer grey")
            absent(app, "Add a workspace to start a session", "drawer")
            shot(app, "02-drawer")
        }
        #endif
        #if os(macOS)
        // File ▸ New Session, and ⌘N with it, are no longer grey with no workspace.
        app.menuBars.menuBarItems["File"].click()
        settle(1)
        let item = app.menuBars.menuItems["New Session"]
        XCTAssertTrue(item.exists && item.isEnabled, "File ▸ New Session is enabled")
        app.typeKey(.escape, modifierFlags: [])
        settle(1)
        #endif
    }

    // MARK: board 03 ③ ④ and rules 6–8: the message waits, can be taken back, and goes by itself

    func test1TheMessageWaitsThenGoesByItself() throws {
        let app = launch(until: found, name("held"))
        send(app, message, "held")
        expect(app, waiting, "held")
        expect(app, "Withdraw", "held-withdraw")
        lowerKeyboard(app)
        let line = element(app, containing: waiting)
        bring(app, line, between: 90, and: bandBottom, "held-line")
        shot(app, name("03-held"))

        // Taken back, its words are in the composer again, and it can be sent again.
        tapButton(app, "Withdraw", "held-withdraw")
        if !waitUntil(8, { ((composer(app).value as? String) ?? "").contains("Fix the flaky") }) {
            XCTFail("the words did not come back: \(composer(app).value ?? "nil")")
        }
        absent(app, waiting, "held-withdrawn")
        let button = sendButton(app)
        press(button)
        settle(1.5)
        expect(app, waiting, "held-again")
        lowerKeyboard(app)

        // Step one.
        tapButton(app, "Use This Folder", "held-folder")
        expect(app, "git repository · main", "held-folder-done")
        expect(app, "Change", "held-change")
        shot(app, name("04-folder-done"))
        XCTAssertEqual(requests("BODY /api/sessions {").count, 0, "nothing goes before both steps are done")

        // Step two: a sign-in lands on the machine, and nobody presses anything.
        setStub(#"{"sign":"claude"}"#)
        expect(app, "Created workspace", "created", timeout: 40)
        expect(app, "/home/orbit/code/app", "created-where")
        expect(app, "Rename", "created-rename")
        expect(app, "running the auth tests 20 times", "created-reply", timeout: 20)
        checkTheCreate(#"{"workDir": "/home/orbit/code/app"}"#, "created")
        shot(app, name("05-created"))

        // Rename, from that line.
        tapButton(app, "Rename", "rename")
        settle(1.5)
        let field = app.alerts.textFields.firstMatch.exists ? app.alerts.textFields.firstMatch
            : app.sheets.textFields.firstMatch.exists ? app.sheets.textFields.firstMatch : app.dialogs.textFields.firstMatch
        if field.waitForExistence(timeout: 8) {
            press(field)
            settle(0.5)
            #if os(macOS)
            field.typeKey("a", modifierFlags: .command)
            field.typeText("app-web\n")
            #else
            field.typeText("-web\n")
            #endif
            settle(1)
            let save = app.buttons["Save"]
            if save.exists { press(save) }
            if !waitUntil(10, { !requests("BODY /api/agents/w1").isEmpty }) {
                XCTFail("Rename reached no PATCH: \(requestsLog().suffix(600))")
            }
            expect(app, "app-web", "renamed", timeout: 15)
            shot(app, name("05b-renamed"))
        } else {
            write(app.debugDescription, "no-rename-field.txt")
            XCTFail("Rename opened no field")
        }

        #if os(iOS)
        if isPhone {
            // Back to the workspace it made, and the drawer's row is that workspace's now.
            let back = app.navigationBars.buttons.element(boundBy: 0)
            press(back)
            settle(2)
            press(app.buttons["Open navigation"])
            settle(1.5)
            expect(app, "orbit@austin", "drawer-after")
            absent(app, "Set up orbit@austin", "drawer-after")
            shot(app, "06-drawer-after")
        }
        #endif
    }

    /// The message goes at once when both steps are done first, and a new folder is told by its name.
    func test2ReadyTheFirstSendMakesItAll() throws {
        let app = launch(until: found, name("ready"))
        setStub(#"{"sign":"claude"}"#)
        expect(app, "signed in on orbit@austin", "ready-signed", timeout: 20)
        tapButton(app, "A new folder", "ready-new")
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "name")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 8), "the new folder's name")
        press(field)
        settle(0.5)
        field.typeText("payments\n")
        settle(1)
        lowerKeyboard(app)
        if element(app, containing: "Use This Folder").exists { tapButton(app, "Use This Folder", "ready-use") }
        expect(app, "new folder · created as the session starts", "ready-folder")
        expect(app, "Ready. Send a task — Orbit adds the workspace “payments” for /home/orbit/orbit-repos/payments as it starts.", "ready-foot")
        shot(app, name("07-ready"))
        send(app, message, "ready")
        expect(app, "Created workspace", "ready-created", timeout: 20)
        checkTheCreate(#"{"newFolder": "payments"}"#, "ready-created")
    }

    // MARK: rule 4: a path is checked on the machine as it is typed

    func test3AFolderIsCheckedOnTheMachine() throws {
        let app = launch(until: found, name("folders"))
        tapButton(app, "Another folder on orbit@austin", "folders-other")
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "/path/to/project")).firstMatch
        guard field.waitForExistence(timeout: 8) else {
            write(app.debugDescription, "no-path-field.txt")
            return XCTFail("the other folder's field")
        }
        press(field)
        settle(0.5)
        field.typeText("/nope")
        expect(app, "Checking on orbit@austin…", "folders-checking", timeout: 8)
        expect(app, "No such directory on orbit@austin.", "folders-missing", timeout: 15)
        let use = app.buttons.matching(NSPredicate(format: "label == %@ OR title == %@", "Use This Folder", "Use This Folder")).firstMatch
        XCTAssertFalse(use.isEnabled, "what isn't there can't be picked")
        lowerKeyboard(app)
        shot(app, name("08-no-such-directory"))
        press(field)
        settle(0.5)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + "/srv/shared")
        expect(app, "Found · not a git repository — sessions will share it instead of isolating.", "folders-shared", timeout: 15)
        XCTAssertTrue(use.isEnabled, "a folder that is no repository can be used")
        lowerKeyboard(app)
        shot(app, name("09-not-a-repository"))
    }

    // MARK: rule 1 and the interface agreement: what the card says for a machine it can't work with

    func test4AMachineThatCantAnswerSaysSo() throws {
        let gone = launch(scene: "offline", page: ["-probe.machine", "austin"], until: "is offline", name("offline"))
        expect(gone, "orbit@austin is offline. It can’t check folders or sign in until it’s back.", "offline")
        absent(gone, "Sign In", "offline")
        shot(gone, name("10-offline"))
        gone.terminate()

        let old = launch(scene: "old", until: "updates itself first", name("old"))
        expect(old, "orbit@austin updates itself first: this version can’t check folders yet. You can sign in meanwhile.", "old")
        shot(old, name("11-older-runner"))
    }

    // MARK: rule 11: every machine offline lands on Machines & models

    func test5WithNoMachineOnlineTheLandingIsMachinesAndModels() throws {
        let app = launch(scene: "offline", until: "orbit@austin", name("all-offline"))
        settle(3)
        absent(app, "Pick where it works", "all-offline")
        shot(app, name("12-all-offline"))
    }

    // MARK: rule 12: a machine's page says Start a session, and never "on the web"

    func test6TheMachinesPageStartsASession() throws {
        let app = launch(page: ["-probe.runner", "austin"], until: "orbit@austin", name("machine"))
        let empty = element(app, containing: "No workspaces on orbit@austin yet.")
        bring(app, empty, between: 90, and: bandBottom, "machine-empty")
        expect(app, "No workspaces on orbit@austin yet. Start a session and pick the folder it works in as you go.", "machine")
        absent(app, "Add or change workspaces", "machine")
        absent(app, "add one here", "machine")
        shot(app, name("13-machine-page"))
        tapButton(app, "Start a session", "machine-start")
        expect(app, "Pick where it works and sign in a coding CLI.", "machine-card", timeout: 20)
    }

    // MARK: with no workspace, New session and ⌘N lead to the machine from anywhere in the app

    func test12NewSessionLeadsToTheMachine() throws {
        let card = "Pick where it works and sign in a coding CLI."
        let app = launch(until: found, name("new-session"))
        openTheDrawer(app)
        press(element(app, containing: "Projects"))
        if !waitUntil(10, { !element(app, containing: card).exists }) {
            write(app.debugDescription, "stayed-new-session.txt")
            XCTFail("Projects did not leave the machine's page")
        }
        #if os(macOS)
        app.typeKey("n", modifierFlags: .command)
        #else
        openTheDrawer(app)
        let new = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "New session")).firstMatch
        XCTAssertTrue(new.isEnabled, "New session is no longer grey")
        press(new)
        #endif
        expect(app, card, "new-session", timeout: 15)
        // An answer isn't kept past the page that asked: it asks again, and the suggestion comes back.
        expect(app, found, "new-session-found", timeout: 20)
        XCTAssertEqual(requests("BODY /api/sessions {").count, 0, "opening the page sends nothing")
        shot(app, name("21-new-session"))
    }

    // MARK: rule 9: with workspaces, the row comes after every one of them

    func test7WithWorkspacesTheRowComesLast() throws {
        #if os(macOS)
        let app = launch(scene: "mixed", until: "payments-api", name("mixed"))
        expect(app, "Set up orbit@austin", "mixed-row")
        shot(app, "mac-14-sidebar-mixed")
        let row = element(app, containing: "Set up orbit@austin")
        press(row)
        settle(2)
        expect(app, "Pick where it works and sign in a coding CLI.", "mixed-card", timeout: 20)
        shot(app, "mac-15-sidebar-card")
        #else
        let app = launch(scene: "mixed", until: "No open sessions", name("mixed"))
        if isPhone {
            press(app.buttons["Open navigation"])
            settle(1.5)
        }
        expect(app, "Set up orbit@austin", "mixed-row")
        let workspace = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "payments-api")).firstMatch
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Set up orbit@austin")).firstMatch
        XCTAssertLessThan(workspace.frame.minY, row.frame.minY, "after every workspace")
        shot(app, name("14-drawer-mixed"))
        press(row)
        settle(2)
        expect(app, "Pick where it works and sign in a coding CLI.", "mixed-card", timeout: 20)
        shot(app, name("15-card-from-the-row"))
        #endif
    }

    // MARK: rule 5: a key that can run here answers the second step

    func test10AKeyAnswersTheSecondStep() throws {
        resetStub()
        setStub(#"{"key":true}"#)
        let app = launchKeepingStub(until: found, name("key"))
        expect(app, "Use an API Key", "key-offered", timeout: 20)
        shot(app, name("18-sign-in-and-key"))
        tapButton(app, "Use an API Key", "key-press")
        expect(app, "DeepSeek", "key-step")
        expect(app, "API key", "key-step-kind")
        absent(app, "Sign in Claude Code on orbit@austin", "key-step")
        tapButton(app, "Use This Folder", "key-folder")
        expect(app, "Ready. Send a task", "key-ready")
        shot(app, name("19-on-a-key"))
        send(app, message, "key")
        expect(app, "Created workspace", "key-created", timeout: 20)
        checkTheCreate(#"{"workDir": "/home/orbit/code/app"}"#, "key-created", provider: "deepseek")
    }

    // MARK: rule 6: a refusal stays where the message waited, saying why, until it is tried again

    func test9ARefusalWaitsOnThePerson() throws {
        let app = launch(until: found, name("refused"))
        setStub(#"{"sign":"claude","refuse":"orbit@austin refused this one"}"#)
        expect(app, "signed in on orbit@austin", "refused-signed", timeout: 20)
        tapButton(app, "Use This Folder", "refused-folder")
        expect(app, "Ready. Send a task", "refused-ready")
        // Refused as it is typed: the words stay in the composer, as any send's do.
        send(app, message, "refused-typed")
        expect(app, "Couldn't start the session", "refused-typed", timeout: 15)
        XCTAssertTrue(((composer(app).value as? String) ?? "").contains("Fix the flaky"), "the words stay")
        lowerKeyboard(app)
        tapButton(app, "Change", "refused-change")
        expect(app, "Use This Folder", "refused-folder-again")
        // With the folder taken back the message waits; both steps done again, it goes by itself, and
        // is refused: that stays on it, and nothing more is sent until asked.
        press(sendButton(app))
        settle(1.5)
        expect(app, waiting, "refused-held")
        lowerKeyboard(app)
        tapButton(app, "Use This Folder", "refused-folder-back")
        expect(app, "Couldn’t send: orbit@austin refused this one", "refused-held", timeout: 15)
        absent(app, "Couldn't start the session", "refused-one-line")
        expect(app, "Try again", "refused-retry")
        expect(app, "Withdraw", "refused-withdraw")
        let line = element(app, containing: "Couldn’t send")
        bring(app, line, between: 90, and: bandBottom, "refused-line")
        shot(app, name("17-refused"))
        settle(6)
        XCTAssertEqual(requests("BODY /api/sessions {").count, 2, "the typed send and the waiting one, and no third by itself")

        setStub(#"{"refuse":null}"#)
        tapButton(app, "Try again", "refused-again")
        expect(app, "Created workspace", "refused-created", timeout: 20)
        XCTAssertEqual(requests("BODY /api/sessions {").count, 3, "Try again sends it once more")
    }

    // MARK: another device made the workspace: the message is neither lost nor sent

    func test11AWorkspaceMadeElsewhereTakesTheWaitingMessage() throws {
        let app = launch(until: found, name("elsewhere"))
        send(app, message, "elsewhere")
        expect(app, waiting, "elsewhere")
        lowerKeyboard(app)
        setStub(#"{"elsewhere":true}"#)
        if !waitUntil(20, { !element(app, containing: waiting).exists }) {
            write(app.debugDescription, "stayed-elsewhere.txt")
            XCTFail("the page stayed on the machine after it got a workspace")
        }
        if !field(app, holding: "Fix the flaky").waitForExistence(timeout: 10) {
            write(app.debugDescription, "no-words-elsewhere.txt")
            XCTFail("the waiting words did not come back in that workspace's composer")
        }
        absent(app, "Set up orbit@austin", "elsewhere-moved")
        XCTAssertEqual(requests("BODY /api/sessions {").count, 0, "they are the person's to send again: nothing went")
        shot(app, name("20-elsewhere"))
    }

    // MARK: dark

    func test8Dark() throws {
        let app = launch(until: found, dark: true, name("dark"))
        send(app, message, "dark")
        expect(app, waiting, "dark")
        lowerKeyboard(app)
        shot(app, name("16-dark-held"))
    }
}
