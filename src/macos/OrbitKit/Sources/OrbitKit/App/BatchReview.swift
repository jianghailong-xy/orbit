import Foundation

// The batch-create review, laid out for a phone: what the write does first, then the tasks — by
// level when they wait on each other, one numbered list when they do not — and each task one push
// from a page of its own. Approved as docs/mocks/batch-create-review-ios (index.html ②③④ and
// dependencies.html).
//
// Levels are web's layers (`buildBatchGraph`, longest path), so the two clients put one batch in the
// same order. The indented tree in BatchTree.swift stays for the transcript's record of a decided
// batch. The card stopped drawing it because a tree hangs a task under its FIRST prerequisite and can
// only count the others ("waits on 1 more") without saying which they are.

/// One task of the window, as the review lists it.
public struct BatchLevelRow: Equatable, Sendable, Identifiable {
    /// Its position in the window the card was given: the index into `BatchApprovalPreview.tasks`,
    /// and into the input's own `tasks`, which the server windows from the front.
    public let index: Int
    /// 1-based, in reading order: level by level, and in batch order within a level. A prerequisite
    /// therefore always carries a smaller number than what waits on it.
    public let number: Int
    public let title: String
    /// The numbers of the tasks in this window it waits on, ascending.
    public let waitsOn: [Int]
    /// It also waits on a task that already exists, outside the batch.
    public let waitsOutside: Bool
    public var id: Int { index }
}

/// One level: the tasks whose deepest prerequisite in the window is one level up. Tasks on the same
/// level do not wait on each other, so they can run in parallel.
public struct BatchLevel: Equatable, Sendable, Identifiable {
    /// 1-based.
    public let number: Int
    public let rows: [BatchLevelRow]
    public var id: Int { number }
}

/// One consequence line and the kind of consequence it is, so a view can mark "starts running" as
/// its own thing without parsing the sentence. The sentence is `batchImpactLines`' own, unchanged.
public struct BatchImpactRow: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case starting, waiting, manualStart, cannotRun }

    public let kind: Kind
    public let text: String
    public var id: String { text }

    /// Before the dash: the count and what happens to it, which is the part a person decides on.
    public var head: String {
        text.components(separatedBy: " — ").first ?? text
    }

    /// After the dash, on a line of its own: the reason, capitalized as the start of that line. Nil
    /// for a sentence with no dash.
    public var reason: String? {
        let parts = text.components(separatedBy: " — ")
        guard parts.count > 1 else { return nil }
        let rest = parts.dropFirst().joined(separator: " — ")
        return rest.prefix(1).uppercased() + rest.dropFirst()
    }
}

/// What a task's page in the review shows, read off the body the runner is about to send. The
/// preview carries titles and wiring only; the full bodies ride beside it in the input.
public struct BatchTaskDetail: Equatable, Sendable {
    public let title: String
    public let description: String
    public let acceptanceCriteria: String
    public let completionCriterion: String
    public let labels: [String]

    /// The chip the task's own detail draws for how it is judged ("Judged by · submitted evidence").
    public var judgedBy: String? { TaskJudgmentCopy.completionCriterionChip[completionCriterion] }
}

public extension Approvals {

    // MARK: levels

    /// Where each task's ref sits in the window.
    private static func refIndex(_ tasks: [BatchPreviewTask]) -> [String: Int] {
        var indexByRef: [String: Int] = [:]
        for (i, t) in tasks.enumerated() {
            if let ref = t.ref, !ref.isEmpty { indexByRef[ref] = i }
        }
        return indexByRef
    }

    /// Each task's level, 0-based: one below its deepest prerequisite in the window. This is
    /// longest-path layering, as web's `buildBatchGraph` does it, so a task that waits on both a root
    /// and a leaf sits under the leaf. Refs may only name earlier items (the server enforces it), so
    /// one forward pass is the whole computation. A ref naming nothing in the window is ignored.
    static func batchLayers(_ tasks: [BatchPreviewTask]) -> [Int] {
        let indexByRef = refIndex(tasks)
        var layer = Array(repeating: 0, count: tasks.count)
        for (i, t) in tasks.enumerated() {
            for ref in t.dependsOnRefs ?? [] {
                guard let from = indexByRef[ref], from != i else { continue }
                layer[i] = max(layer[i], layer[from] + 1)
            }
        }
        return layer
    }

    /// The window as the review lists it: by level, numbered in reading order, with every in-window
    /// prerequisite named by its number. A batch with no edges in the window is one level, which the
    /// review draws as a plain numbered list.
    static func batchLevels(_ tasks: [BatchPreviewTask]) -> [BatchLevel] {
        let layer = batchLayers(tasks)
        guard let deepest = layer.max() else { return [] }
        let indexByRef = refIndex(tasks)
        let order = tasks.indices.sorted { (layer[$0], $0) < (layer[$1], $1) }
        var number = Array(repeating: 0, count: tasks.count)
        for (n, i) in order.enumerated() { number[i] = n + 1 }
        func row(_ i: Int) -> BatchLevelRow {
            let prerequisites = Set((tasks[i].dependsOnRefs ?? []).compactMap { indexByRef[$0] }.filter { $0 != i })
            return BatchLevelRow(index: i, number: number[i], title: tasks[i].title,
                                 waitsOn: prerequisites.map { number[$0] }.sorted(),
                                 waitsOutside: !(tasks[i].dependsOnTaskIds ?? []).isEmpty)
        }
        return (0...deepest).map { d in
            BatchLevel(number: d + 1, rows: order.filter { layer[$0] == d }.map(row))
        }
    }

