import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// What the Runners list and a runner's page read, decoded from the shapes the server actually sends.
///
/// GET /runners is `runners.service.ts listRunners`: the row's own columns, the relays projected to
/// `install` and `accountRemove`, and `online` / `activeSessions` worked out per request. GET
/// /workspaces is `workspaces.service.ts list`: the workspace row — BIGINT byte counts arrive as
/// strings (main.ts BigInt.toJSON) — with its machine's checkout state attached. Every value a
/// newer server or runner can add (a status, an engine, a git state, an updater word) has to come
/// through as itself instead of failing the whole list.
final class RunnerPageDTOTests: XCTestCase {

    private static let runnersJSON = """
    [
      {"id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","name":"wikova","displayName":null,
       "hostname":"vmi3129740","labels":["linux","x64"],"status":"ONLINE","maxConcurrent":12,
       "version":"0.1.197","lastHeartbeatAt":"2026-09-29T00:14:52.312Z",
       "enrolledAt":"2026-06-02T08:15:00.000Z","position":0,
       "planUsage":{"provider":"claude","fiveHour":{"utilization":14,"resetsAt":"2026-09-29T02:59:59Z"},
                    "sevenDay":{"utilization":98,"resetsAt":"2026-10-02T03:59:59Z"}},
       "modelCatalog":{"codex":[{"value":"gpt-5.6-sol","label":"GPT-5.6 Sol"}]},
       "runtimeDefaultModels":{"claude":"claude-opus-5"},
       "runsAsRoot":true,"minFreeDiskMb":20480,"reposRoot":"/root/orbit-repos",
       "capabilities":["codex-account-remove-v1"],"heartbeatLeaseOwner":"runner-1:4242",
       "heartbeatDraining":false,
       "engines":[
         {"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes",
          "update":{"status":"checked","at":"2026-09-29T00:08:00Z","okAt":"2026-09-29T00:08:00Z",
                    "latest":"2.1.284"}},
         {"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes",
          "accounts":[{"id":"default","home":"/root/.codex","codexHome":"/root/.codex","auth":"yes",
                       "fingerprintPrefix":"cxa1_0a1b2c3d"},
                      {"id":"1fda3f43","name":"Work","home":"/root/.orbit/codex-accounts/1fda3f43",
                       "auth":"no"}],
          "update":{"status":"updated","at":"2026-09-28T23:40:00Z","okAt":"2026-09-28T23:40:00Z",
                    "updatedAt":"2026-09-28T23:40:00Z","latest":"0.158.0"}},
         {"engine":"gemini","installed":true,"version":"0.9.0","auth":"unknown",
          "update":{"status":"rolling-back","at":"2026-09-28T23:40:00Z",
                    "message":"a word this build has never heard"}}
       ],
       "install":{"status":null,"engine":null,"command":null,"message":null,"mode":null},
       "accountRemove":{"engine":"codex","account":null,"status":null,"message":null},
       "online":true,"activeSessions":4,"commands":[],"skills":[]},
      {"id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e30","name":"longdeMac-mini.local","displayName":"Mac mini",
       "hostname":"longdeMac-mini","labels":[],"status":"HIBERNATING","maxConcurrent":4,
       "version":"0.1.155","lastHeartbeatAt":"2026-09-14T14:25:09.000Z",
       "enrolledAt":"2026-07-01T10:00:00.000Z","position":1,"planUsage":null,"modelCatalog":null,
       "runtimeDefaultModels":{},"runsAsRoot":false,"minFreeDiskMb":null,"reposRoot":null,
       "capabilities":[],"heartbeatLeaseOwner":null,"heartbeatDraining":null,"engines":null,
       "install":{"status":"queued","engine":"opencode","command":"npm i -g opencode-ai",
                  "message":null,"mode":"reinstall"},
       "accountRemove":{"engine":"claude","account":"0badf00d","status":"pending","message":null},
       "online":false,"activeSessions":0,"commands":[],"skills":[]},
      {"id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31","name":"old-box","status":"OFFLINE",
       "maxConcurrent":2,"version":null,"lastHeartbeatAt":null,"online":false,"activeSessions":0,
       "commands":[],"skills":[]}
    ]
    """

