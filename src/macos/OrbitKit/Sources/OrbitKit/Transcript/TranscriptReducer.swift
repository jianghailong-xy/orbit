import Foundation

/// The folded transcript state a view renders.
public struct TranscriptState: Equatable, Sendable {
    public var items: [TranscriptItem] = []
    public var pendingApprovals: [PendingApproval] = []
    public var background: [BackgroundProc] = []
    public var status: RunStatus = .pending
    /// Durable high-water seq — the `?sinceSeq=` value to reconnect with.
    public var maxSeq: Int = 0
    public init() {}
}

/// Pure, UI-free state machine that folds the `RunEvent` stream into a `TranscriptState`.
/// This is the native port of the web `AgentView` event logic; it is the single most
/// behavior-dense piece of the client and is exercised directly by the Phase-0 tests.
///
/// Invariants:
///  - durable events (real `seq`) are deduped via `seen` and advance `maxSeq`;
///  - `text_delta`/`thinking_delta` are animation only — appended to the open bubble,
///    never deduped, never advancing `maxSeq`;
///  - `approval_*` and `background_output` ride seq 0 and bypass dedup entirely.
public struct TranscriptReducer: Sendable {
    public private(set) var state = TranscriptState()

    private var seen = Set<Int>()
    private var openAssistant: Int?     // index of the in-progress assistant bubble, if any
    private var openThinking: Int?
    private var idSeq = 0

    public init() {}

    public mutating func apply(_ ev: RunEvent) {
        if ev.type.isDurable && ev.seq > 0 {
            if seen.contains(ev.seq) { return }       // dedup replayed/duplicate durable events
            seen.insert(ev.seq)
            if ev.seq > state.maxSeq { state.maxSeq = ev.seq }
        }

        switch ev.type {
        case .textDelta:      appendAssistantDelta(str(ev, "delta") ?? str(ev, "text") ?? "")
        case .assistant:      finalizeAssistant(str(ev, "text") ?? str(ev, "content") ?? "", seq: ev.seq, turnId: ev.turnId)
        case .thinkingDelta:  appendThinkingDelta(str(ev, "delta") ?? str(ev, "text") ?? "")
        case .thinking:       finalizeThinking(str(ev, "text") ?? "", seq: ev.seq)
        case .toolUse:        openTool(ev)
        case .toolResult:     closeTool(ev)
        case .turnEnd:        endTurn(ev)
        case .user:           appendUser(ev)
        case .interrupt:      appendInterrupt(seq: ev.seq)
        case .error:          appendError(ev)
        case .approvalRequest:  upsertApproval(ev)
        case .approvalResolved: resolveApproval(ev)
        case .backgroundTask:   upsertBackground(ev)
        case .backgroundOutput: appendBackgroundOutput(ev)
        case .status, .result:  applyStatus(ev)
        case .system, .unknown: break          // lifecycle noise — no transcript item
        }
    }

    /// Show a user bubble immediately on send, before the server's `user` event echoes back.
    /// Reconciled by `clientTurnId` when that durable event arrives.
    public mutating func addOptimisticUser(clientTurnId: String, text: String, attachmentIds: [String] = []) {
        flushStreaming()
        state.items.append(.user(UserBubble(id: nextID(), text: text, attachmentIds: attachmentIds,
                                            clientTurnId: clientTurnId, pending: true)))
    }

    // MARK: - assistant / thinking streaming

    private mutating func appendAssistantDelta(_ delta: String) {
        guard !delta.isEmpty else { return }
        if let i = openAssistant, case .assistant(var b) = state.items[i] {
            b.streamingText += delta
            state.items[i] = .assistant(b)
        } else {
            state.items.append(.assistant(AssistantBubble(id: nextID(), text: "", streamingText: delta, seq: nil, turnId: nil)))
            openAssistant = state.items.count - 1
        }
    }

