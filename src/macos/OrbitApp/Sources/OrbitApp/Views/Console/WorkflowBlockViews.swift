import SwiftUI
import OrbitKit

// An Orbit workflow (`mcp__orbit__workflow`) as iOS and macOS draw it — board
// docs/mocks/subagent-workflow part 4: the folded block, the page of its calls by phase, and the strip
// of the turn its end opens. The words are OrbitKit's (`WorkflowBlock`, `WorkflowFinishedStrip`).

private let workflowTint = Color.purple

/// The folded block: `✦ Workflow <description>` with a spinner or how it ended, then the grey
/// `<phase> · <done> of <started> · $<cost>`, then, italic while it runs, how many calls run and wait.
/// A tap opens its calls.
struct WorkflowBlockView: View {
    let card: ToolCard
    var fullPayload: (@MainActor (Int) async -> JSONValue?)? = nil
    @Environment(\.taskActivity) private var taskActivity
    @State private var showingCalls = false

    var body: some View {
        let block = WorkflowBlockView.block(card, taskActivity)
        Button { showingCalls = true } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Image(systemName: "sparkle").font(.orbitMeta).foregroundStyle(workflowTint)
                    Text(WorkflowBlock.label).font(.orbitLabel.weight(.semibold)).foregroundStyle(.primary)
                        .layoutPriority(1)
                    Text(block.title).font(.orbitLabel).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    WorkflowStateGlyph(state: block.state)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(block.progress).font(.orbitMeta).monospacedDigit().foregroundStyle(.secondary)
                    if let live = block.live {
                        Text(live).font(.orbitMeta).italic().foregroundStyle(.secondary)
                    }
                    if let error = block.error {
                        Text(error).font(.orbitMeta).foregroundStyle(.red).lineLimit(3)
                    }
                }
                .padding(.leading, 20)
            }
            .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(workflowTint.opacity(0.06))
            .overlay(alignment: .leading) { Rectangle().fill(workflowTint).frame(width: 3) }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("workflow-block")
        .sheet(isPresented: $showingCalls) {
            WorkflowCallsSheet(card: card, fullPayload: fullPayload ?? taskActivity?.fullPayload)
                .environment(\.taskActivity, taskActivity)
        }
    }

    static func block(_ card: ToolCard, _ activity: TaskActivityLookup?) -> WorkflowBlock {
        WorkflowBlock.describe(card: card, workflow: activity?.workflowRun(card.id),
                               nested: activity?.subagentItems(card.id) ?? [],
                               run: { activity?.subagentRun($0) },
                               backgroundRunning: activity?.isRunning(card.id) ?? false)
    }
}

/// A spinner while it runs, then how it ended.
private struct WorkflowStateGlyph: View {
    let state: WorkflowBlock.State
    var body: some View {
        switch state {
        case .running: ProgressView().controlSize(.small)
        case .done: Image(systemName: "checkmark").font(.orbitMeta.weight(.bold)).foregroundStyle(.green)
        case .failed: Image(systemName: "xmark").font(.orbitMeta.weight(.bold)).foregroundStyle(.red)
        case .stopped: Image(systemName: "stop.fill").font(.orbitMeta).foregroundStyle(.red)
        }
    }
}

/// The page a workflow opens to: its calls by phase, each section headed by its counts, each row its
/// label, the line it handed back and how it stands. A row opens the call's SubAgent detail — the same
/// one a `delegate` call's block opens to.
struct WorkflowCallsSheet: View {
    let card: ToolCard
    var fullPayload: (@MainActor (Int) async -> JSONValue?)? = nil
    @Environment(\.taskActivity) private var taskActivity
    @Environment(\.dismiss) private var dismiss
    /// Ended phases the reader opened past their first rows.
    @State private var unfolded: Set<String> = []