    private static let workspacesJSON = """
    [
      {"id":"0199b111-0000-7000-8000-000000000001","name":"orbit","description":null,"model":null,
       "appendSystemPrompt":null,"systemPrompt":null,"disallowedTools":[],"providerFallbacks":[],
       "canCreateTasks":true,"canDelegate":true,"maxConcurrentTasks":null,"effort":"high",
       "targetRunnerId":null,"targetLabels":[],"runnerId":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f",
       "workDir":"/root/orbit","repoUrl":"https://github.com/example/orbit","env":null,
       "codexAccount":null,"claudeAccount":null,"agentKey":null,"enabled":true,"autoInitGit":false,
       "enableWorktree":true,"defaultMergeTarget":null,"workDirExists":true,"workDirIsGit":true,
       "workDirProbedAt":"2026-09-29T00:14:52.312Z","workDirFreeBytes":"10087419904",
       "workDirTotalBytes":"211157901312","ownerId":"0199aaaa-0000-7000-8000-000000000001",
       "createdAt":"2026-06-02T08:20:00.000Z","deletedAt":null,"position":0,
       "runner":{"id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","name":"wikova","displayName":null},
       "lastProvider":"anthropic-2","provider":"anthropic-2",
       "repoHealth":{"root":"/root/orbit","branch":"main","state":"merge","paths":["src/a.ts","src/b.ts"],
                     "agentIds":["0199b111-0000-7000-8000-000000000001"]},
       "repoCleanup":{"status":"failed","branch":null,"message":"the checkout is in use"}},
      {"id":"0199b111-0000-7000-8000-000000000002","name":"archive","description":null,"model":null,
       "disallowedTools":[],"enabled":true,"autoInitGit":false,"enableWorktree":false,
       "runnerId":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","workDir":"/mnt/archive",
       "workDirExists":true,"workDirIsGit":false,"workDirFreeBytes":17592186044416,
       "workDirTotalBytes":35184372088832,"lastProvider":"claude","provider":"claude",
       "runner":{"id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","name":"wikova","displayName":null},
       "repoHealth":{"root":"/mnt/archive","state":"bisect"},"repoCleanup":null},
      {"id":"0199b111-0000-7000-8000-000000000003","name":"scratch","description":null,"model":null,
       "disallowedTools":[],"enabled":true,"autoInitGit":false,"enableWorktree":false,"runnerId":null,
       "workDir":null,"workDirExists":null,"workDirIsGit":null,"workDirProbedAt":null,
       "workDirFreeBytes":null,"workDirTotalBytes":null,"lastProvider":null,"provider":null,
       "runner":null,"repoHealth":null,"repoCleanup":null}
    ]
    """

    private func runners() throws -> [Runner] {
        try JSONDecoder().decode([Runner].self, from: Data(Self.runnersJSON.utf8))
    }

    private func workspaces() throws -> [Agent] {
        try JSONDecoder().decode([Agent].self, from: Data(Self.workspacesJSON.utf8))
    }

