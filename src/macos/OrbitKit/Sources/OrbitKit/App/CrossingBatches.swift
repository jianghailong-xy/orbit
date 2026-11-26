import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   CROSS-PROJECT REQUESTS AS A DECISION CARD IN THE TARGET PROJECT'S COORDINATOR CONVERSATION
   ─────────────────────────────────────────────────────────────────────────────────────────────

   The crossings `GET /projects/:id/handoffs` lists (`ProjectCrossings`) that ask THIS project —
   the target end — to take work in: moves, filings and dependencies. The conversation that
   coordinates the project draws them as one card per batch, built like the criteria decision card
   (board `docs/mocks/handoff-in-chat/01-board.html`, ③–⑤; spec of task 34vT0PEhdlq1lILqsg2WG).

   A move that names no target (`toProjectId == nil`) leaves this project instead of joining one.
   It is answered in the SOURCE project's coordinator conversation, so that conversation batches it
   too — apart from the batches moving work in, even from the same source and of the same kind. No
   other project's conversation draws it.

   A batch is what one agent asked in one go: rows from the same source project, of the same kind,
   asked while the batch was still open. One press answers every row of it still pending — one
   decision POST each, each with its own crossing key — through the project page's door.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/// One batch of crossings into this project: same source, same kind, asked while still open.
public struct CrossingBatch: Equatable, Sendable, Identifiable {
    /// How a fully answered batch went.
    public enum Verdict: Equatable, Sendable {
        case approved, refused, mixed
    }

    /// `crossing-batch-` + the first row's id — the card's id too.
    public let id: String
    public let kind: String
    /// The rows, oldest first. Never empty.
    public let rows: [ProjectCrossing]
    /// Whether this card is drawn in the conversation that answers it (the TARGET project's, or for
    /// a move out the source's). False in the session that asked: there "here" is not the project
    /// the work goes into, and the copy names it instead.
    public let inTarget: Bool
    /// A batch of moves that take their tasks out of the source project, answered in the source
    /// project's coordinator conversation. False for work moving into a project.
    public let out: Bool

    public init(id: String, kind: String, rows: [ProjectCrossing], inTarget: Bool = true, out: Bool = false) {
        self.id = id
        self.kind = kind
        self.rows = rows
        self.inTarget = inTarget
        self.out = out
    }

    /// Where the card is placed in the transcript: when the first row was asked.
    public var moment: String { rows.first?.requestedAt ?? "" }
    public var pending: [ProjectCrossing] { rows.filter { ProjectCrossings.isAnswerable($0.state) } }
    public var answered: Bool { pending.isEmpty }
    public var isLive: Bool { !answered }

    /// Nil while some row still waits.
    public var verdict: Verdict? {
        guard answered else { return nil }
        if rows.allSatisfy({ $0.state == "APPROVED" || $0.state == "APPLIED" }) { return .approved }
        if rows.allSatisfy({ $0.state == "DENIED" }) { return .refused }
        return .mixed
    }

    /// The latest answer's clock.
    public var decidedAt: String? {
        rows.compactMap(\.decidedAt).max { CrossingBatches.isEarlier($0, $1) }
    }

    /// The source project, by name only.
    public var sourceTitle: String {
        rows.first?.fromProject?.title ?? ProjectCrossings.unnamedProject
    }
}

public enum CrossingBatches {

    public static let fileKind = "FILE_TASK"
    public static let dependKind = "DEPEND_ON_TASK"
    public static let idPrefix = "crossing-batch-"

    // MARK: the batches

    /// Whether `row` asks `projectID` — the target end — rather than being asked by it.
    public static func targets(_ row: ProjectCrossing, projectID: String) -> Bool {
        row.toProjectId == projectID || row.toProjectPublicId == projectID
    }

    /// Whether `row` takes its task out of `projectID` — the source end of a `MOVE_TASK` that names
    /// no target. Such a row is answered in the source project's coordinator conversation.
    public static func leaves(_ row: ProjectCrossing, projectID: String) -> Bool {
        row.isToNoProject && row.kind == ProjectCrossings.moveKind
            && (row.fromProjectId == projectID || row.fromProjectPublicId == projectID)
    }

