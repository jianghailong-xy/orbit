import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum APIError: Error, Equatable {
    case http(status: Int, body: String?)
    case unauthorized
    case invalidResponse
    case notConfigured
}

/// Async REST client for the Orbit control plane (`/api`). JWT bearer; 401 surfaces as
/// `.unauthorized` so the app can prompt re-login (tokens last 7 days, no refresh endpoint).
///
/// Uses `dataTask` + a continuation rather than `data(for:)` so it compiles on Linux
/// Foundation too; the surface is plain `async`/`await`.
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    private let tokenStore: TokenStore
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(baseURL: URL, tokenStore: TokenStore, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.session = session
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    private var token: String? { tokenStore.token(for: baseURL) }

    // MARK: auth

    public func setupStatus() async throws -> SetupStatus {
        try await get("auth/setup-status")
    }

    public func login(email: String, password: String) async throws -> LoginResponse {
        let res: LoginResponse = try await post("auth/login", body: LoginRequest(email: email, password: password))
        tokenStore.setToken(res.accessToken, for: baseURL)
        return res
    }

    public func me() async throws -> User { try await get("users/me") }

    // MARK: sessions

    public func listSessions(view: String = "active", runnerId: String? = nil) async throws -> [Session] {
        var q = [URLQueryItem(name: "view", value: view)]
        if let runnerId { q.append(URLQueryItem(name: "runnerId", value: runnerId)) }
        return try await get("sessions", query: q)
    }

    public func session(_ id: String) async throws -> Session { try await get("sessions/\(id)") }

    public func createSession(_ req: CreateSessionRequest) async throws -> Session {
        try await post("sessions", body: req)
    }

    public func sendTurn(sessionID: String, _ req: SessionTurnRequest) async throws -> TurnAccepted {
        try await post("sessions/\(sessionID)/turns", body: req)
    }

    public func interrupt(sessionID: String) async throws {
        _ = try await postRaw("sessions/\(sessionID)/interrupt", body: Optional<Empty>.none)
    }

    // MARK: approvals

    public func approvals(sessionID: String, status: String = "PENDING") async throws -> [ApprovalInfo] {
        try await get("sessions/\(sessionID)/approvals", query: [URLQueryItem(name: "status", value: status)])
    }

    public func decideApproval(sessionID: String, approvalID: String, _ req: ApprovalDecisionRequest) async throws {
        _ = try await postRaw("sessions/\(sessionID)/approvals/\(approvalID)/decision", body: req)
    }

    // MARK: agents / runners

    public func agents() async throws -> [Agent] { try await get("agents") }
    public func runners() async throws -> [Runner] { try await get("runners") }
    public func runner(_ id: String) async throws -> Runner { try await get("runners/\(id)") }

    // MARK: runner enrollment (Phase 4 — one-app device flow)

    /// Start a device enrollment (acts as the would-be runner; this endpoint needs no auth).
    public func deviceStart(_ req: DeviceStartRequest) async throws -> DeviceStartResponse {
        try await post("runner/device/start", body: req)
    }

    /// Poll for the enrollment result; `approved` carries the runner credential.
    public func devicePoll(deviceCode: String) async throws -> DevicePollResponse {
        try await post("runner/device/poll", body: ["deviceCode": deviceCode])
    }

    /// Approve a device enrollment as the signed-in user (JWT) — lets the app enroll its own
    /// host runner without a browser round-trip.
    public func approveDevice(userCode: String) async throws {
        _ = try await postRaw("runners/device/\(userCode)/approve", body: Optional<Empty>.none)
    }

    // MARK: turns / lifecycle (Phase 2)

    public func withdrawTurn(sessionID: String, turnId: String) async throws {
        _ = try await send(makeRequest("sessions/\(sessionID)/turns/\(turnId)", method: "DELETE",
                                       body: Optional<Empty>.none))
    }

    public func resume(sessionID: String, _ req: ResumeRequest) async throws -> TurnAccepted {
        try await post("sessions/\(sessionID)/resume", body: req)
    }

    public func updateConfig(sessionID: String, _ req: ConfigUpdateRequest) async throws {
        _ = try await send(makeRequest("sessions/\(sessionID)/config", method: "PATCH", body: req))
    }

    // MARK: worktree

    public func diff(sessionID: String) async throws -> SessionDiff {
        try await get("sessions/\(sessionID)/diff")
    }

    public func refreshDiff(sessionID: String) async throws {
        _ = try await postRaw("sessions/\(sessionID)/diff/refresh", body: Optional<Empty>.none)
    }

    public func commit(sessionID: String) async throws {
        _ = try await postRaw("sessions/\(sessionID)/commit", body: Optional<Empty>.none)
    }

    public func merge(sessionID: String, targetBranch: String?) async throws {
        _ = try await postRaw("sessions/\(sessionID)/merge", body: MergeRequest(targetBranch: targetBranch))
    }

    // MARK: attachments

    @discardableResult
    public func uploadAttachment(sessionID: String?, filename: String, mimeType: String,
                                 data: Data) async throws -> String {
        let boundary = "orbit.\(UUID().uuidString)"
        let query = sessionID.map { [URLQueryItem(name: "sessionId", value: $0)] } ?? []
        var req = try makeRequest("attachments", method: "POST", query: query, body: Optional<Empty>.none)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = Multipart.body(boundary: boundary, fieldName: "file",
                                      filename: filename, mimeType: mimeType, fileData: data)
        let respData = try await send(req)
        return try decoder.decode(AttachmentRef.self, from: respData).id
    }

    // MARK: - request plumbing

    private struct Empty: Codable {}

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let data = try await send(makeRequest(path, method: "GET", query: query, body: Optional<Empty>.none))
        return try decoder.decode(T.self, from: data)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        let data = try await send(makeRequest(path, method: "POST", body: body))
        return try decoder.decode(T.self, from: data)
    }

    @discardableResult
    private func postRaw<B: Encodable>(_ path: String, body: B?) async throws -> Data {
        try await send(makeRequest(path, method: "POST", body: body))
    }

    private func makeRequest<B: Encodable>(_ path: String, method: String,
                                           query: [URLQueryItem] = [], body: B?) throws -> URLRequest {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/\(path)"), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(body)
        }
        return req
    }

    private func send(_ req: URLRequest) async throws -> Data {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            let task = session.dataTask(with: req) { data, response, error in
                if let error { cont.resume(throwing: error); return }
                guard let http = response as? HTTPURLResponse, let data else {
                    cont.resume(throwing: APIError.invalidResponse); return
                }
                switch http.statusCode {
                case 200..<300: cont.resume(returning: data)
                case 401:       cont.resume(throwing: APIError.unauthorized)
                default:        cont.resume(throwing: APIError.http(status: http.statusCode,
                                                                    body: String(data: data, encoding: .utf8)))
                }
            }
            task.resume()
        }
    }
}
