import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

private final class DeviceEnrollmentURLProtocol: URLProtocol, @unchecked Sendable {
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

/// The request `orbit register` makes, decided from the Add Runner sheet as the web's /enroll page
/// decides it: GET /runners/device/:userCode says whether it is still PENDING, or APPROVED or DENIED, and
/// when a runner already of its name last checked in; POST …/approve and …/deny decide it, and deciding
/// one already decided the other way is refused 409 `DEVICE_ENROLLMENT_DECIDED` with a sentence of its own.
final class RunnerDeviceEnrollmentTests: XCTestCase {
    override func tearDown() {
        DeviceEnrollmentURLProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeviceEnrollmentURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!,
                         tokenStore: InMemoryTokenStore(), session: URLSession(configuration: configuration))
    }

    private func decode(_ json: String) throws -> DeviceInfo {
        try JSONDecoder().decode(DeviceInfo.self, from: Data(json.utf8))
    }

    // MARK: the lookup

    func testAPendingRequestWithARunnerOfItsNameSaysWhenThatOneWasLastOnline() throws {
        let info = try decode(#"""
            {"userCode":"ABCDE-FGH23","name":"devbox","hostname":"vmi3337007","labels":["gpu"],"maxConcurrent":16,
             "status":"PENDING","nameConflict":true,"existingLastSeenAt":"2026-10-25T11:00:00.000Z","runnerId":null,
             "createdAt":"2026-10-28T11:59:41.000Z","expiresAt":"2026-10-28T12:09:41.000Z"}
            """#)
        XCTAssertEqual(info.status, "PENDING")
        XCTAssertEqual(info.nameConflict, true)
        XCTAssertEqual(info.existingLastSeenAt, "2026-10-25T11:00:00.000Z")
        XCTAssertNil(info.runnerId)
        XCTAssertEqual(info.expiresAt, "2026-10-28T12:09:41.000Z")
        XCTAssertEqual(info.labels, ["gpu"])
    }

    func testADecidedRequestSaysWhichWay() throws {
        let approved = try decode(#"""
            {"userCode":"ABCDE-FGH23","name":"devbox","status":"APPROVED","nameConflict":false,"existingLastSeenAt":null,
             "runnerId":"0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69","expiresAt":"2026-10-28T12:09:41.000Z"}
            """#)
        XCTAssertEqual(approved.status, "APPROVED")
        XCTAssertEqual(approved.runnerId, "0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69")
        XCTAssertNil(approved.existingLastSeenAt)

        let denied = try decode(#"""
            {"userCode":"ABCDE-FGH23","name":"devbox","status":"DENIED","nameConflict":false,"existingLastSeenAt":null,
             "runnerId":null,"expiresAt":"2026-10-28T12:09:41.000Z"}
            """#)
        XCTAssertEqual(denied.status, "DENIED")
        XCTAssertNil(denied.runnerId)
    }

    /// A server from before Deny answers none of the new fields; the lookup still reads.
    func testAnAnswerWithoutTheNewFieldsStillReads() throws {
        let info = try decode(#"{"userCode":"ABCD-1234","name":"mac-mini","status":"PENDING","nameConflict":true}"#)
        XCTAssertEqual(info.name, "mac-mini")
        XCTAssertNil(info.existingLastSeenAt)
        XCTAssertNil(info.runnerId)
        XCTAssertNil(info.expiresAt)
    }

    // MARK: the presses

    func testDenyPostsItsOwnRouteBesideApprove() async throws {
        let seen = DeviceEnrollmentSeenRequests()
        DeviceEnrollmentURLProtocol.handler = { request in
            seen.record(request)
            return (201, Data(#"{"ok":true,"name":"devbox"}"#.utf8))
        }
        try await client().denyDevice(userCode: "ABCDE-FGH23")
        try await client().approveDevice(userCode: "ABCDE-FGH23")
        XCTAssertEqual(seen.lines, ["POST /api/runners/device/ABCDE-FGH23/deny",
                                    "POST /api/runners/device/ABCDE-FGH23/approve"])
    }

    func testARefusedDecisionIsSaidInTheServersWords() async {
        DeviceEnrollmentURLProtocol.handler = { _ in
            (409, Data(#"{"code":"DEVICE_ENROLLMENT_DECIDED","message":"This registration request was already approved"}"#.utf8))
        }
        do {
            try await client().denyDevice(userCode: "ABCDE-FGH23")
            XCTFail("a refused denial went through")
        } catch {
            XCTAssertEqual(APIClient.failureReason(error), "This registration request was already approved")
            XCTAssertEqual(APIClient.refusalCode(error), "DEVICE_ENROLLMENT_DECIDED")
        }
    }

    // MARK: the words

    /// The notice under a request of a name already on the account, as the web's /enroll page words it:
    /// "Last online …. " only when the server says when that runner last checked in.
    func testTheSameNamesNoticeSaysWhenThatRunnerWasLastOnlineOnlyWhenTheServerSays() throws {
        let now = try XCTUnwrap(RelativeTime.parse("2026-10-28T12:00:00.000Z"))
        let detail = RunnerPageCopy.RUNNER_DEVICE_NAME_TAKEN_DETAIL
        let seen = try decode(#"{"name":"devbox","nameConflict":true,"existingLastSeenAt":"2026-10-25T11:00:00.000Z"}"#)
        XCTAssertEqual(RunnerPageFormat.deviceNameTakenDetail(seen, now: now), "Last online 3d ago. \(detail)")
        let recent = try decode(#"{"name":"devbox","nameConflict":true,"existingLastSeenAt":"2026-10-28T11:55:00.000Z"}"#)
        XCTAssertEqual(RunnerPageFormat.deviceNameTakenDetail(recent, now: now), "Last online 5m ago. \(detail)")
        let never = try decode(#"{"name":"devbox","nameConflict":true,"existingLastSeenAt":null}"#)
        XCTAssertEqual(RunnerPageFormat.deviceNameTakenDetail(never, now: now), detail)
    }

    func testTheSentencesAreThePagesOwn() {
        XCTAssertEqual(RunnerPageCopy.RUNNER_DEVICE_APPROVED, "Machine registered")
        XCTAssertEqual(RunnerPageCopy.runnerDeviceApprovedDetail(name: "devbox"),
                       "devbox is on your account. Go back to the terminal — it finishes setting up by itself.")
        XCTAssertEqual(RunnerPageCopy.RUNNER_DEVICE_DENIED, "Request denied")
        XCTAssertEqual(RunnerPageCopy.RUNNER_DEVICE_DENIED_DETAIL,
                       "Nothing was added to your account. orbit register in that terminal stops and says the request was denied.")
        XCTAssertEqual(RunnerPageCopy.runnerDeviceNameTaken(name: "devbox"), "\"devbox\" is already on your account")
        XCTAssertEqual(RunnerPageCopy.RUNNER_DEVICE_NAME_TAKEN_DETAIL,
                       "Approving gives it a new credential and the old one stops working; its workspaces and history stay. "
                           + "A different computer with the same name? Deny, then run orbit register --name <new-name> on it.")
        XCTAssertEqual(RunnerPageCopy.RUNNER_REREGISTER, "Re-register")
        XCTAssertEqual(RunnerPageCopy.RUNNER_DENY, "Deny")
    }
}

/// The method and path of each request the stub was handed, in order.
private final class DeviceEnrollmentSeenRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []

    func record(_ request: URLRequest) {
        lock.lock()
        seen.append("\(request.httpMethod ?? "?") \(request.url?.path ?? "")")
        lock.unlock()
    }

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }
}