    /// The batches this project's coordinator conversation draws, oldest first: the crossings into
    /// it and the moves out of it.
    ///
    /// Rows are grouped by direction, source project and kind; within a group, oldest first, a row
    /// joins the batch before it while that batch is still open at the row's `requestedAt` — some
    /// member not yet answered, or answered after the row was asked. Otherwise the row starts a new
    /// batch. The direction is part of the key, so a move out never joins a move in from the same
    /// source.
    public static func batches(_ rows: [ProjectCrossing], projectID: String) -> [CrossingBatch] {
        var groups: [String: [ProjectCrossing]] = [:]
        var groupOrder: [String] = []
        for row in rows {
            let direction: String
            if targets(row, projectID: projectID) {
                direction = "in"
            } else if leaves(row, projectID: projectID) {
                direction = "out"
            } else {
                continue
            }
            // The move card is answered through the session's batch door, which takes one asker's
            // moves out of one project into another; grouping by asker keeps one card = one answer.
            let asker = row.kind == ProjectCrossings.moveKind ? (row.requestedBySession?.id ?? "") : ""
            let key = "\(direction)\u{1F}\(row.fromProjectId)\u{1F}\(row.kind)\u{1F}\(asker)"
            if groups[key] == nil { groupOrder.append(key) }
            groups[key, default: []].append(row)
        }
        var batches: [CrossingBatch] = []
        for key in groupOrder {
            let isOut = key.hasPrefix("out\u{1F}")
            let sorted = groups[key, default: []].enumerated()
                .sorted { isEarlier($0.element.requestedAt, $1.element.requestedAt)
                    || ($0.element.requestedAt == $1.element.requestedAt && $0.offset < $1.offset) }
                .map(\.element)
            var current: [ProjectCrossing] = []
            for row in sorted {
                let open = current.contains { member in
                    guard let decided = member.decidedAt else { return true }
                    return isEarlier(row.requestedAt, decided)
                }
                if current.isEmpty || open {
                    current.append(row)
                } else {
                    batches.append(batch(current, out: isOut))
                    current = [row]
                }
            }
            if !current.isEmpty { batches.append(batch(current, out: isOut)) }
        }
        return batches.enumerated()
            .sorted { isEarlier($0.element.moment, $1.element.moment)
                || ($0.element.moment == $1.element.moment && $0.offset < $1.offset) }
            .map(\.element)
    }

    /// The same card for a batch a session is served directly (`GET /sessions/:id/task-moves`):
    /// the moves it asked for, or the moves into a project it coordinates. Nil for a read with no
    /// rows, and for a batch that is not a move.
    ///
    /// The id is the first row's door, the same spelling the project read gives the same batch, so
    /// the two reads draw ONE card when a session is both ends of it.
    public static func batch(from read: TaskMoveBatch,
                             inTarget: Bool = true) -> CrossingBatch? {
        guard let first = read.moves.first, first.kind == ProjectCrossings.moveKind else { return nil }
        let rows = read.moves.enumerated()
            .sorted { isEarlier($0.element.requestedAt, $1.element.requestedAt)
                || ($0.element.requestedAt == $1.element.requestedAt && $0.offset < $1.offset) }
            .map(\.element)
        return CrossingBatch(id: idPrefix + ProjectCrossings.doorID(first), kind: first.kind,
                             rows: rows, inTarget: inTarget, out: first.isToNoProject)
    }

    private static func batch(_ rows: [ProjectCrossing], out: Bool) -> CrossingBatch {
        CrossingBatch(id: idPrefix + ProjectCrossings.doorID(rows[0]), kind: rows[0].kind, rows: rows,
                      out: out)
    }

    /// `a` before `b`: by the instant when both parse, by the ISO string otherwise.
    public static func isEarlier(_ a: String, _ b: String) -> Bool {
        if let x = ThinkingSummary.date(a), let y = ThinkingSummary.date(b) { return x < y }
        return a < b
    }

    // MARK: where the card stands

    /// What the card is right now for this client.
    public enum Standing: Equatable, Sendable {
        /// At least one row still waits: answerable.
        case live
        /// Fully answered, and this client pressed it — or never saw it waiting (only the owner
        /// answers): `Decision recorded · ✓ Approved by you at <time>`.
        case recorded(verdict: CrossingBatch.Verdict, at: String?)
        /// This client saw it waiting, did not press, and it is answered now.
        case elsewhere(verdict: CrossingBatch.Verdict)
    }

