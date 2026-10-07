import XCTest

// TEMPORARY evidence probe (see ../README.md). The card a session page draws when no engine ever
// ran, on the iPhone and on the Mac, against stub.py:
//
//   S1  a task session whose SOURCE was refused — the card, its code/ref/stderr lines, and the
//       press that starts a NEW run on the task (the real `POST /api/tasks/T1/execute`);
//   S2  an ordinary session the reaper ended — the same card, "Send it again";
//   S3  an engine the machine does not have — the runner's own sentence, rendered.
//   P1  the project page's SOURCE_UNRESOLVED blocker.
final class RunStartShotTests: ProbeCase {
    private let title = "This run never started"
    private let branch = "refs/heads/project/34bZ3i4AvgJaaow5E9tH"
    private let stderr = "git: fatal: couldn't find remote ref refs/heads/project/34bZ3i4AvgJaaow5E9tH"

    #if os(iOS)
    func testIPhoneShowsWhyTheRunNeverStarted() { drive("ios", bottom: 780) }
    #endif

    #if os(macOS)
    func testMacShowsWhyTheRunNeverStarted() { drive("mac", bottom: 660) }
    #endif

    private func picture(_ app: XCUIApplication, _ name: String) {
        settle(1.2)
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
    }

    /// A launch comes up with the card for one of the stub's sessions; a state the stub never drove
    /// fails the test, and the picture is kept anyway.
    private func open(_ session: String, until label: String, _ name: String) -> XCUIApplication {
        resetStub()
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-probe.session", session,
                               "-ApplePersistenceIgnoreState", "YES"]
        #if os(macOS)
        app.launchArguments += ["-shell.sidebarVisible", "NO"]
        #endif
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !waitUntil(15, { app.windows.count > 0 }) {
            note("\(name): no window after launch; pressing ⌘N")
            app.typeKey("n", modifierFlags: .command)
            _ = waitUntil(15, { app.windows.count > 0 })
        }
        #endif
        if !appears(app, label, timeout: 120) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(label) never showed — the app did not render the stub's state")
        }
        settle(1.5)
        return app
    }

    private func drive(_ platform: String, bottom: CGFloat) {
        // 1. The refused run: the card, with the refusal's own facts on it.
        var app = open("S1", until: title, "\(platform)-refused")
        guard appears(app, title, timeout: 5) else { return }
        note("\(platform): card shown for S1; body text follows")
        for line in [branch, stderr, "BASE_REF_NOT_FOUND"] {
            note("\(platform): \(line) \(appears(app, line, timeout: 3) ? "shown" : "MISSING")")
        }
        note("\(platform): Start it again \(appears(app, "Start it again", timeout: 3) ? "shown" : "MISSING")")
        note("\(platform): Chat about this \(appears(app, "Chat about this", timeout: 3) ? "shown" : "MISSING")")
        picture(app, "\(platform)-1-refused")

        // 2. The press: a NEW run on the task, which the stub records and answers.
        let start = element(app, containing: "Start it again")
        if start.exists {
            press(start)
            settle(2.5)
            picture(app, "\(platform)-2-start-it-again")
        } else {
            note("\(platform): no Start it again to press")
        }
        write(requestsLog(), "\(platform)-requests.txt")
        app.terminate()

        // 3. An ordinary session the runner went offline under: same card, a re-send instead.
        app = open("S2", until: "The runner holding this session went offline", "\(platform)-offline")
        note("\(platform): Send it again \(appears(app, "Send it again", timeout: 3) ? "shown" : "MISSING")")
        picture(app, "\(platform)-3-offline")
        app.terminate()

        // 4. An engine the machine does not have, in the runner's own words.
        app = open("S3", until: "OpenCode isn't installed on", "\(platform)-not-installed")
        picture(app, "\(platform)-4-not-installed")
        app.terminate()

        // 5. The project page's SOURCE_UNRESOLVED card.
        resetStub()
        let project = XCUIApplication()
        project.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh", "-probe.project",
                                   "-ApplePersistenceIgnoreState", "YES"]
        #if os(macOS)
        project.launchArguments += ["-shell.sidebarVisible", "NO"]
        #endif
        project.launch()
        dismissSystemPrompts()
        if !appears(project, "Its baseline is a branch that doesn't exist yet", timeout: 120) {
            write(project.debugDescription, "missing-\(platform)-project.txt")
            XCTFail("\(platform): the project page never drew the SOURCE_UNRESOLVED card")
        }
        note("\(platform): code+ref \(appears(project, "BASE_REF_NOT_FOUND · \(branch)", timeout: 3) ? "shown" : "MISSING")")
        note("\(platform): task row \(appears(project, "Two-engine pin board: OpenCode row", timeout: 3) ? "shown" : "MISSING")")
        picture(project, "\(platform)-5-project-blocker")
        write(requestsLog(), "\(platform)-project-requests.txt")
    }
}
