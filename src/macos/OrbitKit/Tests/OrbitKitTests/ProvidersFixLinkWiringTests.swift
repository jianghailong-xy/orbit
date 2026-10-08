import Foundation
import OrbitKit
import XCTest

/// A row this machine can't run is a request for the install or the sign-in that would make it one,
/// and `ConsoleModel.webFixURL` is where that request is answered: the press leaves the client for
/// the web Providers page, the one end that carries an install for every engine Orbit offers. The
/// picker's login engines and OpenCode used to be sent to the runner's own page instead, which has
/// no install for them — so "Not installed, sign in →" promised a press that couldn't be made.
///
/// `ConsoleModel.swift` compiles only under SwiftUI, so this reads the source the way the other
/// wiring checks do — and reads web's own row list beside it, because a `?engine=` link is only
/// worth sending when the page draws that row and focuses it.
final class ProvidersFixLinkWiringTests: XCTestCase {
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
    private static let webChoices = "src/web/src/lib/sessionProviderChoices.ts"
    private static let webEngines = "src/web/src/components/RunnerEngines.tsx"

    /// The fix-link function and nothing after it.
    private func webFix() throws -> String {
        try slice(try source(Self.console), from: "func webFixURL(engine: String, runnerID: String) -> URL? {",
                  to: "func installDsh() async {")
    }

    /// The engines `webFixURL` sends to Providers: the array literal its membership test reads.
    private func providersEngines() throws -> [String] {
        let line = try XCTUnwrap(try webFix().split(separator: "\n").first { $0.contains("let inProviders = [") },
                                 "webFixURL no longer reads a list of engines to send to Providers")
        return line.components(separatedBy: "\"").enumerated()
            .filter { $0.offset % 2 == 1 }
            .map(\.element)
    }

    // MARK: the link

    /// Every engine the press can name — the four this adds and the two that were already fixed
    /// there — and nothing else: an engine neither end has a row for stays nil, which is what makes
    /// the press fall back to the runner's own page.
    func testWebFixURLSendsEveryEngineTheProvidersPageHasARowFor() throws {
        let engines = try providersEngines()
        XCTAssertEqual(engines, ["claude", "codex", "kimi", "opencode", "antigravity", "dsh"],
                       "the engines a fix link names")
        for engine in ["claude", "codex", "kimi", "opencode"] {
            XCTAssertTrue(engines.contains(engine), "\(engine)'s unavailable row has nowhere to go")
        }
        XCTAssertTrue(try webFix().contains(
            "return inProviders.contains(engine) ? providersURL(engine: engine, runnerID: runnerID) : nil"),
                      "a listed engine is the Providers deep link; an unlisted one stays nil")
    }

    /// The link is the page's own `?runner=&engine=`, which is the shape its reader picks the row
    /// out of.
    func testTheDeepLinkIsThePagesOwnRunnerAndEngineQuery() throws {
        let url = try slice(try source(Self.console),
                            from: "func providersURL(engine: String, runnerID: String) -> URL? {",
                            to: "func connectGeminiURL() async -> URL {")
        for piece in ["api.baseURL.appendingPathComponent(\"providers\")",
                      "URLQueryItem(name: \"runner\", value: runnerID)",
                      "URLQueryItem(name: \"engine\", value: engine)"] {
            XCTAssertTrue(url.contains(piece), "the providers URL lost \(piece)")
        }
    }

    /// Harness's connect form keeps its own branch: that row is about a key to paste, and its page
    /// is the connect form rather than the list.
    func testTheHarnessConnectFormKeepsItsOwnBranch() throws {
        let fix = try webFix()
        XCTAssertTrue(fix.contains("if engine == DshRuntime.connectFix {"),
                      "the connect-a-key row no longer has its own destination")
        XCTAssertTrue(fix.contains("return api.baseURL.appendingPathComponent(\"providers/new/\\(DshRuntime.presetSlug)\")"),
                      "the connect-a-key row no longer opens the Harness connect form")
    }

    // MARK: the end it lands on

    /// Web draws a row for each of the four — the sign-in engines from `ENGINE_SLUGS` and OpenCode
    /// beside them — and `?engine=` is matched against exactly that list and focused. A link to an
    /// engine the page has no row for would open the page with nothing to land on.
    func testTheProvidersPageDrawsAndFocusesEveryRowTheLinkNames() throws {
        let slugs = try slice(try source(Self.webChoices), from: "export const ENGINE_SLUGS = [",
                              to: "] as const;")
        for engine in ["CLAUDE", "CODEX", "KIMI", "ANTIGRAVITY"] {
            XCTAssertTrue(slugs.contains("AgentProvider.\(engine),"),
                          "web's Providers lost its \(engine) row")
        }
        let engines = try source(Self.webEngines)
        XCTAssertTrue(engines.contains("const ROW_ENGINES: RowEngine[] = [...ENGINE_SLUGS, 'opencode'];"),
                      "web's Providers lost the OpenCode row")
        for piece in ["const focusRunner = routeId(params.get('runner'));",
                      "const engineParam = params.get('engine');",
                      "const focusEngine: InstallEngine | null = ROW_ENGINES.find((e) => e === engineParam) ?? null;",
                      "focused={engine === focusEngine}"] {
            XCTAssertTrue(engines.contains(piece), "the Providers page lost `\(piece)`")
        }
    }

    // MARK: the rows that ask

    /// The string the link is asked about is the row's own: an engine the machine hasn't installed
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

    /// Both surfaces an unavailable row appears on open the link, and the runner's own page is only
    /// what an engine with no link left falls back to.
    func testTheUnavailableRowPressOpensTheLink() throws {
        let composer = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift")
        XCTAssertTrue(composer.contains(
            "if let rid = console.runnerID, let url = console.webFixURL(engine: choice.fixEngine ?? \"\", runnerID: rid) { openURL(url) }"))
        XCTAssertTrue(composer.contains("else if let rid = console.runnerID { app.route(to: .runner(rid)) }"),
                      "a fix with no link still lands on the runner")
        let agents = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift")
        XCTAssertTrue(agents.contains("if let url = draft.webFixURL(engine: engine, runnerID: rid) { openURL(url) }"))
        XCTAssertTrue(agents.contains("else { app.route(to: .runner(rid)) }"),
                      "the new-session engine sheet falls back to the runner too")
        let sheet = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/AgentIdentity.swift")
        XCTAssertTrue(sheet.contains("if !greyed { onFixRunner?(engine.fixEngine ?? engine.slug) }"),
                      "the sheet hands the row's engine to the fix")
    }
}
