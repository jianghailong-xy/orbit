import SwiftUI

// The console's data, shaped the way `TranscriptView` reads it from `ConsoleModel`
// (v0.1.2-beta.142): one published `state` snapshot plus the side sources the rows are assembled
// from. The publish semantics are copied, not approximated — they decide WHEN the List's rows change
// relative to the scroll calls, which is the whole question.

struct PItem: Identifiable, Equatable {
    enum Kind: Equatable { case user, assistant, thinking, tool }
    let id: String
    let seq: Int
    var kind: Kind
    var text: String
    var finalized = true
    var running = false
}

struct PApproval: Identifiable, Equatable { let id: String }
struct PQueued: Identifiable, Equatable { let id: String; let text: String }
struct PStatusCard: Identifiable, Equatable { let id: String; let afterItemID: String? }
struct PDecisionCard: Identifiable, Equatable { let id: String; let afterItemID: String? }
struct ScrollRequest: Equatable { let rowID: String; let tick: Int }

enum PRunStatus: Equatable { case idle, running }

struct TState: Equatable {
    var items: [PItem] = []
    var hasMoreOlder = false
    var oldestSeq: Int? = nil
    var maxSeq = 0
    var status: PRunStatus = .idle
    var pendingApprovals: [PApproval] = []
    var queued: [PQueued] = []
}

/// `TranscriptRow`, same cases and the same id scheme.
enum PRow: Identifiable, Equatable {
    case loadOlder(cursor: Int)
    case item(PItem)
    case toolGroup([PItem])
    case statusCard(PStatusCard)
    case decisionCard(PDecisionCard)
    case approval(PApproval)
    case working
    case queued(PQueued)
    case bottom

    var id: String {
        switch self {
        case .loadOlder(let cursor): return "load-older-\(cursor)"
        case .item(let item):        return item.id
        case .toolGroup(let cards):  return cards.first?.id ?? "tool-group-empty"
        case .statusCard(let card):  return "local-status-\(card.id)"
        case .decisionCard(let card): return card.id
        case .approval(let appr):    return "approval-\(appr.id)"
        case .working:               return "working-indicator"
        case .queued(let bubble):    return "queued-\(bubble.id)"
        case .bottom:                return "transcript-bottom"
        }
    }
}

/// `TranscriptRows.build`, same order: head records, load-earlier, history (+ anchored cards),
/// orphaned cards, trailing questions, approvals, working, queued, bottom; tool runs of 3+ folded;
/// duplicate ids dropped.
enum ProbeRows {
    static func build(state: TState, statusCards: [PStatusCard], canPageOlder: Bool,
                      showWorkingIndicator: Bool, decisionCards: [PDecisionCard]) -> [PRow] {
        var rows: [PRow] = []
        var anchored: [String: [PStatusCard]] = [:]
        for card in statusCards {
            guard let anchor = card.afterItemID else { rows.append(.statusCard(card)); continue }
            anchored[anchor, default: []].append(card)
        }
        var anchoredDecisions: [String: [PDecisionCard]] = [:]
        var trailingDecisions: [PDecisionCard] = []
        for card in decisionCards {
            if let anchor = card.afterItemID {
                anchoredDecisions[anchor, default: []].append(card)
            } else {
                trailingDecisions.append(card)
            }
        }
        if canPageOlder { rows.append(.loadOlder(cursor: state.oldestSeq ?? 0)) }
        for item in state.items {
            rows.append(.item(item))
            for card in anchored.removeValue(forKey: item.id) ?? [] { rows.append(.statusCard(card)) }
            for card in anchoredDecisions.removeValue(forKey: item.id) ?? [] { rows.append(.decisionCard(card)) }
        }
        for card in statusCards where card.afterItemID.map({ anchored[$0] != nil }) == true {
            rows.append(.statusCard(card))
        }
        for card in decisionCards {
            guard let anchor = card.afterItemID, anchoredDecisions[anchor] != nil else { continue }
            trailingDecisions.append(card)
        }
        rows.append(contentsOf: trailingDecisions.map(PRow.decisionCard))
        rows.append(contentsOf: state.pendingApprovals.map(PRow.approval))
        if showWorkingIndicator { rows.append(.working) }
        rows.append(contentsOf: state.queued.map(PRow.queued))
        rows.append(.bottom)
        var seen = Set<String>()
        return groupToolRuns(rows).filter { seen.insert($0.id).inserted }
    }

