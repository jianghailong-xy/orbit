import Foundation

// Turns Orbit opened, folded (web parity: `lib/orbitExchangeFold.ts`, `components/OrbitExchangeFold.tsx`
// and the fold rules in `Transcript.tsx` — `orbitTurnOf`, `turnNeedsReader`, `foldOrbitExchanges`;
// design: docs/mocks/coordinator-exchange-fold/, approved 2026-11-11).
//
// A coordinator spends most of its turns on facts Orbit tells it — in one real coordinator 260 of 555
// turns were Orbit's, and the reply under a watch's turn was a median 155 characters saying nothing
// needed doing. Each such turn, with everything the agent did and said under it, is one row:
//
//   → Evidence revision 2 submitted: B1 — 我确认了 B1… · 5:14 PM
//
// and two or more in a row are one group row, `7 Orbit updates handled · 3 evidence, 2 watches ·
// 5:14 PM – 6:44 PM`, which opens to a tree of the tasks they are about. Opening an exchange draws
// exactly the rows the conversation drew before the fold existed.

/// What kind of turn an exchange opened with, as the group row counts them.
public enum ExchangeCategory: String, Equatable, Sendable, CaseIterable {
    case evidence, ready, project, watch, job, notice, message, reply
}

/// What an exchange is about, as far as a tree can place it.
public enum ExchangeTarget: Equatable, Sendable {
    case task(id: String, title: String?)
    case session(id: String, title: String?)
}

/// One turn Orbit opened, and every row the conversation draws for it.
public struct OrbitExchange: Identifiable, Equatable, Sendable {
    /// The turn's opening bubble's id — the row the fold stands in for, and a scroll target.
    public let id: String
    public let ts: String?
    /// What happened, in the words the turn's own line says it in.
    public let what: String
    /// The same with the task's name taken off, for a row drawn under that task.
    public let whatInTask: String?
    /// The first line of the agent's last reply in the turn, as plain text.
    public let reply: String
    public let category: ExchangeCategory
    public let target: ExchangeTarget?
    /// The rows the turn is drawn as when opened: exactly what the conversation drew before.
    public let rows: [TranscriptRow]

    public init(id: String, ts: String?, what: String, whatInTask: String? = nil, reply: String,
                category: ExchangeCategory, target: ExchangeTarget?, rows: [TranscriptRow] = []) {
        self.id = id
        self.ts = ts
        self.what = what
        self.whatInTask = whatInTask
        self.reply = reply
        self.category = category
        self.target = target
        self.rows = rows
    }

    /// Every transcript item id the exchange holds — its opening bubble's and every row's under it —
    /// so a find can tell which exchange a hit sits in.
    public var itemIDs: Set<String> {
        var ids: Set<String> = [id]
        for row in rows {
            switch row {
            case .item(let item): ids.insert(item.id)
            case .steps(let items): items.forEach { ids.insert($0.id) }
            default: ids.insert(row.id)
            }
        }
        return ids
    }
}

/// What the console knows that places an exchange in the tree: which task a session runs, which tasks
/// a task waits on, and a task's title. Each answers nothing it does not know.
public struct ExchangeTreeLookup: Sendable {
    public var taskOfSession: @Sendable (String) -> (id: String, title: String?)?
    public var upstreamOf: @Sendable (String) -> [String]
    public var taskTitle: @Sendable (String) -> String?

    public init(taskOfSession: @escaping @Sendable (String) -> (id: String, title: String?)? = { _ in nil },
                upstreamOf: @escaping @Sendable (String) -> [String] = { _ in [] },
                taskTitle: @escaping @Sendable (String) -> String? = { _ in nil }) {
        self.taskOfSession = taskOfSession
        self.upstreamOf = upstreamOf
        self.taskTitle = taskTitle
    }

    public static let empty = ExchangeTreeLookup()
}

/// A task in a group's tree: its own exchanges, then the tasks after it in the same group.
public struct ExchangeBranch: Identifiable, Equatable, Sendable {
    /// Unique within the tree: the task's id (`idKey`), or `other`.
    public let key: String
    /// The task's id as the exchanges spelled it; nil for the branch of everything else.
    public let taskId: String?
    public var title: String
    public var exchanges: [OrbitExchange]
    public var children: [ExchangeBranch]

    public var id: String { key }
    public var isOther: Bool { key == OrbitExchangeFold.otherKey }
}

public enum OrbitExchangeFold {
    // MARK: Copy (web: OrbitExchangeFold.tsx, lib/orbitExchangeFold.ts — held by OrbitExchangeFoldCopyParityTests)