    private mutating func finalizeAssistant(_ full: String, seq: Int, turnId: String?) {
        if let i = openAssistant, case .assistant(var b) = state.items[i] {
            b.text = full.isEmpty ? b.streamingText : full
            b.streamingText = ""
            b.seq = seq
            b.turnId = turnId ?? b.turnId
            state.items[i] = .assistant(b)
        } else {
            state.items.append(.assistant(AssistantBubble(id: nextID(), text: full, streamingText: "", seq: seq, turnId: turnId)))
        }
        openAssistant = nil
    }

    private mutating func appendThinkingDelta(_ delta: String) {
        guard !delta.isEmpty else { return }
        if let i = openThinking, case .thinking(var b) = state.items[i] {
            b.streamingText += delta
            state.items[i] = .thinking(b)
        } else {
            state.items.append(.thinking(ThinkingBlock(id: nextID(), text: "", streamingText: delta, seq: nil)))
            openThinking = state.items.count - 1
        }
    }

    private mutating func finalizeThinking(_ full: String, seq: Int) {
        if let i = openThinking, case .thinking(var b) = state.items[i] {
            b.text = full.isEmpty ? b.streamingText : full
            b.streamingText = ""
            b.seq = seq
            state.items[i] = .thinking(b)
        } else if !full.isEmpty {
            state.items.append(.thinking(ThinkingBlock(id: nextID(), text: full, streamingText: "", seq: seq)))
        }
        openThinking = nil
    }

    /// Close any dangling streaming bubble before a structural boundary (tool/user/turn end).
    private mutating func flushStreaming() {
        if let i = openAssistant, case .assistant(var b) = state.items[i] {
            if b.text.isEmpty { b.text = b.streamingText }
            b.streamingText = ""
            state.items[i] = .assistant(b)
        }
        openAssistant = nil
        if let i = openThinking, case .thinking(var b) = state.items[i] {
            if b.text.isEmpty { b.text = b.streamingText }
            b.streamingText = ""
            state.items[i] = .thinking(b)
        }
        openThinking = nil
    }

    // MARK: - tools

    private mutating func openTool(_ ev: RunEvent) {
        flushStreaming()
        let id = str(ev, "toolUseId") ?? str(ev, "tool_use_id") ?? str(ev, "id") ?? nextID()
        let name = str(ev, "name") ?? str(ev, "toolName") ?? "tool"
        let input = ev.payload["input"] ?? .null
        state.items.append(.toolCall(ToolCard(id: id, name: name, input: input, result: nil, status: .running)))
    }

    private mutating func closeTool(_ ev: RunEvent) {
        let id = str(ev, "toolUseId") ?? str(ev, "tool_use_id") ?? str(ev, "id")
        let isError = ev.payload["isError"]?.boolValue ?? ev.payload["is_error"]?.boolValue ?? false
        let result = str(ev, "content") ?? str(ev, "result") ?? ev.payload["content"]?.asString
        for idx in stride(from: state.items.count - 1, through: 0, by: -1) {
            if case .toolCall(var card) = state.items[idx], card.result == nil, id == nil || card.id == id {
                card.result = result
                card.status = isError ? .error : .ok
                state.items[idx] = .toolCall(card)
                return
            }
        }
    }

    // MARK: - turn / user / interrupt / error

    private mutating func endTurn(_ ev: RunEvent) {
        flushStreaming()
        if let s = str(ev, "status"), let st = RunStatus(rawValue: s) {
            state.status = st
        } else {
            state.status = .awaitingInput
        }
    }

    private mutating func appendUser(_ ev: RunEvent) {
        flushStreaming()
        let cid = str(ev, "clientTurnId")
        let body = str(ev, "text") ?? str(ev, "content") ?? ""
        let atts = stringArray(ev.payload["attachmentIds"]) ?? []
        if let cid, let i = state.items.firstIndex(where: {
            if case .user(let b) = $0 { return b.clientTurnId == cid && b.pending }
            return false
        }) {
            if case .user(var b) = state.items[i] {       // reconcile optimistic bubble
                b.pending = false
                if !body.isEmpty { b.text = body }
                state.items[i] = .user(b)
            }
            return
        }
        state.items.append(.user(UserBubble(id: nextID(), text: body, attachmentIds: atts, clientTurnId: cid, pending: false)))
    }