    static func groupToolRuns(_ rows: [PRow]) -> [PRow] {
        var out: [PRow] = []
        var run: [PItem] = []
        func flush() {
            if run.count >= 3 {
                out.append(.toolGroup(run))
            } else {
                out.append(contentsOf: run.map { PRow.item($0) })
            }
            run.removeAll()
        }
        for row in rows {
            if case .item(let item) = row, item.kind == .tool {
                run.append(item)
            } else {
                flush()
                out.append(row)
            }
        }
        flush()
        return out
    }
}

@Observable @MainActor
final class FakeRegistry {
    private(set) var models: [String: FakeConsole] = [:]
    private var streamingSessionID: String?

    func peek(_ sessionID: String) -> FakeConsole? { models[sessionID] }

    /// `ConsoleRegistry.focus`: one streaming console; the previous one stops.
    func focus(_ sessionID: String?) {
        guard sessionID != streamingSessionID else { return }
        if let prev = streamingSessionID { models[prev]?.stopStreaming() }
        streamingSessionID = sessionID
        guard let sessionID else { return }
        let model = models[sessionID] ?? FakeConsole(sessionID: sessionID)
        models[sessionID] = model
        model.startStreaming()
    }
}

@Observable @MainActor
final class FakeConsole {
    let sessionID: String
    private(set) var state = TState()
    private(set) var stateRevision = 0
    private(set) var localSendTick = 0
    private(set) var localStatusCards: [PStatusCard] = []
    private(set) var decisionCards: [PDecisionCard] = []
    private(set) var scrollRequest: ScrollRequest?
    private(set) var recordRequest: ScrollRequest?
    private(set) var highlightedRowID: String?
    private(set) var newerCursor: Int?
    var detached: Bool { newerCursor != nil }
    private(set) var sending = false
    private(set) var awaitingReply = false
    /// Probe-only: "press" the sticky header / the jump-to-latest disc. The view runs the button's
    /// own action on a tick (the actions need the ScrollViewProxy, which only the view holds).
    private(set) var probeStickyTick = 0
    private(set) var probeJumpTick = 0

    private var reducer = TState()
    private var publishScheduled = false
    private var prependAnchorID: String?
    private var readingHistory = false
    private(set) var loadingOlder = false
    private(set) var loadingNewer = false
    private var jumpingToLatest = false
    private var scrollTick = 0
    private var highlightGeneration = 0
    private var streamTask: Task<Void, Never>?
    private var nextID = 0
    private var newerPagesLeft = 0
    private var steps: [Step] = []
    private var rng: SplitMix

    static let maxWindowItems = 1000
    static let windowTrimSlack = 200

    init(sessionID: String) {
        self.sessionID = sessionID
        var seed = Probe.seed
        for b in sessionID.utf8 { seed = seed &* 31 &+ UInt64(b) }
        rng = SplitMix(seed: seed)
        let restored = Self.restoredCount(sessionID: sessionID, rng: &rng)
        if restored > 0 {
            reducer.items = makeItems(restored, firstSeq: 5_000)
            reducer.maxSeq = reducer.items.last?.seq ?? 0
            reducer.oldestSeq = reducer.items.first?.seq
            reducer.hasMoreOlder = true
            state = reducer   // `ConsoleModel.init(restoring:)` renders the persisted window at once
        }
        Trace.shared.log("CONSOLE \(sessionID) restored=\(restored)")
    }

