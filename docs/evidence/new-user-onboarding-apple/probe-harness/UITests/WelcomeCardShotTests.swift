import XCTest

// Evidence probe (see ../README.md), task 34vVmAY8RjCVUiaWKFD6N: a new account's welcome card on the real shells,
// driven against stub.py, beside the web's pages in docs/mocks/new-user-onboarding/after/. Each state is
// photographed; a word missing from the screen, or the card where an account with history must not see it,
// fails the test.
final class WelcomeCardShotTests: ProbeCase {
    private let title = "Welcome to Orbit, Mia"
    private let lead = "Orbit gives a coding agent a computer and a task"
    private let placeholder = "Describe a task for the agent…"
    private let examples = [
        "Build a one-page site that shows today’s weather for a city",
        "Read github.com/owner/repo and explain how it is put together",
        "Write a script that renames my photos by the date they were taken",
    ]
    private let defaultWorkspace = "2zQeDGWFFAgN2112jNTf8"

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

    /// The empty composer's placeholder: a label over the phone's text view, a field's placeholder on the Mac.
    private func placeholderShows(_ app: XCUIApplication, _ text: String) -> Bool {
        waitUntil(10) {
            element(app, containing: text).exists
                || app.textFields.matching(NSPredicate(format: "placeholderValue == %@", text)).firstMatch.exists
                || app.textViews.matching(NSPredicate(format: "placeholderValue == %@", text)).firstMatch.exists
        }
    }

