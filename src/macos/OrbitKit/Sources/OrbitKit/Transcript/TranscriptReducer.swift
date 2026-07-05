import Foundation

/// The folded transcript state a view renders.
public struct TranscriptState: Equatable, Sendable, Codable {
    public var items: [TranscriptItem] = []
    public var pendingApprovals: [PendingApproval] = []
    public var background: [BackgroundProc] = []
    /// Messages sent while a turn was already in flight. Held OUT of `items` — which is still
    /// growing with the running turn's output — and rendered after the transcript, so a mid-turn
    /// send isn't sandwiched into the middle of the streaming reply. Moved into `items` (as a real
    /// row, in order) when the durable `user` event for the turn lands. Mirrors web's separate
    /// `queued` state (see `addOptimisticUser`).
    public var queued: [UserBubble] = []
    public var status: RunStatus = .pending
    /// Durable high-water seq — the `?sinceSeq=` value to reconnect with.
    public var maxSeq: Int = 0
    public init() {}

    // Tolerant decode so snapshots written before `queued` existed still rehydrate (the key just
    // defaults to empty) instead of discarding the whole cached session; the other fields keep
    // their prior strictness. `encode(to:)` stays synthesized from these keys.
    enum CodingKeys: String, CodingKey { case items, pendingApprovals, background, queued, status, maxSeq }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decode([TranscriptItem].self, forKey: .items)
        pendingApprovals = try c.decode([PendingApproval].self, forKey: .pendingApprovals)
        background = try c.decode([BackgroundProc].self, forKey: .background)
        queued = (try? c.decodeIfPresent([UserBubble].self, forKey: .queued)) ?? []
        status = try c.decode(RunStatus.self, forKey: .status)
        maxSeq = try c.decode(Int.self, forKey: .maxSeq)
    }
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
///
/// `Codable` so the entire reducer — including the dedup set, the open-bubble cursors, and the
/// synthetic id counter — can be snapshotted to disk and rehydrated verbatim. Restoring the whole
/// reducer (not just `state`) makes a resumed `?sinceSeq=maxSeq` stream behave bit-for-bit as if
/// the reducer had never been torn down: no duplicate bubbles, no id collisions. The synthesized
/// conformance is module-internal (only `FileTranscriptStore` round-trips it).
public struct TranscriptReducer: Sendable, Codable {
    public private(set) var state = TranscriptState()

    private var seen = Set<Int>()
    private var openAssistant: Int?     // index of the in-progress assistant bubble, if any
    private var openThinking: Int?
    private var idSeq = 0
    /// Command text of each `Bash(run_in_background)` launch, keyed by its tool_use id. The
    /// `background_*` events never carry the command, so the tray title is correlated from the
    /// launch captured here — matching web's `deriveBackgroundShells`, which titles the row
    /// `description ?? command`. Transient: rebuilt from replayed tool_use events and excluded
    /// from the persisted keys below, so snapshots written before it existed still decode.
    private var bgLaunch: [String: String] = [:]

