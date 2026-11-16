import XCTest

// TEMPORARY evidence probe (GitHub workspaces P3, board 04 A after the main sync): the From GitHub option, the repository picker, a picked repository
// and the card ready to send, on a bare machine; the conversation's first line while a clone runs, after each failure
// and once it is done; and Settings → GitHub — on the iPhone and on the Mac, against stub.py.
final class GithubShotTests: ProbeCase {
    #if os(iOS)
    func testIPhoneGithubStates() { drive("ios") }
    #endif

    #if os(macOS)
    func testMacGithubStates() { drive("mac") }
    #endif

    private func github(_ mode: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__github")!)
        request.httpMethod = "POST"
        request.httpBody = Data("{\"mode\":\"\(mode)\"}".utf8)
        request.timeoutInterval = 10
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in answered.signal() }.resume()
        _ = answered.wait(timeout: .now() + 15)
    }

    private func open(_ args: [String], mode: String = "connected", until words: String, _ name: String) -> XCUIApplication {
        resetStub()
        github(mode)
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-probe.fresh",
                               "-ApplePersistenceIgnoreState", "YES"] + args
        #if os(macOS)
        app.launchArguments += ["-shell.sidebarVisible", "NO"]
        #endif
        app.launch()
        dismissSystemPrompts()
        #if os(macOS)
        if !waitUntil(15, { app.windows.count > 0 }) {
            app.typeKey("n", modifierFlags: .command)
            _ = waitUntil(15, { app.windows.count > 0 })
        }
        #endif
        if !appears(app, words, timeout: 90) {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words) never showed")
        }
        settle(1.5)
        return app
    }

    private func picture(_ app: XCUIApplication, _ name: String, expect words: [String] = []) {
        dismissSystemPrompts()
        settle(1.2)
        for w in words where !element(app, containing: w).exists {
            XCTFail("\(name): \(w) is not on screen")
            note("\(name): missing \(w)")
        }
        guard app.windows.firstMatch.exists else { note("\(name): no window"); return }
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
    }

    private func tap(_ app: XCUIApplication, _ words: String, _ name: String) {
        let target = buttons(app, beginning: words).first ?? element(app, containing: words)
        guard target.exists else {
            XCTFail("\(name): nothing to press called \(words)")
            write(app.debugDescription, "missing-press-\(name).txt")
            return
        }
        bring(app, target, between: 60, and: 640, name)
        press(target)
        settle(1)
    }

    private func drive(_ p: String) {
        // 0 · board 04 A: main's folder name, then the "or" rule and the From GitHub row under it.
        var app = open(["-probe.machine", "r2"], until: "From GitHub", "\(p)-0")
        picture(app, "\(p)-0-from-github-row", expect: ["Uses this folder if it exists, otherwise creates it.", "or", "From GitHub",
                                                         "Clone a repository you can reach on GitHub."])
        app.terminate()

        // 1 · the setup card: From GitHub, not connected.
        app = open(["-probe.machine", "r2"], mode: "disconnected", until: "From GitHub", "\(p)-1")
        tap(app, "From GitHub", "\(p)-1")
        _ = appears(app, "Connect GitHub", timeout: 20)
        picture(app, "\(p)-1-from-github-connect", expect: ["Connect GitHub", "Opens GitHub, then comes back here."])
        app.terminate()

        // 2 · connected: the repository picker.
        app = open(["-probe.machine", "r2"], until: "From GitHub", "\(p)-2")
        tap(app, "From GitHub", "\(p)-2")
        _ = appears(app, "orbit-web", timeout: 20)
        picture(app, "\(p)-2-repo-picker", expect: ["Signed in to GitHub as @ada", "Search your repositories", "Add repositories on GitHub",
                                                  "Type a folder name instead"])

        // 3 · a repository picked: branch, folder, the machine's answer.
        tap(app, "orbit-labs/orbit-web", "\(p)-3")
        _ = appears(app, "Cloned before the session starts", timeout: 20)
        settle(4)
        picture(app, "\(p)-3-repo-picked", expect: ["orbit-labs/orbit-web", "Other branch", "Use This Repository", "Type a folder name instead"])

        // 3b · Other branch open.
        tap(app, "Other branch", "\(p)-3b")
        settle(2)
        picture(app, "\(p)-3b-other-branch")

        // 4 · used: the folder step's line and the ready sentence.
        tap(app, "Use This Repository", "\(p)-4")
        _ = appears(app, "Orbit clones", timeout: 20)
        picture(app, "\(p)-4-ready", expect: ["orbit-labs/orbit-web → ~/orbit-repos/orbit-web", "cloned before the session starts"])
        app.terminate()

        // 5 · the conversation's first line.
        let lines: [(String, String, String)] = [
            ("S1", "42%", "5-cloning"),
            ("S2", "fatal: could not read from remote repository.", "6-failed-git"),
            ("S3", "no longer installed", "7-failed-app-removed"),
            ("S4", "Your GitHub sign-in expired.", "8-failed-sign-in"),
            ("S6", "Couldn’t clone orbit-labs/orbit-web.", "9-failed-no-reason"),
            ("S5", "Created workspace", "10-created"),
        ]
        for (session, words, name) in lines {
            app = open(["-probe.session", session], until: words, "\(p)-\(name)")
            picture(app, "\(p)-\(name)", expect: [words])
            app.terminate()
        }

        #if os(iOS)
        // 11a · Settings' list: GitHub under Integrations, between Personal and Machines, as the web's nav has it.
        app = open(["-probe.settingsList"], until: "Personal", "\(p)-11a")
        let integrations = element(app, containing: "Integrations")
        bring(app, integrations, between: 200, and: 500, "\(p)-11a")
        picture(app, "\(p)-11a-settings-list-integrations", expect: ["Integrations", "GitHub", "Machines"])
        app.terminate()
        #endif

        // 11 · Settings → GitHub.
        app = open(["-probe.settings"], until: "Your GitHub account", "\(p)-11")
        picture(app, "\(p)-11-settings-github", expect: ["Connected", "Where Orbit’s app is installed"])
        let workspaces = element(app, containing: "Workspaces from GitHub")
        bring(app, workspaces, between: 60, and: 700, "\(p)-11b")
        picture(app, "\(p)-11b-settings-github-workspaces", expect: ["Uses Orbit’s GitHub app", "Uses this machine’s Git credential"])
        app.terminate()
    }
}
