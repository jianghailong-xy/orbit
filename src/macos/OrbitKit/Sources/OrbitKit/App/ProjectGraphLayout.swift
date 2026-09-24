import Foundation

/// A project's dependency picture, made drawable on a phone: the web's folds and words
/// (`lib/projectDependencyGraph.ts`, `components/ProjectDependencyGraph.tsx`), and a layered layout
/// of its own.
///
/// The web lays the plan out with dagre, left to right on a desktop and top to bottom under 640px,
/// in a pannable canvas 240px tall. A phone gets the same marks and the same words, but the layout
/// picks whichever direction fits the screen's width — a wide, shallow plan (five done, seven
/// ready) reads left to right in one screen, a deep one top to bottom — and tasks that nothing
/// depends on and that depend on nothing are set out after the plan rather than given a rank.
///
/// Pure and view-free, so it is tested on Linux.
public enum ProjectGraph {

    // MARK: - Folding

    /// Fold each connected block of finished tasks into one mark — the web's `foldSettledMarks`.
    ///
    /// A block is a set of DONE tasks joined to each other by dependency edges, all under the same
    /// parent, none of them a parent of their own; only blocks of two or more are folded. A fold the
    /// reader opened (`expanded`) is simply not folded. A fold that would close a cycle leaves the
    /// whole graph unfolded.
    public static func foldSettled(marks: [ProjectGraphMark], edges: [ProjectGraphEdge],
                                   expanded: Set<String>) -> (marks: [ProjectGraphMark], edges: [ProjectGraphEdge]) {
        let ids = Set(marks.map(\.id))
        var parents = Set<String>()
        for mark in marks {
            if let parent = mark.parentTaskId, ids.contains(parent) { parents.insert(parent) }
        }
        var settleable: [String: ProjectGraphMark] = [:]
        var order: [String] = []
        for mark in marks where mark.kind == .task && mark.status == "DONE" && !mark.running && !mark.queued
            && !parents.contains(mark.id) {
            settleable[mark.id] = mark
            order.append(mark.id)
        }
        guard settleable.count >= 2 else { return (marks, edges) }

        var root = Dictionary(order.map { ($0, $0) }, uniquingKeysWith: { first, _ in first })
        func find(_ id: String) -> String {
            var at = id
            while let up = root[at], up != at { at = up }
            var walk = id
            while let up = root[walk], up != at {
                root[walk] = at
                walk = up
            }
            return at
        }
        for edge in edges {
            guard let source = settleable[edge.sourceMarkId], let target = settleable[edge.targetMarkId],
                  source.parentTaskId == target.parentTaskId else { continue }
            let a = find(source.id), b = find(target.id)
            if a != b { root[a] = b }
        }

        var blocks: [String: [ProjectGraphMark]] = [:]
        var blockOrder: [String] = []
        for id in order {
            let key = find(id)
            if blocks[key] == nil { blockOrder.append(key) }
            blocks[key, default: []].append(settleable[id]!)
        }

        var foldOf: [String: String] = [:]
        var folds: [String: ProjectGraphMark] = [:]
        for key in blockOrder {
            let block = blocks[key] ?? []
            guard block.count >= 2 else { continue }
            let members = block.sorted { $0.id < $1.id }
            let id = "settled:\(members[0].id)"
            if expanded.contains(id) { continue }
            for member in members { foldOf[member.id] = id }
            folds[id] = ProjectGraphMark(
                kind: .settled, id: id, title: "\(members.count) done", parentTaskId: members[0].parentTaskId,
                taskCount: members.count, statusCounts: ["DONE": members.count],
                members: members.map {
                    ProjectGraphMark.Member(taskId: $0.taskId ?? $0.id, title: $0.title, status: $0.status ?? "DONE")
                })
        }
        guard !folds.isEmpty else { return (marks, edges) }

        var folded: [ProjectGraphMark] = []
        var emitted = Set<String>()
        for mark in marks {
            guard let fold = foldOf[mark.id] else {
                folded.append(mark)
                continue
            }
            if emitted.insert(fold).inserted, let mark = folds[fold] { folded.append(mark) }
        }
        var seen = Set<ProjectGraphEdge>()
        var foldedEdges: [ProjectGraphEdge] = []
        for edge in edges {
            let source = foldOf[edge.sourceMarkId] ?? edge.sourceMarkId
            let target = foldOf[edge.targetMarkId] ?? edge.targetMarkId
            // Inside a block the order is the block's own business.
            guard source != target else { continue }
            let unit = ProjectGraphEdge(sourceMarkId: source, targetMarkId: target)
            if seen.insert(unit).inserted { foldedEdges.append(unit) }
        }
        return hasCycle(folded, foldedEdges) ? (marks, edges) : (folded, foldedEdges)
    }

