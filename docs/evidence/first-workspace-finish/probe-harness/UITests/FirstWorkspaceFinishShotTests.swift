import XCTest

// Evidence probe (see ../README.md), task 34pSMchIBHSRImnxiCxuk: the setup card's finishing touches, driven as a
// person drives them against stub.py, on the real shells. A machine approved a moment ago is waited for and its
// folder step opens within seconds of its first heartbeat (F1); the register directory's suggestion still comes
// after another path took its question (F4); a new folder's name already on the machine is said before anything
// is sent (F6). A word missing from the screen, a press offered where there should be none, or a request the app
// didn't make fails the test; each state is photographed.
final class FirstWorkspaceFinishShotTests: ProbeCase {
    private let message = "Fix the flaky login test in tests/auth — it fails about one run in five on CI."
    private let found = "Found · git repository · main"
    private let connecting = "Waiting for orbit@austin to connect. It can check folders and sign in as soon as it does."
    private let alreadyThere = "This folder already exists on orbit@austin. Sessions will use what’s in it."
    private let aFile = "There’s already a file with this name on orbit@austin. Pick another name."

    /// Each platform's pictures under their own names.
    private func name(_ scene: String) -> String {
        #if os(iOS)
        scene
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

    /// Above the composer, where a press lands on what it means to.
    private var bandBottom: CGFloat {
        #if os(iOS)
        730
        #else
        640
        #endif
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

    private func button(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR title BEGINSWITH %@", words, words)).firstMatch
    }

    private func useThisFolder(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ OR title == %@", "Use This Folder", "Use This Folder")).firstMatch
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

    private func sendButton(_ app: XCUIApplication) -> XCUIElement {
        for words in ["Send", "Up Arrow", "arrow.up.circle.fill", "Arrow Up Circle"] {
            let hit = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", words, words)).firstMatch
            if hit.exists { return hit }
        }
        return app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'up' AND NOT (label CONTAINS[c] 'set up')")).firstMatch
    }

    /// Type into the composer and press Send.
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

    private func lowerKeyboard(_ app: XCUIApplication) {
        #if os(iOS)
        guard app.keyboards.firstMatch.exists else { return }
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 400)),
                    withVelocity: .fast, thenHoldForDuration: 0.3)
        settle(1)
        #endif
    }

