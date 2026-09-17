import Foundation

// The tasks a person named with `#`, as the control plane described them to the agent.
//
// Delivery appends a `<referenced-task>` block for every `#`-reference in a message (apiserver
// `tasks/reference-expansion.ts` `describeTask`). Like the background-jobs inventory it rides along
// with whatever the person typed, so it stays the folded entry under their words — this only turns
// the block into cards. What it replaces there is a plain-text table, and with it the one thing on
// it worth the most: the task's id sits in the opening tag, where a reader could see it and not tap
// it.
//
// The block has one wording and has never been reworded (unlike background-jobs, which is read in
// two), so a reworded field is read as no field at all and the note keeps the shape it has always
// had. That is the intended failure: a card missing the row a reader came for is worse than the
// text.
//
// Only `referenced-task`. Delivery writes `<referenced-list>` too, but this deployment's record
// holds not one of them, and a shape nobody has seen is not one to guess at — such a block is left
// in `rest` and read as it always was.
//
// Web reads the same block with `parseReferencedTasks` (src/web/src/lib/referencedTask.ts) and draws
// it as `ReferencedTaskNote.tsx`. This is that rule for iOS and macOS, which share OrbitKit. Neither
// end compiles the other, so `ReferencedTaskCopyParityTests` is what holds the two to each other.

/// One block: a task as the control plane described it, in that description's own words.
public struct ReferencedTask: Equatable, Sendable {
    /// From the opening tag, in the base62 spelling the agent would pass back — and the link's.
    public let id: String
    public let title: String
    /// `DONE` | `OPEN` | `FAILED` | … — the lifecycle name, never translated.
    public let status: String
    /// What the status line said after it: `验收任务`, `协调任务`.
    public let suffixes: [String]
    /// The list it is filed under, or the block's own words for being in none.
    public let list: String
    public let assignee: String
    public let runs: Int
    /// Of those, how many took a turn — the evidence question, which the block answers up front.
    public let executed: Int
    /// The last run as the block put it: `SUCCEEDED, 59 turns`, `FAILED (unattributed), 31 turns`.
    public let lastRun: String

    public init(id: String, title: String, status: String, suffixes: [String], list: String,
                assignee: String, runs: Int, executed: Int, lastRun: String) {
        self.id = id
        self.title = title
        self.status = status
        self.suffixes = suffixes
        self.list = list
        self.assignee = assignee
        self.runs = runs
        self.executed = executed
        self.lastRun = lastRun
    }
}

public struct ReferencedTasks: Equatable, Sendable {
    public let tasks: [ReferencedTask]
    /// Whatever else the same note carried — another block's rows are not this one's to draw.
    public let rest: String

    public init(tasks: [ReferencedTask], rest: String) {
        self.tasks = tasks
        self.rest = rest
    }
}

/// Reading the `#`-reference blocks in a control plane note, and nothing else.
///
/// Every pattern here is the one the browser reads the same block with, character for character;
/// `ReferencedTaskCopyParityTests` compares them to their declarations in `referencedTask.ts`.
public enum ReferencedTaskText {
    /// The whole block, tag to tag, with the id the opening tag carries.
    static let blockPattern = "<referenced-task id=\"([^\"\\n]*)\">\\n([\\s\\S]*?)\\n<\\/referenced-task>"
    /// A field line: two spaces, the label, and the value. The narration line matches no label.
    static let fieldPattern = "^ {2}(标题|状态|所属|运行) +(.*)$"
    /// `(无列表) · 负责 orbit` — greedy, so a list whose own title says it keeps it.
    static let placePattern = "^(.*) · 负责 (.*)$"
    static let runsPattern = "^共 (\\d+) 次，其中执行过 turn 的 (\\d+) 次；最近一次：(.*)$"
    /// What the status line hangs its suffixes off, and what a card hangs them off in turn.
    static let suffix = " · "

    private static let block = try? NSRegularExpression(pattern: blockPattern)
    private static let field = Pattern(fieldPattern)
    private static let place = Pattern(placePattern)
    private static let runs = Pattern(runsPattern)

