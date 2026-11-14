import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class DismissURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class DismissSeenRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: URLRequest?

    func record(_ request: URLRequest) {
        lock.lock()
        stored = request
        lock.unlock()
    }

    var request: URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

/// Dismiss an engine update warning until the next release (web `updateNoteOf`'s `dismissed`,
/// `runner.engineUpdateDismissals`): quiet while the dismissal is still `update.latest`, a warning
/// again once a newer release is out.
final class RunnerEngineUpdateDismissTests: XCTestCase {
    override func tearDown() {
        DismissURLProtocol.handler = nil
        super.tearDown()
    }

    /// 2026-09-29T00:15:00Z, the case file's clock: 13 days after behindSince.
    private static let nowMs: Int64 = 1_790_640_900_000
    private static let now = Date(timeIntervalSince1970: Double(nowMs) / 1000)

    private func update(latest: String) -> RunnerEngineUpdate {
        RunnerEngineUpdate(status: "failed", at: "2026-09-28T23:50:00Z", okAt: "2026-09-15T00:00:00Z",
                           latest: latest, behindSince: "2026-09-16T00:00:00Z")
    }

    private func runner(latest: String, dismissed: String?) throws -> Runner {
        let dismissals = dismissed.map { #","engineUpdateDismissals":{"codex":"\#($0)"}"# } ?? ""
        return try JSONDecoder().decode(Runner.self, from: Data(#"""
        {"id":"r","name":"aivps-sg","online":true,"lastHeartbeatAt":"2026-09-29T00:14:50Z","engines":[
          {"engine":"codex","installed":true,"version":"codex-cli 0.159.2","auth":"yes",
           "update":{"status":"failed","at":"2026-09-28T23:50:00Z","okAt":"2026-09-15T00:00:00Z",
                     "latest":"\#(latest)","behindSince":"2026-09-16T00:00:00Z"}}]\#(dismissals)}
        """#.utf8))
    }

    func testADismissalAgainstTheLatestQuietsTheWarningAndKeepsTheDrift() {
        XCTAssertEqual(RunnerAttention.updateNoteOf(update(latest: "0.169.0"), nowMs: Self.nowMs,
                                                    dismissed: "0.169.0"),
                       RunnerEngineUpdateNote(tone: .quiet, text: "13d behind 0.169.0 · warning dismissed"))
        XCTAssertEqual(RunnerAttention.updateNoteOf(update(latest: "0.169.0"), nowMs: Self.nowMs),
                       RunnerEngineUpdateNote(tone: .warn, text: "13d behind 0.169.0"))
    }

    func testANewerReleaseWarnsAgain() {
        XCTAssertEqual(RunnerAttention.updateNoteOf(update(latest: "0.170.0"), nowMs: Self.nowMs,
                                                    dismissed: "0.169.0"),
                       RunnerEngineUpdateNote(tone: .warn, text: "13d behind 0.170.0"))
        XCTAssertEqual(RunnerAttention.updateNoteOf(update(latest: "0.169.0"), nowMs: Self.nowMs, dismissed: ""),
                       RunnerEngineUpdateNote(tone: .warn, text: "13d behind 0.169.0"))
    }

    func testADismissedEngineRaisesNoItemAndTheMachineIsNotCounted() throws {
        let dismissed = try runner(latest: "0.169.0", dismissed: "0.169.0")
        XCTAssertEqual(dismissed.engineUpdateDismissals, ["codex": "0.169.0"])
        let quiet = RunnerAttention.runnerAttention(runner: dismissed, workspaces: [], nowMs: Self.nowMs,
                                                    latestVersion: nil)
        XCTAssertTrue(quiet.isEmpty, "\(quiet.map(\.kind))")
        XCTAssertNil(RunnerAttention.listAttentionLine(quiet))
        XCTAssertNotEqual(MachinesAndModels.summary(dismissed, now: Self.now), "1 engine not updating")
        XCTAssertNil(RunnerPageFormat.updateFailedLine(try XCTUnwrap(dismissed.engines?.first), now: Self.now,
                                                       dismissed: "0.169.0"))
        XCTAssertFalse(RunnerPageFormat.offersUpdateWarningDismiss(
            dismissed, health: try XCTUnwrap(dismissed.engines?.first), now: Self.now))

        let newer = try runner(latest: "0.170.0", dismissed: "0.169.0")
        let back = RunnerAttention.runnerAttention(runner: newer, workspaces: [], nowMs: Self.nowMs,
                                                   latestVersion: nil)
        XCTAssertEqual(back.map(\.kind), [.engineNotUpdating])
        XCTAssertEqual(MachinesAndModels.summary(newer, now: Self.now), "1 engine not updating")
        XCTAssertTrue(RunnerPageFormat.offersUpdateWarningDismiss(
            newer, health: try XCTUnwrap(newer.engines?.first), now: Self.now))
        let item = try XCTUnwrap(back.first)
        XCTAssertEqual(RunnerPageFormat.updateWarningDismissEngine(item), "codex")
        XCTAssertEqual(RunnerPageCopy.attentionDismissUntilNextRelease(
            engine: RunnerPageFormat.engineName("codex")), "Dismiss until next Codex release")
    }

    func testAnOlderServerWithoutDismissalsDismissesNothing() throws {
        let old = try runner(latest: "0.169.0", dismissed: nil)
        XCTAssertNil(old.engineUpdateDismissals)
        XCTAssertEqual(RunnerAttention.runnerAttention(runner: old, workspaces: [], nowMs: Self.nowMs,
                                                       latestVersion: nil).map(\.kind), [.engineNotUpdating])
    }

    func testDismissPostsTheEnginesUpdateWarningRoute() async throws {
        let seen = DismissSeenRequest()
        DismissURLProtocol.handler = { request in
            seen.record(request)
            return (201, Data(#"{"engine":"codex","latest":"0.169.0"}"#.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DismissURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://orbit.test")!,
                               tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
        try await client.dismissEngineUpdateWarning("runner", engine: "codex")
        let request = try XCTUnwrap(seen.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/runners/runner/engines/codex/update-warning/dismiss")
    }
}
