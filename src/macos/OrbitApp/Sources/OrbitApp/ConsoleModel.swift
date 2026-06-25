import Foundation
import Observation
import OrbitKit

struct PendingAttachment: Identifiable, Equatable, Sendable {
    let id: String
    let filename: String
}

/// Drives one open session: the reconnecting SSE consume loop (folded through the verified
/// `TranscriptReducer`) plus the interactive actions — send/queue/interrupt, tool approvals,
/// and worktree commit/merge. All decision logic lives in OrbitKit (ComposerLogic / Approvals);
/// this is the orchestration + UI-facing state.
@MainActor
@Observable
final class ConsoleModel {
    let sessionID: String
    private(set) var state = TranscriptState()
    private(set) var connected = false

    // composer
    var composerText = ""
    var shellMode = false
    var modelID = AgentDefaults.defaultModelID
    var permissionMode: PermissionMode = .default
    private(set) var pendingAttachments: [PendingAttachment] = []
    private(set) var sending = false

    // worktree
    private(set) var diff: [FilePatch] = []
    private(set) var worktreeBusy = false

    var statusMessage: String?

    private var reducer = TranscriptReducer()
    private let stream: EventStreaming
    private let api: APIClient

    init(sessionID: String, baseURL: URL, tokenStore: TokenStore) {
        self.sessionID = sessionID
        self.api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        #if os(macOS)
        self.stream = URLSessionEventStream(baseURL: baseURL, token: { tokenStore.token(for: baseURL) })
        #else
        self.stream = MockEventStream([])
        #endif
    }

    // MARK: live stream

    func run() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                connected = true
                for try await ev in stream.events(sessionID: sessionID, sinceSeq: reducer.state.maxSeq) {
                    reducer.apply(ev)
                    state = reducer.state
                    attempt = 0
                }
                connected = false
                try? await Task.sleep(nanoseconds: 300_000_000)
            } catch is CancellationError {
                return
            } catch {
                connected = false
                attempt += 1
                if attempt > 12 { return }
                let ms = min(15_000, 500 * (1 << min(attempt, 5)))
                try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            }
        }
    }

    // MARK: composer

    var availability: SendAvailability { ComposerLogic.availability(status: state.status) }

    var canSend: Bool {
        !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sending
            && availability != .blocked
    }

    func send() async {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        let clientTurnId = UUID().uuidString
        let attachmentIds = pendingAttachments.map(\.id)

        // Optimistic bubble; reconciled by the server's `user` event (same clientTurnId).
        reducer.addOptimisticUser(clientTurnId: clientTurnId, text: text, attachmentIds: attachmentIds)
        state = reducer.state
        composerText = ""
        pendingAttachments = []

        sending = true
        defer { sending = false }
        do {
            if ComposerLogic.shouldResume(status: state.status) {
                _ = try await api.resume(sessionID: sessionID,
                                         ResumeRequest(clientTurnId: clientTurnId, content: text,
                                                       kind: shellMode ? "shell" : "message",
                                                       model: modelID, permissionMode: permissionMode.rawValue))
            } else {
                _ = try await api.sendTurn(sessionID: sessionID,
                                           ComposerLogic.makeTurn(clientTurnId: clientTurnId, text: text,
                                                                  shell: shellMode, attachmentIds: attachmentIds))
            }
        } catch {
            statusMessage = "Send failed — \(error)"
        }
    }

    func interrupt() async {
        do { try await api.interrupt(sessionID: sessionID) }
        catch { statusMessage = "Interrupt failed" }
    }

    func attach(filename: String, mimeType: String, data: Data) async {
        do {
            let id = try await api.uploadAttachment(sessionID: sessionID, filename: filename,
                                                    mimeType: mimeType, data: data)
            pendingAttachments.append(PendingAttachment(id: id, filename: filename))
        } catch {
            statusMessage = "Upload failed"
        }
    }

    func removeAttachment(_ att: PendingAttachment) {
        pendingAttachments.removeAll { $0.id == att.id }
    }

    // MARK: approvals

    func decide(_ approval: PendingApproval, behavior: ApprovalBehavior,
                answers: [String: [String]]? = nil, remember: Bool = false) async {
        var rule: PermissionRule?
        if remember, behavior == .allow, let input = approval.input {
            rule = Approvals.rememberRule(toolName: approval.toolName ?? "", input: input)
        }
        let req = ApprovalDecisionRequest(behavior: behavior, message: nil, answers: answers, rememberRule: rule)
        do { try await api.decideApproval(sessionID: sessionID, approvalID: approval.id, req) }
        catch { statusMessage = "Approval failed" }
    }

    // MARK: worktree

    func loadDiff() async {
        worktreeBusy = true
        defer { worktreeBusy = false }
        do { diff = try await api.diff(sessionID: sessionID).patches }
        catch { /* keep last */ }
    }

    func commit() async {
        worktreeBusy = true
        defer { worktreeBusy = false }
        do { try await api.commit(sessionID: sessionID); statusMessage = "Commit requested" }
        catch { statusMessage = "Commit failed" }
    }

    func merge(target: String?) async {
        worktreeBusy = true
        defer { worktreeBusy = false }
        do { try await api.merge(sessionID: sessionID, targetBranch: target); statusMessage = "Merge requested" }
        catch { statusMessage = "Merge failed" }
    }
}