    private enum CodingKeys: String, CodingKey { case state, seen, openAssistant, openThinking, idSeq }

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
        case .backgroundOutput: applyBackgroundOutput(ev)
        case .status, .result:  applyStatus(ev)
        case .system, .unknown: break          // lifecycle noise — no transcript item
        }
    }

    /// Show a user bubble immediately on send, before the server's `user` event echoes back.
    /// Reconciled by the server `turnId` (tagged via `setOptimisticTurnId` once POST /turns
    /// returns) — or by `clientTurnId` if the server ever echoes it — when that durable event arrives.
    ///
    /// A `queued` send (a turn is already in flight) is held in `state.queued`, NOT appended to
    /// `items`: the running turn is still streaming into `items`, so an inline bubble would be
    /// sandwiched mid-reply — its continued `text_delta`/tool output would land after it. Rendered
    /// after the transcript and reconciled out of the queue by `appendUser` once the runner leases
    /// it. An idle send has no in-flight output to split, so it goes straight into `items`.
    public mutating func addOptimisticUser(clientTurnId: String, text: String,
                                           attachments: [TurnAttachment] = [], queued: Bool = false) {
        let bubble = UserBubble(id: nextID(), text: text, attachments: attachments,
                                clientTurnId: clientTurnId, turnId: nil, pending: true, queued: queued)
        if queued {
            state.queued.append(bubble)
        } else {
            flushStreaming()
            state.items.append(.user(bubble))
        }
    }

    /// Tag the optimistic bubble (found by its `clientTurnId`) with the server-assigned `turnId`
    /// from the POST /turns (or /resume) response. The durable `user` event echoes `turnId`, not
    /// `clientTurnId`, so without this tag it wouldn't reconcile and the bubble would duplicate.
    /// No-op if the bubble was already reconciled (no longer pending) or never added.
    public mutating func setOptimisticTurnId(clientTurnId: String, turnId: String) {
        // A queued send lives in `state.queued`, an idle one in `state.items` — tag whichever holds it.
        if let i = state.queued.firstIndex(where: { $0.clientTurnId == clientTurnId && $0.pending }) {
            state.queued[i].turnId = turnId
            return
        }
        guard let i = state.items.firstIndex(where: {
            if case .user(let b) = $0 { return b.clientTurnId == clientTurnId && b.pending }
            return false
        }), case .user(var b) = state.items[i] else { return }
        b.turnId = turnId
        state.items[i] = .user(b)
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
        // A background shell launch: remember its command so the (command-less) background_* events
        // can title the tray row. Prefer the human `description`, like web does.
        if name == "Bash", input["run_in_background"]?.boolValue == true {
            let desc = input["description"]?.stringValue
            if let label = (desc?.isEmpty == false ? desc : nil) ?? input["command"]?.stringValue {
                bgLaunch[id] = label
            }
        }
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
        // The runner echoes `attachments` (an array of `{id, mime, name}`) on the durable user
        // event, NOT `attachmentIds` — parse those so the bubble can render images / file chips
        // after a reload (web reads the same field).
        let atts = attachments(ev.payload["attachments"])
        // The runner just leased a queued send: drop its placeholder from `state.queued` — this
        // durable event becomes its real transcript row below, in order (web parity). Matched by the
        // server `turnId` we tagged onto it, or an echoed `clientTurnId`.
        state.queued.removeAll { q in
            (cid != nil && q.clientTurnId == cid) || (ev.turnId != nil && q.turnId == ev.turnId)
        }
        // Reconcile a pending optimistic bubble: prefer the server's `clientTurnId` echo (if it
        // ever sends one), else the server-assigned `turnId` we tagged onto the bubble from the
        // POST response — the runner echoes `turnId`, not `clientTurnId` (web parity).
        if let i = state.items.firstIndex(where: {
            guard case .user(let b) = $0, b.pending else { return false }
            if let cid, b.clientTurnId == cid { return true }
            if let tid = ev.turnId, b.turnId == tid { return true }
            return false
        }) {
            if case .user(var b) = state.items[i] {       // reconcile optimistic bubble
                b.pending = false
                if !body.isEmpty { b.text = body }
                if !atts.isEmpty { b.attachments = atts }   // durable refs carry mime; keep ids if absent
                b.ts = ev.ts ?? b.ts
                state.items[i] = .user(b)
            }
            return
        }
        state.items.append(.user(UserBubble(id: nextID(), text: body, attachments: atts, ts: ev.ts,
                                            clientTurnId: cid, turnId: ev.turnId, pending: false)))
    }

    private mutating func appendInterrupt(seq: Int) {
        flushStreaming()
        state.items.append(.interrupt(id: nextID(), seq: seq))
        state.status = .interrupted
        // An interrupt drops still-queued follow-ups server-side — they never get a durable `user`
        // event to reconcile them — so clear the local queue to match (web parity).
        state.queued.removeAll()
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

    /// Reconcile pending approvals against the REST source of truth (GET /approvals?status=PENDING),
    /// the authoritative list on (re)connect since the seq-0 `approval_request`/`approval_resolved`
    /// nudges are live-only and never replayed. Any approval we *already knew about before the fetch*
    /// (`knownBefore`) that the server no longer lists was resolved elsewhere — e.g. answered on the
    /// web client while this socket was suspended/dropped, so its `approval_resolved` never reached
    /// us — so drop it. Approvals absent from `knownBefore` are live nudges that arrived via SSE
    /// *during* the fetch: keep them even when the (older) REST snapshot predates them, so a
    /// concurrent request isn't clobbered. Then add any listed approval we don't already hold.
    /// Mirrors the web, which refetches `listApprovals` on session open and replaces its approvals
    /// state wholesale.
    public mutating func reconcileApprovals(_ approvals: [PendingApproval], knownBefore: Set<String>) {
        let listed = Set(approvals.map(\.id))
        state.pendingApprovals.removeAll { knownBefore.contains($0.id) && !listed.contains($0.id) }
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

    // Runner keys background events by `shellId` (Claude's shell id) and `toolUseId` (the launching
    // Bash call) — NOT `id`/`taskId`. Read those first (older aliases kept as a fallback) so events
    // correlate to one process instead of each minting a throwaway synthetic id.
    private mutating func upsertBackground(_ ev: RunEvent) {
        let toolUseID = str(ev, "toolUseId")
        let id = str(ev, "shellId") ?? toolUseID ?? str(ev, "id") ?? str(ev, "taskId") ?? nextID()
        let status = str(ev, "status") ?? "running"
        // The command isn't on this event; correlate it from the launching Bash tool_use (bgLaunch).
        let command = str(ev, "command") ?? toolUseID.flatMap { bgLaunch[$0] }
        if let i = state.background.firstIndex(where: { $0.id == id }) {
            state.background[i].status = status
            if let command { state.background[i].command = command }
        } else {
            state.background.append(BackgroundProc(id: id, command: command, status: status, outputTail: ""))
        }
    }

    // `background_output` carries the WHOLE current output tail (a capped file snapshot re-sent on
    // each change under the `content` key), not an incremental delta — so replace, don't append.
    private mutating func applyBackgroundOutput(_ ev: RunEvent) {
        let toolUseID = str(ev, "toolUseId")
        guard let id = str(ev, "shellId") ?? toolUseID ?? str(ev, "id") ?? str(ev, "taskId") else { return }
        let snapshot = str(ev, "content") ?? str(ev, "output") ?? str(ev, "chunk") ?? str(ev, "text") ?? ""
        guard !snapshot.isEmpty else { return }
        if let i = state.background.firstIndex(where: { $0.id == id }) {
            state.background[i].outputTail = snapshot
        } else {
            state.background.append(BackgroundProc(id: id, command: toolUseID.flatMap { bgLaunch[$0] },
                                                   status: "running", outputTail: snapshot))
        }
    }

    private mutating func applyStatus(_ ev: RunEvent) {
        if let s = str(ev, "status"), let st = RunStatus(rawValue: s) { state.status = st }
    }

    // MARK: - helpers

    private mutating func nextID() -> String { idSeq += 1; return "i\(idSeq)" }
    private func str(_ ev: RunEvent, _ key: String) -> String? { ev.payload[key]?.stringValue }
    /// Parse the `user` event's `attachments` array (`[{id, mime, name}]`) into refs, dropping any
    /// element without an `id`. Older runners may send `images` (id-only) instead — not handled
    /// here since current runners always emit `attachments`.
    private func attachments(_ v: JSONValue?) -> [TurnAttachment] {
        guard case .array(let a)? = v else { return [] }
        return a.compactMap { el in
            guard let id = el["id"]?.stringValue else { return nil }
            return TurnAttachment(id: id, mime: el["mime"]?.stringValue, name: el["name"]?.stringValue)
        }
    }
}
