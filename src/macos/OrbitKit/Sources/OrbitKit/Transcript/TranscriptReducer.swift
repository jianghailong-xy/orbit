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
    /// Context-window occupancy (tokens) reported by the runner, for the composer's context gauge.
    /// nil until the first usage-bearing event arrives (older runners omit it) → the gauge is
    /// hidden.
    public var contextTokens: Int?
    /// What `contextTokens` is a fraction of, reported beside it by the runner (which reads it off
    /// the CLI that produced the tokens). Kept as a pair rather than looked up per render: a
    /// window resolved separately can belong to a different model than the count it divides — the
    /// id alone doesn't determine it (`opus` vs `opus[1m]`). nil for a runner too old to send one,
    /// which leaves the composer on AgentDefaults.contextWindow.
    public var contextWindow: Int?
    public init() {}

    // Tolerant decode so snapshots written before `queued` (or the history-window cursor) existed
    // still rehydrate (the keys just default) instead of discarding the whole cached session; the
    // other fields keep their prior strictness. `encode(to:)` stays synthesized from these keys.
    enum CodingKeys: String, CodingKey { case items, pendingApprovals, background, queued, status, maxSeq, oldestSeq, hasMoreOlder, contextTokens, contextWindow }
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
        contextWindow = (try? c.decodeIfPresent(Int.self, forKey: .contextWindow)) ?? nil
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
    /// Engine stderr already given an error row, keyed on the line minus its leading timestamp (the
    /// runtimes that log at all stamp every line, so raw text is unique per occurrence and nothing
    /// would ever fold). A repeat bumps that row's count instead of taking a row of its own: codex
    /// re-reports the same line on every request for the rest of a conversation whose history lost a
    /// tool result — 217 identical red lines in one observed session (web parity: `engineStderr`).
    /// Transient like `bgLaunch` — excluded from the persisted keys below, so snapshots written
    /// before it existed still decode; a rehydrated session simply starts folding afresh.
    private var stderrSeen: [String: (id: String, line: String, count: Int)] = [:]

    private enum CodingKeys: String, CodingKey { case state, seen, openAssistant, openThinking, idSeq }

    public init() {}

    public mutating func apply(_ ev: RunEvent) {
        // `sentinelSeq` is a live-only terminal broadcast wearing a durable type — it must move
        // neither cursor (see `RunEvent.sentinelSeq`), and it is not deduped either: it is never
        // replayed, so a repeat is a genuine second finalization, and `applyStatus` is idempotent.
        if ev.type.isDurable && ev.seq > 0 && ev.seq != RunEvent.sentinelSeq {
            if seen.contains(ev.seq) { return }       // dedup replayed/duplicate durable events
            seen.insert(ev.seq)
            if ev.seq > state.maxSeq { state.maxSeq = ev.seq }
            // Low-water mark: the `before=` cursor for scroll-up history paging.
            if state.oldestSeq.map({ ev.seq < $0 }) ?? true { state.oldestSeq = ev.seq }
        }
        // The runner reports context-window occupancy on `turn_end`; a lightweight event can also
        // refresh the gauge without ending the active turn. Guard on > 0 so an event without usage
        // doesn't blank a known value. The window rides the same event and is taken only from one
        // that carried a count, so the two halves the gauge divides always describe one reading.
        if let ct = ev.payload["contextTokens"]?.intValue, ct > 0 {
            state.contextTokens = ct
            if let cw = ev.payload["contextWindow"]?.intValue, cw > 0 { state.contextWindow = cw }
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
        case .userDelivery:   applyUserDelivery(ev)
        case .interrupt:      appendInterrupt(seq: ev.seq)
        case .error:          appendError(ev)
        case .approvalRequest:  upsertApproval(ev)
        case .approvalResolved: resolveApproval(ev)
        // A REST re-fetch order handled by ConsoleModel, not transcript content.
        case .queuedTurnsChanged: break
        case .backgroundTask:   upsertBackground(ev)
        case .backgroundOutput: applyBackgroundOutput(ev)
        case .status, .result:  applyStatus(ev)
        case .system:           appendEngineStderr(ev)
        // An order to the consume loop, not transcript content: it can't re-fetch anything from
        // in here, so it acts on `resetForResync()` + a fresh tail page (see `ConsoleModel.run()`).
        case .resync:           break
        case .unknown:          break          // lifecycle noise — no transcript item
        }
    }

    /// Drop the loaded transcript window so a tail page can re-seed it from scratch — the reducer
    /// half of the server's `resync` order (see `RunEventType.resync`).
    ///
    /// Everything that makes this window a *position* in the history goes: the folded items, the
    /// dedup set, both cursors, and the open-bubble marks (a bubble left open here would swallow
    /// the first deltas of the re-seeded window). What survives is the state the transcript stream
    /// doesn't own and other paths re-seed on the same reconnect — pending approvals, the
    /// background tray, the composer's queued sends, the run status and the context gauge —
    /// because clearing those would blank live UI the re-seed cannot restore. Web's `reseed`
    /// draws the same line: it resets `events`/`seen`/`oldestSeq`/`lastSeq` and nothing else.
    public mutating func resetForResync() {
        state.items = []
        state.maxSeq = 0
        state.oldestSeq = nil
        state.hasMoreOlder = false
        seen.removeAll()
        openAssistant = nil
        openThinking = nil
        bgLaunch.removeAll()
        stderrSeen.removeAll()
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
    ///
    /// `steer` is the same response's verdict on what this message actually became: the server
    /// files a message sent while a turn is running into that turn instead of queueing it behind
    /// it. It is authoritative over the send's own guess — that guess is read off a status the
    /// stream may not have caught up with, while the server decided this under the Session row
    /// lock — so a bubble that says "Queued" here stops saying it, and stops offering a withdraw
    /// the server would refuse.
    public mutating func setOptimisticTurnId(clientTurnId: String, turnId: String, steer: Bool = false) {
        // A queued send lives in `state.queued`, an idle one in `state.items` — tag whichever holds it.
        if let i = state.queued.firstIndex(where: { $0.clientTurnId == clientTurnId && $0.pending }) {
            state.queued[i].turnId = turnId
            if steer { state.queued[i].steer = true }
            return
        }
        guard let i = state.items.firstIndex(where: {
            if case .user(let b) = $0 { return b.clientTurnId == clientTurnId && b.pending }
            return false
        }), case .user(var b) = state.items[i] else { return }
        b.turnId = turnId
        if steer { b.steer = true }
        state.items[i] = .user(b)
    }

    /// Drop an optimistic bubble whose send ultimately failed, so a message that never reached the
    /// server doesn't sit in the transcript looking delivered (the composer hands its text back
    /// instead — see `ConsoleModel.send`). Matched by `clientTurnId`, and only while unconfirmed:
    /// a bubble the durable `user` event already reconciled belongs to a turn that DID land — the
    /// response to it was merely lost — and must stay. `undelivered` counts as unconfirmed (the run
    /// ended under a send still retrying its POST), or the composer would hand the text back AND
    /// leave the bubble behind.
    public mutating func removeOptimisticUser(clientTurnId: String) {
        func unconfirmed(_ b: UserBubble) -> Bool { b.pending || b.undelivered }
        state.queued.removeAll { $0.clientTurnId == clientTurnId && unconfirmed($0) }
        guard let i = state.items.firstIndex(where: {
            if case .user(let b) = $0 { return b.clientTurnId == clientTurnId && unconfirmed(b) }
            return false
        }) else { return }
        state.items.remove(at: i)
        // The open-bubble cursors are item INDICES — close the gap left behind, or a delta arriving
        // for a still-streaming turn would land in the wrong bubble (same hazard as `prependPage`).
        if let o = openAssistant, o > i { openAssistant = o - 1 }
        if let o = openThinking, o > i { openThinking = o - 1 }
    }

    /// Withdraw a still-queued message locally (the queued bubble's Cancel button). The server-side
    /// `DELETE …/turns/:turnId` is fired by the caller; if the runner already leased it, its durable
    /// `user` event simply lands as a normal transcript row (`appendUser` finds no queue entry to
    /// reconcile, since it's gone by then). Web parity: `setQueued(q ⇒ q.filter(…))`.
    public mutating func removeQueued(id: String) {
        state.queued.removeAll { $0.id == id }
    }

    /// Reconcile the visible queued tail against GET /sessions/:id/turns. That endpoint is the
    /// durable truth because a PENDING turn has no `user` event until the runner leases it.
    ///
    /// `knownBefore` contains only server-backed turn ids captured before the fetch. A listed row
    /// is updated/deduplicated in server order; a previously-known row now absent was withdrawn on
    /// another client and is removed. Optimistic bubbles without a turn id, plus bubbles created
    /// while the request was in flight, survive a stale snapshot. When the POST and GET cross, an
    /// untagged optimistic bubble is adopted by matching its content + attachment ids.
    public mutating func reconcileQueuedTurns(_ turns: [QueuedTurnInfo], knownBefore: Set<String>) {
        let previous = state.queued
        let deliveredTurnIDs = Set(state.items.compactMap { item -> String? in
            guard case .user(let bubble) = item else { return nil }
            return bubble.turnId
        })
        var consumed = Set<Int>()
        var reconciled: [UserBubble] = []

        // The REST query may have read a row just before the runner leased it, then arrive after
        // that turn's durable `user` event. Never resurrect such a stale row below the transcript.
        for turn in turns where !deliveredTurnIDs.contains(turn.turnId) {
            let incomingAttachments = turn.attachments?.map {
                TurnAttachment(id: $0.id, mime: $0.mimeType)
            }
            let incomingAttachmentIDs = incomingAttachments?.map(\.id)
            let exact = previous.indices.first {
                !consumed.contains($0) && previous[$0].turnId == turn.turnId
            }
            let optimistic = previous.indices.first {
                guard !consumed.contains($0), previous[$0].turnId == nil,
                      previous[$0].pending, previous[$0].text == turn.content else { return false }
                return incomingAttachmentIDs == nil || previous[$0].attachments.map(\.id) == incomingAttachmentIDs
            }

            if let i = exact ?? optimistic {
                consumed.insert(i)
                var bubble = previous[i]
                bubble.text = turn.content
                if let incomingAttachments { bubble.attachments = incomingAttachments }
                bubble.turnId = turn.turnId
                bubble.pending = true
                bubble.queued = true
                bubble.undelivered = false
                // The server's kind, so a reopened console can still tell the message waiting for
                // its turn from the one being written into the turn in progress.
                bubble.steer = SteerDelivery.isSteerKind(turn.kind)
                reconciled.append(bubble)
            } else {
                reconciled.append(UserBubble(id: "server-\(turn.turnId)", text: turn.content,
                                             attachments: incomingAttachments ?? [], turnId: turn.turnId,
                                             pending: true, queued: true,
                                             steer: SteerDelivery.isSteerKind(turn.kind)))
            }
        }

        // Preserve local work the REST snapshot cannot safely disprove: an untagged optimistic send,
        // or a server-backed bubble that arrived after this particular fetch began. Everything that
        // was already known to the server and is now absent has been cancelled/leased elsewhere.
        for i in previous.indices where !consumed.contains(i) {
            let bubble = previous[i]
            if let turnId = bubble.turnId,
               knownBefore.contains(turnId) || deliveredTurnIDs.contains(turnId) { continue }
            reconciled.append(bubble)
        }
        state.queued = reconciled
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
        // Three failures arrive as an ordinary assistant reply — an expired sign-in, a spent quota
        // or an unreachable provider, and an outright API error — with a `success` result, so
        // nothing upstream treats the turn as failed. Rendered verbatim they read as the agent
        // answering "API Error: 529". Raise each as the row that says what it is instead: a remedy
        // the user can act on, a pause that fixes itself, or a plain error line (web parity: the
        // `assistant` case's classification ladder, in this same order — the specific readings
        // come first, and an API error we cannot place is one a re-send would reproduce).
        //
        // Classify the text the turn actually ends with: an `assistant` event carrying no text of
        // its own finalizes whatever streamed into the open bubble.
        var streamed = ""
        if let i = openAssistant, case .assistant(let b) = state.items[i] { streamed = b.streamingText }
        let settled = full.isEmpty ? streamed : full
        if EngineAuth.isAuthErrorText(settled) {
            dropOpenAssistant()
            appendAuthError(settled)
            return
        }
        if EngineErrors.isUsageLimitErrorText(settled) {
            dropOpenAssistant()
            appendAutoRetry(settled, variant: .quota, seq: seq)
            return
        }
        if EngineErrors.isRetryableApiErrorText(settled) {
            dropOpenAssistant()
            appendAutoRetry(settled, variant: .apiError, seq: seq)
            return
        }
        if EngineErrors.isApiErrorText(settled) {
            dropOpenAssistant()
            state.items.append(.error(id: nextID(), message: settled))
            return
        }
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

    /// Drop the streaming bubble that was carrying the text just reclassified as a failure — it is
    /// always the tail while open, so removing it can't disturb another open block's index.
    private mutating func dropOpenAssistant() {
        if let i = openAssistant, i == state.items.count - 1, case .assistant = state.items[i] {
            state.items.remove(at: i)
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
        state.items.append(.toolCall(ToolCard(id: id, name: name, input: input, result: nil, status: .running,
                                              inputSeq: ev.seq, inputTruncated: ev.truncated)))
    }

    private mutating func closeTool(_ ev: RunEvent) {
        let id = str(ev, "toolUseId") ?? str(ev, "tool_use_id") ?? str(ev, "id")
        let isError = ev.payload["isError"]?.boolValue ?? ev.payload["is_error"]?.boolValue ?? false
        // `content` is a string, a block array, or a whole MCP CallToolResult wrapper — flattened
        // the one way web flattens it. `result` is the older runners' key for the same thing.
        let result = ToolResultContent.text(ev.payload["content"]) ?? str(ev, "result")
        // A Read on an image (or an MCP screenshot) delivers `content` as an array of image blocks,
        // not a string — decode those into bytes for inline display (web parity: `resultImages()`).
        let images = ToolResultContent.images(ev.payload["content"])
        // Recorded separately from the decoded bytes because the server drops an oversized image's
        // `data` and keeps the block: the card must still know a picture is here, or it folds and
        // never asks for it. Web parity: `hasResultImage`.
        let hasImage = ToolResultContent.hasImage(ev.payload["content"])
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
                card.resultHasImage = hasImage
                card.status = isError ? .error : .ok
                card.resultSeq = ev.seq
                card.resultTruncated = ev.truncated
                state.items[idx] = .toolCall(card)
                return
            }
        }
    }

    // MARK: - turn / user / interrupt / error

    private mutating func endTurn(_ ev: RunEvent) {
        flushStreaming()
        if let s = str(ev, "status"), let st = RunStatus(rawValue: s) {
            setStatus(st)
        } else {
            setStatus(.awaitingInput)
        }
    }

    /// Adopt a run-status transition, and settle anything the transition strands.
    ///
    /// A message is only un-pended by its own durable `user` event, which the runner emits when it
    /// hands the text to the agent. If the run settles terminal first — an expired sign-in is the
    /// common way, since the runner's auth preflight fails *before* it feeds the turn — that event
    /// never comes: the server drains the still-queued turns (`status: ANSWERED`) and broadcasts no
    /// event saying so. The bubble would then sit on "Sending…" for the life of the session, and a
    /// resume can't rescue it either (that turn is spent; a retry is a new one). Terminal is the
    /// signal, so mark them here — anything still pending at this point was never taken.
    private mutating func setStatus(_ status: RunStatus) {
        state.status = status
        guard status.isTerminal else { return }
        for i in state.items.indices {
            guard case .user(var b) = state.items[i], b.pending else { continue }
            b.pending = false
            b.undelivered = true
            state.items[i] = .user(b)
        }
        for i in state.queued.indices where state.queued[i].pending {
            state.queued[i].pending = false
            state.queued[i].undelivered = true
        }
    }

    /// The runner's own account of what happened to a message it was given (`user_delivery`).
    ///
    /// It names its turn in the payload rather than relying on the event's own attribution,
    /// because a delivery settles on the writer's schedule and not the conversation's: the turn in
    /// progress when a message is finally written is often a different one. A report for a turn
    /// this window has never seen is dropped — after a resync the bubble it belongs to may be off
    /// the loaded page, and there is nothing to amend.
    ///
    /// A failure sets `undelivered`, which is the same fact the drained-on-terminal path records
    /// and reads the same to the person: this message never reached the engine. A message is never
    /// re-marked as arrived by a later report — the states only move forward — but neither is a
    /// failure ever overwritten by a stale one, since the runner reports each transition once.
    private mutating func applyUserDelivery(_ ev: RunEvent) {
        guard let turnId = str(ev, "turnId") ?? ev.turnId, let delivery = str(ev, "delivery") else { return }
        if let i = state.items.lastIndex(where: {
            if case .user(let b) = $0 { return b.turnId == turnId }
            return false
        }), case .user(var b) = state.items[i] {
            b.delivery = delivery
            b.undelivered = delivery == "failed"
            state.items[i] = .user(b)
            return
        }
        // Still in the queued tail: a steer can be reported failed before the runner ever files
        // its `user` event (it is refused outright when no turn is running to fold it into).
        if let i = state.queued.firstIndex(where: { $0.turnId == turnId }) {
            state.queued[i].delivery = delivery
            if delivery == "failed" {
                state.queued[i].pending = false
                state.queued[i].undelivered = true
            }
        }
    }

    private mutating func appendUser(_ ev: RunEvent) {
        markOutageOver()          // the session went on — whatever was waiting on a retry no longer is
        let cid = str(ev, "clientTurnId")
        // What the runner echoes is what it was *given*, which includes anything delivery appended
        // (a `#`-reference expansion, a list's condition board). Split at ingest rather than at
        // render, because `echoes` below falls back to comparing this against the text the person
        // typed: an unsplit body never matches, so a referencing message would strand its
        // optimistic bubble on "Sending…" and append a duplicate next to it.
        let delivered = splitDeliveredMessage(str(ev, "text") ?? str(ev, "content") ?? "")
        // How far the runner had got with this message when it filed the event, and whether it
        // was filed as a steer — the message written into the turn already running. Both ride the
        // durable event, so a reload rebuilds the indicator instead of showing a message that
        // says nothing about itself.
        let delivery = str(ev, "delivery")
        let steer = ev.payload["steer"]?.boolValue == true
        // An ordinary user message opens a turn, so anything still streaming when it arrives was
        // left dangling and is closed here. A steer is the one user message that is NOT a
        // boundary: it lands in the middle of a reply that is still being written. Closing that
        // bubble would strand it holding a half-sentence, and the authoritative `assistant` event
        // for the same block — arriving with the whole text and no open bubble to fill — would
        // then append the reply a SECOND time, in full, under the partial copy.
        if !steer { flushStreaming() }
        let body = delivered.text
        // The runner echoes `attachments` (an array of `{id, mime, name}`) on the durable user
        // event, NOT `attachmentIds` — parse those so the bubble can render images / file chips
        // after a reload (web reads the same field).
        let atts = attachments(ev.payload["attachments"])
        // Does this durable `user` event echo a still-pending optimistic bubble? Match on the
        // server `turnId` we tagged onto it (or an echoed `clientTurnId`), falling back to the
        // message text while the bubble is still untagged. The tag is applied from the POST /turns
        // response (`setOptimisticTurnId`), but on iOS that response and this SSE event race — they
        // ride separate connection pools, so the event can land first. A turnId-only match would
        // then miss and append a duplicate, stranding the original bubble on "Sending…".
        func echoes(_ b: UserBubble) -> Bool {
            if let cid, b.clientTurnId == cid { return true }
            if let tid = ev.turnId, b.turnId == tid { return true }
            return b.turnId == nil && !body.isEmpty && b.text == body
        }
        // The runner just leased a queued send: drop its placeholder from `state.queued` — this
        // durable event becomes its real transcript row below, in order (web parity).
        if let qi = state.queued.firstIndex(where: echoes) {
            state.queued.remove(at: qi)
        }
        // Reconcile a pending optimistic (idle) bubble in place rather than appending a duplicate.
        if let i = state.items.firstIndex(where: {
            guard case .user(let b) = $0, b.pending else { return false }
            return echoes(b)
        }) {
            if case .user(var b) = state.items[i] {       // reconcile optimistic bubble
                b.pending = false
                if let tid = ev.turnId { b.turnId = tid }    // adopt the id if we matched by text
                if !body.isEmpty { b.text = body }
                b.injected = delivered.injected
                if !atts.isEmpty { b.attachments = atts }   // durable refs carry mime; keep ids if absent
                b.ts = ev.ts ?? b.ts
                b.steer = b.steer || steer
                // Only a runner that reports delivery at all gets to settle this: an older one
                // says nothing, and reading its silence as "arrived" would clear a bubble the
                // terminal-drain had already marked as never taken.
                if let delivery {
                    b.delivery = delivery
                    b.undelivered = delivery == "failed"
                }
                state.items[i] = .user(b)
            }
            return
        }
        state.items.append(.user(UserBubble(id: nextID(), text: body, attachments: atts, ts: ev.ts,
                                            clientTurnId: cid, turnId: ev.turnId, pending: false,
                                            undelivered: delivery == "failed",
                                            injected: delivered.injected, steer: steer,
                                            delivery: delivery)))
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
        // A signed-out engine is reported as an error event rather than assistant text (there is no
        // model in the loop yet — it never got to spawn), but the remedy is the same human action,
        // so it earns the same card instead of a bare error line (web parity).
        if EngineAuth.isAuthErrorText(msg) { appendAuthError(msg); return }
        state.items.append(.error(id: nextID(), message: msg))
    }

    /// Surface an engine's stderr as an error row. A runtime's only account of why it failed to come
    /// up arrives there — "--dangerously-skip-permissions cannot be used with root/sudo privileges",
    /// "No conversation found with session ID: …" — and it is reported on a `system` event, which
    /// carries no other transcript row. Dropped, the turn reads as a silent blank: the user sends
    /// again, the engine fails the same way, and nothing on screen ever says why (web parity:
    /// Transcript's `system` case). Everything else on a `system` event stays lifecycle noise.
    private mutating func appendEngineStderr(_ ev: RunEvent) {
        guard let raw = str(ev, "stderr") else { return }
        let line = EngineStderr.clean(raw)
        guard !line.isEmpty, !EngineStderr.isBenign(line) else { return }
        let key = EngineStderr.foldKey(line)
        if let seen = stderrSeen[key], let i = state.items.firstIndex(where: { $0.id == seen.id }) {
            let count = seen.count + 1
            stderrSeen[key] = (id: seen.id, line: seen.line, count: count)
            state.items[i] = .error(id: seen.id, message: "\(seen.line) ×\(count)")
            return
        }
        let id = nextID()
        stderrSeen[key] = (id: id, line: line, count: 1)
        state.items.append(.error(id: id, message: line))
    }

    /// A failure that fixes itself, raised as a card carrying the pending retry rather than a bare
    /// error line: nothing is being asked of the reader, and the message will go out again on its
    /// own (web parity: `autoRetry`).
    private mutating func appendAutoRetry(_ message: String, variant: AutoRetryNotice.Variant, seq: Int) {
        markOutageOver()
        // A quota is usually spent on the message that just went out, which puts that bubble
        // directly above the card — quoting it there is the same sentence twice, and it is the
        // tallest thing in the card. A textless bubble (image-only turn) is not what a retry would
        // re-send, so it doesn't count as the message being above.
        var afterUserMsg = false
        if case .user(let b)? = state.items.last,
           !b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            afterUserMsg = true
        }
        state.items.append(.autoRetry(AutoRetryNotice(id: nextID(), message: message, variant: variant,
                                                      seq: seq, afterUserMsg: afterUserMsg)))
    }

    /// The outage the newest card describes is over — decided by the next user message, whoever
    /// sent it: the retry firing, the user retrying by hand, and the user typing something else all
    /// land as one. Without this a session that recovered would keep the card of the outage it
    /// recovered from and — since the armed retry is cleared once it fires — render it as "nothing
    /// pending", i.e. as if the retry had been switched off.
    ///
    /// Found by scanning back rather than remembered, so a reducer rehydrated from a snapshot (which
    /// carries the items but no cursor) still settles the card it restored.
    private mutating func markOutageOver() {
        for i in state.items.indices.reversed() {
            guard case .autoRetry(var n) = state.items[i] else { continue }
            if n.stale { return }        // the newest is already history; so is everything above it
            n.stale = true
            state.items[i] = .autoRetry(n)
            return
        }
    }

    /// A sign-in failure is reported once per dispatch, so a session picked up again reports the
    /// identical one seconds later. That card is a remedy, not a log line: two of them say nothing
    /// new and put two live copies of a sign-in there is only one of on screen — with two codes to
    /// read and two Cancels for the same relay. A repeat folds into the card above it (web parity).
    private mutating func appendAuthError(_ message: String) {
        if case .authError(_, let previous)? = state.items.last, previous == message { return }
        state.items.append(.authError(id: nextID(), message: message))
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
        if let s = str(ev, "status"), let st = RunStatus(rawValue: s) { setStatus(st) }
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
}