    var body: some View {
        let block = WorkflowBlockView.block(card, taskActivity)
        NavigationStack {
            // One flat array of rows (`ListRowShapeTests`): each phase's head, its calls, its `N more`.
            List {
                ForEach(rows(block)) { row in
                    WorkflowCallsListRow(row: row) { unfolded.insert($0) }
                }
            }
            .navigationTitle(block.title.isEmpty ? WorkflowBlock.label : block.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .navigationDestination(for: String.self) { id in
                WorkflowCallDetailSlot(call: block.calls.first(where: { $0.id == id }), fullPayload: fullPayload)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 460)
        #endif
        .accessibilityIdentifier("workflow-calls")
    }

    private func rows(_ block: WorkflowBlock) -> [WorkflowCallsRow] {
        var rows: [WorkflowCallsRow] = []
        for section in block.sections {
            rows.append(.head(section.header.uppercased(), first: rows.isEmpty))
            let all = unfolded.contains(section.id)
            for call in all ? section.calls : Array(section.calls.prefix(section.shown)) { rows.append(.call(call)) }
            if let more = section.more, !all { rows.append(.more(more, section: section.id)) }
        }
        return rows.isEmpty ? [.empty] : rows
    }
}

enum WorkflowCallsRow: Identifiable {
    case head(String, first: Bool)
    case call(WorkflowBlock.Call)
    case more(String, section: String)
    case empty

    var id: String {
        switch self {
        case .head(let title, _): return "head:" + title
        case .call(let call): return "call:" + call.id
        case .more(_, let section): return "more:" + section
        case .empty: return "empty"
        }
    }
}

/// One row of the calls page, whatever it is.
private struct WorkflowCallsListRow: View {
    let row: WorkflowCallsRow
    let unfold: (String) -> Void

    var body: some View {
        switch row {
        case .head(let title, let first):
            Text(title).font(.orbitSectionLabel.weight(.semibold)).foregroundStyle(.secondary)
                .padding(.top, first ? 0 : 10)
                .listRowSeparator(.hidden)
        case .call(let call):
            NavigationLink(value: call.id) { WorkflowCallRow(call: call) }
        case .more(let words, let section):
            Button(words) { unfold(section) }.buttonStyle(.plain).foregroundStyle(.secondary)
        case .empty:
            Text("No calls yet").foregroundStyle(.secondary)
        }
    }
}

/// The detail a row opens to, or nothing once its call has left the transcript's window.
private struct WorkflowCallDetailSlot: View {
    let call: WorkflowBlock.Call?
    var fullPayload: (@MainActor (Int) async -> JSONValue?)? = nil

    var body: some View {
        if let call { WorkflowCallDetail(call: call, fullPayload: fullPayload) }
    }
}

private struct WorkflowCallRow: View {
    let call: WorkflowBlock.Call

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(call.label).font(.body.weight(.semibold)).lineLimit(1).layoutPriority(1)
            if let result = call.result {
                Text(result).font(.body).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 4)
            switch call.state {
            case .queued: Text("Queued").font(.orbitMeta).foregroundStyle(.secondary)
            case .running: ProgressView().controlSize(.small)
            case .done: Image(systemName: "checkmark").font(.orbitMeta.weight(.bold)).foregroundStyle(.green)
            case .failed: Image(systemName: "xmark").font(.orbitMeta.weight(.bold)).foregroundStyle(.red)
            }
        }
        .opacity(call.state == .queued ? 0.55 : 1)
    }
}

/// One call's SubAgent: its block's lines and the detail a `delegate` call opens to — steps, Why, result.
private struct WorkflowCallDetail: View {
    let call: WorkflowBlock.Call
    var fullPayload: (@MainActor (Int) async -> JSONValue?)? = nil
    @Environment(\.taskActivity) private var taskActivity

    var body: some View {
        let run = taskActivity?.subagentRun(call.id)
        let block = SubagentBlock.describe(input: call.card.input, run: run, status: call.card.status,
                                           parentEngine: taskActivity?.parentEngine,
                                           result: SubagentResult.text(callResult: call.card.result, run: run))
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                AgentBlockLines(block: block, live: nil,
                                steps: SubagentBlock.steps(taskActivity?.subagentItems(call.id) ?? []))
                ToolCardView(card: call.card, fullPayload: fullPayload, showsHeader: false)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(call.label)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .accessibilityIdentifier("workflow-call-detail")
    }
}

/// The turn a workflow's end opened (board part 4 ②): a pale purple strip per workflow — how it ended,
/// then its calls, failures, time and cost. The parent's answer follows it as its own reply. A tap
/// scrolls to the workflow's block.
struct WorkflowFinishedStripView: View {
    let wake: WorkflowFinished
    @Environment(\.taskActivity) private var taskActivity

    var body: some View {
        let workflows = taskActivity?.workflows() ?? []
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(wake.runs.enumerated()), id: \.offset) { _, run in
                let server = WorkflowFinishedStrip.workflow(for: run, in: workflows)
                strip(WorkflowFinishedStrip.describe(run, workflow: server), toolUseId: server?.toolUseId)
            }
        }
        .accessibilityIdentifier("workflow-finished-strip")
    }

    private func strip(_ strip: WorkflowFinishedStrip, toolUseId: String?) -> some View {
        Button { if let toolUseId { taskActivity?.reveal?(toolUseId) } } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(strip.title).font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(strip.failed ? AnyShapeStyle(Color.red) : AnyShapeStyle(.primary))
                Text(strip.line).font(.orbitMeta).monospacedDigit().foregroundStyle(.secondary)
            }
            .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(workflowTint.opacity(0.09))
            .overlay(alignment: .leading) { Rectangle().fill(strip.failed ? Color.red : workflowTint).frame(width: 3) }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
