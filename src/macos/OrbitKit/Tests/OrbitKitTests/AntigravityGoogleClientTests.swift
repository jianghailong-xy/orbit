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
        XCTAssertEqual(RunnerPageFormat.engineStatus(health)?.text, "Google account")
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

    func testSharedNativeViewsUseTheseLoginAndQuotaData() throws {
        let engine = try String(contentsOf: file("src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerEnginePage.swift"), encoding: .utf8)
        let relay = try String(contentsOf: file("src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerSignInView.swift"), encoding: .utf8)
        let rows = try String(contentsOf: file("src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerPageParts.swift"), encoding: .utf8)
        XCTAssertTrue(engine.contains("RunnerPageFormat.antigravityCanSignIn(runner)"))
        XCTAssertTrue(engine.contains("RunnerSignInView(runnerID: runner.id, engine: .antigravity)"))
        XCTAssertTrue(engine.contains("Re-sign in · change Google account"))
        XCTAssertTrue(engine.contains("GoogleSignInTermsView()"))
        XCTAssertTrue(relay.contains("case .awaitingCode:"))
        XCTAssertTrue(relay.contains("PasteBackForm(model: model)"))
        XCTAssertTrue(relay.contains("console.runnerAntigravity?.googleLogin == .available"))
        XCTAssertTrue(relay.contains("EngineAuth.googleTermsURL"))
        XCTAssertTrue(rows.contains("remaining"))
    }
}
