import SwiftUI
import OrbitKit

// How a background SubAgent's card ends (board docs/mocks/subagent-card-and-end-line, approved 2026-11-20),
// in OrbitKit's `SubagentCardEnd` words. Like Claude Code's built-in Agent, the SubAgent is one card from
// start to end: the row's status says how it ended, the folded line under it becomes the ending, and the
// opened card closes on an end block. The turn the control plane opened for the end draws nothing.
// Web parity: `SubagentCardEnd.tsx`.

/// The row's end: ✓ alone for DONE; the mark and a word chip for every other end — red for a run that
/// did not finish, grey for one that was stopped.
struct SubagentEndStatus: View {
    let status: String

    var body: some View {
        let tone = SubagentCardEnd.tone(status)
        HStack(spacing: 5) {
            if let word = SubagentCardEnd.chip(status) {
                Text(word)
                    .font(.orbitMonoFine)
                    .foregroundStyle(tone == .stopped ? Color.secondary : Color.red)
                    .fixedSize()
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background((tone == .stopped ? Color.gray : Color.red).opacity(tone == .stopped ? 0.14 : 0.1),
                                in: RoundedRectangle(cornerRadius: 4))
            }
            SubagentEndGlyph(status: status)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status == "DONE" ? "done" : status.lowercased())
        .accessibilityIdentifier("subagent-end-status")
    }
}

/// The mark alone: ✓, ✕, or a grey disc with a square in it for a stop.
struct SubagentEndGlyph: View {
    let status: String

    var body: some View {
        switch SubagentCardEnd.tone(status) {
        case .ok: Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        case .stopped: Image(systemName: "stop.circle.fill").font(.orbitLabel).foregroundStyle(.gray)
        }
    }
}

/// The folded card's ending, where the live line was while it ran: two lines of what a run that finished
/// handed back, or why one did not, once, and the files it left.
struct SubagentFoldedEnd: View {
    let run: SubagentRunView
    let onShowFiles: () -> Void

    var body: some View {
        let tone = SubagentCardEnd.tone(run.status)
        if tone == .ok {
            if let result = run.resultSummary, !result.isEmpty {
                inlineMarkdown(result)
                    .font(.orbitSubtext)
                    .foregroundStyle(.secondary)
                    .lineLimit(SubagentCardEnd.resultLines).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("subagent-ending")
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                if let reason = SubagentCardEnd.because(run.status) {
                    Text(reason)
                        .font(.orbitSubtext)
                        .foregroundStyle(tone == .stopped ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color.red))
                        .fixedSize(horizontal: false, vertical: true)
                }
                files
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("subagent-ending")
        }
    }

    /// `9 files left uncommitted Show files model-routing.ts · task-route-decision.ts · +7`
    @ViewBuilder private var files: some View {
        let paths = run.changedFiles ?? []
        if !paths.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(SubagentCardEnd.fileCount(paths.count)).foregroundStyle(.secondary).fixedSize()
                Button(SubagentCardEnd.showFiles, action: onShowFiles)
                    .buttonStyle(.plain).foregroundStyle(.tint).fixedSize()
                Text(SubagentCardEnd.fileNames(paths))
                    .font(.orbitMonoFine).foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.leading, 2)
            }
            .font(.orbitSubtext)
        }
    }
}

/// While the end turn waits on the queue: the agent has not read it yet, and it can still be kept back.
struct SubagentWakeQueuedLine: View {
    let onDontSend: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text("\(SubagentCardEnd.waiting) ·").foregroundStyle(.tertiary)
            Button(SubagentCardEnd.dontSend, action: onDontSend)
                .buttonStyle(.plain).foregroundStyle(.tint)
        }
        .font(.orbitMeta)
        .accessibilityIdentifier("subagent-wake-queued")
    }
}

/// The opened card's foot: how it ended and when, every file it left, what the agent read, and the run.
struct SubagentEndBlock: View {
    let run: SubagentRunView
    let runId: String?
    let wake: SubagentCardEnd.WakeSeen?
    @State private var allFiles = false
    @State private var showingRaw = false

    var body: some View {
        let tone = SubagentCardEnd.tone(run.status)
        let files = run.changedFiles ?? []
        let shown = allFiles ? files : Array(files.prefix(SubagentCardEnd.filesShown))
        VStack(alignment: .leading, spacing: 4) {
            if let head = SubagentCardEnd.endHead(run.status, when: run.endedAt.flatMap { RelativeTime.format($0) }) {
                Text(head)
                    .font(.orbitSubtext)
                    .foregroundStyle(tone == .stopped ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color.red))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !files.isEmpty {
                Text(SubagentCardEnd.filesHead(files.count))
                    .font(.orbitSubtext).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(shown, id: \.self) { path in
                        Text(path).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    if shown.count < files.count {
                        Button(SubagentCardEnd.moreFiles(files.count - shown.count)) { allFiles = true }
                            .buttonStyle(.plain).foregroundStyle(.tint)
                    }
                }
                .font(.orbitMonoFine).foregroundStyle(.tertiary)
            }
            if let wake {
                DisclosureGroup(isExpanded: $showingRaw) {
                    Text(wake.text)
                        .font(.orbitMonoFine)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 2)
                } label: {
                    Text(SubagentCardEnd.rawSummary).font(.orbitMeta).foregroundStyle(.tertiary)
                }
            }
            if let runId {
                Text(SubagentCardEnd.runLine(runId, readAt: wake?.readAt.flatMap(SubagentCardEnd.clock)))
                    .font(.orbitMeta).foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityIdentifier("subagent-end-block")
    }
}

/// Each SubAgent end turn still on the queue, by run id: its `Don't send`.
struct SubagentQueuedWakes {
    let dontSend: [String: @MainActor () -> Void]
}

private struct SubagentWakesKey: EnvironmentKey {
    static let defaultValue: [String: SubagentCardEnd.WakeSeen] = [:]
}

private struct SubagentQueuedWakesKey: EnvironmentKey {
    static let defaultValue: SubagentQueuedWakes? = nil
}

extension EnvironmentValues {
    /// The SubAgent end turns the console holds, by run id (`SubagentCardEnd.wakes`).
    var subagentWakes: [String: SubagentCardEnd.WakeSeen] {
        get { self[SubagentWakesKey.self] }
        set { self[SubagentWakesKey.self] = newValue }
    }

    /// The SubAgent end turns still on the queue, by run id. Nil where no console sets it.
    var subagentQueuedWakes: SubagentQueuedWakes? {
        get { self[SubagentQueuedWakesKey.self] }
        set { self[SubagentQueuedWakesKey.self] = newValue }
    }
}