    /// How big the persisted window is at launch. Over 1200 = the app was backgrounded while the
    /// reader was up in the history (the cap is suspended then, and `persistAll` saves what's there).
    private static func restoredCount(sessionID: String, rng: inout SplitMix) -> Int {
        switch sessionID {
        case "s-big": return 1000
        case "s-small": return 150
        default: break
        }
        switch Probe.scenario {
        case "cold": return 0
        case "warm": return 600
        case "overcap": return 1400
        case "trim": return 1190
        case "resync": return 1100
        case "record": return 800
        case "history": return 900
        case "fuzz": return [0, 200, 650, 1000, 1150, 1350][rng.int(0, 5)]
        case "press": return 700
        default: return 600
        }
    }

    // MARK: rows / indicator (as `ConsoleModel`)

    var showWorkingIndicator: Bool {
        guard sending || awaitingReply || state.status == .running else { return false }
        guard state.pendingApprovals.isEmpty else { return false }
        guard let last = state.items.last else { return true }
        switch last.kind {
        case .assistant, .thinking: return last.finalized
        case .tool: return !last.running
        case .user: return true
        }
    }

    func linkCardsRefreshStale() {}
    func noteTopVisible(_ id: String?) {}

    // MARK: publish (copied semantics)

    private func scheduleStatePublish() {
        guard !publishScheduled else { return }
        publishScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let self else { return }
            self.publishStateNow()
        }
    }

    private func publishStateNow() {
        publishScheduled = false
        let trimmed = trimWindow()
        stateRevision &+= 1
        let before = state.items.count
        state = reducer
        Stats.publishes += 1
        Trace.shared.log("PUBLISH \(sessionID) rev=\(stateRevision) items \(before)->\(state.items.count)"
                         + (trimmed ? " TRIMMED" : "") + " approvals=\(state.pendingApprovals.count) "
                         + "queued=\(state.queued.count) status=\(state.status) why=\(LastCause.text)")
        clearAwaitingReplyIfSatisfied()
    }

    private func clearAwaitingReplyIfSatisfied() {
        guard awaitingReply else { return }
        var tailIsUnansweredUser = false
        if let last = state.items.last, last.kind == .user { tailIsUnansweredUser = true }
        if state.status == .running || !tailIsUnansweredUser { awaitingReply = false }
    }

    func setReadingHistory(_ reading: Bool) {
        readingHistory = reading
        if Probe.fix == "route" {
            // Candidate fix: not from inside the transcript's update — a scroll issued later in the
            // same dispatch would be resolved against the rows this trim is about to remove.
            guard !reading else { return }
            Task { @MainActor [weak self] in
                guard let self, !self.readingHistory, self.trimWindow() else { return }
                LastCause.text = "setReadingHistory(false) trim (next turn)"
                self.publishStateNow()
            }
            return
        }
        if !reading, trimWindow() {
            LastCause.text = "setReadingHistory(false) trim"
            publishStateNow()
        }
    }

    /// `TranscriptReducer.trimOlder(keeping: 1000, slack: 200)` behind `ConsoleModel.trimWindow`.
    @discardableResult
    private func trimWindow() -> Bool {
        guard #available(iOS 18, macOS 15, *) else { return false }
        guard !readingHistory, !loadingOlder else { return false }
        guard reducer.items.count > Self.maxWindowItems + Self.windowTrimSlack else { return false }
        let split = reducer.items.count - Self.maxWindowItems
        // Never cut into a bubble still being streamed into (`openAssistant`/`openThinking`).
        let firstOpen = reducer.items.firstIndex(where: { !$0.finalized }) ?? Int.max
        guard split <= firstOpen else { return false }
        reducer.items.removeFirst(split)
        reducer.oldestSeq = reducer.items.first?.seq
        reducer.hasMoreOlder = true
        return true
    }

    func takePrependAnchor() -> String? {
        defer { prependAnchorID = nil }
        return prependAnchorID
    }

    // MARK: paging (copied semantics; the network is a sleep)

    func loadOlder() async {
        guard !loadingOlder, state.hasMoreOlder, let before = state.oldestSeq else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        try? await Task.sleep(nanoseconds: UInt64(rng.int(200, 600)) * 1_000_000)
        let count = min(200, max(0, before - 1))
        let page = makeItems(count, firstSeq: before - count, prefix: "o\(before)-")
        let anchor = reducer.items.first?.id
        reducer.items = page + reducer.items
        reducer.oldestSeq = page.first?.seq ?? reducer.oldestSeq
        reducer.hasMoreOlder = (page.first?.seq ?? 1) > 1
        if let anchor, reducer.items.first?.id != anchor { prependAnchorID = anchor }
        LastCause.text = "loadOlder +\(page.count)"
        publishStateNow()
    }

    func loadNewer() async {
        guard !loadingNewer, !jumpingToLatest, let after = newerCursor else { return }
        loadingNewer = true
        defer { loadingNewer = false }
        try? await Task.sleep(nanoseconds: UInt64(rng.int(200, 600)) * 1_000_000)
        guard !jumpingToLatest, newerCursor == after else { return }
        reducer.items += makeItems(200, firstSeq: after + 1)
        reducer.maxSeq = reducer.items.last?.seq ?? reducer.maxSeq
        newerPagesLeft -= 1
        newerCursor = newerPagesLeft > 0 ? reducer.maxSeq : nil
        LastCause.text = "loadNewer +200 detached=\(detached)"
        publishStateNow()
    }

    func jumpToLatest() async {
        guard detached, !jumpingToLatest else { return }
        jumpingToLatest = true
        defer { jumpingToLatest = false }
        reducer = TState(status: reducer.status)
        await seedTailPage()
        newerCursor = nil
        LastCause.text = "jumpToLatest"
        publishStateNow()
    }

    func recordRequestFollowed(_ request: ScrollRequest) {
        recordRequest = nil
        highlightedRowID = request.rowID
        highlightGeneration += 1
        let generation = highlightGeneration
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            guard let self, self.highlightGeneration == generation else { return }
            self.highlightedRowID = nil
        }
    }

    // MARK: the stream loop (`ConsoleModel.run()`)

    func startStreaming() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in await self?.run() }
    }

    func stopStreaming() {
        readingHistory = false
        streamTask?.cancel()
        streamTask = nil
    }

    private func pause(_ lo: Int, _ hi: Int) async {
        try? await Task.sleep(nanoseconds: UInt64(rng.int(lo, hi)) * 1_000_000)
    }

    private func run() async {
        // The open's seeds, each publishing on its own when its read comes back.
        Task { [weak self] in
            guard let self else { return }
            await self.pause(120, 700)
            if self.rng.chance(0.35) { self.reducer.pendingApprovals = [PApproval(id: "ap-seed")] }
            LastCause.text = "refreshApprovals"
            self.publishStateNow()
        }
        Task { [weak self] in
            guard let self else { return }
            await self.pause(120, 700)
            if self.rng.chance(0.35) { self.reducer.queued = [PQueued(id: "q-seed", text: "follow-up")] }
            LastCause.text = "refreshQueuedTurns"
            self.publishStateNow()
        }
        Task { [weak self] in
            guard let self else { return }
            await self.pause(300, 1500)
            self.decisionCards = [PDecisionCard(id: "decision-1", afterItemID: self.reducer.items.dropLast(3).last?.id)]
            LastCause.text = "decisionCards read"
            Trace.shared.log("DECISIONS \(self.sessionID) n=\(self.decisionCards.count)")
        }

        if sessionID == "s-main" && Probe.scenario == "press" {
            // Churn: an approval row that comes and goes at the tail, published on its own, often
            // enough that a publish is usually pending when a tap's main-queue hop runs.
            Task { [weak self] in
                while let self, !Task.isCancelled {
                    await self.pause(6, 22)
                    LastCause.text = "churn approval"
                    self.reducer.pendingApprovals = self.reducer.pendingApprovals.isEmpty
                        ? [PApproval(id: "ap-churn")] : []
                    self.publishStateNow()
                }
            }
        }
        if sessionID == "s-main" && Probe.scenario == "record" {
            await openAtRecord()
        } else if reducer.items.isEmpty {
            await seedTailPage()
        }
        if Task.isCancelled { return }

        let opened = Date()
        var lastScripted = Date()
        while !Task.isCancelled {
            await pause(25, 90)
            if Task.isCancelled { return }
            if detached { continue }   // held off the stream while a record window has a gap
            streamStep()
            if sessionID == "s-main" {
                await scenarioBeat(since: opened, last: &lastScripted)
            }
        }
    }

    private func seedTailPage() async {
        await pause(250, 900)
        let start = (reducer.maxSeq > 0 ? reducer.maxSeq : 9_000) + 1
        reducer.items = makeItems(200, firstSeq: start)
        reducer.maxSeq = reducer.items.last?.seq ?? 0
        reducer.oldestSeq = reducer.items.first?.seq
        reducer.hasMoreOlder = true
        LastCause.text = "seedTailPage 200"
        publishStateNow()
    }

    private func openAtRecord() async {
        await pause(400, 900)
        newerPagesLeft = 2
        reducer = TState(status: reducer.status)
        reducer.items = makeItems(200, firstSeq: 2_000, prefix: "r-")
        reducer.oldestSeq = reducer.items.first?.seq
        reducer.maxSeq = reducer.items.last?.seq ?? 0
        reducer.hasMoreOlder = true
        newerCursor = reducer.maxSeq
        LastCause.text = "openRecord page"
        publishStateNow()
        scrollTick += 1
        let target = reducer.items[100].id
        recordRequest = ScrollRequest(rowID: target, tick: scrollTick)
        Trace.shared.log("RECORD request \(target)")
    }

    /// The per-scenario interventions on top of the plain stream.
    private func scenarioBeat(since opened: Date, last: inout Date) async {
        let now = Date()
        switch Probe.scenario {
        case "trim":
            // A catch-up replay after a long gap: bursts of events, each publish crossing the cap.
            if now.timeIntervalSince(last) > 0.35 {
                last = now
                burst(rng.int(30, 90))
            }
        case "resync":
            if now.timeIntervalSince(last) > 2.5 {
                last = now
                await resync()
            }
        case "history":
            if now.timeIntervalSince(last) > 4.5 {
                last = now
                await historyCycle()
            }
        case "fuzz":
            if rng.chance(0.10) { await fuzzOp() }
        case "press":
            // The three taps whose scroll takes a main-queue hop in the shipped view.
            switch rng.int(0, 99) {
            case 0..<50:
                LastCause.text = "jump press"
                probeJumpTick += 1
            case 50..<75:
                LastCause.text = "needs-you press"
                scrollTick += 1
                let target = state.pendingApprovals.first.map { "approval-\($0.id)" }
                    ?? state.items.dropLast(rng.int(0, 3)).last?.id ?? "transcript-bottom"
                scrollRequest = ScrollRequest(rowID: target, tick: scrollTick)
            default:
                LastCause.text = "sticky press"
                probeStickyTick += 1
            }
        default:
            // Plain streaming, with an occasional send and /status card.
            if now.timeIntervalSince(last) > 3 {
                last = now
                send()
            }
        }
    }

    // MARK: operations (each one a thing `ConsoleModel` really does)

    private func resync() async {
        LastCause.text = "resync reset"
        reducer = TState(status: reducer.status)   // `resetForResync`: not published on its own
        await seedTailPage()
    }

    private func historyCycle() async {
        LastCause.text = "sticky press"
        probeStickyTick += 1                           // atBottom = false, scroll up to a question
        await pause(300, 700)
        for _ in 0..<3 { await loadOlder() }           // the reader pages up: the cap is suspended
        await pause(200, 600)
        LastCause.text = "jump press"
        probeJumpTick += 1                             // atBottom = true → trim + follow
    }

    private func send() {
        LastCause.text = "send"
        localSendTick &+= 1
        sending = true
        reducer.items.append(item(.user, "a new question for the agent — " + words(rng.int(4, 30))))
        publishStateNow()
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self else { return }
            self.sending = false
            self.awaitingReply = true
            self.reducer.status = .running
            self.scheduleStatePublish()
        }
    }

    private func burst(_ n: Int) {
        LastCause.text = "burst +\(n)"
        reducer.items += makeItems(n, firstSeq: reducer.maxSeq + 1)
        reducer.maxSeq = reducer.items.last?.seq ?? reducer.maxSeq
        scheduleStatePublish()
    }

    private func fuzzOp() async {
        switch rng.int(0, 99) {
        case 0..<8: send()
        case 8..<13:
            LastCause.text = "status card"
            localStatusCards.append(PStatusCard(id: "sc\(nextID)", afterItemID: reducer.items.last?.id))
            nextID += 1
        case 13..<19:
            LastCause.text = "approval toggle"
            reducer.pendingApprovals = reducer.pendingApprovals.isEmpty ? [PApproval(id: "ap\(nextID)")] : []
            nextID += 1
            publishStateNow()
        case 19..<25:
            LastCause.text = "queued toggle"
            reducer.queued = reducer.queued.isEmpty ? [PQueued(id: "q\(nextID)", text: "later")] : []
            nextID += 1
            publishStateNow()
        case 25..<31:
            LastCause.text = "decision toggle"
            decisionCards = decisionCards.isEmpty
                ? [PDecisionCard(id: "decision-\(nextID)", afterItemID: rng.chance(0.5) ? reducer.items.last?.id : nil)]
                : []
            nextID += 1
        case 31..<39: burst(rng.int(20, 160))
        case 39..<42: await resync()
        case 42..<47:
            LastCause.text = "needs-you press"
            scrollTick += 1
            let target = decisionCards.first?.id ?? state.items.dropLast(rng.int(0, 40)).last?.id ?? "transcript-bottom"
            scrollRequest = ScrollRequest(rowID: target, tick: scrollTick)
        case 47..<53:
            LastCause.text = "sticky press"
            probeStickyTick += 1
        case 53..<59:
            LastCause.text = "jump press"
            probeJumpTick += 1
        case 59..<62:
            await openAtRecord()
        case 62..<67:
            if readingHistory { await loadOlder() }
        case 67..<72:
            LastCause.text = "double publish"
            reducer.items.append(item(.assistant, words(rng.int(5, 40))))
            publishStateNow()
            reducer.items.append(item(.tool, "Bash: ls -la", running: true))
            publishStateNow()
        case 72..<77:
            LastCause.text = "decision + publish"
            decisionCards = [PDecisionCard(id: "decision-\(nextID)", afterItemID: reducer.items.last?.id)]
            nextID += 1
            reducer.items.append(item(.assistant, words(rng.int(5, 40))))
            publishStateNow()
        default:
            break
        }
    }

    // MARK: a synthetic agent turn

    private enum Step { case userTurn, thinkStart, thinkDelta, thinkEnd, textStart, textDelta, textEnd,
                        toolStart, toolEnd, turnEnd }

    private func refillSteps() {
        var s: [Step] = []
        if rng.chance(0.4) { s.append(.userTurn) }
        s.append(.thinkStart)
        s += Array(repeating: Step.thinkDelta, count: rng.int(3, 12))
        s.append(.thinkEnd)
        for _ in 0..<rng.int(1, 3) {
            if rng.chance(0.5) {
                s.append(.textStart)
                s += Array(repeating: Step.textDelta, count: rng.int(2, 8))
                s.append(.textEnd)
            }
            for _ in 0..<rng.int(1, 6) { s += [.toolStart, .toolEnd] }
        }
        s.append(.textStart)
        s += Array(repeating: Step.textDelta, count: rng.int(4, 20))
        s += [.textEnd, .turnEnd]
        steps = s
    }

    private func streamStep() {
        if steps.isEmpty { refillSteps() }
        let step = steps.removeFirst()
        LastCause.text = "stream \(step)"
        switch step {
        case .userTurn:
            reducer.items.append(item(.user, "question — " + words(rng.int(4, 25))))
            reducer.status = .running
        case .thinkStart:
            reducer.items.append(item(.thinking, "", finalized: false))
            reducer.status = .running
        case .thinkDelta: extendOpen(.thinking)
        case .thinkEnd: finalizeOpen(.thinking)
        case .textStart: reducer.items.append(item(.assistant, "", finalized: false))
        case .textDelta: extendOpen(.assistant)
        case .textEnd: finalizeOpen(.assistant)
        case .toolStart: reducer.items.append(item(.tool, "Bash: run step \(nextID)", running: true))
        case .toolEnd:
            if let i = reducer.items.lastIndex(where: { $0.kind == .tool && $0.running }) {
                reducer.items[i].running = false
            }
        case .turnEnd:
            reducer.status = .idle
        }
        reducer.maxSeq += 1
        scheduleStatePublish()
    }

    private func extendOpen(_ kind: PItem.Kind) {
        if let i = reducer.items.lastIndex(where: { $0.kind == kind && !$0.finalized }) {
            reducer.items[i].text += words(rng.int(3, 14))
        }
    }

    private func finalizeOpen(_ kind: PItem.Kind) {
        if let i = reducer.items.lastIndex(where: { $0.kind == kind && !$0.finalized }) {
            reducer.items[i].finalized = true
        }
    }

    // MARK: item factory

    private func item(_ kind: PItem.Kind, _ text: String, finalized: Bool = true, running: Bool = false) -> PItem {
        nextID += 1
        reducer.maxSeq += 1
        return PItem(id: "i\(nextID)", seq: reducer.maxSeq, kind: kind, text: text,
                     finalized: finalized, running: running)
    }

    private func makeItems(_ n: Int, firstSeq: Int, prefix: String = "") -> [PItem] {
        var out: [PItem] = []
        out.reserveCapacity(n)
        var toolRun = 0
        for k in 0..<n {
            nextID += 1
            let kind: PItem.Kind
            if toolRun > 0 {
                kind = .tool
                toolRun -= 1
            } else {
                switch rng.int(0, 99) {
                case 0..<10: kind = .user
                case 10..<45: kind = .assistant
                case 45..<58: kind = .thinking
                default:
                    kind = .tool
                    toolRun = rng.int(0, 6)
                }
            }
            let text: String
            switch kind {
            case .user: text = "question — " + words(rng.int(3, 30))
            case .assistant: text = words(rng.int(8, 160))
            case .thinking: text = words(rng.int(10, 60))
            case .tool: text = "Bash: step \(nextID)"
            }
            out.append(PItem(id: "\(prefix)i\(nextID)", seq: firstSeq + k, kind: kind, text: text))
        }
        return out
    }

    private static let vocabulary = ["the", "transcript", "list", "scrolls", "to", "its", "tail", "while",
                                     "rows", "arrive", "and", "a", "window", "is", "trimmed", "at", "head"]
    private func words(_ n: Int) -> String {
        var s = ""
        for _ in 0..<n { s += Self.vocabulary[rng.int(0, Self.vocabulary.count - 1)] + " " }
        return s
    }
}