    public static let otherBranchTitle = "Not about a task"
    static let otherKey = "other"

    /// The group row: `7 Orbit updates handled`.
    public static func groupCount(_ n: Int) -> String { "\(n) Orbit updates handled" }

    /// `1 update` / `3 updates`.
    public static func updates(_ n: Int) -> String { "\(n) \(n == 1 ? "update" : "updates")" }

    /// What a shut branch says under its title: `6 updates · 3 downstream · last: …`.
    public static func branchSummary(_ branch: ExchangeBranch) -> String {
        let every = branchExchanges(branch)
        let below = downstreamCount(branch)
        var parts = [updates(every.count)]
        if below > 0 { parts.append("\(below) downstream") }
        if let last = every.last, !last.reply.isEmpty { parts.append("last: \(last.reply)") }
        return parts.joined(separator: " · ")
    }

    private static let categoryWords: [(ExchangeCategory, String, String)] = [
        (.evidence, "evidence", "evidence"),
        (.ready, "can start", "can start"),
        (.project, "project update", "project updates"),
        (.watch, "watch", "watches"),
        (.job, "background job", "background jobs"),
        (.notice, "run notice", "run notices"),
        (.message, "message", "messages"),
        (.reply, "reply", "replies"),
    ]

    /// What a group holds, counted by kind: `3 evidence, 1 can start, 2 watches`.
    public static func kinds(_ exchanges: [OrbitExchange]) -> String {
        categoryWords.compactMap { category, one, many in
            let n = exchanges.filter { $0.category == category }.count
            return n == 0 ? nil : "\(n) \(n == 1 ? one : many)"
        }.joined(separator: ", ")
    }

    /// Facts a coordinator is told that are bad news: they stay in view, as they always were drawn. A
    /// stopped run is not one of them: in real coordinators every such notice was a run waiting on
    /// purpose, and what needs the owner reaches them as a card of its own.
    public static let loudDeliveries: Set<CoordinatorDelivery.Kind> = [
        .taskDispatchRefused, .projectBlockerRaised,
    ]

