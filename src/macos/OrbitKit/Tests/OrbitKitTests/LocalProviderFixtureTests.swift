import Foundation
import XCTest
@testable import OrbitKit

/// The shared case file `contracts/ollama-provider.fixtures.json` — the same bytes
/// `src/web/src/lib/localProvider.fixtures.test.ts` reads. Each case is one provider read plus the
/// session it would run and the answer both clients must give: the status, the default model, the
/// refusal (code, sentence and remedy), the context window, the efforts and the model options.
///
/// This is the native half of the phase 4B parity: a local Ollama must read the same in the browser
/// and in these clients, or the pickers disagree about what can run.
final class LocalProviderFixtureTests: XCTestCase {
    private struct Fixture: Decodable {
        let version: Int
        let cases: [Case]

        struct Case: Decodable {
            let name: String
            let now: String
            let row: ConfiguredProvider
            let runner: RunnerFacts?
            let session: Session
            let sessionRunner: RunnerFacts?
            let expect: Expect
        }

        struct RunnerFacts: Decodable {
            let capabilities: [String]?
            let capabilitiesReportedAt: String?
        }

        struct Session: Decodable {
            let runnerId: String?
            let model: String?
        }

        struct Refusal: Decodable {
            let code: LocalProviderRefusalCode
            let message: String
        }

        struct Expect: Decodable {
            let state: String
            let capability: String
            let targetModel: String?
            let refusal: Refusal?
            let remedy: String?
            let contextWindow: Int?
            let efforts: [String]
            let modelOptions: [String]
            let canChoose: Bool
        }
    }

    private func file(_ relative: String) throws -> URL {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = root.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) { return url }
            root.deleteLastPathComponent()
        }
        throw CocoaError(.fileReadNoSuchFile)
    }

    private func fixtures() throws -> Fixture {
        try JSONDecoder().decode(
            Fixture.self,
            from: Data(contentsOf: file("contracts/ollama-provider.fixtures.json")))
    }

    private func runner(_ facts: Fixture.RunnerFacts?) -> LocalProviderRunnerFacts? {
        facts.map { LocalProviderRunnerFacts(capabilities: $0.capabilities,
                                             reported: $0.capabilitiesReportedAt != nil) }
    }

    private func remedy(_ code: LocalProviderRefusalCode?) -> String? {
        switch code?.remedy {
        case .manageProvider?: return "provider"
        case .runnerPage?: return "runner"
        case nil: return nil
        }
    }

    func testTheSharedCasesReadTheSameInTheNativeClients() throws {
        let fixture = try fixtures()
        XCTAssertEqual(fixture.version, 1)
        XCTAssertFalse(fixture.cases.isEmpty)

        for (index, test) in fixture.cases.enumerated() {
            let now = try XCTUnwrap(LocalProviders.parseDate(test.now), test.name)
            let row = test.row
            let facts = LocalProviders.facts(from: row)

            // The status a picker draws: what the bound runner made of the row's last probe.
            let status = LocalProviders.status(facts, runner: runner(test.runner), now: now)
            XCTAssertEqual(status.state, test.expect.state, "\(index):\(test.name) state")
            XCTAssertEqual(status.capability, test.expect.capability, "\(index):\(test.name) capability")

            // The model a session would run: its own, else the row's default, else the first it
            // names — never the built-in Claude default.
            let target = LocalProviders.targetModel(row: row, sessionModel: test.session.model)
            XCTAssertEqual(target, test.expect.targetModel, "\(index):\(test.name) target model")
            if test.session.model == nil {
                let fallback = AgentDefaults.defaultModel(engine: "claude", provider: row.slug, catalog: nil,
                                                          configured: [row], runtimeDefaults: nil)
                XCTAssertEqual(fallback.isEmpty ? nil : fallback, test.expect.targetModel,
                               "\(index):\(test.name) default model")
            }

            // Whether the session may run there now, in the server's own words.
            let refusal = LocalProviders.readiness(
                facts,
                target: LocalProviderTarget(runnerId: test.session.runnerId,
                                            runner: runner(test.sessionRunner), model: target),
                now: now)
            XCTAssertEqual(refusal?.code, test.expect.refusal?.code, "\(index):\(test.name) refusal code")
            XCTAssertEqual(refusal?.message, test.expect.refusal?.message, "\(index):\(test.name) refusal message")
            XCTAssertEqual(remedy(refusal?.code), test.expect.remedy, "\(index):\(test.name) remedy")
            XCTAssertEqual(refusal == nil, test.expect.canChoose, "\(index):\(test.name) can choose")

            // The composer's context gauge and effort menu read the same pair.
            XCTAssertEqual(AgentDefaults.contextWindow(for: target ?? "", catalog: nil, configured: [row],
                                                       provider: row.slug),
                           test.expect.contextWindow, "\(index):\(test.name) context window")
            let efforts = AgentDefaults.efforts(for: "claude", provider: row.slug, model: target ?? "",
                                                catalog: nil, configured: [row]).map(\.rawValue)
            XCTAssertEqual(efforts, test.expect.efforts, "\(index):\(test.name) efforts")

            // The model menu: the row's own models, then what the instance's runner discovered.
            let options = AgentDefaults.models(engine: "claude", provider: row.slug, catalog: nil,
                                               configured: [row]).map(\.id)
            XCTAssertEqual(options, test.expect.modelOptions, "\(index):\(test.name) model options")
        }
    }

    /// Every case named in the shared file covers one of the refusal codes, so a reader can see the
    /// vocabulary a session meets is the server's whole set.
    func testTheCasesCoverEveryRefusalCode() throws {
        let codes = Set(try fixtures().cases.compactMap { $0.expect.refusal?.code })
        XCTAssertEqual(codes, Set(LocalProviderRefusalCode.allCases))
    }
}