    /// A request body as JSON values, so a key that was left out and a key sent as null differ.
    private func encoded<T: Encodable>(_ value: T) throws -> [String: JSONValue] {
        try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(value))
    }

    // MARK: GET /runners

    func testTheRunnerListReadsEveryFieldTheRunnerPageShows() throws {
        let all = try runners()
        XCTAssertEqual(all.map(\.name), ["wikova", "longdeMac-mini.local", "old-box"])
        let wikova = all[0]
        XCTAssertEqual(wikova.status, .online)
        XCTAssertEqual(wikova.hostname, "vmi3129740")
        XCTAssertEqual(wikova.labels, ["linux", "x64"])
        XCTAssertEqual(wikova.enrolledAt, "2026-06-02T08:15:00.000Z")
        XCTAssertEqual(wikova.minFreeDiskMb, 20_480)
        XCTAssertEqual(wikova.reposRoot, "/root/orbit-repos")
        XCTAssertEqual(wikova.heartbeatLeaseOwner, "runner-1:4242")
        XCTAssertEqual(wikova.heartbeatDraining, false)
        XCTAssertNotNil(wikova.install)
        XCTAssertNil(wikova.install?.status)
        XCTAssertNil(wikova.install?.mode)
        XCTAssertEqual(wikova.accountRemove?.engine, "codex")
        XCTAssertNil(wikova.accountRemove?.account)

        let codex = try XCTUnwrap(wikova.engineHealth(.codex))
        XCTAssertEqual(codex.accounts?.map(\.id), ["default", "1fda3f43"])
        XCTAssertEqual(codex.accounts?.first?.codexHome, "/root/.codex")
        XCTAssertEqual(codex.accounts?.first?.fingerprintPrefix, "cxa1_0a1b2c3d")
        XCTAssertEqual(codex.accounts?.last?.name, "Work")
        XCTAssertEqual(codex.accounts?.last?.home, "/root/.orbit/codex-accounts/1fda3f43")
        XCTAssertEqual(codex.accounts?.last?.auth, "no")
        XCTAssertEqual(codex.update, RunnerEngineUpdate(status: "updated", at: "2026-09-28T23:40:00Z",
                                                        okAt: "2026-09-28T23:40:00Z", latest: "0.158.0",
                                                        updatedAt: "2026-09-28T23:40:00Z"))
        XCTAssertEqual(wikova.engineHealth(.claude)?.update?.status, "checked")
    }

    /// A status, an engine, an updater word or a relay state this build has never heard of is kept
    /// as it came, and costs nothing else on the list.
    func testValuesThisBuildHasNeverHeardOfDoNotCostTheList() throws {
        let all = try runners()
        let gemini = try XCTUnwrap(all[0].engines?.first { $0.engine == "gemini" })
        XCTAssertEqual(gemini.auth, "unknown")
        XCTAssertEqual(gemini.update?.status, "rolling-back")
        XCTAssertEqual(gemini.update?.message, "a word this build has never heard")

        let mini = all[1]
        XCTAssertEqual(mini.status, .unknown)
        XCTAssertEqual(mini.install?.status, "queued")
        XCTAssertEqual(mini.install?.engine, "opencode")
        XCTAssertEqual(mini.install?.command, "npm i -g opencode-ai")
        XCTAssertEqual(mini.install?.mode, "reinstall")
        XCTAssertEqual(mini.accountRemove?.engine, "claude")
        XCTAssertEqual(mini.accountRemove?.account, "0badf00d")
        XCTAssertEqual(mini.accountRemove?.status, "pending")
        XCTAssertNil(mini.minFreeDiskMb)
        XCTAssertNil(mini.heartbeatDraining)
        XCTAssertNil(mini.engines)
        XCTAssertNil(WorkspaceRunnerAvailabilityLogic.onlineValue(explicit: nil, status: mini.status))
    }

    /// A row from before any of these fields existed still reads, with each of them unknown.
    func testAnOlderServersRowReadsWithEveryNewFieldUnknown() throws {
        let old = try runners()[2]
        XCTAssertEqual(old.status, .offline)
        XCTAssertNil(old.hostname)
        XCTAssertNil(old.labels)
        XCTAssertNil(old.enrolledAt)
        XCTAssertNil(old.minFreeDiskMb)
        XCTAssertNil(old.reposRoot)
        XCTAssertNil(old.heartbeatLeaseOwner)
        XCTAssertNil(old.heartbeatDraining)
        XCTAssertNil(old.install)
        XCTAssertNil(old.accountRemove)
    }

    /// The decoded list is what the attention rule reads.
    func testTheDecodedListFeedsTheRunnerPagesRule() throws {
        let all = try runners()
        let nowMs: Int64 = 1_790_640_900_000
        XCTAssertEqual(RunnerAttention.latestRunnerVersion(nil, runners: all), "0.1.197")
        XCTAssertEqual(RunnerAttention.runnerListSubtitle(all[0], nowMs: nowMs), "vmi3129740 · v0.1.197")
        XCTAssertEqual(RunnerAttention.runnerListSubtitle(all[1], nowMs: nowMs),
                       "Offline · last seen 14d ago · v0.1.155")
        // wikova: its checkout is mid-merge, `archive` spends its Claude login at 98% of the week,
        // and the tightest disk has 9.4 GB free under a 20 GB Keep Free.
        let items = RunnerAttention.runnerAttention(runner: all[0], workspaces: try workspaces(),
                                                    nowMs: nowMs, latestVersion: "0.1.197")
        XCTAssertEqual(items.map(\.kind), [.checkoutStuck, .quotaNearLimit, .diskLow])
        XCTAssertEqual(RunnerAttention.listAttentionLine(items),
                       "orbit checkout stuck in a merge · Claude weekly limit 98%")
        XCTAssertEqual(items.last?.detail,
                       "9.4 GB free of 197 GB, under the 20 GB it keeps free — task runs stop being sent here until space frees up.")
    }

    // MARK: GET /workspaces

    func testTheWorkspaceListReadsByteCountsSentAsStringsOrNumbers() throws {
        let all = try workspaces()
        XCTAssertEqual(all.map(\.name), ["orbit", "archive", "scratch"])
        XCTAssertEqual(all[0].workDirFreeBytes, 10_087_419_904)
        XCTAssertEqual(all[0].workDirTotalBytes, 211_157_901_312)
        XCTAssertEqual(all[1].workDirFreeBytes, 17_592_186_044_416)
        XCTAssertEqual(all[1].workDirTotalBytes, 35_184_372_088_832)
        XCTAssertNil(all[2].workDirFreeBytes)
        XCTAssertNil(all[2].workDirTotalBytes)
        XCTAssertEqual(RunnerAttention.runnerDisk(all),
                       RunnerDisk(freeBytes: 10_087_419_904, totalBytes: 211_157_901_312, usedPercent: 95))
    }

    func testTheWorkspaceListReadsItsCheckoutAndDirectoryState() throws {
        let all = try workspaces()
        let orbit = all[0]
        XCTAssertEqual(orbit.enableWorktree, true)
        XCTAssertEqual(orbit.workDirExists, true)
        XCTAssertEqual(orbit.workDirIsGit, true)
        XCTAssertEqual(orbit.repoHealth, RunnerRepoHealth(root: "/root/orbit", state: "merge", branch: "main",
                                                          paths: ["src/a.ts", "src/b.ts"]))
        XCTAssertEqual(orbit.repoCleanup, RunnerRepoCleanup(status: "failed", branch: nil,
                                                            message: "the checkout is in use"))
        // A git state this build has never heard of is kept as it came.
        XCTAssertEqual(all[1].repoHealth?.state, "bisect")
        XCTAssertEqual(all[1].workDirIsGit, false)
        XCTAssertNil(all[1].repoCleanup)
        let scratch = all[2]
        XCTAssertNil(scratch.workDirExists)
        XCTAssertNil(scratch.workDirIsGit)
        XCTAssertNil(scratch.repoHealth)
        XCTAssertNil(scratch.repoCleanup)
    }

    // MARK: request bodies

    /// PATCH /runners/:id: leaving Keep Free alone sends no key at all, turning it off sends null.
    func testKeepFreeIsLeftAloneClearedOrSet() throws {
        XCTAssertEqual(try encoded(UpdateRunnerRequest(displayName: "Mac mini")),
                       ["displayName": .string("Mac mini")])
        XCTAssertEqual(try encoded(UpdateRunnerRequest(minFreeDiskMb: .clear)), ["minFreeDiskMb": .null])
        XCTAssertEqual(try encoded(UpdateRunnerRequest(maxConcurrent: 8, minFreeDiskMb: .set(20_480))),
                       ["maxConcurrent": .int(8), "minFreeDiskMb": .int(20_480)])
        XCTAssertEqual(try encoded(UpdateRunnerRequest()), [:])
    }

    /// POST /runners/:id/login names an account only when one was asked for.
    func testASignInNamesAnAccountOnlyWhenAsked() throws {
        XCTAssertEqual(try encoded(StartLoginRequest(engine: .claude)), ["engine": .string("claude")])
        XCTAssertEqual(try encoded(StartLoginRequest(engine: .codex, account: "1fda3f43")),
                       ["engine": .string("codex"), "account": .string("1fda3f43")])
        XCTAssertEqual(try encoded(StartLoginRequest(engine: .codex, accountName: "Work")),
                       ["engine": .string("codex"), "accountName": .string("Work")])
    }
}

