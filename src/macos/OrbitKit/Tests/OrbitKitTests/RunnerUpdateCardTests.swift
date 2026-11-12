import Foundation
import XCTest
@testable import OrbitKit

/// The runner page's Update card (docs/runner-update-drain-design.md §4, board 4), one per phase the
/// runner reports — the web's `RunnerDetailPage.selfUpdate.test.tsx` "the Update card" block, at this
/// end. The reports are `src/shared/src/runner-self-update.fixture.json`'s, which the Go runner
/// writes field for field; the card's words are `RunnerPageCopy`'s, held to the web's by
/// `RunnerPageCopyParityTests`.
final class RunnerUpdateCardTests: XCTestCase {

    private static let fixture = "src/shared/src/runner-self-update.fixture.json"
    private static let utc = TimeZone(identifier: "UTC")!

    private struct Missing: Error, CustomStringConvertible {
        let description: String
    }

    private func repoFile(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(description: "\(relative) wasn't found above this test; point this check at its new home.")
    }

    /// The fixture's report for `name`, edited as JSON before it is read.
    private func report(_ name: String, _ edit: (inout [String: Any]) -> Void = { _ in }) throws -> [String: Any] {
        let data = try Data(contentsOf: try repoFile(Self.fixture))
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try XCTUnwrap(file["cases"] as? [[String: Any]])
        var found = try XCTUnwrap(cases.first { $0["name"] as? String == name }?["report"] as? [String: Any],
                                  "no fixture case \(name)")
        edit(&found)
        return found
    }

    /// A runner on 0.1.253, as GET /runners answers it, reporting `selfUpdate`.
    private func runner(_ selfUpdate: [String: Any]?) throws -> Runner {
        var json: [String: Any] = [
            "id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31", "name": "studio-mac", "version": "0.1.253",
            "online": true, "runsAsRoot": false,
        ]
        if let selfUpdate { json["selfUpdate"] = selfUpdate }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func date(_ iso: String) throws -> Date { try XCTUnwrap(RelativeTime.parse(iso)) }

    func testAvailableIsQuietAndSaysWhenItInstalls() throws {
        let r = try runner(try report("available") { $0["targetVersion"] = "0.1.254" })
        let card = try XCTUnwrap(RunnerPageFormat.updateCard(r, now: try date("2023-11-14T22:33:20Z"), timeZone: Self.utc))
        XCTAssertEqual(card, .init(phase: "available", warn: false, title: "0.1.254 is available", tag: "Available",
                                   body: "It installs when no turn is running. If turns keep running for an hour, "
                                       + "it stops taking new work so they can finish.",
                                   progressLabel: nil, progress: nil))
        XCTAssertEqual(RunnerPageFormat.versionValue(r, latest: "0.1.254"),
                       "0.1.253 · 0.1.254 installs when no turn is running")
    }

    func testDrainingCountsTheTurnsAndTheTimeAndAboutSaysUpdatingTo() throws {
        let r = try runner(try report("draining") {
            $0["turnsInFlight"] = 2
            $0["turnsAtDrain"] = 8
        })
        // 38 min after the drain began (23:13:20Z).
        let card = try XCTUnwrap(RunnerPageFormat.updateCard(r, now: try date("2023-11-14T23:51:20Z"), timeZone: Self.utc))
        XCTAssertEqual(card, .init(phase: "draining", warn: true, title: "Updating to 0.1.254", tag: "Not taking new work",
                                   body: "0.1.254 has been waiting since 22:13. After an hour it stopped taking new "
                                       + "work so the turns in flight can finish; then it installs and restarts.",
                                   progressLabel: "Waiting for 2 of 8 turns · 38 min", progress: 0.75))
        XCTAssertEqual(RunnerPageFormat.versionValue(r, latest: "0.1.254"), "0.1.253 · updating to 0.1.254")
    }

    func testDrainingFromARunnerThatDidNotCountTheTurnsAtTheStart() throws {
        let r = try runner(try report("draining") {
            $0.removeValue(forKey: "availableSince")
            $0.removeValue(forKey: "turnsAtDrain")
        })
        let card = try XCTUnwrap(RunnerPageFormat.updateCard(r, now: try date("2023-11-15T01:05:20Z"), timeZone: Self.utc))
        XCTAssertEqual(card.body, RunnerPageCopy.RUNNER_UPDATE_DRAINING_BODY_NO_SINCE)
        XCTAssertEqual(card.progressLabel, "Waiting for 1 turn · 1 h 52 min")
        XCTAssertEqual(card.progress, 0)
    }

    func testRestartingIsAmberWithNoBar() throws {
        let r = try runner(try report("restarting"))
        let card = try XCTUnwrap(RunnerPageFormat.updateCard(r, now: try date("2023-11-15T00:00:00Z"), timeZone: Self.utc))
        XCTAssertEqual(card, .init(phase: "restarting", warn: true, title: "Restarting into 0.1.254…", tag: "Restarting",
                                   body: "Usually under a minute.", progressLabel: nil, progress: nil))
        XCTAssertEqual(RunnerPageFormat.versionValue(r, latest: "0.1.254"), "0.1.253 · updating to 0.1.254")
    }

    func testPostponedSaysUntilWhenAndWhatHappensThen() throws {
        let r = try runner(try report("postponed"))
        let card = try XCTUnwrap(RunnerPageFormat.updateCard(r, now: try date("2023-11-14T23:00:00Z"), timeZone: Self.utc))
        XCTAssertEqual(card, .init(phase: "postponed", warn: false, title: "0.1.254 postponed until 02:00", tag: "Postponed",
                                   body: "Taking work as usual. At 02:00 it waits for the turns in flight again, "
                                       + "for up to an hour.",
                                   progressLabel: nil, progress: nil))
    }

    func testAnOldRunnerHasNoCardAndKeepsTodaysWording() throws {
        let r = try runner(try report("oldRunner"))
        XCTAssertNil(RunnerPageFormat.updateCard(r, now: Date(), timeZone: Self.utc))
        XCTAssertEqual(RunnerPageFormat.versionValue(r, latest: "0.1.254"),
                       "0.1.253 · 0.1.254 installs when no turn is running")
        // And a phase this client doesn't know draws nothing rather than a guess.
        let unknown = try runner(["state": "waitingForIdle", "phase": "installing", "targetVersion": "0.1.254"])
        XCTAssertNil(RunnerPageFormat.updateCard(unknown, now: Date(), timeZone: Self.utc))
    }

    /// The app's runner page (which can't compile on Linux) draws the card above Needs Attention.
    func testTheRunnerPageDrawsTheCard() throws {
        let view = try String(contentsOf: try repoFile("src/macos/OrbitApp/Sources/OrbitApp/Views/SkillsRunnersView.swift"),
                              encoding: .utf8)
        XCTAssertTrue(view.contains("if let card = RunnerPageFormat.updateCard(runner, now: now) {\n                updateSection(card)\n            }"),
                      "the runner page does not draw the Update card")
    }
}