    /// `sawLive`: this process saw the batch pending. `pressedAt`: when this process pressed it.
    public static func standing(_ batch: CrossingBatch, sawLive: Bool, pressedAt: Date?) -> Standing {
        guard let verdict = batch.verdict else { return .live }
        if sawLive && pressedAt == nil { return .elsewhere(verdict: verdict) }
        return .recorded(verdict: verdict, at: batch.decidedAt ?? pressedAt.map(isoStamp))
    }

    private static func isoStamp(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    // MARK: the words

    /// The heading: the question while it asks, what happened once it is answered.
    public static func title(_ batch: CrossingBatch) -> String {
        let one = batch.rows.count == 1
        if let verdict = batch.verdict { return answeredTitle(batch, verdict) }
        if batch.out { return one ? takeOutTitle : takeOutManyTitle }
        if batch.kind == ProjectCrossings.moveKind, !batch.inTarget {
            return one ? "Move this task into \(targetTitle(batch))?"
                       : "Move these tasks into \(targetTitle(batch))?"
        }
        switch batch.kind {
        case ProjectCrossings.moveKind: return one ? "Move this task here?" : "Move these tasks here?"
        case dependKind: return one ? "Allow this dependency?" : "Allow these dependencies?"
        default: return one ? "File this task here?" : "File these tasks here?"
        }
    }

    /// An answered card's heading, in the past tense; a mixed answer says only that.
    public static func answeredTitle(_ batch: CrossingBatch, _ verdict: CrossingBatch.Verdict) -> String {
        let one = batch.rows.count == 1
        let noun = batch.kind == dependKind ? (one ? "Dependency" : "Dependencies") : (one ? "Task" : "Tasks")
        switch verdict {
        case .mixed: return one ? "Request answered" : "Requests answered"
        case .refused:
            if batch.out { return "\(noun) kept in the project" }
            switch batch.kind {
            case ProjectCrossings.moveKind: return one ? "Move refused" : "Moves refused"
            case dependKind: return "\(noun) refused"
            default: return one ? "Filing refused" : "Filings refused"
            }
        case .approved:
            if batch.out { return "\(noun) taken out of the project" }
            switch batch.kind {
            case ProjectCrossings.moveKind:
                return batch.inTarget ? "\(noun) moved here" : "\(noun) moved into \(targetTitle(batch))"
            case dependKind: return "\(noun) allowed"
            default: return "\(noun) filed here"
            }
        }
    }

    /// The project the batch goes into, by name — what the asking session's card says where the
    /// target's conversation says "this project".
    public static func targetTitle(_ batch: CrossingBatch) -> String {
        batch.rows.first?.toProject?.title ?? ProjectCrossings.unnamedProject
    }

    /// "this project" in the target's conversation; the target's name in the asking session; "No
    /// project" for a move out.
    public static func toText(_ batch: CrossingBatch) -> String {
        if batch.out { return toNoProject }
        return batch.inTarget ? toThisProject : targetTitle(batch)
    }

    /// The live badge: what is being asked.
    public static func liveBadge(_ kind: String) -> String {
        switch kind {
        case ProjectCrossings.moveKind: return "move"
        case dependKind: return "depend"
        default: return "file"
        }
    }

    public static func badge(_ batch: CrossingBatch) -> String {
        switch batch.verdict {
        case nil: return liveBadge(batch.kind)
        case .approved?: return batch.out ? takenOutBadge
            : (batch.kind == ProjectCrossings.moveKind ? "moved" : "approved")
        case .refused?: return "refused"
        case .mixed?: return "answered"
        }
    }

    public static func noun(_ kind: String, count: Int) -> String {
        if kind == dependKind { return count == 1 ? "dependency" : "dependencies" }
        return count == 1 ? "task" : "tasks"
    }

    public static func listHead(_ kind: String) -> String {
        switch kind {
        case ProjectCrossings.moveKind: return "Tasks to move"
        case dependKind: return "Tasks waited on"
        default: return "Tasks to file"
        }
    }

    /// The head over a batch's rows: a move out names what it takes out.
    public static func listHead(for batch: CrossingBatch) -> String {
        batch.out ? takeOutListHead : listHead(batch.kind)
    }

    /// `8 tasks from Runner v1 · for criteria 4–11`; a move out says what it takes out and from where.
    /// Criteria are named by their number — the one a person reads on the project page — and a
    /// server too old to send one falls back to the criterion's words, never its opaque key.
    public static func summary(_ batch: CrossingBatch) -> String {
        let n = batch.rows.count
        if batch.out {
            let what = "\(n) \(noun(batch.kind, count: n))"
            switch batch.verdict {
            case nil: return "\(what) to take out of \(batch.sourceTitle)"
            case .approved?: return "\(what) taken out of \(batch.sourceTitle)"
            case .refused?: return "\(what) kept in \(batch.sourceTitle)"
            case .mixed?: return "\(what) from \(batch.sourceTitle)"
            }
        }
        let head = "\(n) \(noun(batch.kind, count: n)) from \(batch.sourceTitle)"
        var seen = Set<String>()
        let criteria = batch.rows.compactMap(\.requestedCriterion).filter { seen.insert($0.key).inserted }
        let ordinals = criteria.compactMap(\.ordinal)
        let texts = criteria.filter { $0.ordinal == nil }
            .compactMap { criterionName($0).map { "“\($0)”" } }
        let named = Set(ordinals).count + texts.count
        guard named > 0 else { return head }
        var parts: [String] = []
        if let range = criteriaRange(ordinals) { parts.append(range) }
        parts.append(contentsOf: texts)
        return "\(head) · for \(named == 1 ? "criterion" : "criteria") \(parts.joined(separator: ", "))"
    }

    /// `4–11` when the numbers are a run, else `4, 6, 9`; nil for none.
    public static func criteriaRange(_ ordinals: [Int]) -> String? {
        let numbers = Array(Set(ordinals)).sorted()
        guard !numbers.isEmpty else { return nil }
        let contiguous = numbers.enumerated().allSatisfy { index, number in
            index == 0 || number == numbers[index - 1] + 1
        }
        if numbers.count > 1, contiguous { return "\(numbers.first!)–\(numbers.last!)" }
        return numbers.map(String.init).joined(separator: ", ")
    }

    /// What a person calls a criterion: `Criterion 4`, or its words from a server that sends no
    /// number. Never its key, which is an opaque id. Nil when it has neither (deleted).
    public static func criterionName(_ criterion: ProjectCrossing.Criterion) -> String? {
        if let ordinal = criterion.ordinal { return "Criterion \(ordinal)" }
        guard let text = criterion.text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return nil }
        return text
    }