    /// Replace each run the reader opened with its steps, chained in order — the web's
    /// `expandRunMarks`. Edges into the run land on its first step, edges out leave its last.
    public static func expandRuns(marks: [ProjectGraphMark], edges: [ProjectGraphEdge],
                                  expanded: Set<String>) -> (marks: [ProjectGraphMark], edges: [ProjectGraphEdge]) {
        let opened = marks.filter { $0.kind == .run && $0.expandable && expanded.contains($0.id) && !$0.members.isEmpty }
        guard !opened.isEmpty else { return (marks, edges) }
        var ends: [String: (first: String, last: String)] = [:]
        var result: [ProjectGraphMark] = []
        var chain: [ProjectGraphEdge] = []
        for mark in marks {
            guard let run = opened.first(where: { $0.id == mark.id }), let first = run.members.first,
                  let last = run.members.last else {
                result.append(mark)
                continue
            }
            ends[run.id] = (first.taskId, last.taskId)
            for (index, member) in run.members.enumerated() {
                result.append(.task(id: member.taskId, title: member.title, status: member.status,
                                    workState: member.workState, running: member.running, queued: member.queued,
                                    parentTaskId: run.parentTaskId, verificationState: member.verificationState))
                if index > 0 {
                    chain.append(ProjectGraphEdge(sourceMarkId: run.members[index - 1].taskId,
                                                  targetMarkId: member.taskId))
                }
            }
        }
        let rerouted = edges.map {
            ProjectGraphEdge(sourceMarkId: ends[$0.sourceMarkId]?.last ?? $0.sourceMarkId,
                             targetMarkId: ends[$0.targetMarkId]?.first ?? $0.targetMarkId)
        }
        return (result, rerouted + chain)
    }

    /// What the canvas draws: finished blocks folded first, then the runs the reader opened — the
    /// web's order, so a run opened whose every step is done is not folded straight back.
    public static func prepare(_ graph: ProjectDependencyGraph,
                               expanded: Set<String>) -> (marks: [ProjectGraphMark], edges: [ProjectGraphEdge]) {
        let settled = foldSettled(marks: graph.marks, edges: graph.edges, expanded: expanded)
        return expandRuns(marks: settled.marks, edges: settled.edges, expanded: expanded)
    }

    static func hasCycle(_ marks: [ProjectGraphMark], _ edges: [ProjectGraphEdge]) -> Bool {
        var indegree = Dictionary(marks.map { ($0.id, 0) }, uniquingKeysWith: { first, _ in first })
        var out: [String: [String]] = [:]
        for edge in edges {
            guard indegree[edge.sourceMarkId] != nil, let count = indegree[edge.targetMarkId] else { continue }
            indegree[edge.targetMarkId] = count + 1
            out[edge.sourceMarkId, default: []].append(edge.targetMarkId)
        }
        var ready = indegree.filter { $0.value == 0 }.map(\.key)
        var settled = 0
        while let id = ready.popLast() {
            settled += 1
            for next in out[id] ?? [] {
                let left = (indegree[next] ?? 1) - 1
                indegree[next] = left
                if left == 0 { ready.append(next) }
            }
        }
        return settled != marks.count
    }

    // MARK: - What a mark says

    /// A mark's state for its colour and the edges leaving it — the web's
    /// `getTaskDependencyVisualState` over `markLiveState`.
    public enum State: Sendable, Equatable {
        case pending, active, queued, complete, failed
    }

    /// How a task mark is drawn: the one tone worth acting on (`ready`), work held back (`blocked`),
    /// or its state.
    public enum Tone: Sendable, Equatable {
        case ready, blocked, active, queued, complete, failed
    }