    /// Choose A new folder and type `name` into its field.
    private func nameANewFolder(_ app: XCUIApplication, _ name: String, _ scene: String) -> Bool {
        tapButton(app, "A new folder", "\(scene)-row")
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "name")).firstMatch
        guard field.waitForExistence(timeout: 8) else {
            write(app.debugDescription, "no-name-field-\(scene).txt")
            XCTFail("\(scene): the new folder's name field")
            return false
        }
        press(field)
        settle(0.5)
        field.typeText(name)
        return true
    }

    /// The lines of the log with this in them, since this launch put the stub back: the log is the whole pass's.
    private func requests(_ line: String) -> [String] {
        let sinceReset = requestsLog().components(separatedBy: "POST /__reset").last ?? ""
        return sinceReset.components(separatedBy: "\n").filter { $0.contains(line) }
    }

    // MARK: F1: a machine approved a moment ago is waited for, and opens within seconds of its first heartbeat

    func test0AMachineStillConnectingIsWaitedFor() throws {
        let app = launch(scene: "connecting", page: ["-probe.machine", "austin"], until: "to connect", name("connecting"))
        expect(app, connecting, "connecting")
        absent(app, "updates itself first", "connecting")
        absent(app, "is offline", "connecting")
        // Nothing declared yet, so no new folder to offer: the other folder's row is drawn, and closed.
        let other = button(app, "Another folder on orbit@austin")
        if other.waitForExistence(timeout: 10) {
            XCTAssertFalse(other.isEnabled, "the folder step is closed while the machine connects")
        } else {
            write(app.debugDescription, "no-other-row-connecting.txt")
            XCTFail("the folder step is drawn")
        }
        absent(app, "A new folder", "connecting")
        let use = useThisFolder(app)
        XCTAssertTrue(use.exists && !use.isEnabled, "Use This Folder is there and off")
        XCTAssertEqual(requests("BODY /api/runners/austin/dir-probe").count, 0, "nothing is asked of a machine still connecting")
        shot(app, name("f1-connecting"))

        // Its first heartbeat. Nothing tells the app: the page's own reads find it.
        let row = button(app, "A new folder")
        let beat = Date()
        setStub(#"{"scene":"bare"}"#)
        let opened = waitUntil(15) { !self.element(app, containing: self.connecting).exists && row.exists && row.isEnabled }
        let took = Date().timeIntervalSince(beat)
        note("f1: the folder step opened \(String(format: "%.1f", took)) s after the first heartbeat")
        XCTAssertTrue(opened, "the folder step never opened")
        XCTAssertLessThan(took, 5, "the folder step opened \(took) s after the first heartbeat")
        expect(app, found, "connected", timeout: 15)
        note("f1: the register directory's answer showed \(String(format: "%.1f", Date().timeIntervalSince(beat))) s after it")
        absent(app, "updates itself first", "connected")
        shot(app, name("f1-connected"))
    }

    // MARK: F6: a new folder's name already on the machine is said before anything is sent

    func test1ANewFolderNameThatIsAFolderIsUsedAsItIs() throws {
        let app = launch(until: found, name("new-folder"))
        guard nameANewFolder(app, "payments", "new-folder") else { return }
        expect(app, alreadyThere, "new-folder-exists")
        absent(app, "Starts empty", "new-folder-exists")
        XCTAssertTrue(useThisFolder(app).isEnabled, "a folder that is there can be used")
        XCTAssertFalse(requests("BODY /api/runners/austin/dir-probe {\"path\": \"/home/orbit/orbit-repos/payments\"}").isEmpty,
                       "the name was asked about where it would go")
        lowerKeyboard(app)
        shot(app, name("f6-new-folder-exists"))

        // Picked, it is that folder, and goes by its path.
        tapButton(app, "Use This Folder", "new-folder-use")
        expect(app, "/home/orbit/orbit-repos/payments", "new-folder-done")
        expect(app, "git repository · main", "new-folder-done-note")
        absent(app, "new folder · created as the session starts", "new-folder-done")
        setStub(#"{"sign":"claude"}"#)
        expect(app, "Ready. Send a task — Orbit adds the workspace “payments” for /home/orbit/orbit-repos/payments as it starts.",
               "new-folder-ready", timeout: 20)
        send(app, message, "new-folder")
        expect(app, "Created workspace", "new-folder-created", timeout: 20)
        let creates = requests("BODY /api/sessions {")
        XCTAssertEqual(creates.count, 1, "one send, one create: \(creates)")
        if let body = creates.first {
            note("new-folder-created: \(body)")
            XCTAssertTrue(body.contains("\"newWorkspace\": {\"workDir\": \"/home/orbit/orbit-repos/payments\"}"), body)
        }
    }

    func test3ANewFolderNameThatIsAFileCantBe() throws {
        let app = launch(until: found, name("new-folder-file"))
        guard nameANewFolder(app, "notes.txt", "new-folder-file") else { return }
        expect(app, aFile, "new-folder-file")
        absent(app, "Starts empty", "new-folder-file")
        XCTAssertFalse(useThisFolder(app).isEnabled, "nothing can be made over a file")
        lowerKeyboard(app)
        shot(app, name("f6-new-folder-file"))
        XCTAssertEqual(requests("BODY /api/sessions {").count, 0, "nothing was sent")
    }

    // MARK: F4: the register directory's suggestion still comes after another path took its question

    func test2TheSuggestionComesBackAfterAnotherPathTookItsQuestion() throws {
        resetStub()
        setStub(#"{"scene":"bare","slow":true}"#)
        let app = launchKeepingStub(until: "Another folder on orbit@austin", name("re-ask"))
        absent(app, "Where you ran orbit register", "re-ask-before")
        tapButton(app, "Another folder on orbit@austin", "re-ask-other")
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "/path/to/project")).firstMatch
        guard field.waitForExistence(timeout: 8) else {
            write(app.debugDescription, "no-path-field.txt")
            return XCTFail("the other folder's field")
        }
        press(field)
        settle(0.5)
        field.typeText("/srv/shared")
        expect(app, "Found · not a git repository — sessions will share it instead of isolating.", "re-ask-typed")
        expect(app, "Where you ran orbit register", "re-ask-suggestion", timeout: 20)
        expect(app, found, "re-ask-found")
        let asked = requests("BODY /api/runners/austin/dir-probe {\"path\": \"~/code/app\"}")
        XCTAssertEqual(asked.count, 2, "asked at first, and again once the typed path had its answer: \(asked)")
        lowerKeyboard(app)
        shot(app, name("f4-suggestion-back"))
    }
}
