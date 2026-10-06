import Foundation
import XCTest
@testable import OrbitKit

/// The same sanitized control-plane payload is rendered by web and both native shells.
final class AntigravityGoogleClientTests: XCTestCase {
    private func file(_ relative: String) throws -> URL {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = root.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) { return url }
            root.deleteLastPathComponent()
        }
        throw CocoaError(.fileReadNoSuchFile)
    }

    private func fixtures() throws -> [String: Runner] {
        try JSONDecoder().decode([String: Runner].self, from: Data(contentsOf: file("docs/evidence/antigravity-google-login/clients/fixtures.json")))
    }

    func testGoogleIdentityQuotaAndResetDataUsedByMacOSAndIOS() throws {
        let runner = try XCTUnwrap(fixtures()["google"])
        let health = try XCTUnwrap(runner.engines?.first)
        XCTAssertEqual(runner.antigravity?.googleLogin, .available)
        XCTAssertEqual(health.authSource, "google")
        XCTAssertEqual(RunnerPageFormat.engineStatus(health)?.text, "Signed in",
                       "a Google sign-in is signed in, in the words Claude Code's and Codex's rows use")
        XCTAssertTrue(RunnerPageFormat.antigravityCanSignIn(runner))
        let rows = RunnerPageFormat.engineWindows(runner, engine: "antigravity")
        XCTAssertEqual(rows.map(\.label), ["Weekly", "5-hour"])
        XCTAssertEqual(rows.map(\.groupLabel), ["gemini-weekly", "3p-5h"])
        XCTAssertEqual(rows.map(\.percent), [72, 18])
        XCTAssertTrue(rows.allSatisfy(\.remaining))
        XCTAssertEqual(rows.map { $0.window.resetsAt }, ["2026-10-09T03:00:00Z", "2026-10-04T08:00:00Z"])
    }

    func testLoginEntryGatesAndUnknownAuth() throws {
        let data = try fixtures()
        for state in ["signed-out", "google", "env-key", "unknown"] {
            let runner = try XCTUnwrap(data[state])
            XCTAssertTrue(RunnerPageFormat.antigravityCanSignIn(runner), state)
            XCTAssertEqual(EngineAuth.remedy(forProvider: "antigravity", googleLogin: runner.antigravity?.googleLogin), .signIn(.antigravity))
        }
        for state in ["macos", "old"] {
            let runner = try XCTUnwrap(data[state])
            XCTAssertFalse(RunnerPageFormat.antigravityCanSignIn(runner), state)
            XCTAssertEqual(EngineAuth.remedy(forProvider: "antigravity", googleLogin: runner.antigravity?.googleLogin), .connectGemini)
            XCTAssertNotNil(EngineAuth.antigravityLoginHint(runner.antigravity?.googleLogin))
        }
        XCTAssertEqual(EngineAuth.antigravityLoginHint(.unsupportedPlatform), "Google sign-in is not supported on macOS runners yet. Use a Gemini API key.")
        XCTAssertNil(RunnerPageFormat.engineStatus(try XCTUnwrap(data["unknown"]?.engines?.first)))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try XCTUnwrap(data["env-key"]?.engines?.first))?.text, "env key")
    }

    func testPickerOffersGoogleAndPreservesBothKeyPaths() throws {
        let data = try fixtures()
        let gemini = ConfiguredProvider(slug: "gemini-key", label: "Gemini", runtime: "antigravity", presetSlug: "gemini")
        for state in ["google", "unknown", "env-key", "expired"] {
            let runner = try XCTUnwrap(data[state])
            let choices = SessionProviderChoices.choices(configured: [gemini], engines: runner.engines, antigravity: runner.antigravity)
            let builtin = try XCTUnwrap(choices.first { $0.slug == "antigravity" })
            XCTAssertEqual(builtin.labelDetail, state == "env-key" ? "env key" : "Google account")
            XCTAssertEqual(builtin.unavailable, state == "expired" ? "Not signed in" : nil)
            XCTAssertNil(choices.first { $0.slug == "gemini-key" }?.unavailable)
        }
        let out = try XCTUnwrap(data["signed-out"])
        let google = try XCTUnwrap(data["google"])
        let signedOut = SessionProviderChoices.choices(configured: [], engines: out.engines, antigravity: google.antigravity)
        XCTAssertEqual(signedOut.first { $0.slug == "antigravity" }?.unavailable, "Not signed in")
        XCTAssertFalse(SessionProviderChoices.choices(configured: [], engines: out.engines, antigravity: out.antigravity).contains { $0.slug == "antigravity" })
        XCTAssertNil(SessionProviderChoices.choices(configured: [], engines: out.engines, antigravity: out.antigravity, antigravityKeyAvailable: true).first { $0.slug == "antigravity" }?.unavailable,
                     "a workspace's own GEMINI_API_KEY still runs on a signed-out runner")
        let expired = try XCTUnwrap(data["expired"])
        let workspaceKey = try XCTUnwrap(SessionProviderChoices.choices(configured: [], engines: expired.engines,
            antigravity: expired.antigravity, antigravityKeyAvailable: true).first { $0.slug == "antigravity" })
        XCTAssertNil(workspaceKey.unavailable, "a workspace key also bypasses a lapsed Google account")
        XCTAssertEqual(workspaceKey.labelDetail, "env key", "this session spends the workspace key")
    }

    func testOldRunnerWithoutAntigravityHealthKeepsItsUpgradeEntry() throws {
        for payload in [
            #"{"id":"old","name":"Older runner"}"#,
            #"{"id":"old","name":"Older runner","engines":[]}"#,
            #"{"id":"old","name":"Older runner","engines":[],"antigravity":{"supported":false,"installed":null,"envKeyAvailable":false,"googleLogin":"needs_update"}}"#,
        ] {
            let runner = try JSONDecoder().decode(Runner.self, from: Data(payload.utf8))
            let health = try XCTUnwrap(RunnerPageFormat.engines(runner).first { $0.engine == "antigravity" })
            XCTAssertNil(health.installed)
            XCTAssertEqual(RunnerPageFormat.engineStatus(health, runner: runner)?.text, "Update runner")
            XCTAssertFalse(RunnerPageFormat.antigravityCanSignIn(runner))
            XCTAssertEqual(EngineAuth.antigravityLoginHint(runner.antigravity?.googleLogin), "Update this runner to sign in with Google.")
        }
    }

    func testMacOSRunnerWithAnEnvironmentKeyKeepsTheKeyAndUnsupportedLoginHint() throws {
        let runner = try JSONDecoder().decode(Runner.self, from: Data(#"{"id":"mac","name":"Mac runner","engines":[{"engine":"antigravity","installed":true,"auth":"yes","authSource":"env_key"}],"antigravity":{"supported":true,"installed":true,"envKeyAvailable":true,"authSource":"env_key","googleLogin":"unsupported_platform"}}"#.utf8))
        let health = try XCTUnwrap(RunnerPageFormat.engines(runner).first)
        XCTAssertEqual(RunnerPageFormat.engineStatus(health, runner: runner)?.text, "env key")
        XCTAssertFalse(RunnerPageFormat.antigravityCanSignIn(runner))
        XCTAssertEqual(EngineAuth.antigravityLoginHint(runner.antigravity?.googleLogin), "Google sign-in is not supported on macOS runners yet. Use a Gemini API key.")
        XCTAssertTrue(RunnerPageFormat.engineWindows(runner, engine: "antigravity").isEmpty)
        let choice = try XCTUnwrap(SessionProviderChoices.choices(configured: [], engines: runner.engines,
            antigravity: runner.antigravity).first { $0.slug == "antigravity" })
        XCTAssertNil(choice.unavailable)
        XCTAssertEqual(choice.labelDetail, "env key")
    }

    func testMissingCLITakesPrecedenceOverGoogleLoginAvailability() throws {
        for login in ["available", "unsupported_platform", "needs_update"] {
            let payload = """
            {"id":"missing","name":"Runner without CLI","engines":[{"engine":"antigravity","installed":false,"auth":"unknown"}],"antigravity":{"supported":true,"installed":false,"envKeyAvailable":false,"googleLogin":"\(login)"}}
            """
            let runner = try JSONDecoder().decode(Runner.self, from: Data(payload.utf8))
            let health = try XCTUnwrap(RunnerPageFormat.engines(runner).first)
            XCTAssertEqual(RunnerPageFormat.engineStatus(health, runner: runner)?.text, "Not installed", login)
            XCTAssertFalse(RunnerPageFormat.antigravityCanSignIn(runner), login)
        }
    }

    func testZeroRemainingIsSpentAndSignedOutHasNoQuota() throws {
        let snapshot = PlanUsageSnapshot(provider: "antigravity", buckets: [PlanUsageBucket(id: "3p-5h", window: "5h", remainingFraction: 0, resetTime: "2026-10-04T08:00:00Z")])
        let row = try XCTUnwrap(snapshot.rows.first)
        XCTAssertEqual(row.percent, 0)
        XCTAssertEqual(row.window.utilization, 100)
        XCTAssertTrue(row.nearLimit)
        XCTAssertTrue(row.remaining)
        let runner = try XCTUnwrap(fixtures()["expired"])
        XCTAssertTrue(RunnerPageFormat.engineWindows(runner, engine: "antigravity").isEmpty)
    }

    func testPasteCodeRelayDTOAndTerms() throws {
        let encoded = try JSONEncoder().encode(StartLoginRequest(engine: .antigravity))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: String])
        XCTAssertEqual(object, ["engine": "antigravity"])
        let relay = try JSONDecoder().decode(RunnerLoginState.self, from: Data(#"{"engine":"antigravity","status":"awaiting_code","url":"https://example.test/authorize"}"#.utf8))
        XCTAssertEqual(relay.engine, LoginEngine.antigravity.rawValue)
        XCTAssertEqual(relay.status, .awaitingCode)
        XCTAssertNil(relay.userCode)
        XCTAssertEqual(EngineAuth.googleTermsURL.absoluteString, "https://antigravity.google/terms")
        XCTAssertEqual(EngineAuth.googleTermsWarning, "Google terms restrict personal account sign-in through third-party tools; your account may be suspended.")
    }

    /// Antigravity's engine page is Claude Code's and Codex's: its Google sign-ins are the Accounts
    /// section's rows, signed in through the same card, with Add Account where the runner keeps an
    /// added one apart, and Google's terms under the section — not a section of its own with one
    /// account to replace. The row on the runner's page says why it can't sign in where it can't, and
    /// otherwise offers Sign In the way every engine's does, with no terms and no button of its own.
    func testSharedNativeViewsUseTheseLoginAndQuotaData() throws {
        let engine = try String(contentsOf: file("src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerEnginePage.swift"), encoding: .utf8)
        let relay = try String(contentsOf: file("src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerSignInView.swift"), encoding: .utf8)
        let rows = try String(contentsOf: file("src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerPageParts.swift"), encoding: .utf8)
        for piece in ["RunnerPageFormat.accountLines(health)",
                      "RunnerSignInView(runnerID: runner.id, engine: login, account: line.signInAccount)",
                      "if RunnerPageFormat.canAddAccount(runner, engine: engine) {",
                      "} else if let hint = RunnerPageFormat.signInHint(runner, engine: engine) {",
                      "} else if RunnerPageFormat.canSignIn(runner, engine: engine) && (!line.envKey || alone) {",
                      "Button(line.envKey ? \"Sign in with Google\" : line.auth == \"yes\" ? \"Sign In Again\" : RunnerPageCopy.RUNNER_SIGN_IN) {",
                      "if engine == \"antigravity\" && RunnerPageFormat.antigravityCanSignIn(runner) {",
                      "GoogleSignInTermsView()",
                      "} else if line.envKey {",
                      "Text(\"env key · runs on your Gemini key\")"] {
            XCTAssertTrue(engine.contains(piece), "the engine page lost \(piece)")
        }
        XCTAssertFalse(engine.contains("antigravitySection"), "Antigravity has no section of its own")
        XCTAssertFalse(engine.contains("Re-sign in"), "an account is signed in again on its own row")
        XCTAssertTrue(relay.contains("case .awaitingCode:"))
        XCTAssertTrue(relay.contains("PasteBackForm(model: model)"))
        XCTAssertTrue(relay.contains("console.runnerAntigravity?.googleLogin == .available"))
        XCTAssertTrue(relay.contains("EngineAuth.googleTermsURL"))
        let start = try XCTUnwrap(rows.range(of: "struct RunnerEngineRow: View {"))
        let end = try XCTUnwrap(rows.range(of: "struct RunnerWorkspaceRow: View {", range: start.upperBound..<rows.endIndex))
        let engineRow = String(rows[start.lowerBound..<end.lowerBound])
        XCTAssertTrue(engineRow.contains("if let hint = RunnerPageFormat.signInHint(runner, engine: health.engine) {"))
        XCTAssertTrue(engineRow.contains("} else if RunnerPageFormat.needsSignIn(health) {"))
        XCTAssertFalse(engineRow.contains("GoogleSignInTermsView()"), "Google's terms are the engine page's, not the row's")
        XCTAssertFalse(engineRow.contains("Re-sign in"))
        XCTAssertTrue(rows.contains("remaining"))
    }
}
