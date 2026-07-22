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

/// Async REST client for the Orbit control plane (`/api`). Short-lived JWT bearer; on a 401 it makes
/// one single-flight `POST /auth/refresh` (via the shared `SessionRefresher`) and retries the request
/// once. `.unauthorized` surfaces only when that refresh fails — the app then prompts re-login.
///
/// Uses `dataTask` + a continuation rather than `data(for:)` so it compiles on Linux
/// Foundation too; the surface is plain `async`/`await`.
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    private let tokenStore: TokenStore
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(baseURL: URL, tokenStore: TokenStore, session: URLSession = .orbitREST) {
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
        tokenStore.setRefreshToken(res.refreshToken, for: baseURL)
        return res
    }

    /// Revoke a refresh token server-side on sign-out. Best-effort (`try?`); takes the token
    /// explicitly so the caller can clear local storage immediately without racing this call.
    public func revokeRefreshToken(_ refreshToken: String) async {
        _ = try? await postRaw("auth/logout", body: RefreshRequest(refreshToken: refreshToken))
    }

    public func me() async throws -> User { try await get("users/me") }
    public func updatePreferences(_ req: UpdatePreferencesRequest) async throws -> User {
        try await patch("users/me/preferences", body: req)
    }
    public func changePassword(_ req: ChangePasswordRequest) async throws {
        _ = try await postRaw("auth/change-password", body: req)
    }

    // MARK: push notifications (iOS)

    /// Register this device's APNs token so the server can push "needs your reply" alerts.
    public func registerDeviceToken(_ req: DeviceTokenRequest) async throws {
        _ = try await postRaw("push/register", body: req)
    }

    /// Drop this device's token (e.g. on sign-out) so it stops receiving pushes.
    public func unregisterDeviceToken(token: String) async throws {
        _ = try await postRaw("push/unregister", body: ["token": token])
    }

    // MARK: admin (role-gated; non-admins get 403)
    public func adminUsers() async throws -> [User] { try await get("admin/users") }
    public func createUser(_ req: CreateUserRequest) async throws -> CreateUserResult { try await post("admin/users", body: req) }
    public func setUserRole(_ id: String, role: String) async throws -> User { try await patch("admin/users/\(id)/role", body: UpdateRoleRequest(role: role)) }
    public func deleteUser(_ id: String) async throws { try await deleteRaw("admin/users/\(id)") }

    // MARK: sessions

    public func listSessions(view: String = "active", runnerId: String? = nil) async throws -> [Session] {
        var q = [URLQueryItem(name: "view", value: view)]
        if let runnerId { q.append(URLQueryItem(name: "runnerId", value: runnerId)) }
        return try await get("sessions", query: q)
    }

    public func session(_ id: String) async throws -> Session { try await get("sessions/\(id)") }

    /// GET /sessions/:id decoded to the worktree-status-bar detail (branch, changedFiles, merge /
    /// commit status, targets). Same endpoint as `session(_:)`, but decodes the richer worktree
    /// fields the list-shaped `Session` drops.
    public func sessionDetail(_ id: String) async throws -> SessionDetail { try await get("sessions/\(id)") }

    /// A page of a session's persisted events for tail-first loading (web parity): `tail=N` returns
    /// the newest N (initial paint — open a long session at the latest message instead of replaying
    /// its whole history over SSE), `before=<seq>&limit=N` the N events just older than a seq
    /// (scroll-up). Events come back chronological (seq ascending).
    public func eventPage(sessionID: String, tail: Int? = nil,
                          before: Int? = nil, limit: Int? = nil) async throws -> EventPage {
        var q: [URLQueryItem] = []
        if let tail { q.append(URLQueryItem(name: "tail", value: String(tail))) }
        if let before { q.append(URLQueryItem(name: "before", value: String(before))) }
        if let limit { q.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await get("sessions/\(sessionID)/events/page", query: q)
    }

    /// The session's complete background-shell list (GET /sessions/:id/background): every
    /// Bash(run_in_background) it ever launched, with output recovered from the agent's Read polls,
    /// derived server-side over ALL persisted events. Seeds the tray with the full history the loaded
    /// event window can't hold (older launches) — and the output for agent shells whose live tail is
    /// broadcast-only (never persisted). Live SSE `background_*` events then overlay this. Web parity:
    /// `getBackgroundShells` merged with the live-derived overlay in BackgroundShellsTray.
    public func backgroundShells(sessionID: String) async throws -> [BgShellDTO] {
        try await get("sessions/\(sessionID)/background")
    }

    public func createSession(_ req: CreateSessionRequest) async throws -> Session {
        try await post("sessions", body: req)
    }

    public func sendTurn(sessionID: String, _ req: SessionTurnRequest) async throws -> TurnAccepted {
        try await post("sessions/\(sessionID)/turns", body: req)
    }

    public func interrupt(sessionID: String) async throws {
        _ = try await postRaw("sessions/\(sessionID)/interrupt", body: Optional<Empty>.none)
    }

    // Lifecycle: gracefully end (PARKED), archive/restore (hide/unhide), hard delete. After any
    // of these the caller refetches the list (`view=active|archived|deleted`).
    public func endSession(_ id: String) async throws { _ = try await postRaw("sessions/\(id)/end", body: Optional<Empty>.none) }
    public func archiveSession(_ id: String) async throws { _ = try await postRaw("sessions/\(id)/archive", body: Optional<Empty>.none) }
    public func restoreSession(_ id: String) async throws { _ = try await postRaw("sessions/\(id)/restore", body: Optional<Empty>.none) }
    public func deleteSession(_ id: String) async throws { try await deleteRaw("sessions/\(id)") }
    /// Hard-delete a trashed session and all its data — irreversible (the Trash tab's "Delete
    /// Permanently"). Server: `DELETE /sessions/:id/purge`.
    public func purgeSession(_ id: String) async throws { try await deleteRaw("sessions/\(id)/purge") }
    /// Pin/unpin: personal ordering that floats the session to the top of every list (POST to set,
    /// DELETE to clear). After either the caller refetches the list to pick up the new order.
    public func pinSession(_ id: String) async throws { _ = try await postRaw("sessions/\(id)/pin", body: Optional<Empty>.none) }
    public func unpinSession(_ id: String) async throws { try await deleteRaw("sessions/\(id)/pin") }

    // MARK: session tags (personal colored labels)

    /// The caller's tag library — the 7 seeded system tags plus any custom ones, picker-ordered
    /// (system first). An older server without the endpoint 404s; the caller treats that as "no tags".
    public func listSessionTags() async throws -> [SessionTag] { try await get("session-tags") }
    /// Create a custom tag (name + palette color); returns the created tag.
    public func createSessionTag(name: String, color: String) async throws -> SessionTag {
        try await post("session-tags", body: CreateSessionTagRequest(name: name, color: color))
    }
    /// Rename and/or recolor a custom tag (system tags are rejected server-side); returns the updated tag.
    public func updateSessionTag(_ id: String, name: String? = nil, color: String? = nil) async throws -> SessionTag {
        try await patch("session-tags/\(id)", body: UpdateSessionTagRequest(name: name, color: color))
    }
    /// Delete a custom tag; its links to sessions cascade away server-side.
    public func deleteSessionTag(_ id: String) async throws { try await deleteRaw("session-tags/\(id)") }
    /// Replace the full set of tags applied to a session; returns the session's new tag set.
    @discardableResult
    public func setSessionTags(_ sessionID: String, tagIDs: [String]) async throws -> [SessionTag] {
        try await put("sessions/\(sessionID)/tags", body: SetSessionTagsRequest(tagIds: tagIDs))
    }
    /// Share/unshare: mint (or clear) a public read-only link to this session's transcript, served
    /// at `<baseURL>/s/<shareToken>` with no auth. `enableShare` is idempotent server-side (returns
    /// the existing token if already shared); `disableShare` makes any live link 404 immediately.
    public func enableShare(_ id: String) async throws -> ShareInfo { try await postEmpty("sessions/\(id)/share") }
    public func disableShare(_ id: String) async throws { try await deleteRaw("sessions/\(id)/share") }

    // MARK: approvals

    public func approvals(sessionID: String, status: String = "PENDING") async throws -> [ApprovalInfo] {
        try await get("sessions/\(sessionID)/approvals", query: [URLQueryItem(name: "status", value: status)])
    }

    public func decideApproval(sessionID: String, approvalID: String, _ req: ApprovalDecisionRequest) async throws {
        _ = try await postRaw("sessions/\(sessionID)/approvals/\(approvalID)/decision", body: req)
    }

    // MARK: agents / runners

    public func agents() async throws -> [Agent] { try await get("agents") }
    public func agent(_ id: String) async throws -> Agent { try await get("agents/\(id)") }
    public func createAgent(_ req: CreateAgentRequest) async throws -> Agent { try await post("agents", body: req) }
    public func updateAgent(_ id: String, _ req: UpdateAgentRequest) async throws -> Agent { try await patch("agents/\(id)", body: req) }
    public func deleteAgent(_ id: String) async throws { try await deleteRaw("agents/\(id)") }
    public func reorderAgents(_ ids: [String]) async throws { try await postRaw("agents/reorder", body: ReorderAgentsRequest(ids: ids)) }

    // MARK: tasks
    public func tasks() async throws -> [TaskItem] { try await get("tasks") }
    public func task(_ id: String) async throws -> TaskItem { try await get("tasks/\(id)") }
    public func createTask(_ req: CreateTaskRequest) async throws -> TaskItem { try await post("tasks", body: req) }
    public func updateTask(_ id: String, _ req: UpdateTaskRequest) async throws -> TaskItem { try await patch("tasks/\(id)", body: req) }
    public func deleteTask(_ id: String) async throws { try await deleteRaw("tasks/\(id)") }
    public func executeTask(_ id: String) async throws { try await postRaw("tasks/\(id)/execute", body: Optional<Empty>.none) }
    public func batchExecute(_ req: BatchExecuteRequest) async throws { try await postRaw("tasks/batch-execute", body: req) }
    public func batchStop(_ req: BatchStopRequest) async throws { try await postRaw("tasks/batch-stop", body: req) }
    public func batchAssign(_ req: BatchAssignRequest) async throws { try await postRaw("tasks/batch-assign", body: req) }
    public func addTaskComment(taskID: String, _ req: CreateTaskCommentRequest) async throws { try await postRaw("tasks/\(taskID)/comments", body: req) }
    public func removeTaskComment(taskID: String, commentID: String) async throws { try await deleteRaw("tasks/\(taskID)/comments/\(commentID)") }
    public func addTaskDependency(taskID: String, _ req: AddDependencyRequest) async throws { try await postRaw("tasks/\(taskID)/dependencies", body: req) }
    public func removeTaskDependency(taskID: String, dependsOnTaskID: String) async throws { try await deleteRaw("tasks/\(taskID)/dependencies/\(dependsOnTaskID)") }

    /// Control-plane–configured model providers (GET /api/providers): enabled only, de-sensitized
    /// (no key/baseUrl). Merged into the composer/agent-editor pickers alongside claude/codex.
    public func providers() async throws -> [ConfiguredProvider] { try await get("providers") }

    public func runners() async throws -> [Runner] { try await get("runners") }
    public func runner(_ id: String) async throws -> Runner { try await get("runners/\(id)") }
    public func updateRunner(_ id: String, _ req: UpdateRunnerRequest) async throws -> Runner { try await patch("runners/\(id)", body: req) }
    public func rotateRunnerToken(_ id: String) async throws -> RotateTokenResponse { try await postEmpty("runners/\(id)/rotate-token") }
    public func deleteRunner(_ id: String) async throws { try await deleteRaw("runners/\(id)") }
    public func createEnrollmentToken(_ req: CreateEnrollmentTokenRequest) async throws -> EnrollmentTokenInfo { try await post("runners/enrollment-tokens", body: req) }
    public func enrollmentTokens() async throws -> [EnrollmentTokenInfo] { try await get("runners/enrollment-tokens") }

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

    /// Fetch an attachment's raw bytes (GET /attachments/:id). Bearer-guarded, so an `<img src>`
    /// can't carry the token — the transcript fetches the blob and decodes it client-side.
    public func downloadAttachment(_ id: String) async throws -> Data {
        try await send(makeRequest("attachments/\(id)", method: "GET", body: Optional<Empty>.none))
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

    private func patch<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        let data = try await send(makeRequest(path, method: "PATCH", body: body))
        return try decoder.decode(T.self, from: data)
    }

    private func put<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        let data = try await send(makeRequest(path, method: "PUT", body: body))
        return try decoder.decode(T.self, from: data)
    }

    private func deleteRaw(_ path: String) async throws {
        _ = try await send(makeRequest(path, method: "DELETE", body: Optional<Empty>.none))
    }

    /// POST with no request body but a decoded response (e.g. rotate-token).
    private func postEmpty<T: Decodable>(_ path: String) async throws -> T {
        let data = try await send(makeRequest(path, method: "POST", body: Optional<Empty>.none))
        return try decoder.decode(T.self, from: data)
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

    private func send(_ original: URLRequest) async throws -> Data {
        var req = original
        var didRefresh = false
        while true {
            let (data, status) = try await rawSend(req)
            switch status {
            case 200..<300:
                return data
            case 401:
                // Try one single-flight refresh, then retry the request with the fresh token.
                // `.unauthorized` (→ re-login) surfaces only if that refresh also fails.
                if !didRefresh {
                    let refresher = await SessionRefresherRegistry.shared.refresher(
                        baseURL: baseURL, tokenStore: tokenStore, session: session)
                    if await refresher.refresh() {
                        didRefresh = true
                        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
                        continue
                    }
                }
                throw APIError.unauthorized
            default:
                throw APIError.http(status: status, body: String(data: data, encoding: .utf8))
            }
        }
    }

    /// Execute a request and hand back the raw body + HTTP status; status interpretation (including
    /// the 401 refresh-retry) lives in `send`.
    private func rawSend(_ req: URLRequest) async throws -> (Data, Int) {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Data, Int), Error>) in
            let task = session.dataTask(with: req) { data, response, error in
                if let error { cont.resume(throwing: error); return }
                guard let http = response as? HTTPURLResponse, let data else {
                    cont.resume(throwing: APIError.invalidResponse); return
                }
                cont.resume(returning: (data, http.statusCode))
            }
            task.resume()
        }
    }
}
