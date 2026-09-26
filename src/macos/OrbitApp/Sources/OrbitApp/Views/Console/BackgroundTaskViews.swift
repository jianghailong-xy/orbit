import SwiftUI
import OrbitKit

// What the workspace's background sub-agents and workflows are doing, drawn on their cards and in
// the tray: the progress their runner relays (`TaskProgress`), and a sub-agent's own transcript
// nested under the call that started it. Web parity: TaskProgressBlock.tsx and `.chat-subagent`.

/// The console's background agents and workflows, as the cards read them: progress by launching
/// call, whether the work still runs, and what each sub-agent did. Compared by console identity
/// only — the console rebuilds this on every render, and closures never compare equal — so the
/// cards that read it re-render through the observed model, not through the environment.
struct TaskActivityLookup: Equatable {
    let consoleID: ObjectIdentifier
    let progress: (String) -> TaskProgress?
    let isRunning: (String) -> Bool
    let subagentItems: (String) -> [TranscriptItem]

    static func == (lhs: TaskActivityLookup, rhs: TaskActivityLookup) -> Bool {
        lhs.consoleID == rhs.consoleID
    }
}

private struct TaskActivityKey: EnvironmentKey {
    static let defaultValue: TaskActivityLookup? = nil
}

extension EnvironmentValues {
    var taskActivity: TaskActivityLookup? {
        get { self[TaskActivityKey.self] }
        set { self[TaskActivityKey.self] = newValue }
    }
}

/// How far a workflow (or an agent) has got: its agents by phase — done, running with the tool it
/// is on, queued — and the totals underneath. The words are `TaskProgressCopy`'s, the same table
/// web's TaskProgressBlock draws from.
struct TaskProgressView: View {
    let progress: TaskProgress

    var body: some View {
        let groups = TaskProgressCopy.phaseGroups(progress)
        let footer = TaskProgressCopy.footer(progress)
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                if !group.title.isEmpty || groups.count > 1 {
                    HStack(spacing: 5) {
                        Text(group.title.uppercased())
                            .font(.orbitSectionLabel.weight(.semibold)).tracking(0.4)
                        Text("\(group.done)/\(group.total)").font(.orbitSectionLabel)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                }
                ForEach(group.agents) { agent in
                    TaskAgentRow(agent: agent)
                }
            }
            if !footer.isEmpty {
                Divider().opacity(0.5).padding(.top, 4)
                Text(footer).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One agent of a workflow: where it stands, its label, what it is on right now, and its count.
private struct TaskAgentRow: View {
    let agent: TaskProgress.Agent

    var body: some View {
        let now = TaskProgressCopy.now(agent)
        let detail = TaskProgressCopy.detail(agent)
        HStack(spacing: 8) {
            glyph.frame(width: 16)
            Text(agent.label).font(.orbitMono).lineLimit(1).truncationMode(.tail).layoutPriority(1)
            if !now.isEmpty {
                Text(now).font(.orbitMonoFine).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 4)
            if !detail.isEmpty {
                Text(detail).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }

    @ViewBuilder private var glyph: some View {
        switch TaskProgressCopy.lane(agent) {
        case .done:    Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case .failed:  Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        case .running: ProgressView().controlSize(.small)
        case .queued:  Image(systemName: "circle").font(.orbitLabel).foregroundStyle(.tertiary)
        }
    }
}

/// What a sub-agent did — its calls, its words — under the Agent call that started it, folded the
/// way the conversation folds (`TranscriptRows.nested`). An agent it started is a card here too,
/// and opens to its own list the same way.
struct SubagentTranscriptView: View {
    let items: [TranscriptItem]
    var fullPayload: (@MainActor (Int) async -> JSONValue?)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(TranscriptRows.nested(items)) { row in
                switch row {
                case .item(let item):
                    TranscriptItemView(item: item, fullPayload: fullPayload)
                case .toolGroup(let cards):
                    ToolGroupCardView(cards: cards, fullPayload: fullPayload)
                default:
                    EmptyView()
                }
            }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.14)).frame(width: 2) }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
