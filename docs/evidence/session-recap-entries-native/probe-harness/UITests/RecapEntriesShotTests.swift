import XCTest

// TEMPORARY evidence probe (see ../README.md). The server's recap in the places a session is entered
// from besides the session list, on the iPhone and on the Mac, against stub.py:
//
//   on  — the chat page carries S1's recap at its top ("Recap · <n>m ago" + the sentence, never the
//         raw reply); P1's entries say what the session list says: its row in the workspace list
//         (iPhone), its sessions page's rows (iPhone) and its page's coordinator card (both) draw a
//         recap under its "Recap · <clock>" label in place of the raw reply, and a member with no
//         recap keeps its reply.
//   off — the same stub started with `--recaps-off` (the same account with Session recaps off):
//         the chat page draws nothing in the recap's place, the entries their raw replies, and no
//         "Recap · " label is drawn anywhere.
//
// Which pass this run is comes from the run script (`TEST_RUNNER_RECAPS_OFF`, reaching the runner as
// `RECAPS_OFF`), because the stub's own mode is fixed when the script starts it.
final class RecapEntriesShotTests: ProbeCase {
    // The words the claims are made of, each copied from where the app gets it: the label is
    // `SessionLine.recapWord` + the separator both labels build (`recapLabel`, `recapAgo`); the
    // sentences are the stub's own fixture text.
    private let label = "Recap · "
    private let project = "Recap everywhere"
    private let coordTitle = "Coordinate the recap"
    private let coordRecap = "Landed the chat-page recap on all three clients; the shots are next."
    private let coordReply = "Filed the evidence task and pinged the reviewer."
    private let memberTitle = "Coordinator card line"
    private let memberRecap = "Wired the coordinator card to the session list's own line."
    private let memberReply = "Pushed the card change."
    private let plainTitle = "Fixture rebase"
    private let plainReply = "Rebased the fixtures; the suite is green."
    private let otherTitle = "Drawer shadow fix"
    private let otherRecap = "Softened the drawer's shadow and re-ran the web suite."
    private let otherReply = "Pushed the drawer fix."
    private let answered = "Done on all three clients: the header line, the coordinator card and the project row."

    #if os(iOS)
    func testIPhoneShowsTheRecapOnTheChatPageAndTheProjectEntries() {
        chat("ios"); list(); sessions(); projectPage("ios")
        write(requestsLog(), "ios-requests\(notesSuffix).txt")
    }
    #endif

    #if os(macOS)
    func testMacShowsTheRecapOnTheChatPageAndTheProjectPage() {
        chat("mac"); projectPage("mac")
        write(requestsLog(), "mac-requests\(notesSuffix).txt")
    }
    #endif

    private var shotsDir: String { ProcessInfo.processInfo.environment["SHOTS_DIR"] ?? "/tmp" }
    /// Whether the stub behind this pass was started with `--recaps-off`.
    private var recapsOff: Bool { ProcessInfo.processInfo.environment["RECAPS_OFF"] != nil }
    override var notesSuffix: String { recapsOff ? "-off" : "-on" }
    private var mode: String { recapsOff ? "with-recaps-off" : "with-recap" }

    /// Claims that came back wrong in this step: noted as they are found, failed once its picture is kept.
    private var wrong: [String] = []

    /// A claim, answered in the notes; a wrong answer fails the test after the picture is taken.
    private func claim(_ what: String, _ holds: Bool) {
        note("\(what): \(holds ? "yes" : "NO")")
        if !holds { wrong.append(what) }
    }

    /// One launch on the page `page` names, waiting for `until` to be drawn. The Mac app writes its
    /// own picture of the window too (`-probe.shot`).
    private func open(_ page: String, _ name: String, until: String) -> XCUIApplication {
        var extra = ["-probe.page", page]
        #if os(macOS)
        extra += ["-probe.windowLog", "/tmp/recap-entries-window-\(name).log",
                  "-probe.shot", "\(shotsDir)/mac-window-\(name).png"]
        #endif
        return launch(until: until, timeout: 120, extra: extra, name)
    }