    /// A task run's `notify` handed to its coordinator because it could not reach the owner (apiserver
    /// sessions/run-notify.ts `<orbit-run-notice>`): the task it is about, by id and title. Recorded as
    /// the turn's control-plane note with no card beside it, so it is read off the words (web
    /// `parseRunNotice`). Nil for anything else.
    public static func parseRunNotice(_ note: String?) -> (taskId: String?, taskTitle: String?)? {
        guard let note = note?.trimmingCharacters(in: .whitespacesAndNewlines),
              note.contains("</orbit-run-notice>"),
              let head = try? NSRegularExpression(pattern: #"^<orbit-run-notice task="([^"]*)" run-session="[^"]*"[^>]*>\n"#),
              let m = head.firstMatch(in: note, range: NSRange(note.startIndex..., in: note)),
              let idRange = Range(m.range(at: 1), in: note) else { return nil }
        let id = String(note[idRange])
        var title: String?
        if let re = try? NSRegularExpression(pattern: #"A run of the task “([\s\S]*?)” used notify\."#),
           let t = re.firstMatch(in: note, range: NSRange(note.startIndex..., in: note)),
           let r = Range(t.range(at: 1), in: note) {
            title = String(note[r])
        }
        return (id.isEmpty ? nil : id, title)
    }

    // MARK: Reading a turn

    /// Ids compared whichever way each is spelled (uuid or base62).
    public static func idKey(_ id: String) -> String { PublicID.storageKey(id) }

    /// The first line a reply says, as plain text: what a folded row shows of how the agent answered.
    public static func replyGist(_ text: String) -> String {
        let line = text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("```") && !$0.hasPrefix("---") && !$0.hasPrefix("|") } ?? ""
        var out = line
        out = replacing(#"!?\[([^\]]*)\]\([^)]*\)"#, in: out, with: "$1")
        out = replacing(#"^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)"#, in: out, with: "")
        out = replacing(#"(\*\*|__|`)"#, in: out, with: "")
        return out.trimmingCharacters(in: .whitespaces)
    }

    private static func replacing(_ pattern: String, in text: String, with template: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return text }
        return re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    /// What a turn's opening bubble says happened, when Orbit opened the turn and it is one the reader
    /// can be spared: a fact told to a coordinator, a watch or (in a coordinator) a background job
    /// coming back, another session's reply. Nil for everything else, and for those that went wrong — a refused start, a
    /// blocker, a stopped run, a failed target or job, a delivery nobody confirmed — which stay drawn.
    /// `rows` and `reply` are left for the caller to fill.
    public static func orbitTurn(_ bubble: UserBubble,
                                 watchName: ((WatchWake, WatchWakeTarget) -> String?)? = nil,
                                 coordinator: Bool = false) -> OrbitExchange? {
        if bubble.steer || bubble.queued || bubble.undelivered { return nil }
        if bubble.delivery == "failed" || bubble.delivery == "unconfirmed" { return nil }
        if bubble.itemCard != nil || bubble.ownerAnswer != nil
            || bubble.taskStart != nil || bubble.startedCard != nil
            || bubble.reviewRequest != nil || bubble.reviewReturn != nil { return nil }
        let ts = bubble.ts
        // Another session's message: a task's run reporting to its coordinator, folded under that task.
        // The agent's answer under it says what it did; anything the owner must decide comes as a card.
        if let card = bubble.sessionMessage {
            let task: String? = card.fromTaskId == nil ? nil
                : (card.fromTitle.hasPrefix("Task: ") ? String(card.fromTitle.dropFirst("Task: ".count)) : card.fromTitle)
            let target: ExchangeTarget = card.fromTaskId.map { .task(id: $0, title: task) }
                ?? .session(id: card.fromSessionId, title: card.fromTitle)
            return OrbitExchange(id: bubble.id, ts: ts, what: "Message from \(task ?? card.fromTitle)",
                                 whatInTask: "Message", reply: "", category: .message, target: target)
        }
        // A task run's notify that could not reach the owner, handed to the coordinator.
        if let notice = parseRunNotice(bubble.note ?? bubble.text) {
            return OrbitExchange(id: bubble.id, ts: ts,
                                 what: notice.taskTitle.map { "Run notice: \($0)" } ?? "Run notice",
                                 whatInTask: "Run notice", reply: "", category: .notice,
                                 target: notice.taskId.map { .task(id: $0, title: notice.taskTitle) })
        }
        if let replies = bubble.sessionReplies {
            guard bubble.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  replies.count == 1, let reply = replies.first else { return nil }
            return OrbitExchange(id: bubble.id, ts: ts, what: "Reply from \(reply.fromTitle)", reply: "",
                                 category: .reply, target: .session(id: reply.fromSessionId, title: reply.fromTitle))
        }
        if let delivery = bubble.coordinatorDelivery {
            if loudDeliveries.contains(delivery.kind) { return nil }
            let what = CoordinatorDeliveryCard.sentence(delivery)
            let category: ExchangeCategory
            switch delivery.kind {
            case .evidenceSubmitted, .evidenceMovedIn: category = .evidence
            case .dependentReady: category = .ready
            default: category = .project
            }
            return OrbitExchange(
                id: bubble.id, ts: ts, what: what,
                whatInTask: delivery.task.map { what.replacingOccurrences(of: ": \($0.title)", with: "") },
                reply: "", category: category,
                target: delivery.task.map { .task(id: $0.id, title: $0.title) })
        }
        if let wake = WatchWakeText.parse(bubble.text) {
            if WatchWakeCard.isFailed(wake) { return nil }
            let one = wake.changedTargets.count == 1 ? wake.changedTargets.first : nil
            let name = one.flatMap { watchName?(wake, $0) }.flatMap { $0.isEmpty ? nil : $0 }
            let title = WatchWakeCard.title(wake.kind)
            let target: ExchangeTarget? = one.flatMap { t in
                switch t.kind {
                case .task: return .task(id: t.id, title: name)
                case .session: return .session(id: t.id, title: name)
                default: return nil
                }
            }
            return OrbitExchange(id: bubble.id, ts: ts, what: name.map { "\(title): \($0)" } ?? title,
                                 whatInTask: title, reply: "", category: .watch, target: target)
        }
        if let wake = BackgroundWakeText.parse(bubble.note) {
            // Outside a coordinator a background job is the agent's work on what the reader asked: its
            // turns are the answer, not news about it, so they stay drawn (owner, 2026-11-12).
            guard coordinator else { return nil }
            if wake.jobs.contains(where: BackgroundWakeCard.isFailed) { return nil }
            let title = BackgroundWakeCard.title(wake)
            let name = BackgroundWakeCard.lineName(wake)
            return OrbitExchange(id: bubble.id, ts: ts, what: name.map { "\(title): \($0)" } ?? title,
                                 reply: "", category: .job, target: nil)
        }
        return nil
    }

    /// A call that asks the owner something: the turn it is in stays in view whatever opened it.
    static func asksOwner(_ name: String) -> Bool {
        for verb in ["ask_owner", "request_owner_action"] {
            if name == verb || name.hasSuffix("__\(verb)") || name.hasSuffix(".\(verb)") { return true }
        }
        return false
    }

    private static func needsReader(_ item: TranscriptItem) -> Bool {
        switch item {
        case .error, .authError: return true
        case .toolCall(let card): return asksOwner(card.name)
        default: return false
        }
    }

    // MARK: Folding the rows

    private enum Segment {
        case loose(TranscriptRow)
        case turn(head: UserBubble, rows: [TranscriptRow])
    }

    /// A message that opens a turn of its own: not a steer written into a running one, and not the
    /// queue's.
    private static func opensTurn(_ row: TranscriptRow) -> UserBubble? {
        guard case .item(.user(let bubble)) = row, !bubble.steer, !bubble.queued else { return nil }
        return bubble
    }

    /// Rows a turn is drawn with. Anything else — the load-earlier row, the recap, an approval, the
    /// working indicator, the queue, the tail — ends the turn and is never folded.
    private static func belongsToTurn(_ row: TranscriptRow) -> Bool {
        switch row {
        case .item, .turnHead, .steps, .statusCard, .decisionCard: return true
        default: return false
        }
    }

    /// The rows cut into turns, with the turns Orbit opened folded, runs of them together. The last
    /// turn never folds: it is what the reader opened the conversation to see, and it may still be
    /// running. A turn with a card of its own drawn inside it — a question, a status card — is never
    /// folded either: a fold would hide something that is waiting on somebody.
    public static func fold(_ rows: [TranscriptRow],
                            watchName: ((WatchWake, WatchWakeTarget) -> String?)? = nil,
                            coordinator: Bool = false) -> [TranscriptRow] {
        var segments: [Segment] = []
        var open: (head: UserBubble, rows: [TranscriptRow])?
        func close() {
            if let turn = open { segments.append(.turn(head: turn.head, rows: turn.rows)) }
            open = nil
        }
        for row in rows {
            if let head = opensTurn(row) {
                close()
                open = (head, [row])
            } else if open != nil, belongsToTurn(row) {
                open!.rows.append(row)
            } else {
                close()
                segments.append(.loose(row))
            }
        }
        close()
        let lastTurn = segments.lastIndex { if case .turn = $0 { return true } else { return false } }

        var out: [TranscriptRow] = []
        var run: [OrbitExchange] = []
        func flush() {
            if !run.isEmpty { out.append(.exchanges(run)) }
            run.removeAll()
        }
        for (index, segment) in segments.enumerated() {
            switch segment {
            case .loose(let row):
                flush()
                out.append(row)
            case .turn(let head, let turnRows):
                if index != lastTurn, let exchange = folded(head: head, rows: turnRows, watchName: watchName,
                                                                coordinator: coordinator) {
                    run.append(exchange)
                } else {
                    flush()
                    out.append(contentsOf: turnRows)
                }
            }
        }
        flush()
        return out
    }

    private static func folded(head: UserBubble, rows: [TranscriptRow],
                               watchName: ((WatchWake, WatchWakeTarget) -> String?)?,
                               coordinator: Bool) -> OrbitExchange? {
        guard let orbit = orbitTurn(head, watchName: watchName, coordinator: coordinator) else { return nil }
        var replies: [String] = []
        for row in rows {
            switch row {
            case .item(let item):
                if needsReader(item) { return nil }
                if case .assistant(let bubble) = item,
                   !bubble.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    replies.append(bubble.text)
                }
            case .steps(let items):
                if items.contains(where: needsReader) { return nil }
            case .statusCard, .decisionCard:
                return nil
            default:
                break
            }
        }
        // An exchange is the turn and its answer: one the agent has not answered yet is already the
        // single line its card draws, and folding it would only take that line away.
        guard let last = replies.last else { return nil }
        return OrbitExchange(id: orbit.id, ts: orbit.ts, what: orbit.what, whatInTask: orbit.whatInTask,
                             reply: replyGist(last), category: orbit.category, target: orbit.target, rows: rows)
    }

    // MARK: The tree

    /// A group's exchanges as a tree of the tasks they are about: each exchange under its task, and a
    /// task under the task it waits on when that task is in the same group too (the first one to
    /// appear, when it waits on several). A task whose prerequisites are not in the group is a root.
    /// Exchanges about no task — a background job, a session no task is known to run — gather in one
    /// branch, last. Nil when the group is about one thing only.
    public static func tree(_ exchanges: [OrbitExchange], lookup: ExchangeTreeLookup) -> [ExchangeBranch]? {
        var branches: [String: ExchangeBranch] = [:]
        var order: [String] = []
        var other: [OrbitExchange] = []
        for exchange in exchanges {
            var key: String
            var taskId: String?
            var title: String?
            switch exchange.target {
            case .task(let id, let t)?:
                key = idKey(id); taskId = id; title = t
            case .session(let id, _)?:
                // A session no task is known to run (a landing, another project's conversation)
                // places nothing: it joins everything else rather than a branch named after an id.
                guard let task = lookup.taskOfSession(id) else {
                    other.append(exchange)
                    continue
                }
                key = idKey(task.id); taskId = task.id; title = task.title
            case nil:
                other.append(exchange)
                continue
            }
            if branches[key] == nil {
                let named = title ?? taskId.flatMap(lookup.taskTitle) ?? ""
                branches[key] = ExchangeBranch(key: key, taskId: taskId, title: named, exchanges: [], children: [])
                order.append(key)
            }
            if branches[key]!.title.isEmpty, let title, !title.isEmpty { branches[key]!.title = title }
            branches[key]!.exchanges.append(exchange)
        }
        if order.count + (other.isEmpty ? 0 : 1) < 2 { return nil }

        // Who goes under whom, by key; children keep the order their first exchange arrived in.
        var parent: [String: String] = [:]
        func isBelow(_ candidate: String, _ key: String) -> Bool {
            var at = parent[candidate]
            while let up = at {
                if up == key { return true }
                at = parent[up]
            }
            return false
        }
        for key in order {
            var branch = branches[key]!
            if branch.title.isEmpty, let raw = branch.taskId {
                branch.title = "Task \(String(PublicID.toPublic(raw).suffix(8)))"
                branches[key] = branch
            }
            guard let taskId = branch.taskId else { continue }
            let prerequisites = Set(lookup.upstreamOf(taskId).map(idKey))
            if let up = order.first(where: { $0 != key && prerequisites.contains($0) && !isBelow($0, key) }) {
                parent[key] = up
            }
        }
        func build(_ key: String) -> ExchangeBranch {
            var branch = branches[key]!
            branch.children = order.filter { parent[$0] == key }.map(build)
            return branch
        }
        var roots = order.filter { parent[$0] == nil }.map(build)
        if !other.isEmpty {
            roots.append(ExchangeBranch(key: otherKey, taskId: nil, title: otherBranchTitle, exchanges: other, children: []))
        }
        return roots
    }

    /// Every exchange a branch holds, its own and its descendants', in conversation order.
    public static func branchExchanges(_ branch: ExchangeBranch) -> [OrbitExchange] {
        var all: [OrbitExchange] = []
        func walk(_ b: ExchangeBranch) {
            all.append(contentsOf: b.exchanges)
            b.children.forEach(walk)
        }
        walk(branch)
        return all.sorted { ($0.ts ?? "") < ($1.ts ?? "") }
    }

    /// How many tasks sit below a branch, at any depth.
    public static func downstreamCount(_ branch: ExchangeBranch) -> Int {
        branch.children.reduce(0) { $0 + 1 + downstreamCount($1) }
    }

    /// Which tasks each task waits on, read off a project's dependency graph: a straight run is one
    /// mark whose members wait on each other in order, and an edge between marks joins the last task
    /// of the one to the first of the other. A motif stands for many instances, so it places nothing.
    public static func upstream(from graph: ProjectDependencyGraph?) -> ExchangeTreeLookup {
        var up: [String: [String]] = [:]
        var titles: [String: String] = [:]
        var first: [String: String] = [:]
        var last: [String: String] = [:]
        func add(_ task: String, _ prerequisite: String) { up[idKey(task), default: []].append(prerequisite) }
        for mark in graph?.marks ?? [] {
            switch mark.kind {
            case .task:
                guard let taskId = mark.taskId else { continue }
                titles[idKey(taskId)] = mark.title
                first[mark.id] = taskId
                last[mark.id] = taskId
            case .run, .settled:
                for (i, member) in mark.members.enumerated() {
                    titles[idKey(member.taskId)] = member.title
                    if mark.kind == .run, i > 0 { add(member.taskId, mark.members[i - 1].taskId) }
                }
                if let head = mark.members.first, let tail = mark.members.last {
                    first[mark.id] = head.taskId
                    last[mark.id] = tail.taskId
                }
            default:
                continue
            }
        }
        for edge in graph?.edges ?? [] {
            if let from = last[edge.sourceMarkId], let to = first[edge.targetMarkId] { add(to, from) }
        }
        let frozenUp = up
        let frozenTitles = titles
        return ExchangeTreeLookup(
            upstreamOf: { frozenUp[idKey($0)] ?? [] },
            taskTitle: { frozenTitles[idKey($0)] })
    }
}