    /// `move · 8 waiting`, while live.
    public static func waitingLine(_ batch: CrossingBatch) -> String {
        "\(liveBadge(batch.kind)) · \(ProjectCrossings.waiting(batch.pending.count))"
    }

    /// Who wrote the card, not where the tasks come from: the From/To lines under it say that.
    public static let provenance = "Written by Orbit — not the requesting agent."
    public static let fromLabel = "From"
    public static let toLabel = "To"
    public static let toThisProject = "this project"
    /// The target end of a batch that takes its tasks out of its project.
    public static let toNoProject = "No project"
    public static let approveLabel = "Approve"
    public static let refuseLabel = "Refuse"
    /// How many rows the review shows before `Show k more`.
    public static let shownRows = 3

    // MARK: a move out of the project

    public static let takeOutTitle = "Take this task out of the project?"
    public static let takeOutManyTitle = "Take these tasks out of the project?"
    public static let takeOutListHead = "Tasks to take out"
    public static let takeOutApprove = "Take it out"
    public static let takeOutManyApprove = "Take them out"
    public static let takeOutRefuse = "Keep it here"
    public static let takeOutManyRefuse = "Keep them here"
    /// The badge an answered move out earns, in place of an into-move's `moved`.
    public static let takenOutBadge = "taken out"
    /// The project page's confirm prompt says the same of one task.
    public static let takeOutConsequence = ProjectCrossings.moveOutApproveConsequence
    public static let takeOutManyConsequence =
        "Confirming takes the tasks out of this project as soon as you answer; no project's acceptance counts them any more."

    /// The approve button's words: a move out takes its task(s) out, a batch into the project keeps
    /// `Approve`.
    public static func approveLabel(for batch: CrossingBatch) -> String {
        guard batch.out else { return approveLabel }
        return batch.rows.count == 1 ? takeOutApprove : takeOutManyApprove
    }

    /// The refuse button's words: a move out keeps the task(s) here, a batch into the project keeps
    /// `Refuse`.
    public static func refuseLabel(for batch: CrossingBatch) -> String {
        guard batch.out else { return refuseLabel }
        return batch.rows.count == 1 ? takeOutRefuse : takeOutManyRefuse
    }

