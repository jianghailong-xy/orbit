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
    /// Oldest durable seq folded into this window — the `before=` cursor for pulling the previous
    /// history page when the user scrolls up (web parity: AgentView's `oldestSeqRef`).
    public var oldestSeq: Int?
    /// Whether the server holds events older than `oldestSeq` (the last fetched page's `hasMore`).
    /// Gates the transcript's load-earlier row.
    public var hasMoreOlder: Bool = false
    /// Context-window occupancy (tokens) reported on the latest `turn_end`, for the composer's
    /// context gauge. nil until a turn completes (older runners omit it) → the gauge is hidden.
    public var contextTokens: Int?
    public init() {}

    // Tolerant decode so snapshots written before `queued` (or the history-window cursor) existed
    // still rehydrate (the keys just default) instead of discarding the whole cached session; the
    // other fields keep their prior strictness. `encode(to:)` stays synthesized from these keys.
    enum CodingKeys: String, CodingKey { case items, pendingApprovals, background, queued, status, maxSeq, oldestSeq, hasMoreOlder, contextTokens }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decode([TranscriptItem].self, forKey: .items)
        pendingApprovals = try c.decode([PendingApproval].self, forKey: .pendingApprovals)
        background = try c.decode([BackgroundProc].self, forKey: .background)
        queued = (try? c.decodeIfPresent([UserBubble].self, forKey: .queued)) ?? []
        status = try c.decode(RunStatus.self, forKey: .status)
        maxSeq = try c.decode(Int.self, forKey: .maxSeq)
        oldestSeq = (try? c.decodeIfPresent(Int.self, forKey: .oldestSeq)) ?? nil
        hasMoreOlder = (try? c.decodeIfPresent(Bool.self, forKey: .hasMoreOlder)) ?? false
        contextTokens = (try? c.decodeIfPresent(Int.self, forKey: .contextTokens)) ?? nil
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
    /// Namespace for synthetic ids ("i1", "i2", …). A sub-reducer folding an older history page
    /// (see `prependOlder`) gets a per-page prefix so its ids can never collide with this
    /// reducer's — now or after either mints more. Transient like `bgLaunch`: the parent's is
    /// always "i", so it's excluded from the persisted keys and old snapshots still decode.
    private var idPrefix = "i"
    /// Command + optional `description` of each `Bash(run_in_background)` launch, keyed by its
    /// tool_use id. The `background_*` events never carry either, so both are correlated from the
    /// launch captured here — matching web's `deriveBackgroundShells`, which titles the row
    /// `description ?? command` yet keeps the command to show in the expanded body. Transient:
    /// rebuilt from replayed tool_use events and excluded from the persisted keys below, so
    /// snapshots written before it existed still decode.
    private var bgLaunch: [String: (command: String, description: String?)] = [:]

    private enum CodingKeys: String, CodingKey { case state, seen, openAssistant, openThinking, idSeq }

    public init() {}

    public mutating func apply(_ ev: RunEvent) {
        if ev.type.isDurable && ev.seq > 0 {
            if seen.contains(ev.seq) { return }       // dedup replayed/duplicate durable events
            seen.insert(ev.seq)
            if ev.seq > state.maxSeq { state.maxSeq = ev.seq }
            // Low-water mark: the `before=` cursor for scroll-up history paging.
            if state.oldestSeq.map({ ev.seq < $0 }) ?? true { state.oldestSeq = ev.seq }
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

    /// Fold the tail-first initial page (the newest N persisted events) and record whether older
    /// history remains on the server before it — the cold-open half of tail-first pagination.
    public mutating func applyTailPage(_ page: EventPage) {
        for ev in page.events { apply(ev) }
        state.hasMoreOlder = page.hasMore && !page.events.isEmpty
    }

    /// Fold a `before=oldestSeq` history page — chronological and strictly older than everything
    /// loaded — in FRONT of the current window: the scroll-up half of tail-first pagination (web
    /// AgentView's `loadOlder`). The page is folded standalone by a sub-reducer, then grafted: its
    /// items are prepended, the dedup set merged, and `oldestSeq` moved back. Only transcript
    /// items graft — the page's status/approval/background side effects are discarded, because the
    /// live window owns that truth (a historical `turn_end` must not clobber a running status, nor
    /// an old background task resurrect the tray). One seam wart is accepted (web heals it by
    /// re-reducing its full event array, which an incremental reducer can't): a card whose
    /// `tool_result` was folded — unmatched, and dropped — before its `tool_use` was loaded stays
    /// "running"; a result arriving after the graft closes it normally (closeTool scans all items).
    public mutating func prependOlder(_ page: EventPage) {
        // An empty page means the cursor can't advance: stop the affordance regardless of
        // `hasMore`, or the load-earlier row would spin forever re-fetching nothing.
        state.hasMoreOlder = page.hasMore && !page.events.isEmpty
        // Move the low-water cursor to the page's first durable event — even when every event
        // turns out to be already folded (a misbehaving overlap), so a retry pages onward instead
        // of refetching the same window forever (web parity: `oldestSeqRef` moves unconditionally).
        if let first = page.events.first(where: { $0.type.isDurable && $0.seq > 0 }),
           state.oldestSeq.map({ first.seq < $0 }) ?? true {
            state.oldestSeq = first.seq
        }
        // Only durable events build history (the live-only types fold to side effects discarded
        // below anyway), and pages are disjoint by construction (`before` is exclusive) — but
        // never re-fold a seq this reducer already applied.
        let fresh = page.events.filter { $0.type.isDurable && $0.seq > 0 && !seen.contains($0.seq) }
        guard !fresh.isEmpty else { return }
        var sub = TranscriptReducer()
        sub.idPrefix = "o\(fresh[0].seq)-"   // per-page id namespace: see `idPrefix`
        for ev in fresh { sub.apply(ev) }
        sub.flushStreaming()   // close anything left open at the page's end (defensive; pages hold no deltas)
        state.items = sub.state.items + state.items
        seen.formUnion(sub.seen)
        // The open-bubble cursors are item INDICES — shift them past the prepended rows, or the
        // next live delta would stream into an old bubble. (`maxSeq` keeps the parent's — the
        // page is older by construction; the low-water cursor already moved above.)
        if let i = openAssistant { openAssistant = i + sub.state.items.count }
        if let i = openThinking { openThinking = i + sub.state.items.count }
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
        // A background shell launch: remember its command AND human description so the (command-less)
        // background_* events can title the tray row (description preferred, like web) while still
        // surfacing the raw command in the expanded body.
        if name == "Bash", input["run_in_background"]?.boolValue == true,
           let command = input["command"]?.stringValue {
            let desc = input["description"]?.stringValue
            bgLaunch[id] = (command: command, description: desc?.isEmpty == false ? desc : nil)
        }
        state.items.append(.toolCall(ToolCard(id: id, name: name, input: input, result: nil, status: .running)))
    }

    private mutating func closeTool(_ ev: RunEvent) {
        let id = str(ev, "toolUseId") ?? str(ev, "tool_use_id") ?? str(ev, "id")
        let isError = ev.payload["isError"]?.boolValue ?? ev.payload["is_error"]?.boolValue ?? false
        let result = str(ev, "content") ?? str(ev, "result") ?? ev.payload["content"]?.asString
        // A Read on an image (or an MCP screenshot) delivers `content` as an array of image blocks,
        // not a string — decode those into bytes for inline display (web parity: `resultImages()`).
        let images = resultImages(ev.payload["content"])
        // A confirmed background-shell launch ("…running in background with ID…") must surface in the
        // tray NOW, keyed by its tool_use id — not wait for a background_task that may never arrive
        // (the shell is still running, or its completion notification was never recorded as an event).
        // Mirrors web's deriveBackgroundShells, which builds the shell list from the launch, not the
        // completion. background_task/output then update this same row (correlated by toolUseId).
        if let id, !isError, let launch = bgLaunch[id], let result,
           result.contains("running in background with ID"),
           !state.background.contains(where: { $0.id == id }) {
            state.background.append(BackgroundProc(id: id, command: launch.command, description: launch.description, status: "running", outputTail: "", startedAt: ev.ts))
        }
        for idx in stride(from: state.items.count - 1, through: 0, by: -1) {
            if case .toolCall(var card) = state.items[idx], card.result == nil, id == nil || card.id == id {
                card.result = result
                card.resultImages = images
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
        // The runner reports this turn's context-window occupancy; keep the latest for the
        // composer gauge. Guard on > 0 so a turn without usage doesn't blank a known value.
        if let ct = ev.payload["contextTokens"]?.intValue, ct > 0 { state.contextTokens = ct }
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

    /// Seed the tray with the server's authoritative background-shell list (GET /sessions/:id/background),
    /// fetched on session open + each reconnect. The live reducer only surfaces shells whose launch is
    /// in the loaded event window; this merges in every OTHER shell the session launched — and fills the
    /// output for agent shells whose live tail (`background_output`) is broadcast-only and so never
    /// persists (a cold reload has none, which is why they'd otherwise read "No output captured yet").
    ///
    /// Idempotent and live-preserving, so it's safe to re-run: a shell we already track keeps its
    /// (fresher) live output, gaining only fields it lacks; its status advances a still-running row to
    /// the server's terminal state but never resurrects one the live stream already settled (the
    /// snapshot may predate that). Unknown shells are appended. Reordered chronologically by launch.
    /// This is the native half of web's server-list ∪ live-overlay merge (`mergeBackgroundShells`).
    public mutating func seedBackground(_ incoming: [BackgroundProc]) {
        for proc in incoming {
            if let i = state.background.firstIndex(where: { $0.id == proc.id }) {
                if state.background[i].command == nil { state.background[i].command = proc.command }
                if state.background[i].description == nil { state.background[i].description = proc.description }
                if state.background[i].outputTail.isEmpty { state.background[i].outputTail = proc.outputTail }
                if state.background[i].startedAt == nil { state.background[i].startedAt = proc.startedAt }
                if state.background[i].status == "running" { state.background[i].status = proc.status }
            } else {
                state.background.append(proc)
            }
        }
        // Chronological by launch: ISO-8601 timestamps sort lexicographically = chronologically. A row
        // with no timestamp (shouldn't happen with server data) sorts last (`~` > any digit).
        state.background.sort { ($0.startedAt ?? "~") < ($1.startedAt ?? "~") }
    }

    // Correlate every background event to one process by `toolUseId` (the launching Bash call) — the
    // one id present on the launch tool_use/result AND on every background_* event, so a shell
    // surfaced from its launch (see closeTool) and its later completion are the SAME row. `shellId`
    // and the older `id`/`taskId` are fallbacks. (Runner sends `shellId`/`toolUseId`, never `id`.)
    private mutating func upsertBackground(_ ev: RunEvent) {
        let toolUseID = str(ev, "toolUseId")
        let id = toolUseID ?? str(ev, "shellId") ?? str(ev, "id") ?? str(ev, "taskId") ?? nextID()
        let status = str(ev, "status") ?? "running"
        // Neither the command nor the description is on this event; correlate them from the launching
        // Bash tool_use (bgLaunch).
        let launch = toolUseID.flatMap { bgLaunch[$0] }
        let command = str(ev, "command") ?? launch?.command
        if let i = state.background.firstIndex(where: { $0.id == id }) {
            state.background[i].status = status
            if let command { state.background[i].command = command }
        } else {
            state.background.append(BackgroundProc(id: id, command: command, description: launch?.description, status: status, outputTail: "", startedAt: ev.ts))
        }
    }

    // `background_output` carries the WHOLE current output tail (a capped file snapshot re-sent on
    // each change under the `content` key), not an incremental delta — so replace, don't append.
    private mutating func applyBackgroundOutput(_ ev: RunEvent) {
        let toolUseID = str(ev, "toolUseId")
        guard let id = toolUseID ?? str(ev, "shellId") ?? str(ev, "id") ?? str(ev, "taskId") else { return }
        let snapshot = str(ev, "content") ?? str(ev, "output") ?? str(ev, "chunk") ?? str(ev, "text") ?? ""
        guard !snapshot.isEmpty else { return }
        if let i = state.background.firstIndex(where: { $0.id == id }) {
            state.background[i].outputTail = snapshot
        } else {
            let launch = toolUseID.flatMap { bgLaunch[$0] }
            state.background.append(BackgroundProc(id: id, command: launch?.command, description: launch?.description,
                                                   status: "running", outputTail: snapshot, startedAt: ev.ts))
        }
    }

    private mutating func applyStatus(_ ev: RunEvent) {
        if let s = str(ev, "status"), let st = RunStatus(rawValue: s) { state.status = st }
    }

    // MARK: - helpers

    private mutating func nextID() -> String { idSeq += 1; return "\(idPrefix)\(idSeq)" }
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
    /// Image blocks carried by a tool_result's `content` array (`Read` on a .png, an MCP screenshot):
    /// each `{type:"image", source:{data}}` block's base64 payload decoded to bytes for inline display.
    /// Mirrors web's `resultImages()`. A string / text-only `content` yields []. Base64 that doesn't
    /// decode is dropped (the view can't render it); the view still guards non-image bytes.
    private func resultImages(_ v: JSONValue?) -> [Data] {
        guard case .array(let blocks)? = v else { return [] }
        return blocks.compactMap { b in
            guard b["type"]?.stringValue == "image",
                  let b64 = b["source"]?["data"]?.stringValue,
                  let bytes = Data(base64Encoded: b64) else { return nil }
            return bytes
        }
    }
}
