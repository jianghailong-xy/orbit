import Foundation
import XCTest
@testable import OrbitKit

/// Kimi Code's two sign-in sites on iOS and macOS (docs/mocks/kimi-login-region): which site a
/// device-flow page is on, whether a runner can be told the site, which one its login is on — and
/// that every word the sign-in card says about it is the web's (RunnerSignIn.tsx), looked up in the
/// web source. A missing counterpart is a FAILURE, never an `XCTSkip`.
final class KimiSiteTests: XCTestCase {

    private func runner(capabilities: [String]?, kimiRegion: String? = nil) throws -> Runner {
        var kimi: [String: Any] = ["engine": "kimi", "installed": true, "version": "2.1.1", "auth": "yes"]
        if let kimiRegion { kimi["kimiRegion"] = kimiRegion }
        var json: [String: Any] = ["id": "r1", "name": "hpc", "status": "ONLINE", "engines": [kimi]]
        if let capabilities { json["capabilities"] = capabilities }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testTheSiteOfAPageIsReadOffItsAddress() {
        XCTAssertEqual(KimiSite.of(url: URL(string: "https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86")), .global)
        XCTAssertEqual(KimiSite.of(url: URL(string: "https://www.kimi.com/code/authorize_device?user_code=SHG3-0DSI")), .mainlandCN)
        XCTAssertEqual(KimiSite.of(url: URL(string: "https://AUTH.KIMI.COM/verify")), .mainlandCN)
        XCTAssertEqual(KimiSite.of(url: URL(string: "https://kimi.ai")), .global)
        XCTAssertNil(KimiSite.of(url: URL(string: "https://notkimi.ai")))
        XCTAssertNil(KimiSite.of(url: URL(string: "https://kimi.ai.example.test")))
        XCTAssertNil(KimiSite.of(url: nil))
    }

    func testEachSiteNamesItsDomainItsPlaceAndTheOther() {
        XCTAssertEqual(KimiSite.allCases.map(\.rawValue), ["mainland-cn", "global"])
        XCTAssertEqual(KimiSite.allCases.map(\.domain), ["kimi.com", "kimi.ai"])
        XCTAssertEqual(KimiSite.allCases.map(\.place), ["Mainland China", "International"])
        XCTAssertEqual(KimiSite.mainlandCN.other, .global)
        XCTAssertEqual(KimiSite.global.other, .mainlandCN)
    }

    /// Only a runner that declares kimi-login-region/v1 is told a site; any other signs in where its
    /// CLI decides, so the card names none there.
    func testOnlyARunnerThatDeclaresItCanBeToldTheSite() throws {
        XCTAssertTrue(KimiSite.choosable(on: try runner(capabilities: ["session-worktree-ops-v1", "kimi-login-region/v1"])))
        XCTAssertFalse(KimiSite.choosable(on: try runner(capabilities: ["session-worktree-ops-v1"])))
        XCTAssertFalse(KimiSite.choosable(on: try runner(capabilities: nil)))
        XCTAssertFalse(KimiSite.choosable(on: nil))
    }

    /// Both sites can always be pressed. On a runner that can be told a site, each press names its own;
    /// on one too old to be told, kimi.com goes unnamed (its CLI's own site) and kimi.ai is still named,
    /// for the control plane to refuse in words that say to update the runner.
    func testAPressNamesItsSiteWhereTheRunnerCanBeToldIt() throws {
        let current = try runner(capabilities: ["kimi-login-region/v1"])
        XCTAssertEqual(KimiSite.named(.mainlandCN, on: current), .mainlandCN)
        XCTAssertEqual(KimiSite.named(.global, on: current), .global)
        for older in [try runner(capabilities: ["session-worktree-ops-v1"]), nil] {
            XCTAssertNil(KimiSite.named(.mainlandCN, on: older))
            XCTAssertEqual(KimiSite.named(.global, on: older), .global)
        }
    }

    func testTheRunnersLoginSiteIsTheOneItsProbeReported() throws {
        XCTAssertEqual(KimiSite.current(on: try runner(capabilities: [], kimiRegion: "global")), .global)
        XCTAssertEqual(KimiSite.current(on: try runner(capabilities: [], kimiRegion: "mainland-cn")), .mainlandCN)
        XCTAssertNil(KimiSite.current(on: try runner(capabilities: [])))
        XCTAssertNil(KimiSite.current(on: try runner(capabilities: [], kimiRegion: "eu")))
        // Another engine's report never names a Kimi site.
        XCTAssertNil(KimiSite.current(of: RunnerEngineHealth(engine: "codex", kimiRegion: "global")))
    }

    /// The engine page's line for Kimi's login says which site it is on, where Codex's says where its
    /// login lives; and the Engines row says it after the version.
    func testTheLoginLineAndTheRowSayWhichSite() throws {
        let health = RunnerEngineHealth(engine: "kimi", installed: true, version: "2.1.1", auth: "yes", kimiRegion: "global")
        let line = try XCTUnwrap(RunnerPageFormat.accountLines(health).first)
        XCTAssertEqual(line.subtitle, "kimi.ai")
        XCTAssertEqual(RunnerPageFormat.engineSite(health), "kimi.ai")
        XCTAssertNil(RunnerPageFormat.engineSite(RunnerEngineHealth(engine: "kimi", installed: true, auth: "no")))
        XCTAssertNil(try XCTUnwrap(RunnerPageFormat.accountLines(RunnerEngineHealth(engine: "kimi", auth: "no")).first).subtitle)
    }

    // MARK: the web's words

    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file. Kimi's sign-in on iOS is one half of a pair; "
                + "if the web half moved, move this check with it rather than deleting it.")
        return ""
    }

    func testTheSignInSaysWhatTheWebSays() throws {
        let card = try web("src/web/src/components/RunnerSignIn.tsx")
        for literal in [
            KimiSite.question,
            KimiSite.separateAccounts,
            ">\(KimiSite.currentMark)<",
            "'mainland-cn': { domain: '\(KimiSite.mainlandCN.domain)', where: '\(KimiSite.mainlandCN.place)' }",
            "global: { domain: '\(KimiSite.global.domain)', where: '\(KimiSite.global.place)' }",
            // The sentences that name a site, with the web's expression in its place.
            KimiSite.global.openPage.replacingOccurrences(of: "kimi.ai", with: "${KIMI_SITE[site].domain}"),
            KimiSite.global.copyCodeAndOpen.replacingOccurrences(of: "kimi.ai", with: "${KIMI_SITE[site].domain}"),
            KimiSite.global.enterCode.replacingOccurrences(of: "kimi.ai", with: "<b>{KIMI_SITE[site].domain}</b>"),
            // …and on a card adding an account (docs/mocks/kimi-accounts ④ / 02-ios ⑦).
            KimiSite.global.enterCodeAdding.replacingOccurrences(of: "kimi.ai", with: "<b>{KIMI_SITE[site].domain}</b>"),
            KimiSite.global.useInstead.replacingOccurrences(of: "kimi.ai", with: "{KIMI_SITE[other].domain}"),
        ] {
            XCTAssertTrue(card.contains(literal), "RunnerSignIn.tsx no longer says \(literal)")
        }
        let shared = try web("src/shared/src/dto.ts")
        XCTAssertTrue(shared.contains("KIMI_LOGIN_REGION_V1 = '\(KimiSite.loginRegionCapability)'"),
                      "@orbit/shared no longer asks for \(KimiSite.loginRegionCapability)")
    }
}