    /// A fold is as done as its least done task: anything failed makes it failed, anything running
    /// active, and only a fold with nothing left in it reads as complete.
    public static func state(of mark: ProjectGraphMark) -> State {
        let status: String
        if mark.kind == .task {
            status = mark.status ?? ""
            if status == "FAILED" || status == "CANCELLED" { return .failed }
            if status == "DONE" { return .complete }
            if mark.running || status == "IN_PROGRESS" { return .active }
            return mark.queued ? .queued : .pending
        }
        let counts = mark.statusCounts
        if (counts["FAILED"] ?? 0) > 0 { status = "FAILED" }
        else if (counts["IN_PROGRESS"] ?? 0) > 0 { status = "IN_PROGRESS" }
        else if (counts["OPEN"] ?? 0) > 0 { status = "OPEN" }
        else { status = "DONE" }
        switch status {
        case "FAILED": return .failed
        case "DONE": return .complete
        case "IN_PROGRESS": return .active
        default: return .pending
        }
    }

    /// The server's canonical lane decides "ready" — never the graph's own indegree.
    public static func tone(of mark: ProjectGraphMark) -> Tone {
        switch state(of: mark) {
        case .pending: return mark.workState == "READY" ? .ready : .blocked
        case .active: return .active
        case .queued: return .queued
        case .complete: return .complete
        case .failed: return .failed
        }
    }

    /// How many of each mark's prerequisites have not released it.
    public static func waitingOn(marks: [ProjectGraphMark], edges: [ProjectGraphEdge]) -> [String: Int] {
        let states = Dictionary(marks.map { ($0.id, state(of: $0)) }, uniquingKeysWith: { first, _ in first })
        var waiting: [String: Int] = [:]
        for edge in edges where states[edge.sourceMarkId] != .complete {
            waiting[edge.targetMarkId, default: 0] += 1
        }
        return waiting
    }

    private static let statusWord: [String: String] = [
        "DONE": "Done", "IN_PROGRESS": "In progress", "OPEN": "Open", "FAILED": "Failed", "CANCELLED": "Cancelled",
    ]

    /// A task mark's one line under its title: "Ready to run", "Waiting on 2", "Blocked", or its status.
    public static func meta(of mark: ProjectGraphMark, waitingOn: Int) -> String {
        if mark.workState == "AWAITING_VERIFICATION" {
            switch mark.verificationState {
            case "FAILED": return "Verification failed"
            case "MISSING": return "Missing verifier"
            case "RUNNING": return "Awaiting verification · verifier running"
            case "BLOCKED": return "Awaiting verification · verifier blocked"
            case "PASSED": return "Awaiting verification · applying result"
            default: return "Awaiting verification"
            }
        }
        switch tone(of: mark) {
        case .ready: return "Ready to run"
        case .blocked: return waitingOn > 0 ? "Waiting on \(waitingOn)" : "Blocked"
        default:
            if mark.running { return "Running" }
            if mark.queued { return "Queued" }
            return statusWord[mark.status ?? ""] ?? (mark.status ?? "")
        }
    }

    /// A fold's heading: "5 done" for finished work, the server's own title for a run or a motif.
    public static func foldTitle(_ mark: ProjectGraphMark) -> String {
        mark.kind == .settled ? "\(OrbitLinkCopy.number(mark.taskCount)) done" : mark.title
    }

    /// Under a fold: "Finished · tap to open" for finished work, where the split would say one number
    /// twice; otherwise "12 done · 3 running · 1 failed · 4 open", zeroes left out.
    public static func foldLegend(_ mark: ProjectGraphMark) -> String {
        if mark.kind == .settled { return "Finished · tap to open" }
        let order: [(String, String)] = [("DONE", "done"), ("IN_PROGRESS", "running"), ("FAILED", "failed"),
                                         ("CANCELLED", "cancelled"), ("OPEN", "open")]
        return order.compactMap { key, word -> String? in
            let n = mark.statusCounts[key] ?? 0
            return n > 0 ? "\(OrbitLinkCopy.number(n)) \(word)" : nil
        }.joined(separator: " · ")
    }