    private mutating func appendInterrupt(seq: Int) {
        flushStreaming()
        state.items.append(.interrupt(id: nextID(), seq: seq))
        state.status = .interrupted
    }

    private mutating func appendError(_ ev: RunEvent) {
        let msg = str(ev, "message") ?? str(ev, "error") ?? str(ev, "text") ?? "error"
        state.items.append(.error(id: nextID(), message: msg))
    }

    // MARK: - approvals (live-only; durable truth is GET /approvals)

    private mutating func upsertApproval(_ ev: RunEvent) {
        let id = str(ev, "id") ?? str(ev, "approvalId") ?? nextID()
        let appr = PendingApproval(id: id, kind: approvalKind(ev),
                                   toolName: str(ev, "toolName") ?? str(ev, "name"),
                                   input: ev.payload["input"])
        if let i = state.pendingApprovals.firstIndex(where: { $0.id == id }) {
            state.pendingApprovals[i] = appr
        } else {
            state.pendingApprovals.append(appr)
        }
    }

    private mutating func resolveApproval(_ ev: RunEvent) {
        if let id = str(ev, "id") ?? str(ev, "approvalId") { removeApproval(id: id) }
    }

    /// Merge durable pending approvals fetched via REST — the source of truth on (re)connect,
    /// since `approval_request` nudges ride seq 0 and are never replayed. Add-only (by id) so a
    /// live nudge already folded in is neither duplicated nor clobbered.
    public mutating func seedApprovals(_ approvals: [PendingApproval]) {
        for appr in approvals where !state.pendingApprovals.contains(where: { $0.id == appr.id }) {
            state.pendingApprovals.append(appr)
        }
    }

    /// Drop a pending approval by id. The SSE `approval_resolved` echoes a human decision, but
    /// the UI also removes optimistically on submit to keep the card snappy.
    public mutating func removeApproval(id: String) {
        state.pendingApprovals.removeAll { $0.id == id }
    }

    private func approvalKind(_ ev: RunEvent) -> PendingApproval.Kind {
        Approvals.kind(toolName: str(ev, "toolName") ?? str(ev, "name"))
    }

    // MARK: - background processes

    private mutating func upsertBackground(_ ev: RunEvent) {
        let id = str(ev, "id") ?? str(ev, "taskId") ?? nextID()
        let status = str(ev, "status") ?? "running"
        let command = str(ev, "command")
        if let i = state.background.firstIndex(where: { $0.id == id }) {
            state.background[i].status = status
            if let command { state.background[i].command = command }
        } else {
            state.background.append(BackgroundProc(id: id, command: command, status: status, outputTail: ""))
        }
    }

    private mutating func appendBackgroundOutput(_ ev: RunEvent) {
        guard let id = str(ev, "id") ?? str(ev, "taskId") else { return }
        let chunk = str(ev, "output") ?? str(ev, "chunk") ?? str(ev, "text") ?? ""
        guard !chunk.isEmpty else { return }
        if let i = state.background.firstIndex(where: { $0.id == id }) {
            state.background[i].outputTail += chunk
        } else {
            state.background.append(BackgroundProc(id: id, command: nil, status: "running", outputTail: chunk))
        }
    }

    private mutating func applyStatus(_ ev: RunEvent) {
        if let s = str(ev, "status"), let st = RunStatus(rawValue: s) { state.status = st }
    }

    // MARK: - helpers

    private mutating func nextID() -> String { idSeq += 1; return "i\(idSeq)" }
    private func str(_ ev: RunEvent, _ key: String) -> String? { ev.payload[key]?.stringValue }
    private func stringArray(_ v: JSONValue?) -> [String]? {
        if case .array(let a)? = v { return a.compactMap { $0.stringValue } }
        return nil
    }
}