    public static func showMore(_ hidden: Int) -> String {
        "Show \(hidden) more"
    }

    /// What a row is about, by name.
    public static func rowTitle(_ row: ProjectCrossing) -> String {
        row.kind == fileKind ? row.title : ProjectCrossings.subjectTitle(row)
    }

    public static func requestedLine(_ row: ProjectCrossing) -> String? {
        guard let criterion = row.requestedCriterion else { return nil }
        let name = criterionName(criterion) ?? ProjectCrossings.moveCriterionGone
        return "\(ProjectCrossings.moveRequestedCriterionLabel): \(name)"
    }

    public static func withdrawnLine(_ row: ProjectCrossing) -> String? {
        guard let criterion = row.withdrawnCriterion, let name = criterionName(criterion) else { return nil }
        return "\(ProjectCrossings.moveWithdrawnCriterionLabel): \(name)"
    }

    /// A row already answered names its state; a waiting one names nothing.
    public static func stateLine(_ row: ProjectCrossing) -> String? {
        ProjectCrossings.isAnswerable(row.state) ? nil : ProjectCrossings.label(row.state)
    }

    /// A row's state line in its batch: once every row went the same way the receipt says it, so
    /// only a batch still asking or answered both ways names each row's state.
    public static func stateLine(_ row: ProjectCrossing, in batch: CrossingBatch) -> String? {
        switch batch.verdict {
        case .approved?, .refused?: return nil
        case nil, .mixed?: return stateLine(row)
        }
    }

    /// The label over the quoted reasons: they are the agent's words, under a card Orbit wrote.
    public static func reasonsHead(_ count: Int) -> String {
        count == 1 ? "Reason given by the requesting agent" : "Reasons given by the requesting agent"
    }

    /// Each distinct reason given, once, quoted, in the order first given.
    public static func reasons(_ batch: CrossingBatch) -> [String] {
        var seen = Set<String>()
        return batch.rows.compactMap { row -> String? in
            guard let reason = row.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !reason.isEmpty, seen.insert(reason).inserted else { return nil }
            return "“\(reason)”"
        }
    }

    public static let moveManyApproveConsequence =
        "Confirming is the move: the tasks join the target project as soon as you answer, and nobody has to send the request again."

    /// What approving does.
    public static func consequence(_ batch: CrossingBatch) -> String {
        if batch.out { return batch.rows.count == 1 ? takeOutConsequence : takeOutManyConsequence }
        guard batch.kind == ProjectCrossings.moveKind else { return ProjectCrossings.fileApproveConsequence }
        return batch.rows.count == 1 ? ProjectCrossings.moveApproveConsequence : moveManyApproveConsequence
    }

    public static let recordedHead = "Decision recorded"

    private static func verdictWord(_ verdict: CrossingBatch.Verdict) -> String {
        switch verdict {
        case .approved: return "Approved"
        case .refused: return "Refused"
        case .mixed: return "Answered"
        }
    }

    /// The part after `Decision recorded · `, or the whole line for an answer at another end. Nil
    /// while live.
    public static func receiptVerdict(_ standing: Standing) -> String? {
        switch standing {
        case .live: return nil
        case .recorded(let verdict, let at):
            return "✓ \(verdictWord(verdict)) by you at \(at.map { CriteriaDecisions.receiptClock($0) } ?? "")"
        case .elsewhere(let verdict):
            return "\(verdictWord(verdict)) at another end"
        }
    }

    /// The whole receipt line under an answered card.
    public static func receiptLine(_ standing: Standing) -> String? {
        guard let verdict = receiptVerdict(standing) else { return nil }
        if case .elsewhere = standing { return verdict }
        return "\(recordedHead) · \(verdict)"
    }

    /// The card's one line about answers the door refused.
    public static func refusalNote(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1 ? "1 answer was not recorded" : "\(count) answers were not recorded"
    }

    /// One decision POST body per row still waiting, each with its own crossing key.
    public static func requests(_ batch: CrossingBatch,
                                _ decision: ProjectCrossingDecision) -> [(row: ProjectCrossing, body: ProjectCrossingDecisionRequest)] {
        batch.pending.map { ($0, ProjectCrossings.request($0, decision)) }
    }
}
