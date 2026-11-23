import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

final class AccountHealthTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private let tap = "com.apple.UNNotificationDefaultActionIdentifier"

    private func block(_ kind: String = "ACCOUNT_ACTION_REQUIRED", said: String? = "Add a payment method to continue",
                       trips: Int = 1, scope: String = "", engine: String? = "cursor", line: String = "") -> AccountHealthBlock {
        AccountHealthBlock(id: "h1", subjectKey: "runner:r1:cursor:default", runnerId: "r1", engine: engine,
                           account: "default", scopeModel: scope, kind: kind, said: said, trips: trips,
                           since: "2026-11-22T17:19:00Z", nextTrialAt: "2026-11-22T21:19:00Z", line: line)
    }

    func testClassifiedLineNamesTheProvidersWordsAndTheTimes() {
        let now = RelativeTime.parse("2026-11-22T18:00:00Z")!
        XCTAssertEqual(AccountHealth.line(block(), now: now, timeZone: utc),
                       "Needs action · Cursor said \"Add a payment method to continue\" · since Nov 22, 17:19 · tried again at 21:19")
    }

    func testBreakerLineAndANextTryOnAnotherDay() {
        let now = RelativeTime.parse("2026-11-23T08:00:00Z")!
        let line = AccountHealth.line(block("UNCLASSIFIED_ADMISSION", said: nil, trips: 1), now: now, timeZone: utc)
        XCTAssertEqual(line, "Not used for now · failed to start 2 runs · since Nov 22, 17:19 · tried again at Nov 22, 21:19")
    }

    func testTheServersLeadSentenceWinsAndATrialReadsAsTryingNow() {
        var b = block(line: "Needs action · Anthropic said \"Key revoked\"")
        XCTAssertTrue(AccountHealth.line(b, timeZone: utc).hasPrefix("Needs action · Anthropic said \"Key revoked\" · since"))
        b = AccountHealthBlock(id: "h", kind: "ACCESS_DENIED", said: "No", since: "2026-11-22T17:19:00Z",
                               nextTrialAt: "2026-11-22T21:19:00Z", trialRunning: true)
        XCTAssertTrue(AccountHealth.line(b, timeZone: utc).hasSuffix("trying it now"))
    }

    func testTheRowMatchesTheRunnersWholeAccountOnly() {
        let blocks = [block(scope: "gpt-5"), block()]
        XCTAssertEqual(AccountHealth.block(blocks, runnerID: "r1", engine: "cursor", account: "default")?.scopeModel, "")
        XCTAssertNil(AccountHealth.block(blocks, runnerID: "r1", engine: "codex", account: "default"))
        XCTAssertNil(AccountHealth.block(blocks, runnerID: "r2", engine: "cursor", account: "default"))
        XCTAssertNil(AccountHealth.block([block(scope: "gpt-5")], runnerID: "r1", engine: "cursor", account: "default"))
    }

    func testAKeyAndAPoolLoginMatchTheirWholeAccountOnly() {
        let key = AccountHealthBlock(id: "k", subjectKey: "provider:p1", providerId: "p1", kind: "ACCOUNT_ACTION_REQUIRED",
                                     since: "2026-11-22T17:19:00Z")
        let keyModel = AccountHealthBlock(id: "km", providerId: "p1", scopeModel: "claude-opus", kind: "ACCESS_DENIED",
                                          since: "2026-11-22T17:19:00Z")
        let login = AccountHealthBlock(id: "l", subjectKey: "pool-login:pool1:fp1", account: "fp1", poolId: "pool1",
                                       kind: "CREDENTIAL_REFUSED", since: "2026-11-22T17:19:00Z")
        let blocks = [keyModel, key, login]
        XCTAssertEqual(AccountHealth.block(blocks, providerID: "p1")?.id, "k")
        XCTAssertNil(AccountHealth.block([keyModel], providerID: "p1"))
        XCTAssertNil(AccountHealth.block(blocks, providerID: "p2"))
        XCTAssertEqual(AccountHealth.block(blocks, poolID: "pool1", account: "fp1")?.id, "l")
        XCTAssertEqual(AccountHealth.block(blocks, poolID: "pool1", account: "login:fp1")?.id, "l", "a member's id spelling")
        XCTAssertNil(AccountHealth.block(blocks, poolID: "pool1", account: "fp2"))
        XCTAssertNil(AccountHealth.block(blocks, runnerID: "r1", engine: "cursor", account: "fp1"))
    }

    func testDecodesTheRouteAnswer() throws {
        let json = """
        {"blocks":[{"id":"h1","subjectKey":"k","runnerId":"r1","engine":"cursor","account":"default","providerId":null,
        "poolId":null,"scopeModel":"","kind":"ACCOUNT_ACTION_REQUIRED","said":"x","trips":1,"since":"2026-11-22T17:19:00Z",
        "nextTrialAt":null,"trialRunning":false,"line":"l"}]}
        """
        let answer = try JSONDecoder().decode(AccountHealthAnswer.self, from: Data(json.utf8))
        XCTAssertEqual(answer.blocks?.first?.id, "h1")
        XCTAssertNil(answer.blocks?.first?.nextTrialAt)
    }

    func testAKeyPushOpensProvidersAndARunnerPushOpensTheRunner() {
        let runner = "019a0000-0000-7000-8000-000000000003"
        XCTAssertEqual(Notifications.intent(actionId: tap, userInfo: ["kind": "account-needs-action", "runnerID": runner,
                                                                      "accountHealthID": "h1"]),
                       .open(.runner(PublicID.toPublic(runner))))
        XCTAssertEqual(Notifications.intent(actionId: tap, userInfo: ["kind": "account-needs-action",
                                                                      "accountHealthID": "h2",
                                                                      "subjectKey": "provider:p1"]),
                       .openProviders, "a key has no runner: its row is on Providers")
        XCTAssertEqual(Notifications.intent(actionId: tap, userInfo: ["kind": "account-needs-action",
                                                                      "subjectKey": "pool-login:pool1:fp1"]),
                       .openProviders)
        XCTAssertNil(Notifications.intent(actionId: tap, userInfo: ["kind": "engine-signed-out"]),
                     "a runner kind without its runner still opens nothing")
    }

    // MARK: route + wiring

    private func client(_ status: Int, _ body: String, record: @escaping @Sendable (URLRequest) -> Void) -> APIClient {
        HealthURLProtocol.handler = { request in record(request); return (status, Data(body.utf8)) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HealthURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    func testReadsBlocksAndPostsCheckAgain() async throws {
        let paths = HealthPaths()
        let blocks = try await client(200, #"{"blocks":[{"id":"h1","scopeModel":"","kind":"ACCESS_DENIED","trips":1,"since":"2026-11-22T17:19:00Z","trialRunning":false,"line":""}]}"#) { paths.add($0) }.accountHealth()
        XCTAssertEqual(blocks.map(\.id), ["h1"])
        try await client(200, #"{"cleared":1}"#) { paths.add($0) }.checkAccountAgain("h1")
        XCTAssertEqual(paths.values, ["GET /api/account-health", "POST /api/account-health/h1/check"])
    }

    func testCheckAgainOnAnAlreadyClearedRowIsNotAFailure() async throws {
        try await client(404, #"{"message":"Not found"}"#) { _ in }.checkAccountAgain("gone")
    }

    func testTheRunnerAccountRowDrawsTheBlockAndCheckAgain() throws {
        let page = try wiringSource("OrbitApp/Sources/OrbitApp/Views/RunnerEnginePage.swift")
        XCTAssertTrue(page.contains("AccountHealth.block(runners.healthBlocks, runnerID: runner.id, engine: engine, account: line.id)"))
        XCTAssertTrue(page.contains("runners.checkAccountAgain(block)"))
        let row = try wiringSource("OrbitApp/Sources/OrbitApp/Views/AccountHealthRow.swift")
        XCTAssertTrue(row.contains("AccountHealth.checkAgainTitle") && row.contains("AccountHealth.line(block"))
    }

    private func wiringSource(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return try String(contentsOf: candidate, encoding: .utf8) }
            dir.deleteLastPathComponent()
        }
        throw XCTSkip("\(relative) not found")
    }
}

private final class HealthPaths: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [String] = []
    func add(_ request: URLRequest) { lock.lock(); list.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")"); lock.unlock() }
    var values: [String] { lock.lock(); defer { lock.unlock() }; return list }
}

private final class HealthURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let result = Self.handler!(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
