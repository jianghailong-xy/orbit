import Foundation

// The shape of a proposed batch, for a column too narrow to draw one.
//
// The counts on the card say how much a batch costs; they do not say what it *is*. A chain of ten
// and ten unrelated tasks produce the same list of titles and behave completely differently.
//
// Web draws a real node-and-edge graph, which it can afford: a browser card is wide enough for a
// layer of four boxes. A phone is not — five 138pt nodes scale their labels under eight points —
// so the same structure is rendered the way narrow columns have always rendered a hierarchy, as an
// indented tree. It handles a chain perfectly, reads a fan-out as siblings, and never needs a
// layout pass.

/// One row of the tree: the title, already prefixed with its connector glyphs.
public struct BatchTreeRow: Equatable, Sendable, Identifiable {
    public let depth: Int
    public let prefix: String
    public let title: String
    /// Why this row is not simply "next": another prerequisite it also waits on, one outside the
    /// batch, or the depth cap flattening it.
    public let note: String?
    public var id: String { "\(prefix)\(title)" }

    public var text: String { note == nil ? "\(prefix)\(title)" : "\(prefix)\(title)  (\(note!))" }
}

/// Indentation stops here; deeper rows render flat and say how much deeper they go.
///
/// A phone column is ~300pt and each level costs ~14pt, so a 12-deep chain would push its last
/// titles off the edge — the picture would be lying about the shape by cropping it.
public let maxTreeDepth = 4

public extension Approvals {

    /// Arrange a batch preview's tasks as an indented tree.
    ///
    /// A task is placed under its *first* in-batch prerequisite. A tree cannot show a join, so the
    /// extra prerequisites are counted in the row's note rather than silently dropped — a reader
    /// who sees "waits on 2 more" knows the picture is a simplification, which is the honest thing
    /// for it to say.
    static func batchTreeRows(_ tasks: [BatchPreviewTask]) -> [BatchTreeRow] {
        var indexByRef: [String: Int] = [:]
        for (i, t) in tasks.enumerated() where !(t.ref ?? "").isEmpty { indexByRef[t.ref!] = i }

        // Parent = first prerequisite that is actually in the window the card was given. Refs
        // pointing past it are ordinary (the card draws at most a dozen of a fifty-task batch) and
        // leave the task as a root here.
        var children: [Int: [Int]] = [:]
        var roots: [Int] = []
        var parentOf: [Int: Int] = [:]
        for (i, t) in tasks.enumerated() {
            let inBatch = (t.dependsOnRefs ?? []).compactMap { indexByRef[$0] }
            if let parent = inBatch.first {
                parentOf[i] = parent
                children[parent, default: []].append(i)
            } else {
                roots.append(i)
            }
        }

        var rows: [BatchTreeRow] = []
        func note(_ i: Int, flattenedFrom: Int?) -> String? {
            var parts: [String] = []
            let extra = (tasks[i].dependsOnRefs ?? []).compactMap { indexByRef[$0] }.count - 1
            if extra > 0 { parts.append("waits on \(extra) more") }
            if !(tasks[i].dependsOnTaskIds ?? []).isEmpty { parts.append("waits on a task outside") }
            if let from = flattenedFrom { parts.append("level \(from)") }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        }
        func walk(_ i: Int, depth: Int, ancestorsContinue: [Bool], isLast: Bool) {
            let capped = min(depth, maxTreeDepth)
            var prefix = ""
            if capped > 0 {
                for cont in ancestorsContinue.prefix(max(0, capped - 1)) { prefix += cont ? "│  " : "   " }
                prefix += isLast ? "└─ " : "├─ "
            }
            rows.append(BatchTreeRow(depth: capped, prefix: prefix, title: tasks[i].title,
                                     note: note(i, flattenedFrom: depth > maxTreeDepth ? depth : nil)))
            let kids = children[i] ?? []
            for (n, kid) in kids.enumerated() {
                walk(kid, depth: depth + 1,
                     ancestorsContinue: ancestorsContinue + [!isLast],
                     isLast: n == kids.count - 1)
            }
        }
        for (n, root) in roots.enumerated() {
            walk(root, depth: 0, ancestorsContinue: [], isLast: n == roots.count - 1)
        }
        return rows
    }

    /// A one-line reading of the shape — the caption above the tree, and the whole answer when
    /// there is no structure to indent.
    static func describeBatchShape(_ tasks: [BatchPreviewTask]) -> String {
        if tasks.isEmpty { return "" }
        let rows = batchTreeRows(tasks)
        let edges = rows.filter { $0.depth > 0 }.count
        if edges == 0 { return tasks.count == 1 ? "a single task" : "\(tasks.count) independent tasks" }
        let depth = (rows.map(\.depth).max() ?? 0) + 1
        var widest = 0
        for d in 0..<depth { widest = max(widest, rows.filter { $0.depth == d }.count) }
        if widest == 1 { return "a chain of \(tasks.count)" }
        if depth == 2 { return "\(widest) in parallel after 1" }
        return "\(depth) levels, up to \(widest) in parallel"
    }
}
