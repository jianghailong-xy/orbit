import Foundation
import OrbitKit
import XCTest

/// A row this machine can't run is a request for the install or the sign-in that would make it one, and
/// the press stays in the app: it opens that engine's page on the runner (`AppModel.openRunnerEngine`),
/// which carries the install for every engine a row can name — the sign-in engines and OpenCode — beside
/// their sign-ins. `ConsoleModel.webFixURL` answers only the one fix these clients don't make themselves:
/// connecting a Harness key, on the web's connect form. Before the Infrastructure page the login engines
/// and OpenCode were sent to the web Providers page, because the runner's own page had no install for
/// them — so "Not installed, sign in →" promised a press that couldn't be made there; it can now.
///
/// `ConsoleModel.swift` and the views compile only under SwiftUI, so this reads the source the way the
/// other wiring checks do.
final class EngineFixLinkWiringTests: XCTestCase {
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

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let enginePage = "src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerEnginePage.swift"

    /// The fix-link function and nothing after it.
    private func webFix() throws -> String {
        try slice(try source(Self.console), from: "func webFixURL(engine: String) -> URL? {",
                  to: "func installDsh() async {")
    }

    // MARK: the link

    /// Harness's connect-a-key row is the one press that leaves the app: that row is about a key to paste,
    /// and its page is the web's connect form. Every other engine is nil, which sends the press to the
    /// engine's page in the app — no engine goes to the web's Providers list any more.
    func testOnlyTheHarnessConnectFormIsAWebLink() throws {
        let fix = try webFix()
        XCTAssertTrue(fix.contains("guard engine == DshRuntime.connectFix else { return nil }"),
                      "an engine other than the connect-a-key row has a web link again")
        XCTAssertTrue(fix.contains("return api.baseURL.appendingPathComponent(\"providers/new/\\(DshRuntime.presetSlug)\")"),
                      "the connect-a-key row no longer opens the Harness connect form")
        XCTAssertFalse(try source(Self.console).contains("func providersURL("),
                       "a `/providers?runner=&engine=` link is back")
    }

    // MARK: the rows that ask

    /// The string the press is asked about is the row's own: an engine the machine hasn't installed
    /// carries its slug as `fixEngine`, OpenCode's row included — it is listed whether or not the
    /// machine runs it.
    func testTheRowsNameTheEngineTheyWantFixed() {
        let missing = ["claude", "codex", "kimi", "opencode"].map { RunnerEngineHealth(engine: $0, installed: false) }
        let choices = SessionProviderChoices.choices(configured: [], engines: missing)
        for engine in ["claude", "codex", "kimi", "opencode"] {
            let row = choices.first { $0.slug == engine }
            XCTAssertEqual(row?.unavailable, "Not installed", engine)
            XCTAssertEqual(row?.fixEngine, engine, "\(engine)'s row asks for its own engine to be fixed")
        }
    }

    /// Both surfaces an unavailable row appears on open the engine's page in the app, and the connect
    /// form is the only link left.
    func testTheUnavailableRowPressOpensTheEnginesPage() throws {
        let composer = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift")
        XCTAssertTrue(composer.contains("if let url = console.webFixURL(engine: engine) { openURL(url) }"))
        XCTAssertTrue(composer.contains("else if let rid = console.runnerID { app.openRunnerEngine(rid, engine: engine) }"),
                      "the composer's row no longer lands on the engine's page")
        let agents = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift")
        XCTAssertTrue(agents.contains("if let url = draft.webFixURL(engine: engine) { openURL(url) }"))
        XCTAssertTrue(agents.contains("else { app.openRunnerEngine(rid, engine: engine) }"),
                      "the new-session row and engine sheet no longer land on the engine's page")
        let sheet = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/AgentIdentity.swift")
        XCTAssertTrue(sheet.contains("if !greyed { onFixRunner?(engine.fixEngine ?? engine.slug) }"),
                      "the sheet hands the row's engine to the fix")
    }

    // MARK: the page it lands on

    /// The engine's page installs what the machine lacks — a sign-in engine through its install section,
    /// and OpenCode, which signs in nowhere, through the same one (`Infrastructure.installsOpenCode`) — so
    /// a row's "Not installed →" lands on the press that keeps it.
    func testTheEnginesPageInstallsEveryEngineARowCanName() throws {
        let page = try source(Self.enginePage)
        for piece in ["} else if let login = RunnerPageFormat.loginEngine(engine) {",
                      "installable: Infrastructure.installable(runner, login), offline: offline)",
                      "} else if engine == \"opencode\" {",
                      "installable: Infrastructure.installsOpenCode(runner), offline: offline)",
                      "Button(kind == .installFailed ? \"Retry\" : \"Install \\(RunnerPageFormat.engineName(engine))\") { install() }",
                      "if let failure = await runners.installEngine(id, engine: slug) { show(failure) }"] {
            XCTAssertTrue(page.contains(piece), "the engine page lost `\(piece)`")
        }
        for engine in ["claude", "codex", "kimi", "antigravity"] {
            XCTAssertNotNil(RunnerPageFormat.loginEngine(engine), "\(engine)'s page has no install section")
        }
    }
}
