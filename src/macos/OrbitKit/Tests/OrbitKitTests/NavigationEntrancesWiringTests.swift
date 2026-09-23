import Foundation
import XCTest

/// One door for opening an Agents page, one door for navigation that arrives from outside the app.
///
/// Every entry point used to spell out the same three writes for itself: enter the section, point its
/// pane at the agent the page belongs to, put the frame on that section's stack. Five hand-rolled
/// copies of a rule nothing enforced — and the copy that leaves the agent out fails *silently*, by
/// opening a page under a pane still showing another agent's list. They are one line each now, naming
/// the `NavNode` they open; `show` is the only place the three writes happen.
///
/// The other half is the outside. A URL, a notification's tap, a transcript link, the ⌘K palette and
/// the menu bar all reach the model through `route(to:)` — no second door for "navigation that
/// arrived from somewhere else".
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the shells; each check reads the slice of
/// the file it is about, so a match somewhere else can't pass it.
final class NavigationEntrancesWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// Comment lines removed *and* trailing comments cut, so a line can be compared to the code it
    /// is — which is what an allow-list of statements needs.
    private func bare(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let slash = line.range(of: "//") else { return String(line) }
                return String(line[line.startIndex..<slash.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// Every Agents entry point is one line: the frame it opens, and the call that opens it. No
    /// section write, no agent write, no stack write of its own — those belong to `show`, in one
    /// place, where a new entry point cannot forget one of them.
    func testEveryAgentsEntryPointNamesTheFrameItOpensAndNothingElse() throws {
        let app = try appSource("AppModel.swift")
        // The end anchor is where each entry's own navigation ends; a cold route goes on to fetch the
        // session it named, and that tail is not the entry any more.
        let entries: [(entry: String, end: String, frame: String)] = [
            ("func newSessionInCurrentAgent() {", "\n    }",
             "show(.compose(agentID: id), agent: id)"),
            ("func composeWithAgent(_ id: String) {", "\n    }",
             "show(.compose(agentID: id), agent: id)"),
            ("func openRecentSession(_ s: Session) {", "\n    }",
             "show(.console(sessionID: s.id, origin: .drawer), agent: s.agent?.id ?? s.agentId)"),
            ("func openNeedsYouSession(_ s: Session) {", "\n    }",
             "show(.console(sessionID: s.id, origin: .banner), agent: s.agent?.id ?? s.agentId)"),
            ("func openSession(_ id: String) {", "guard !sessions.contains(where:",
             "show(.console(sessionID: id, origin: .deepLink), agent: agentID(for: id))"),
        ]
        for (entry, end, frame) in entries {
            let body = code(try slice(app, from: entry, to: end))
            XCTAssertTrue(body.contains(frame), "\(entry) opens \(frame)")
            for flat in ["selectedSection", "selectedAgentID", "nav."] {
                XCTAssertFalse(body.contains(flat),
                               "\(entry) still writes \(flat) itself — that is `show`'s job")
            }
        }
    }

    /// The origin is what the shells read back off the frame (the left screen edge, the stream), so
    /// each entry has to name its own: a copy-pasted entry that gives a banner tap the drawer's
    /// origin is a tap that silently hands the edge to the wrong gesture.
    func testTheConsoleEntrancesKeepTheirOriginsApart() throws {
        let app = try appSource("AppModel.swift")
        let origins = ["origin: .drawer", "origin: .banner", "origin: .deepLink"]
        for origin in origins {
            let hits = code(app).components(separatedBy: origin).count - 1
            XCTAssertEqual(hits, 1,
                           "\(origin) is named by exactly one entrance (found \(hits)) — the origin "
                           + "lives on the frame the entrance pushes, nowhere else")
        }
    }

    /// The one transition, and the whole of it: the section a page is opened in, the agent whose pane
    /// it belongs to (left alone when that pane is already showing it, so re-opening the session you
    /// are on doesn't disturb the page beneath), and one stack edit putting the frame on top.
    func testTheOneTransitionWritesTheSectionTheAgentAndTheFrame() throws {
        let app = try appSource("AppModel.swift")
        let show = code(try slice(app,
                                  from: "private func show(_ node: NavNode, agent agentID: String? = nil) {",
                                  to: "\n    }"))
        XCTAssertTrue(show.contains("selectedSection = .agents"), "the section it opens in")
        XCTAssertTrue(show.contains("if let agentID, selectedAgentID != agentID { selectedAgentID = agentID }"),
                      "the agent whose pane the page belongs to, and no write when it is already there")
        XCTAssertTrue(show.contains("nav.replaceTop(with: node)"),
                      "then the frame goes on top of that section's stack")

        // And it is where they land: every entry calls it.
        for entry in ["func newSessionInCurrentAgent() {", "func composeWithAgent(_ id: String) {",
                      "func openRecentSession(_ s: Session) {", "func openNeedsYouSession(_ s: Session) {",
                      "func openSession(_ id: String) {"] {
            let end = entry.hasPrefix("func openSession") ? "guard !sessions.contains(where:" : "\n    }"
            XCTAssertTrue(code(try slice(app, from: entry, to: end)).contains("show("),
                          "\(entry) goes through the one transition")
        }
    }

    /// Navigation that arrives from outside the app goes through `route(to:)` and nothing else. The
    /// two exceptions are keyboard commands with no `Route` to be — ⌘N and ⌘1…⌘9 — which are in-app
    /// affordances like a row, not something that arrived from anywhere.
    func testNavigationFromOutsideTheAppGoesThroughRouteAlone() throws {
        let entries: [(path: String, commands: [String])] = [
            ("src/macos/OrbitApp/Sources/OrbitApp/OrbitApp.swift",
             ["model.newSessionInCurrentAgent()", "model.selectAgent(at: pair.offset)"]),
            ("src/ios/Sources/OrbitiOSApp.swift", []),
        ]
        for (path, commands) in entries {
            let text = try source(path)
            XCTAssertTrue(text.contains("DeepLink.parse(url)"), "\(path) parses an orbit:// URL")
            XCTAssertTrue(text.contains("model.route(to: route)"),
                          "and hands it to the one routing door")
            XCTAssertTrue(text.contains("ReferenceLink.route(url)"),
                          "a transcript link is a route too, and takes the same door")
            for opener in ["openRecentSession(", "openNeedsYouSession(", "openSession(",
                           "openAgent(", "openCreatedAgentSession(", "composeWithAgent(",
                           "startComposingSession("] {
                XCTAssertFalse(text.contains(opener),
                               "\(path) opens a page with \(opener) instead of routing to it")
            }
            for command in commands {
                XCTAssertTrue(text.contains(command),
                              "\(path) keeps \(command) — a keyboard command, not a route")
            }
        }

        // The ⌘K palette is the same door, not a second one.
        let palette = code(try source("src/macos/OrbitApp/Sources/OrbitApp/Views/SessionSearchView.swift"))
        let open = code(try slice(palette, from: "private func open(_ hit: SessionSearchHit) {",
                                  to: "\n    }"))
        XCTAssertTrue(open.contains("model.route(to: .session(hit.id))"),
                      "a palette hit lands through `route(to:)` like every other outside arrival")
    }

    /// Every `Route` has a landing: the enum is exhaustive, but what each case *does* is the model's,
    /// so a case that stopped being handled would be a tap that goes nowhere. Which page each section
    /// puts up for its case is that section's own suite (`WatchWiringTests`, `TasksStackWiringTests`,
    /// `FollowingRunnersAdminWiringTests`, `AgentsStackWiringTests`).
    func testEveryRouteLandsSomewhere() throws {
        let app = try appSource("AppModel.swift")
        let route = code(try slice(app, from: "func route(to route: Route) {",
                                   to: "private func openSession("))
        for label in ["case .active:", "case .session(let id):", "case .task(let id):",
                      "case .runner(let id):", "case .watch(let id):"] {
            XCTAssertTrue(route.contains(label), "`route(to:)` still lands \(label)")
        }
    }

    /// A push names its session by the UUID the server stored; every list row spells it base62. The
    /// console opened under the UUID matched no row, so its header read the agent's name ("orbit")
    /// over a raw status word. The route opens the lists' spelling — and with the console carrying
    /// that spelling, the banner check has to compare the push's id as an id, not as a string.
    func testASessionRouteOpensTheListsSpellingOfItsID() throws {
        let app = try appSource("AppModel.swift")
        let route = code(try slice(app, from: "func route(to route: Route) {",
                                   to: "private func openSession("))
        XCTAssertTrue(route.contains("case .session(let id): openSession(PublicID.toPublic(id))"),
                      "a session route opens the lists' spelling of its id")

        let manager = code(try appSource("NotificationManager.swift"))
        let present = try slice(manager, from: "willPresent notification: UNNotification) async",
                                to: "\n    }")
        XCTAssertTrue(present.contains("PublicID.storageKey(session) != focused.map(PublicID.storageKey)"),
                      "iOS: the approval card skips the session on screen, whichever spelling the push used")
        XCTAssertTrue(present.contains("PublicID.storageKey(session) == focused.map(PublicID.storageKey)"),
                      "macOS: the banner skips the session on screen, whichever spelling the push used")
        XCTAssertFalse(present.contains("session != focused") || present.contains("session == focused"),
                       "no comparison of the two spellings as strings is left")
    }

    /// The approval push's other two readers. The foreground card looked its title up by the UUID and
    /// found nothing, and the needs-you check that takes it down never found the UUID either — so it
    /// came down at the next change to that set, answered or not. The Notification Center reconcile
    /// read every server banner's thread id (the UUID) as "no longer needs you" and cleared them all.
    func testAnApprovalPushIsReadInTheListsSpelling() throws {
        let app = code(try appSource("AppModel.swift"))
        let card = try slice(app, from: "notifications.onForegroundApproval = {",
                             to: "awaitsApproval: true)")
        XCTAssertTrue(card.contains("sessionID: PublicID.toPublic(sessionID)"),
                      "the foreground card holds the lists' spelling of the pushed session")

        let reconcile = try slice(app, from: "let needsYou = Set(SessionGrouping.group(list).needsYou.map(\\.id))",
                                  to: "#endif")
        XCTAssertTrue(reconcile.contains(
            "removeDeliveredApprovals(where: { !needsYou.contains(PublicID.toPublic($0)) })"),
                      "a banner's UUID thread id is looked up in the list-spelled needs-you set")
        XCTAssertFalse(reconcile.contains("!needsYou.contains($0)"),
                       "no thread id is looked up in its raw spelling")
    }

    /// A section switch writes which section is showing, and drives the Tasks data layer's poll.
    /// That is all: no page is dropped by hand for any section, and no list of them is kept here —
    /// each section's stack is its own, and it outlives the view the switch tears down.
    ///
    /// Pinned as an allow-list of lines rather than a list of forbidden ones, so a *new* thing the
    /// switch does has to be argued for here instead of slipping past a name nobody thought to add.
    func testASectionSwitchDropsNothingByHand() throws {
        let app = try appSource("AppModel.swift")
        let setter = bare(try slice(app, from: "var selectedSection: AppSection {",
                                    to: "/// Latches the one-shot default-landing"))
        // Past the declaration line, which names the property itself.
        let lines = setter.split(separator: "\n", omittingEmptySubsequences: false)
            .dropFirst()
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0 != "{" && $0 != "}" }
        let known = ["get { nav.section }",
                     "set {",
                     "nav.section = newValue",
                     "tasks?.setSectionActive(newValue == .tasks)"]
        XCTAssertTrue(lines.contains("nav.section = newValue"), "the switch writes the section")
        XCTAssertTrue(lines.contains("tasks?.setSectionActive(newValue == .tasks)"),
                      "and toggles the Tasks poll — the data layer's, not navigation's")
        XCTAssertEqual(lines, known,
                       "the section switch reads as the section, the poll, and nothing else — a line "
                       + "beyond those is a push being registered by hand again")
    }
}