/// Readying an engine's raw stderr line for the transcript — the native half of the web
/// transcript's `stripAnsi` / `LEADING_TIMESTAMP` / `isBenignEngineStderr`.
private enum EngineStderr {
    // A pattern that fails to compile leaves the text untouched rather than dropping the line: a
    // stderr shown with its escape codes still says why the turn failed.
    private static let ansi = try? NSRegularExpression(pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]")
    private static let leadingTimestamp = try? NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?\\s*")

    /// Trimmed and stripped of ANSI colour codes. The runner strips them at the source now
    /// (runner-go/ansi.go), but every event stored before that still carries them, and the ESC byte
    /// is invisible in a SwiftUI `Text` — what would show is literal "[31m" garbage.
    static func clean(_ raw: String) -> String {
        strip(ansi, from: raw).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The key two occurrences of one line fold on: the line minus its leading ISO-8601 timestamp.
    static func foldKey(_ line: String) -> String { strip(leadingTimestamp, from: line) }

    /// Does this line say nothing about the session? Claude Code prints "⚠ claude.ai connectors are
    /// disabled because ANTHROPIC_API_KEY or another auth source is set …" on every start when an
    /// auth token is in its environment — which is exactly how a configured provider (DeepSeek, …)
    /// borrows the claude runtime. Its advice would break the very provider the user picked, and an
    /// error row on every such session opened on what looked like a failed turn.
    ///
    /// Deliberately one known line rather than a "warnings aren't errors" rule: the reason stderr is
    /// surfaced at all is that a runtime's only account of why it failed to come up arrives there.
    static func isBenign(_ line: String) -> Bool { line.contains("claude.ai connectors are disabled") }

    private static func strip(_ re: NSRegularExpression?, from s: String) -> String {
        guard let re else { return s }
        return re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
    }
}