// MARK: - the routes

private final class RunnerPageURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (status: Int, body: String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let answer = Self.handler?(request) ?? (status: 500, body: "")
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// What reached the wire: the method, the path and the body as JSON values.
private final class RunnerPageRequestLog: @unchecked Sendable {
    struct Sent: Equatable {
        let line: String
        let body: [String: JSONValue]?
    }

    private let lock = NSLock()
    private var storage: [Sent] = []

    func record(_ request: URLRequest) {
        let line = "\(request.httpMethod ?? "?") \(request.url?.path ?? "")"
        let body = Self.body(request).flatMap { try? JSONDecoder().decode([String: JSONValue].self, from: $0) }
        lock.lock()
        storage.append(Sent(line: line, body: body))
        lock.unlock()
    }

    var sent: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    /// URLProtocol hands back a request whose body has been moved to `httpBodyStream`, so the bytes
    /// are read off the stream rather than off `httpBody` (which is nil by then).
    private static func body(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(contentsOf: buffer[0..<read])
        }
        return data
    }
}

/// Each control the runner page adds hits the route runners.controller.ts / workspaces.controller.ts
/// / sessions.controller.ts serves for it, and reads what that route answers.
final class RunnerPageAPIClientTests: XCTestCase {
    override func tearDown() {
        RunnerPageURLProtocol.handler = nil
        super.tearDown()
    }