    /// The tasks in the window that wait on `row`, for the "Needed by" section of its page.
    static func batchNeededBy(_ row: BatchLevelRow, in levels: [BatchLevel]) -> [BatchLevelRow] {
        levels.flatMap(\.rows).filter { $0.waitsOn.contains(row.number) }
    }

    // MARK: the card's lines

    /// The consequence lines with their kinds, in the order a person decides in. `batchImpactLines`
    /// is these sentences, so the two cannot drift apart.
    ///
    /// Written to survive n = 1, which is what a single create is: the card that shows one task reads
    /// these lines too, and "1 wait on a prerequisite" is not a sentence anybody wrote.
    static func batchImpactRows(_ p: BatchApprovalPreview) -> [BatchImpactRow] {
        var rows: [BatchImpactRow] = []
        if p.startingNow > 0 {
            rows.append(BatchImpactRow(kind: .starting, text: "\(p.startingNow) start\(p.startingNow == 1 ? "s" : "") running within the minute"))
        }
        if p.blocked > 0 {
            rows.append(BatchImpactRow(kind: .waiting, text: "\(p.blocked) wait\(p.blocked == 1 ? "s" : "") on a prerequisite"))
        }
        if p.needsManualStart > 0 {
            rows.append(BatchImpactRow(kind: .manualStart, text: "\(p.needsManualStart) need\(p.needsManualStart == 1 ? "s" : "") a manual start — nothing will trigger \(p.needsManualStart == 1 ? "it" : "them")"))
        }
        if p.notDispatchable > 0 {
            rows.append(BatchImpactRow(kind: .cannotRun, text: "\(p.notDispatchable) cannot run — unassigned, no runner, auto-run off, or the list is paused"))
        }
        return rows
    }

    /// Where a batch lands and what shape it is: the list, the edge count and the shape, each only
    /// when there is one. The parts are joined rather than each carrying its own separator, so a
    /// batch with no list does not open on a dangling " · ".
    static func batchDetailLine(_ batch: BatchApprovalPreview) -> String {
        var parts: [String] = []
        if !batch.lists.isEmpty { parts.append("into \(batch.lists.joined(separator: ", "))") }
        if batch.edges > 0 { parts.append("\(batch.edges) dependency edge\(batch.edges == 1 ? "" : "s")") }
        let shape = describeBatchShape(batch.tasks)
        if !shape.isEmpty { parts.append(shape) }
        return parts.joined(separator: " · ")
    }

    // MARK: task pages

    /// Every task body the input carries, in the order it was sent.
    static func batchTaskDetails(from input: JSONValue) -> [BatchTaskDetail] {
        guard case .array(let raw)? = input["tasks"] else { return [] }
        return raw.map { t in
            var labels: [String] = []
            if case .array(let l)? = t["labels"] { labels = l.compactMap { $0.stringValue } }
            return BatchTaskDetail(title: t["title"]?.stringValue ?? "",
                                   description: t["description"]?.stringValue ?? "",
                                   acceptanceCriteria: t["acceptanceCriteria"]?.stringValue ?? "",
                                   completionCriterion: t["completionCriterion"]?.stringValue ?? "",
                                   labels: labels)
        }
    }

    /// The body behind a row: the input's task at the row's own position, which is where the server
    /// windows from. If the two ever disagree, the first body with the row's title is used, never
    /// another task's description under this one's name.
    static func batchTaskDetail(for row: BatchLevelRow, in details: [BatchTaskDetail]) -> BatchTaskDetail? {
        if details.indices.contains(row.index), details[row.index].title == row.title {
            return details[row.index]
        }
        return details.first { $0.title == row.title }
    }

    // MARK: copy

    /// The batch card's yes. It names the count rather than "them", because the title above it
    /// scrolls away. Web's batch card says the same (`ApprovalPanel.tsx`).
    static func batchCreateAction(_ count: Int) -> String {
        "Create \(count) task\(count == 1 ? "" : "s")"
    }

    /// A level's name, and what it says about parallelism when there is anything to say.
    static func batchLevelName(_ level: BatchLevel) -> String { "Level \(level.number)" }
    static func batchLevelParallel(_ level: BatchLevel) -> String? {
        level.rows.count > 1 ? "\(level.rows.count) in parallel" : nil
    }

    /// A row's note: "Waits on" followed by the numbers, and the outside task in words.
    static let batchWaitsOn = "Waits on"
    static let batchOutsideTask = "a task outside"
    static let batchAndOutsideTask = "and a task outside"
    static let batchNeededByHeading = "Needed by"
    static let batchDescriptionHeading = "Description"

    /// The page's title: its number, and out of how many when the card shows them all.
    static func batchTaskPageTitle(_ number: Int, of total: Int?) -> String {
        total.map { "Task \(number) of \($0)" } ?? "Task \(number)"
    }

    /// Under a window that does not hold the whole batch. The counts above it are the whole batch's.
    static func batchMore(_ count: Int) -> String { "+\(count) more" }
}