    /// The fold's bar, in the web's order: done, running, failed, cancelled, open.
    public static func foldSegments(_ mark: ProjectGraphMark) -> [(status: String, count: Int)] {
        ["DONE", "IN_PROGRESS", "FAILED", "CANCELLED", "OPEN"].compactMap { key in
            let n = mark.statusCounts[key] ?? 0
            return n > 0 ? (key, n) : nil
        }
    }

    /// Whether pressing a fold opens it: a finished block always, a run when the response carried
    /// its steps. A motif has nothing to open into.
    public static func canOpen(_ mark: ProjectGraphMark) -> Bool {
        mark.kind == .settled || (mark.kind == .run && mark.expandable && !mark.members.isEmpty)
    }

    /// "13 tasks · 7 ready to run · 5 done · dashed marks are folded".
    public static func summary(taskCount: Int, marks: [ProjectGraphMark]) -> String {
        var ready = 0, done = 0, folded = 0
        for mark in marks {
            if mark.kind != .task { folded += mark.taskCount }
            if state(of: mark) == .complete {
                done += mark.kind == .task ? 1 : mark.taskCount
            } else if mark.kind == .task && mark.workState == "READY" {
                ready += 1
            }
        }
        return ["\(OrbitLinkCopy.number(taskCount)) tasks",
                ready > 0 ? "\(OrbitLinkCopy.number(ready)) ready to run" : nil,
                done > 0 ? "\(OrbitLinkCopy.number(done)) done" : nil,
                folded > 0 ? "dashed marks are folded" : nil]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// Said under the canvas when the server read less than the whole project.
    public static func truncatedNotice(maxTasks: Int?) -> (title: String, detail: String) {
        let size = maxTasks.map { " (\(OrbitLinkCopy.number($0)) tasks)" } ?? ""
        return ("This project is larger than one graph request reads\(size).",
                "The task list below has all of them, in dependency order.")
    }

    // MARK: - Layout

    public enum Direction: Sendable, Equatable {
        case leftToRight, topToBottom
    }

    /// How big things are drawn, in points.
    public struct Metrics: Sendable, Equatable {
        public var taskWidth: Double = 172
        public var taskHeight: Double = 52
        public var foldWidth: Double = 116
        public var foldHeight: Double = 74
        /// Between two ranks, where the edges turn.
        public var rankGap: Double = 32
        /// Between two marks of one rank.
        public var markGap: Double = 8
        public var margin: Double = 12

        public init() {}
    }

    public struct Point: Equatable, Sendable {
        public let x: Double
        public let y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public struct Box: Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double

        public var midX: Double { x + width / 2 }
        public var midY: Double { y + height / 2 }
        public var maxX: Double { x + width }
        public var maxY: Double { y + height }
    }

    public struct Placement: Equatable, Sendable, Identifiable {
        public let mark: ProjectGraphMark
        public let box: Box
        public var id: String { mark.id }
    }

    /// One dependency, drawn prerequisite → dependent as an orthogonal line whose corners are
    /// `points`. It passes long ranks through slots of their own, so it never crosses a mark.
    public struct Route: Equatable, Sendable, Identifiable {
        public let source: String
        public let target: String
        public let points: [Point]
        public var id: String { "\(source)->\(target)" }
    }

    public struct Layout: Equatable, Sendable {
        public let direction: Direction
        public let width: Double
        public let height: Double
        public let placements: [Placement]
        public let routes: [Route]

        /// How far the layout has to shrink to fit `width` points, never enlarged.
        public func fit(width available: Double) -> Double {
            guard width > 0 else { return 1 }
            return min(1, available / width)
        }
    }

    /// The layout that fits `availableWidth` best, left to right when both fit.
    public static func layout(marks: [ProjectGraphMark], edges: [ProjectGraphEdge], availableWidth: Double,
                              metrics: Metrics = Metrics()) -> Layout {
        let across = layout(marks: marks, edges: edges, direction: .leftToRight,
                            availableWidth: availableWidth, metrics: metrics)
        let down = layout(marks: marks, edges: edges, direction: .topToBottom,
                          availableWidth: availableWidth, metrics: metrics)
        return down.fit(width: availableWidth) > across.fit(width: availableWidth) + 0.001 ? down : across
    }

    /// A layered layout: ranks by the longest path of prerequisites, marks ordered in each rank by
    /// where their neighbours sit, a slot of their own for edges that skip a rank, and the marks
    /// with no edges at all set out in rows after the plan.
    public static func layout(marks: [ProjectGraphMark], edges rawEdges: [ProjectGraphEdge], direction: Direction,
                              availableWidth: Double, metrics: Metrics = Metrics()) -> Layout {
        let ids = Set(marks.map(\.id))
        var seen = Set<ProjectGraphEdge>()
        let edges = rawEdges.filter {
            $0.sourceMarkId != $0.targetMarkId && ids.contains($0.sourceMarkId) && ids.contains($0.targetMarkId)
                && seen.insert($0).inserted
        }
        let linked = Set(edges.flatMap { [$0.sourceMarkId, $0.targetMarkId] })
        let plan = marks.filter { linked.contains($0.id) }
        let loose = marks.filter { !linked.contains($0.id) }
        let size: (ProjectGraphMark) -> (width: Double, height: Double) = {
            $0.kind == .task ? (metrics.taskWidth, metrics.taskHeight) : (metrics.foldWidth, metrics.foldHeight)
        }
        let across = direction == .leftToRight

        // Ranks: the longest chain of prerequisites in front of each mark.
        var rank: [String: Int] = [:]
        var indegree = Dictionary(plan.map { ($0.id, 0) }, uniquingKeysWith: { first, _ in first })
        var out: [String: [String]] = [:]
        for edge in edges {
            indegree[edge.targetMarkId, default: 0] += 1
            out[edge.sourceMarkId, default: []].append(edge.targetMarkId)
        }
        var queue = plan.map(\.id).filter { indegree[$0] == 0 }
        var head = 0
        while head < queue.count {
            let id = queue[head]
            head += 1
            let r = rank[id] ?? 0
            rank[id] = r
            for next in out[id] ?? [] {
                rank[next] = max(rank[next] ?? 0, r + 1)
                indegree[next, default: 1] -= 1
                if indegree[next] == 0 { queue.append(next) }
            }
        }
        let deepest = rank.values.max() ?? 0
        for mark in plan where rank[mark.id] == nil { rank[mark.id] = deepest + 1 } // a cycle: never from the server

        // Layers, with a slot for each rank an edge passes through.
        struct Node {
            let id: String
            let mark: ProjectGraphMark?
            let rank: Int
        }
        var nodes: [String: Node] = [:]
        var layers: [[String]] = Array(repeating: [], count: (rank.values.max() ?? -1) + 1)
        for mark in plan {
            let r = rank[mark.id] ?? 0
            nodes[mark.id] = Node(id: mark.id, mark: mark, rank: r)
            layers[r].append(mark.id)
        }
        var down: [String: [String]] = [:]
        var up: [String: [String]] = [:]
        var chains: [(edge: ProjectGraphEdge, path: [String])] = []
        for edge in edges {
            let from = rank[edge.sourceMarkId] ?? 0
            let to = rank[edge.targetMarkId] ?? 0
            var path = [edge.sourceMarkId]
            if to > from + 1 {
                for r in (from + 1)..<to {
                    let slot = "·\(edge.sourceMarkId)->\(edge.targetMarkId)@\(r)"
                    nodes[slot] = Node(id: slot, mark: nil, rank: r)
                    layers[r].append(slot)
                    path.append(slot)
                }
            }
            path.append(edge.targetMarkId)
            for (a, b) in zip(path, path.dropFirst()) {
                down[a, default: []].append(b)
                up[b, default: []].append(a)
            }
            chains.append((edge, path))
        }

        // Order each layer by where its neighbours sit, sweeping down and up.
        func reorder(_ layer: [String], by neighbours: [String: [String]], in adjacent: [String]) -> [String] {
            let at = Dictionary(adjacent.enumerated().map { ($1, Double($0)) }, uniquingKeysWith: { first, _ in first })
            let keyed = layer.enumerated().map { index, id -> (id: String, key: Double, index: Int) in
                let spots = (neighbours[id] ?? []).compactMap { at[$0] }
                return (id, spots.isEmpty ? Double(index) : spots.reduce(0, +) / Double(spots.count), index)
            }
            return keyed.sorted { $0.key == $1.key ? $0.index < $1.index : $0.key < $1.key }.map(\.id)
        }
        if layers.count > 1 {
            for _ in 0..<4 {
                for r in 1..<layers.count { layers[r] = reorder(layers[r], by: up, in: layers[r - 1]) }
                for r in stride(from: layers.count - 2, through: 0, by: -1) {
                    layers[r] = reorder(layers[r], by: down, in: layers[r + 1])
                }
            }
        }

        // Where each layer sits along the direction of work, and each mark across it.
        let slotBreadth = 6.0
        func extent(_ id: String) -> (along: Double, breadth: Double) {
            guard let mark = nodes[id]?.mark else { return (0, slotBreadth) }
            let s = size(mark)
            return across ? (s.width, s.height) : (s.height, s.width)
        }
        let depths = layers.map { layer in layer.map { extent($0).along }.max() ?? 0 }
        var starts: [Double] = []
        var cursor = metrics.margin
        for depth in depths {
            starts.append(cursor)
            cursor += depth + metrics.rankGap
        }
        let planAlong = layers.isEmpty ? 0 : cursor - metrics.rankGap + metrics.margin
        let breadths = layers.map { layer in
            layer.map { extent($0).breadth }.reduce(0, +) + Double(max(0, layer.count - 1)) * metrics.markGap
        }
        let widest = breadths.max() ?? 0
        var boxes: [String: Box] = [:]
        for (r, layer) in layers.enumerated() {
            var offset = metrics.margin + (widest - breadths[r]) / 2
            for id in layer {
                let e = extent(id)
                let along = starts[r] + (depths[r] - e.along) / 2
                boxes[id] = across
                    ? Box(x: along, y: offset, width: e.along, height: e.breadth)
                    : Box(x: offset, y: along, width: e.breadth, height: e.along)
                offset += e.breadth + metrics.markGap
            }
        }
        let planBreadth = layers.isEmpty ? 0 : widest + 2 * metrics.margin
        var width = across ? planAlong : planBreadth
        var height = across ? planBreadth : planAlong

        // Marks with no edges, in rows under the plan.
        if !loose.isEmpty {
            let rowLimit = max(width, availableWidth) - 2 * metrics.margin
            var x = metrics.margin
            var y = height > 0 ? height - metrics.margin + metrics.rankGap / 2 : metrics.margin
            var rowHeight = 0.0
            var rightmost = 0.0
            for mark in loose {
                let s = size(mark)
                if x > metrics.margin && x + s.width > metrics.margin + rowLimit {
                    x = metrics.margin
                    y += rowHeight + metrics.markGap
                    rowHeight = 0
                }
                boxes[mark.id] = Box(x: x, y: y, width: s.width, height: s.height)
                rightmost = max(rightmost, x + s.width)
                x += s.width + metrics.markGap
                rowHeight = max(rowHeight, s.height)
            }
            width = max(width, rightmost + metrics.margin)
            height = y + rowHeight + metrics.margin
        }

        // Edges: out of the side facing the next rank, turning in the gap before each rank they reach.
        var routes: [Route] = []
        for chain in chains {
            guard let first = boxes[chain.path[0]], let last = boxes[chain.path[chain.path.count - 1]] else { continue }
            var points = [across ? Point(x: first.maxX, y: first.midY) : Point(x: first.midX, y: first.maxY)]
            var level = across ? first.midY : first.midX
            for id in chain.path.dropFirst() {
                guard let box = boxes[id], let r = nodes[id]?.rank else { continue }
                let turn = starts[r] - metrics.rankGap / 2
                let next = across ? box.midY : box.midX
                if abs(next - level) > 0.5 {
                    points.append(across ? Point(x: turn, y: level) : Point(x: level, y: turn))
                    points.append(across ? Point(x: turn, y: next) : Point(x: next, y: turn))
                }
                level = next
            }
            points.append(across ? Point(x: last.x, y: last.midY) : Point(x: last.midX, y: last.y))
            routes.append(Route(source: chain.edge.sourceMarkId, target: chain.edge.targetMarkId, points: points))
        }

        let placements = marks.compactMap { mark in boxes[mark.id].map { Placement(mark: mark, box: $0) } }
        return Layout(direction: direction, width: width, height: height, placements: placements, routes: routes)
    }
}
