import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Update Now… (docs/runner-update-drain-design.md §2, D4; board 3 ⑧, board 4, board 5): which runners
/// offer it, the confirmation by how many turns it interrupts, the request, the Restarting and Updated
/// cards, and the transcript's interrupt row and continuation line. The words are `RunnerPageCopy`'s,
/// held to the web's by `RunnerPageCopyParityTests`.
final class RunnerUpdateNowTests: XCTestCase {
    private static let utc = TimeZone(identifier: "UTC")!

    private func runner(_ selfUpdate: [String: Any]?, capabilities: [String]? = ["self-update-now/v1"],
                        updateTurns: [[String: Any]]? = nil) throws -> Runner {
        var json: [String: Any] = [
            "id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31", "name": "studio-mac", "version": "0.1.253",
            "online": true, "runsAsRoot": false,
        ]
        if let selfUpdate { json["selfUpdate"] = selfUpdate }
        if let capabilities { json["capabilities"] = capabilities }
        if let updateTurns { json["updateTurns"] = updateTurns }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func date(_ iso: String) throws -> Date { try XCTUnwrap(RelativeTime.parse(iso)) }

    private let twoTurns: [[String: Any]] = [
        ["id": "34w8a1Backfill00000001", "title": "Backfill missing shard rows", "startedAt": "2023-11-14T21:59:20Z"],
        ["id": "34w8a1Metrics000000002", "title": "  ", "startedAt": "2023-11-14T23:04:20Z"],
    ]

    // MARK: who offers it

    func testOfferedOnlyByARunnerThatDeclaresItWithAReleaseWaiting() throws {
        for phase in ["available", "draining", "postponed"] {
            XCTAssertTrue(RunnerUpdateNow.offered(try runner(["state": "enabled", "phase": phase, "targetVersion": "0.1.254"])), phase)
        }
        XCTAssertFalse(RunnerUpdateNow.offered(try runner(["state": "enabled", "phase": "restarting", "targetVersion": "0.1.254"])))
        XCTAssertFalse(RunnerUpdateNow.offered(try runner(["state": "enabled", "phase": "draining"])), "no version to name")
        XCTAssertFalse(RunnerUpdateNow.offered(try runner(["state": "enabled"])), "nothing waiting")
        XCTAssertFalse(RunnerUpdateNow.offered(try runner(["state": "enabled", "phase": "draining", "targetVersion": "0.1.254"],
                                                          capabilities: ["self-update-postpone/v1"])),
                       "a runner too old to honour it keeps Update Runner Now")
        XCTAssertFalse(RunnerUpdateNow.offered(try runner(nil)))
    }

    // MARK: the confirmation

    func testNoTurnRunning() throws {
        let r = try runner(["state": "enabled", "phase": "available", "targetVersion": "0.1.254"], updateTurns: [])
        let c = RunnerUpdateNow.confirmation(r, machine: "studio-mac", now: try date("2023-11-14T23:51:20Z"))
        XCTAssertEqual(c.title, "Update studio-mac now?")
        XCTAssertEqual(c.body, "No turn is running. It installs 0.1.254 and restarts — usually under a minute.")
        XCTAssertEqual(c.confirm, "Update Now")
        XCTAssertNil(c.jobsNote)
        XCTAssertEqual(c.message, c.body)
        XCTAssertEqual(c.version, "0.1.254")
    }

    func testOneTurn() throws {
        let r = try runner(["state": "enabled", "phase": "postponed", "targetVersion": "0.1.254"],
                           updateTurns: [twoTurns[0]])
        let c = RunnerUpdateNow.confirmation(r, machine: "studio-mac", now: try date("2023-11-14T23:51:20Z"))
        XCTAssertEqual(c.body, "It stops this turn, installs 0.1.254 and restarts — usually under a minute. It then "
                           + "continues where it stopped, with a note that the update interrupted it.")
        XCTAssertEqual(c.confirm, "Interrupt 1 Turn and Update")
        XCTAssertEqual(c.message, c.body + "\n\nBackfill missing shard rows · running 1 h 52 min\n\n"
                           + "Background jobs in those sessions keep running; services they started are stopped. "
                           + "Waiting work starts once it is back.")
    }

    func testTwoTurnsNameEachAndHowLongItHasRun() throws {
        let r = try runner(["state": "enabled", "phase": "draining", "targetVersion": "0.1.254"], updateTurns: twoTurns)
        let c = RunnerUpdateNow.confirmation(r, machine: "studio-mac", now: try date("2023-11-14T23:51:20Z"))
        XCTAssertEqual(c.body, "It stops these turns, installs 0.1.254 and restarts — usually under a minute. Each one "
                           + "then continues where it stopped, with a note that the update interrupted it.")
        XCTAssertEqual(c.turns.map(\.title), ["Backfill missing shard rows", "Untitled session"])
        XCTAssertEqual(c.turns.map(\.running), ["running 1 h 52 min", "running 47 min"])
        XCTAssertEqual(c.jobsNote, RunnerPageCopy.RUNNER_UPDATE_NOW_JOBS_NOTE)
        XCTAssertEqual(c.confirm, "Interrupt 2 Turns and Update")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateNowConfirm(turns: 5), "Interrupt 5 Turns and Update")
        XCTAssertEqual(RunnerPageCopy.RUNNER_UPDATE_NOW_FAILED, "Couldn’t update the runner")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateNowToast(version: "0.1.254"), "Restarting into 0.1.254…")
        XCTAssertEqual(RunnerPageCopy.RUNNER_UPDATE_NOW, "Update Now…")
    }

    // MARK: the request

    func testTheRequestBodyIsTheOwnersExplicitInterrupt() throws {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(RunnerUpdateNow.request)) as? [String: Bool]
        XCTAssertEqual(json, ["interruptTurns": true])
    }

    func testPostsTheRouteWithTheBodyAndReadsTheAnswer() async throws {
        let seen = UpdateNowSeenRequest()
        UpdateNowURLProtocol.handler = { request in
            seen.record(request)
            return (201, Data(#"{"requestedAt":"2026-11-12T03:57:00.000Z","turns":2}"#.utf8))
        }
        defer { UpdateNowURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateNowURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                               session: URLSession(configuration: configuration))
        let answer = try await client.updateRunnerNow("runner-1")
        XCTAssertEqual(answer.turns, 2)
        XCTAssertEqual(answer.requestedAt, "2026-11-12T03:57:00.000Z")
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/runners/runner-1/self-update/now")
        let body = try XCTUnwrap(seen.body)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: Bool], ["interruptTurns": true])
    }

    /// The web posts the same route and body, and the shared contract names them so.
    func testTheRequestIsTheWebsAndTheServers() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/shared/src/dto.ts").path) {
            dir = dir.deletingLastPathComponent()
            if dir.path == "/" { return XCTFail("repo root not found") }
        }
        let shared = try String(contentsOf: dir.appendingPathComponent("src/shared/src/dto.ts"), encoding: .utf8)
        XCTAssertTrue(shared.contains("export const SELF_UPDATE_NOW_V1 = '\(RunnerUpdateNow.capability)';"))
        XCTAssertTrue(shared.contains("export interface RunnerSelfUpdateNowRequest {\n  interruptTurns: true;\n}"))
        XCTAssertTrue(shared.contains("export const RUNNER_UPDATE_INTERRUPT_REASON = '\(RunnerUpdateNow.interruptReason)';"))
        XCTAssertTrue(shared.contains("export const RUNNER_UPDATE_RESUME_NOTE = '\(RunnerUpdateNow.resumeNote)';"))
        let web = try String(contentsOf: dir.appendingPathComponent("src/web/src/lib/runnerUpdateNow.ts"), encoding: .utf8)
        XCTAssertTrue(web.contains("`/runners/${runnerId}/self-update/now`"))
        XCTAssertTrue(web.contains("startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE}`)"))
    }

    // MARK: the Restarting and Updated cards (board 4)

    func testRestartingSaysTheInterruptedTurnsContinue() throws {
        let now = try date("2023-11-15T00:00:00Z")
        func body(_ interrupted: Int?) throws -> String? {
            var report: [String: Any] = ["state": "enabled", "phase": "restarting", "targetVersion": "0.1.254"]
            if let interrupted { report["interruptedTurns"] = interrupted }
            return RunnerPageFormat.updateCard(try runner(report), now: now, timeZone: Self.utc)?.body
        }
        XCTAssertEqual(try body(nil), "Usually under a minute.")
        XCTAssertEqual(try body(0), "Usually under a minute.")
        XCTAssertEqual(try body(1), "1 interrupted turn continues once it is back. Usually under a minute.")
        XCTAssertEqual(try body(2), "2 interrupted turns continue once it is back. Usually under a minute.")
    }

    func testUpdatedForADayAfterwardsWithWhatTheRunnerMeasured() throws {
        let now = try date("2026-11-12T12:00:00Z")
        func card(_ edit: (inout [String: Any]) -> Void) throws -> RunnerPageFormat.UpdateCard? {
            var report: [String: Any] = ["state": "enabled", "lastUpdatedAt": "2026-11-12T09:58:00Z",
                                         "lastUpdatedFrom": "0.1.253", "lastUpdatedTo": "0.1.254"]
            edit(&report)
            return RunnerPageFormat.updateCard(try runner(report), now: now, timeZone: Self.utc)
        }
        let full = try XCTUnwrap(try card {
            $0["lastUpdateSeconds"] = 34
            $0["lastUpdateInterruptedTurns"] = 2
        })
        XCTAssertEqual(full, .init(phase: "updated", warn: false, title: "Updated to 0.1.254", tag: "09:58",
                                   body: "Took 34 s. 2 interrupted turns resumed.", progressLabel: nil, progress: nil))
        XCTAssertEqual(try card { $0["lastUpdateSeconds"] = 72 }?.body, "Took 1 min 12 s.")
        XCTAssertEqual(try card { $0["lastUpdateSeconds"] = 120 }?.body, "Took 2 min.")
        XCTAssertEqual(try card { $0["lastUpdateInterruptedTurns"] = 1 }?.body, "1 interrupted turn resumed.")
        XCTAssertEqual(try card {
            $0["lastUpdateSeconds"] = 34
            $0["lastUpdateInterruptedTurns"] = 0
        }?.body, "Took 34 s.")
        XCTAssertEqual(try card { _ in }?.body, "", "measured nothing: the card, with no body")
        XCTAssertNil(try card { $0["lastUpdatedAt"] = "2026-11-11T11:59:00Z" }, "more than a day ago: About says it")
        XCTAssertNil(try card { $0.removeValue(forKey: "lastUpdatedTo") })
        XCTAssertNil(try card { $0.removeValue(forKey: "lastUpdatedAt") })
        // A release waiting is its own card, whatever was installed before.
        XCTAssertEqual(try card {
            $0["phase"] = "available"
            $0["targetVersion"] = "0.1.255"
        }?.phase, "available")
    }

    func testTookAndUpdatedBodyWords() {
        XCTAssertEqual(RunnerPageCopy.runnerUpdateTook(seconds: 34), "34 s")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateTook(seconds: 59), "59 s")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateTook(seconds: 60), "1 min")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateTook(seconds: 72), "1 min 12 s")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateTook(seconds: 120), "2 min")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateUpdatedBody(took: nil, interruptedTurns: 0), "")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateUpdatedBody(took: "34 s", interruptedTurns: 1),
                       "Took 34 s. 1 interrupted turn resumed.")
        XCTAssertEqual(RunnerPageCopy.runnerUpdateUpdatedTitle(version: "0.1.254"), "Updated to 0.1.254")
    }

    // MARK: the transcript (D4)

    func testTheInterruptRowNamesTheUpdateAndKeepsTheQueue() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, payload: .object(["text": .string("Backfill the shard.")])))
        r.apply(RunEvent(seq: 2, type: .interrupt, payload: .object(["reason": .string("runner_update"),
                                                                    "targetVersion": .string("0.1.254")])))
        r.apply(RunEvent(seq: 3, type: .interrupt, payload: .object(["reason": .string("runner_update")])))
        r.apply(RunEvent(seq: 4, type: .interrupt, payload: .object(["reason": .string("runner_restart")])))
        let rows = r.state.items.compactMap { item -> String? in
            guard case .interrupt(_, let seq, let restart, let update) = item else { return nil }
            if let update { return "\(seq):\(RunnerPageCopy.runnerUpdateInterruptedLine(version: update.targetVersion))" }
            return "\(seq):\(restart ? "runner restart" : "stop")"
        }
        XCTAssertEqual(rows, ["2:⊘ interrupted — the runner updated to 0.1.254",
                              "3:⊘ interrupted — the runner updated",
                              "4:runner restart"])
        let update = RunEvent(seq: 5, type: .interrupt, payload: .object(["reason": .string("runner_update")]))
        XCTAssertFalse(TranscriptReducer.dropsQueue(update), "nobody pressed Stop: the queue goes on")
        XCTAssertTrue(TranscriptReducer.dropsQueue(RunEvent(seq: 6, type: .interrupt, payload: .object([:]))))
    }

    func testAnInterruptRowSurvivesTheSnapshotRoundTrip() throws {
        let rows: [TranscriptItem] = [
            .interrupt(id: "a", seq: 2, runnerRestart: false, runnerUpdate: RunnerUpdateCut(targetVersion: "0.1.254")),
            .interrupt(id: "b", seq: 3),
        ]
        let decoded = try JSONDecoder().decode([TranscriptItem].self, from: JSONEncoder().encode(rows))
        XCTAssertEqual(decoded, rows)
    }

    func testTheContinuationIsOrbitsLineNotTheOwnersBubble() {
        let text = "[Orbit] The runner update interrupted this turn; continue. The runner updated to 0.1.254 at the "
            + "owner's request, which stopped this turn; the work it was doing goes on from here."
        XCTAssertTrue(RunnerUpdateNow.isResume(text))
        XCTAssertEqual(RunnerUpdateNow.resumeLine(text), "The runner update interrupted this turn; continue.")
        XCTAssertFalse(RunnerUpdateNow.isResume("The runner update interrupted this turn; continue."),
                       "the owner's own words, without Orbit's mark")
        XCTAssertFalse(RunnerUpdateNow.isResume("Why did [Orbit] The runner update interrupted this turn; continue."))
        XCTAssertNil(RunnerUpdateNow.resumeLine(nil))
    }

    // MARK: the app draws it (OrbitApp cannot build here; its sources are read)

    func testTheSurfacesDrawUpdateNowThroughOrbitConfirmation() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp").path) {
            dir = dir.deletingLastPathComponent()
            if dir.path == "/" { return XCTFail("repo root not found") }
        }
        let app = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
        let read = { (name: String) in try String(contentsOf: app.appendingPathComponent(name), encoding: .utf8) }
        let control = try read("Views/RunnerUpdateNowControl.swift")
        XCTAssertTrue(control.contains(".orbitConfirmation({ $0.title }, isPresented: askingShown, presenting: asking)"))
        XCTAssertTrue(control.contains("Button(confirmation.confirm, role: .destructive) { update(confirmation) }"))
        XCTAssertTrue(control.contains("Text(confirmation.message)"))
        XCTAssertTrue(control.contains("RunnerUpdateNow.offered(runner)"))
        XCTAssertTrue(control.contains("app.runners?.updateNow(runnerID)"))
        XCTAssertFalse(control.contains(".confirmationDialog("))
        XCTAssertTrue(try read("RunnersModel.swift").contains("await press { _ = try await self.api.updateRunnerNow(id) }"))

        let updating = try read("Views/Console/RunnerUpdatingViews.swift")
        XCTAssertEqual(updating.components(separatedBy: "RunnerUpdateNowControl(runnerID:").count - 1, 2,
                       "the queued page and the popover each draw Update Now…")
        let page = try read("Views/SkillsRunnersView.swift")
        XCTAssertEqual(page.components(separatedBy: "RunnerUpdateNowControl(runnerID: runner.id").count - 1, 2)
        XCTAssertTrue(page.contains(#"if card.phase == "available", RunnerUpdateNow.offered(runner) {"#))
        XCTAssertTrue(page.contains("} else if card.phase == \"postponed\" {"),
                      "a runner without the capability keeps the old Update Now…")

        let row = try read("Views/Console/UserTurnRow.swift")
        XCTAssertTrue(row.contains("} else if let line = RunnerUpdateNow.resumeLine(b.text) {"))
        let console = try read("Views/Console/ConsoleView.swift")
        XCTAssertTrue(console.contains("RunnerPageCopy.runnerUpdateInterruptedLine(version: runnerUpdate.targetVersion)"))
    }
}

private final class UpdateNowURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let result = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The request the stub was handed and its body, which URLProtocol may see as a stream.
private final class UpdateNowSeenRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: URLRequest?
    private var data: Data?

    func record(_ request: URLRequest) {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var out = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                out.append(buffer, count: n)
            }
            body = out
        }
        lock.lock()
        seen = request
        data = body
        lock.unlock()
    }

    var request: URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    var body: Data? {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}