    private func launchIn(_ stub: String, page: [String] = [], until label: String, _ scene: String) -> XCUIApplication {
        resetStub()
        setStub(stub)
        return launchKeepingStub(page: page, until: label, name(scene))
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

    private func everyStep(_ app: XCUIApplication, _ scene: String) {
        expect(app, lead, scene)
        for example in examples { expect(app, example, scene) }
    }

    // MARK: the managed runner's default workspace (web a-managed, a-model, a-ready)

    func test1ManagedPreparing() {
        let scene = "managed-preparing"
        let app = launchIn(#"{"scene":"managed"}"#, page: ["-probe.compose", defaultWorkspace], until: title, scene)
        everyStep(app, scene)
        expect(app, "A computer to work on", scene)
        expect(app, "Orbit is starting one for you. You don’t need to install anything.", scene)
        expect(app, "Preparing your managed runner", scene)
        expect(app, "Use my own computer instead", scene)
        expect(app, "A model to think with", scene)
        expect(app, "Opens once the computer is up", scene)
        expect(app, "Your first message can go once steps 1 and 2 are done.", scene)
        if !placeholderShows(app, placeholder) { XCTFail("\(scene): no welcome placeholder") }
        lowerKeyboard(app)
        shot(app, name(scene))
        bring(app, element(app, containing: "Your first message can go"), between: 80, and: 640, scene)
        shot(app, name("\(scene)-foot"))
    }

    func test2ManagedModel() {
        let scene = "managed-model"
        let app = launchIn(#"{"scene":"managed-up"}"#, page: ["-probe.compose", defaultWorkspace], until: title, scene)
        everyStep(app, scene)
        expect(app, "Computer", scene)
        expect(app, "managed-mia is ready", scene)
        expect(app, "A model to think with", scene)
        expect(app, "Sign in with your Claude or ChatGPT subscription", scene)
        absent(app, "Preparing your managed runner", scene)
        lowerKeyboard(app)
        shot(app, name(scene))
    }

    func test3ManagedReadyAndAnExample() {
        let scene = "managed-ready"
        let app = launchIn(#"{"scene":"managed-ready"}"#, page: ["-probe.compose", defaultWorkspace], until: title, scene)
        expect(app, "Claude Code signed in on managed-mia", scene)
        expect(app, "managed-mia is ready", scene)
        let pick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR title BEGINSWITH %@",
                                                    examples[0], examples[0])).firstMatch
        if pick.waitForExistence(timeout: 10) {
            bring(app, pick, between: 80, and: 600, "\(scene)-example")
            press(pick)
            settle(1.5)
        } else {
            write(app.debugDescription, "no-example-\(scene).txt")
            XCTFail("\(scene): no example to pick")
        }
        // Into the composer, nothing sent: the stub logs any write.
        let filled = waitUntil(10) {
            app.textViews.matching(NSPredicate(format: "value == %@", examples[0])).firstMatch.exists
                || app.textFields.matching(NSPredicate(format: "value == %@", examples[0])).firstMatch.exists
        }
        if !filled { write(app.debugDescription, "not-filled-\(scene).txt"); XCTFail("\(scene): the example never reached the composer") }
        lowerKeyboard(app)
        expect(app, "All set. Send it and the agent starts right away.", scene)
        shot(app, name(scene))
        if requestsLog().contains("BODY /api/sessions") { XCTFail("\(scene): picking an example sent something") }
    }

    // MARK: a bare machine (web a-machine)

    func test4BareMachine() {
        let scene = "machine"
        let app = launchIn(#"{"scene":"bare"}"#, page: ["-probe.machine", "austin"], until: title, scene)
        everyStep(app, scene)
        expect(app, "Folder", scene)
        expect(app, "Your first message", scene)
        // The sidebar keeps its "Set up mia-macbook" row, as the web's does; the card's own head is what goes.
        absent(app, "Pick where it works and sign in a coding CLI", scene)
        if !placeholderShows(app, placeholder) { XCTFail("\(scene): no welcome placeholder") }
        lowerKeyboard(app)
        shot(app, name(scene))
        bring(app, element(app, containing: examples[2]), between: 80, and: 640, scene)
        shot(app, name("\(scene)-examples"))
    }

    // MARK: no machine at all (web a-register)

    func test5NoMachineThenOneComesOnline() {
        let scene = "register"
        let app = launchIn(#"{"scene":"none"}"#, until: title, scene)
        expect(app, lead, scene)
        expect(app, "Connect the computer you want the agent to work on. Run this there:", scene)
        expect(app, "curl -fsSL", scene)
        expect(app, "Waiting for it to connect… this page moves on by itself.", scene)
        expect(app, "Having trouble?", scene)
        expect(app, "A model to think with", scene)
        expect(app, "Opens after step 1", scene)
        expect(app, "Your first message", scene)
        shot(app, name(scene))
        // A machine comes online: the page moves on to its setup card, which greets the account again.
        setStub(#"{"scene":"bare"}"#)
        expect(app, "Folder", "\(scene)-moved-on", timeout: 40)
        expect(app, title, "\(scene)-moved-on")
        shot(app, name("\(scene)-moved-on"))
    }

    // MARK: an account that has had a session sees what it saw before

    func test6HistoryManaged() {
        let scene = "history-managed"
        let app = launchIn(#"{"scene":"managed","history":true}"#, page: ["-probe.compose", defaultWorkspace],
                           until: "Preparing your managed runner", scene)
        settle(4)
        absent(app, "Welcome to Orbit", scene)
        absent(app, "Your first message", scene)
        lowerKeyboard(app)
        shot(app, name(scene))
    }

    func test7HistoryBareMachine() {
        let scene = "history-machine"
        let app = launchIn(#"{"scene":"bare","history":true}"#, page: ["-probe.machine", "austin"],
                           until: "Set up mia-macbook", scene)
        settle(4)
        absent(app, "Welcome to Orbit", scene)
        absent(app, "Your first message", scene)
        if !placeholderShows(app, "Send mia-macbook a task…") { XCTFail("\(scene): the machine's own placeholder is gone") }
        shot(app, name(scene))
    }

    func test8HistoryNoMachine() {
        let scene = "history-none"
        resetStub()
        setStub(#"{"scene":"none","history":true}"#)
        let app = launchKeepingStub(until: "Add Runner", name(scene))
        settle(6)
        absent(app, "Welcome to Orbit", scene)
        absent(app, "Opens after step 1", scene)
        shot(app, name(scene))
    }
}