    /// The tasks a note's blocks name, or nil for a note that names none.
    ///
    /// A block that is not this shape — a field missing, an id that is not one — is left in `rest`
    /// and read as it always was, which is also what a note of nothing but such blocks gets: better
    /// the note as it has always read than half a card.
    public static func parse(_ note: String?) -> ReferencedTasks? {
        guard let note, let block else { return nil }
        var tasks: [ReferencedTask] = []
        var rest = ""
        var from = note.startIndex
        for match in block.matches(in: note, range: NSRange(note.startIndex..., in: note)) {
            guard let whole = Range(match.range, in: note),
                  let id = Range(match.range(at: 1), in: note),
                  let body = Range(match.range(at: 2), in: note),
                  let task = parseTask(String(note[id]), String(note[body])) else { continue }
            tasks.append(task)
            rest += note[from..<whole.lowerBound]
            from = whole.upperBound
        }
        if tasks.isEmpty { return nil }
        rest += note[from...]
        return ReferencedTasks(
            tasks: tasks,
            rest: rest.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// One block's fields, or nil for anything that is not the shape delivery writes.
    private static func parseTask(_ id: String, _ body: String) -> ReferencedTask? {
        // An id that is not one is what makes a card's title a link to nowhere, which would be the
        // dead text this replaced — such a block stays the text it always was.
        guard PublicID.toUUID(id) != nil else { return nil }
        var fields: [String: String] = [:]
        for line in body.components(separatedBy: "\n") {
            guard let groups = field.groups(line), groups.count > 2,
                  let label = groups[1], let value = groups[2] else { continue }
            fields[label] = value
        }
        let status = (fields["状态"] ?? "").components(separatedBy: suffix)
        guard let title = fields["标题"], !title.isEmpty,
              let first = status.first, !first.isEmpty,
              let place = place.groups(fields["所属"] ?? ""),
              let list = place[1], let assignee = place[2],
              let counted = runs.groups(fields["运行"] ?? ""),
              let all = counted[1].flatMap(Int.init), let executed = counted[2].flatMap(Int.init),
              let lastRun = counted[3] else { return nil }
        return ReferencedTask(id: id, title: title, status: first,
                              suffixes: Array(status.dropFirst()), list: list, assignee: assignee,
                              runs: all, executed: executed, lastRun: lastRun)
    }
}

/// What the block reads as on screen: web's `ReferencedTaskNote.tsx`, in the same words and the same
/// order — the status, the title as the link, how the last run came out, and the ids under it.
public enum ReferencedTaskNote {
    /// Where tapping a card goes: the same scheme a `#`-reference in prose is written as, which both
    /// app shells route with `ReferenceLink` (web builds `/tasks/<id>` out of the same id).
    public static func link(_ task: ReferencedTask) -> URL? {
        URL(string: "orbit-task:\(task.id)")
    }

    /// The lifecycle pill for the status the block named — in this app's own labels, which are the
    /// browser's (`TaskStatusPill`'s STATUS_PILL). A status neither of them knows is drawn under its
    /// own name rather than under a wrong one.
    public static func pill(_ task: ReferencedTask) -> TaskPill {
        switch TaskStatus(rawValue: task.status) {
        case .done:       return TaskPill(kind: .done, label: "Done")
        case .inProgress: return TaskPill(kind: .inProgress, label: "In progress")
        case .open:       return TaskPill(kind: .open, label: "Open")
        case .failed:     return TaskPill(kind: .failed, label: "Failed")
        case .cancelled:  return TaskPill(kind: .cancelled, label: "Cancelled")
        case nil:         return TaskPill(kind: .open, label: task.status)
        }
    }

    /// How the last run came out, in the block's own words. Nothing for a task nothing has run.
    public static func outcome(_ task: ReferencedTask) -> String {
        task.runs == 0 ? "" : task.lastRun
    }

    /// "34OEE9MQXMEm0h0Ptm1GG · (无列表) · orbit · 1 run" — the ids, under the title they belong to.
    public static func meta(_ task: ReferencedTask) -> String {
        "\(task.id) · \(task.list) · \(task.assignee) · \(runs(task))"
    }

    /// "1 run", or "1 run, 0 with turns" where they differ.
    ///
    /// The second number is the evidence question the block answers up front — a session that exists
    /// and has never taken a turn is the difference between work that stalled and work that was
    /// never done — and it is worth a reader's attention exactly when it does not match the first.
    public static func runs(_ task: ReferencedTask) -> String {
        if task.runs == 0 { return "never run" }
        let counted = task.runs == 1 ? "1 run" : "\(task.runs) runs"
        return task.executed == task.runs ? counted : "\(counted), \(task.executed) with turns"
    }

    /// "DONE" — or "6 DONE, 2 OPEN" — on the line that names the note folded.
    ///
    /// What the reader came for is the state of the thing they referenced, so one task says its
    /// status outright and several are counted by it, in the order the note named them.
    public static func summary(_ tasks: [ReferencedTask]) -> String {
        if tasks.count == 1, let only = tasks.first { return only.status }
        var order: [String] = []
        var counts: [String: Int] = [:]
        for task in tasks {
            if counts[task.status] == nil { order.append(task.status) }
            counts[task.status, default: 0] += 1
        }
        return order.map { "\(counts[$0] ?? 0) \($0)" }.joined(separator: ", ")
    }
}
