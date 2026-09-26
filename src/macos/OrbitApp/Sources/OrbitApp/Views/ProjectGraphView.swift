import SwiftUI
import OrbitKit

/// The project page's Task graph: the web's marks and words (OrbitKit `ProjectGraph`) in a layout
/// made for the width it is given, and a full-screen reading that pans and zooms.
struct ProjectGraphCard: View {
    let graph: ProjectDependencyGraph
    /// The folds the reader opened. Held by the page, so a refetch does not close what was open.
    @Binding var expanded: Set<String>
    let onOpenTask: (String) -> Void

    @State private var width: CGFloat = 0
    @State private var fullScreen = false

    /// How tall the drawing gets inside the page. A taller plan shrinks to fit, down to a floor
    /// below which titles are not worth drawing, and the rest is the full-screen press's.
    private static let maxInlineHeight: CGFloat = 520
    private static let minInlineScale: CGFloat = 0.5

    var body: some View {
        let prepared = ProjectGraph.prepare(graph, expanded: expanded)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Text(ProjectGraph.summary(taskCount: graph.taskCount, marks: prepared.marks))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button { fullScreen = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
                .controlSize(.small)
                .accessibilityLabel("Show the task graph full screen")
            }
            if width > 0 {
                let layout = ProjectGraph.layout(marks: prepared.marks, edges: prepared.edges,
                                                 availableWidth: Double(width))
                let scale = inlineScale(layout)
                ProjectGraphCanvas(layout: layout, edges: prepared.edges, onOpenMark: open)
                    .scaleEffect(scale, anchor: .topLeading)
                    .frame(width: CGFloat(layout.width) * scale,
                           height: min(CGFloat(layout.height) * scale, Self.maxInlineHeight),
                           alignment: .topLeading)
                    .clipped()
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            if graph.truncated {
                let notice = ProjectGraph.truncatedNotice(maxTasks: graph.maxTasks)
                Label {
                    Text("\(notice.title) \(notice.detail)")
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .font(.orbitLabel)
                .foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 4)
        .background {
            GeometryReader { geo in
                Color.clear.onChange(of: geo.size.width, initial: true) { _, w in width = w }
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $fullScreen) {
            ProjectGraphFullScreen(graph: graph, expanded: $expanded, onOpenTask: onOpenTask)
        }
        #else
        .sheet(isPresented: $fullScreen) {
            ProjectGraphFullScreen(graph: graph, expanded: $expanded, onOpenTask: onOpenTask)
                .frame(minWidth: 720, minHeight: 520)
        }
        #endif
    }

    private func inlineScale(_ layout: ProjectGraph.Layout) -> CGFloat {
        let fit = CGFloat(layout.fit(width: Double(width)))
        let tall = layout.height > 0 ? Self.maxInlineHeight / CGFloat(layout.height) : 1
        return max(Self.minInlineScale, min(fit, tall))
    }

    /// A task opens where tasks live; a fold that can open does, in place.
    private func open(_ mark: ProjectGraphMark) {
        if mark.kind == .task {
            onOpenTask(mark.taskId ?? mark.id)
        } else if ProjectGraph.canOpen(mark) {
            expanded.insert(mark.id)
        }
    }
}

/// The whole plan at a size its titles can be read at, pinch to zoom.
private struct ProjectGraphFullScreen: View {
    let graph: ProjectDependencyGraph
    @Binding var expanded: Set<String>
    let onOpenTask: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let prepared = ProjectGraph.prepare(graph, expanded: expanded)
                let layout = ProjectGraph.layout(marks: prepared.marks, edges: prepared.edges,
                                                 availableWidth: Double(geo.size.width))
                let scale = min(3, max(0.2, zoom * pinch))
                ScrollView([.horizontal, .vertical]) {
                    ProjectGraphCanvas(layout: layout, edges: prepared.edges) { mark in
                        if mark.kind == .task {
                            dismiss()
                            onOpenTask(mark.taskId ?? mark.id)
                        } else if ProjectGraph.canOpen(mark) {
                            expanded.insert(mark.id)
                        }
                    }
                    .scaleEffect(scale, anchor: .topLeading)
                    .frame(width: CGFloat(layout.width) * scale, height: CGFloat(layout.height) * scale,
                           alignment: .topLeading)
                }
                .gesture(
                    MagnifyGesture()
                        .updating($pinch) { value, state, _ in state = value.magnification }
                        .onEnded { value in zoom = min(3, max(0.2, zoom * value.magnification)) }
                )
            }
            .navigationTitle("Task graph")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// The drawing itself, at its layout's own size: edges first, marks over them.
struct ProjectGraphCanvas: View {
    let layout: ProjectGraph.Layout
    let edges: [ProjectGraphEdge]
    let onOpenMark: (ProjectGraphMark) -> Void
    /// The task a task page's dependency graph is drawn around, outlined so the reader finds it.
    var focusID: String? = nil

    var body: some View {
        let marks = layout.placements.map(\.mark)
        let states = Dictionary(marks.map { ($0.id, ProjectGraph.state(of: $0)) },
                                uniquingKeysWith: { first, _ in first })
        let waiting = ProjectGraph.waitingOn(marks: marks, edges: edges)
        ZStack(alignment: .topLeading) {
            ForEach(layout.routes) { route in
                let state = states[route.source] ?? .pending
                ProjectGraphRoute(points: route.points)
                    .stroke(edgeColor(state),
                            style: StrokeStyle(lineWidth: state == .complete ? 1.2 : 1.5, lineCap: .round,
                                               lineJoin: .round, dash: state == .failed ? [4, 3] : []))
                ProjectGraphArrow(points: route.points).fill(edgeColor(state))
            }
            ForEach(layout.placements) { placement in
                Button { onOpenMark(placement.mark) } label: {
                    ProjectGraphMarkView(mark: placement.mark, waitingOn: waiting[placement.id] ?? 0,
                                         isFocus: placement.id == focusID)
                }
                .buttonStyle(.plain)
                .frame(width: CGFloat(placement.box.width), height: CGFloat(placement.box.height))
                .offset(x: CGFloat(placement.box.x), y: CGFloat(placement.box.y))
            }
        }
        .frame(width: CGFloat(layout.width), height: CGFloat(layout.height), alignment: .topLeading)
    }

    /// An edge reports its prerequisite: released (quiet green), still ahead (grey), in flight
    /// (accent), or failed (red, dashed — colour is never the only channel).
    private func edgeColor(_ state: ProjectGraph.State) -> Color {
        switch state {
        case .complete: return Color.green.opacity(0.45)
        case .failed: return Color.red.opacity(0.8)
        case .active, .queued: return Color.accentColor.opacity(0.8)
        case .pending: return Color.secondary.opacity(0.7)
        }
    }
}

/// One mark: a task card with its rail and its one line, or a dashed fold with its bar.
private struct ProjectGraphMarkView: View {
    let mark: ProjectGraphMark
    let waitingOn: Int
    var isFocus = false

    var body: some View {
        if mark.kind == .task {
            taskCard
        } else {
            foldCard
        }
    }

    private var taskCard: some View {
        let tone = ProjectGraph.tone(of: mark)
        let complete = tone == .complete
        let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)
        return HStack(spacing: 0) {
            Rectangle().fill(rail(tone)).frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text(mark.title)
                    .font(.orbitGraphTitle)
                    .fontWeight(complete ? .regular : .semibold)
                    .foregroundStyle(complete ? Color.secondary : Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(ProjectGraph.meta(of: mark, waitingOn: waitingOn))
                    .font(.orbitGraphMeta)
                    .fontWeight(loud(tone) ? .semibold : .regular)
                    .foregroundStyle(metaColor(tone))
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .background(complete ? Color.secondary.opacity(0.08) : Color.secondary.opacity(0.03), in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(isFocus ? Color.accentColor : border(tone), lineWidth: isFocus ? 2 : 1))
        .background {
            if tone == .ready || isFocus { shape.stroke(Color.accentColor.opacity(0.14), lineWidth: 6) }
        }
        .contentShape(shape)
    }

    private var foldCard: some View {
        let settled = mark.kind == .settled
        let failed = ProjectGraph.state(of: mark) == .failed
        let ink = failed ? Color.red : (settled ? Color.green : Color.accentColor)
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 4) {
                Text(ProjectGraph.foldTitle(mark))
                    .font(.orbitGraphTitle)
                    .foregroundStyle(settled ? Color.secondary : Color.primary)
                    .lineLimit(1)
                if !settled {
                    Text("×\(OrbitLinkCopy.number(mark.taskCount))")
                        .font(.orbitGraphMeta)
                        .foregroundStyle(.secondary)
                }
            }
            ProjectGraphFoldBar(mark: mark)
            Text(ProjectGraph.foldLegend(mark))
                .font(.orbitGraphMeta)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(ink.opacity(0.07), in: shape)
        .overlay(shape.strokeBorder(ink.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .contentShape(shape)
    }

    private func rail(_ tone: ProjectGraph.Tone) -> Color {
        switch tone {
        case .ready, .active: return .accentColor
        case .queued: return Color.accentColor.opacity(0.4)
        case .complete: return Color.green.opacity(0.5)
        case .failed: return .red
        case .blocked: return Color.secondary.opacity(0.5)
        }
    }

    private func border(_ tone: ProjectGraph.Tone) -> Color {
        switch tone {
        case .ready: return Color.accentColor.opacity(0.45)
        case .failed: return Color.red.opacity(0.4)
        default: return Color.secondary.opacity(0.25)
        }
    }

    private func loud(_ tone: ProjectGraph.Tone) -> Bool {
        tone == .ready || tone == .active || tone == .failed
    }

    private func metaColor(_ tone: ProjectGraph.Tone) -> Color {
        switch tone {
        case .ready, .active: return .accentColor
        case .failed: return .red
        default: return .secondary
        }
    }
}

/// A fold's proportions, in the web's order: done, running, failed, cancelled, open.
private struct ProjectGraphFoldBar: View {
    let mark: ProjectGraphMark

    var body: some View {
        let segments = ProjectGraph.foldSegments(mark)
        let total = max(1, segments.reduce(0) { $0 + $1.count })
        GeometryReader { geo in
            HStack(spacing: 1) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    color(segment.status)
                        .frame(width: max(2, (geo.size.width - CGFloat(max(0, segments.count - 1)))
                                        * CGFloat(segment.count) / CGFloat(total)))
                }
            }
        }
        .frame(height: 5)
        .background(Color.secondary.opacity(0.15))
        .clipShape(Capsule())
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "DONE": return .green
        case "IN_PROGRESS": return .accentColor
        case "FAILED": return .red
        case "CANCELLED": return Color.secondary.opacity(0.5)
        default: return Color.secondary.opacity(0.35)
        }
    }
}

/// An orthogonal line through `points`, its corners rounded.
private struct ProjectGraphRoute: Shape {
    let points: [ProjectGraph.Point]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        let cgPoints = points.map { CGPoint(x: $0.x, y: $0.y) }
        path.move(to: CGPoint(x: first.x, y: first.y))
        if cgPoints.count > 2 {
            for index in 1..<(cgPoints.count - 1) {
                let before = cgPoints[index - 1], corner = cgPoints[index], after = cgPoints[index + 1]
                // Never rounder than half of either leg, or the arc overshoots a short jog.
                let radius = min(6, hypot(corner.x - before.x, corner.y - before.y) / 2,
                                 hypot(after.x - corner.x, after.y - corner.y) / 2)
                if radius < 0.5 {
                    path.addLine(to: corner)
                } else {
                    path.addArc(tangent1End: corner, tangent2End: after, radius: radius)
                }
            }
        }
        path.addLine(to: cgPoints[cgPoints.count - 1])
        return path
    }
}

/// The arrowhead at a line's end, pointing the way its last segment runs.
private struct ProjectGraphArrow: Shape {
    let points: [ProjectGraph.Point]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard points.count >= 2 else { return path }
        let tip = points[points.count - 1]
        let from = points[points.count - 2]
        let dx = tip.x - from.x, dy = tip.y - from.y
        let length = max(0.001, (dx * dx + dy * dy).squareRoot())
        let ux = dx / length, uy = dy / length
        let back = 6.0, half = 3.5
        path.move(to: CGPoint(x: tip.x, y: tip.y))
        path.addLine(to: CGPoint(x: tip.x - ux * back - uy * half, y: tip.y - uy * back + ux * half))
        path.addLine(to: CGPoint(x: tip.x - ux * back + uy * half, y: tip.y - uy * back - ux * half))
        path.closeSubpath()
        return path
    }
}