    /// The picture with its tree beside it, then the step's wrong claims failed — after, so a wrong
    /// screen is still photographed.
    private func finish(_ app: XCUIApplication, _ name: String) {
        dismissSystemPrompts()
        settle(1.2)
        if app.windows.firstMatch.exists {
            shot(app, name)
            write(app.debugDescription, "tree-\(name).txt")
        } else {
            note("\(name): no window to photograph")
        }
        for what in wrong { XCTFail("\(name): \(what)") }
        wrong = []
        app.terminate()
    }

    /// Whether ONE element carries all of these words within a few seconds.
    private func holds(_ app: XCUIApplication, _ words: [String]) -> Bool {
        waitUntil(5) { element(app, containingAll: words).exists }
    }

    /// No recap label anywhere on screen — the off pass's whole point.
    private func noLabel(_ app: XCUIApplication, _ name: String) {
        claim("\(name): no \(label)label anywhere", !element(app, containing: label).exists)
    }

    // MARK: the chat page

    private func chat(_ platform: String) {
        let name = "\(platform)-chat-\(mode)"
        let app = open("chat", name, until: answered)
        if recapsOff {
            noLabel(app, name)
            claim("\(name): the recap sentence is not drawn", !element(app, containing: coordRecap).exists)
        } else {
            // The label, its relative time and the sentence on ONE element: the header's recap line.
            claim("\(name): the recap under its label and time", holds(app, [label, " ago ", coordRecap]))
            claim("\(name): never the raw reply in its place", !holds(app, [label, coordReply]))
        }
        claim("\(name): the conversation itself is below", appears(app, answered, timeout: 3))
        finish(app, name)
    }

    // MARK: the project's entries (iPhone)

    private func list() {
        let name = "ios-list-\(mode)"
        let app = open("list", name, until: project)
        if recapsOff {
            claim("\(name): P1's row says its coordinator's raw reply", holds(app, [project, coordReply]))
            claim("\(name): S4's row says its raw reply", holds(app, [otherTitle, otherReply]))
            noLabel(app, name)
        } else {
            claim("\(name): P1's row says its coordinator's recap under its label", holds(app, [project, label, coordRecap]))
            claim("\(name): S4's row says its recap under its label", holds(app, [otherTitle, label, otherRecap]))
        }
        finish(app, name)
    }

    private func sessions() {
        let name = "ios-project-sessions-\(mode)"
        let app = open("sessions", name, until: plainTitle)
        if recapsOff {
            claim("\(name): the coordinator's row says its raw reply", holds(app, [coordTitle, coordReply]))
            claim("\(name): the member's row says its raw reply", holds(app, [memberTitle, memberReply]))
            noLabel(app, name)
        } else {
            claim("\(name): the coordinator's row says its recap under its label", holds(app, [coordTitle, label, coordRecap]))
            claim("\(name): the member's row says its recap under its label", holds(app, [memberTitle, label, memberRecap]))
            claim("\(name): the member without one keeps its reply, unlabelled",
                  holds(app, [plainTitle, plainReply]) && !holds(app, [plainTitle, label]))
        }
        finish(app, name)
    }

    // MARK: the project's page (both)

    private func projectPage(_ platform: String) {
        let name = "\(platform)-project-\(mode)"
        let app = open("project", name, until: project)
        let words = recapsOff ? coordReply : coordRecap
        // The card's line once the page's reads have answered, looked up again after the wait: a
        // Mac text is found by its value only once it is drawn, and a lookup made before that is a
        // label query that never matches one (the first run's Mac pass scrolled the card away
        // hunting for it). On the phone the card may sit below the fold of a lazy list, where it is
        // not in the tree at all until `bring` scrolls to it.
        #if os(macOS)
        _ = appears(app, words, timeout: 30)
        #else
        _ = appears(app, words, timeout: 8)
        #endif
        let line = element(app, containing: words)
        // The card under the page's header: brought into the window's upper half, scrolling the
        // page's own column (the Mac's detail pane is the right two thirds with the source list folded).
        bring(app, line, between: 100, and: 600, name)
        if recapsOff {
            claim("\(name): the coordinator card says its raw reply", line.exists)
            noLabel(app, name)
        } else {
            claim("\(name): the coordinator card says its recap under its label", holds(app, [label, coordRecap]))
            claim("\(name): never the raw reply in its place", !element(app, containing: coordReply).exists)
        }
        claim("\(name): the card's own lines are still there", appears(app, "coordinator of this project", timeout: 3))
        finish(app, name)
    }
}