    private func client(_ base: String = "https://orbit.test") -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RunnerPageURLProtocol.self]
        return APIClient(baseURL: URL(string: base)!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private static let answers: [String: String] = [
        "GET /api/sessions/counts": #"[{"workspaceId":"W1","active":2,"running":1,"jobs":0,"needsYou":1}]"#,
        "POST /api/runners/R1/engine-update":
            #"{"status":"pending","engine":null,"command":null,"message":null,"mode":"update"}"#,
        "POST /api/runners/R1/refresh-models": #"{"requestedAt":"2026-09-29T09:00:00.000Z"}"#,
        "POST /api/runners/R1/login":
            #"{"status":"pending","engine":"codex","url":null,"userCode":null,"message":null,"account":null}"#,
        "DELETE /api/runners/R1/accounts/codex/1fda3f43":
            #"{"engine":"codex","account":"1fda3f43","status":"pending","message":null}"#,
        "POST /api/runners/reorder": #"[{"id":"R2","name":"b"},{"id":"R1","name":"a"}]"#,
        "GET /api/runners/device/ABCD-1234":
            #"{"userCode":"ABCD-1234","name":"mac-mini","hostname":"longdeMac-mini","labels":["mac"],"maxConcurrent":4,"status":"PENDING","nameConflict":true,"createdAt":"2026-09-29T09:00:00.000Z"}"#,
        "POST /api/workspaces/W1/repo-cleanup":
            #"{"id":"W1","name":"orbit","repoHealth":{"root":"/root/orbit","state":"merge"},"repoCleanup":{"status":"pending","branch":null,"message":null}}"#,
        "PATCH /api/runners/R1": #"{"id":"R1","name":"a","displayName":null,"maxConcurrent":4,"minFreeDiskMb":null}"#,
    ]

    func testEveryRunnerPageControlHitsItsRoute() async throws {
        let log = RunnerPageRequestLog()
        let answers = Self.answers
        RunnerPageURLProtocol.handler = { request in
            log.record(request)
            let key = "\(request.httpMethod ?? "?") \(request.url?.path ?? "")"
            return answers[key].map { (status: 200, body: $0) } ?? (status: 404, body: "")
        }
        let api = client()

        let counts = try await api.sessionCounts()
        let update = try await api.startEngineUpdate("R1")
        let refresh = try await api.refreshRunnerModels("R1")
        let login = try await api.startRunnerLogin("R1", engine: .codex, accountName: "Work")
        let removal = try await api.removeRunnerAccount("R1", engine: .codex, account: "1fda3f43")
        let order = try await api.reorderRunners(["R2", "R1"])
        let device = try await api.deviceEnrollment(userCode: "ABCD-1234")
        let workspace = try await api.repoCleanup(workspaceId: "W1")
        let patched = try await api.updateRunner("R1", UpdateRunnerRequest(minFreeDiskMb: .clear))

        XCTAssertEqual(counts.map(\.workspaceId), ["W1"])
        XCTAssertEqual(counts.first?.needsYou, 1)
        XCTAssertEqual(update.status, "pending")
        XCTAssertEqual(update.mode, "update")
        XCTAssertEqual(refresh.requestedAt, "2026-09-29T09:00:00.000Z")
        XCTAssertEqual(login.engine, "codex")
        XCTAssertEqual(removal.account, "1fda3f43")
        XCTAssertEqual(removal.status, "pending")
        XCTAssertEqual(order.map(\.id), ["R2", "R1"])
        XCTAssertEqual(device.name, "mac-mini")
        XCTAssertEqual(device.hostname, "longdeMac-mini")
        XCTAssertEqual(device.labels, ["mac"])
        XCTAssertEqual(device.maxConcurrent, 4)
        XCTAssertEqual(device.status, "PENDING")
        XCTAssertEqual(device.nameConflict, true)
        XCTAssertEqual(workspace.repoCleanup?.status, "pending")
        XCTAssertNil(patched.minFreeDiskMb)

        XCTAssertEqual(log.sent, [
            .init(line: "GET /api/sessions/counts", body: nil),
            .init(line: "POST /api/runners/R1/engine-update", body: nil),
            .init(line: "POST /api/runners/R1/refresh-models", body: nil),
            .init(line: "POST /api/runners/R1/login",
                  body: ["engine": .string("codex"), "accountName": .string("Work")]),
            .init(line: "DELETE /api/runners/R1/accounts/codex/1fda3f43", body: nil),
            .init(line: "POST /api/runners/reorder", body: ["ids": .array([.string("R2"), .string("R1")])]),
            .init(line: "GET /api/runners/device/ABCD-1234", body: nil),
            .init(line: "POST /api/workspaces/W1/repo-cleanup", body: nil),
            .init(line: "PATCH /api/runners/R1", body: ["minFreeDiskMb": .null]),
        ])
    }

    /// The manifest sits beside `api/`, under whatever path the instance is served from.
    func testTheReleaseVersionIsReadBesideTheAPI() async throws {
        let log = RunnerPageRequestLog()
        RunnerPageURLProtocol.handler = { request in
            log.record(request)
            return (status: 200, body: #"{"version":" 0.1.197 ","capabilityRevision":3}"#)
        }
        let atRoot = await client().runnerReleaseVersion()
        let underAPath = await client("https://example.test/orbit").runnerReleaseVersion()
        XCTAssertEqual(atRoot, "0.1.197")
        XCTAssertEqual(underAPath, "0.1.197")
        XCTAssertEqual(log.sent.map(\.line), ["GET /dl/version.json", "GET /orbit/dl/version.json"])
    }

    /// A manifest that is missing or says nothing is no answer, not an error on the page.
    func testTheReleaseVersionIsNilWhenTheManifestSaysNothing() async throws {
        for (status, body) in [(404, "Not Found"), (200, "<html></html>"), (200, #"{"version":""}"#),
                               (200, "{}"), (500, "")] {
            RunnerPageURLProtocol.handler = { _ in (status: status, body: body) }
            let version = await client().runnerReleaseVersion()
            XCTAssertNil(version, "\(status) \(body)")
        }
    }
}
