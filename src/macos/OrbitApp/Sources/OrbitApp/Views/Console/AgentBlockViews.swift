import SwiftUI
import OrbitKit

// Orbit's own Agents (`mcp__orbit__delegate`) as the conversation draws them — board
// docs/mocks/subagent-ios-highlight: ① the block's second and third lines and its Changed files, ② a
// group of Agents started together, ③ the session's Agents behind one line of the composer band. The
// words are OrbitKit's (`SubagentBlock`, `SubagentGroup`, `SubagentSessionSummary`).

/// An engine's colour, for its chip's mark and wash.
private func engineTint(_ engine: String?) -> Color {
    switch engine {
    case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
    case "dsh": return Color(red: 0.30, green: 0.42, blue: 1.0)
    case "kimi": return Color(red: 0.10, green: 0.45, blue: 0.95)
    case "antigravity": return Color(red: 0.26, green: 0.52, blue: 0.96)
    case "cursor", "codex", "opencode": return .primary
    default: return .secondary
    }
}

/// `[C] Claude Sonnet 5.5`: the engine's mark and short name, then the model.
struct AgentEngineChip: View {
    let engine: String?
    let name: String?
    let model: String?
    /// The model's name already says the engine's: the mark stands for it alone.
    var modelNamesEngine = false

    var body: some View {
        let tint = engineTint(engine)
        HStack(spacing: 4) {
            if let name {
                Text(String(name.prefix(1)))
                    .font(.orbitSectionLabel.weight(.heavy))
                    .foregroundStyle(Color(white: 1))
                    .frame(width: 14, height: 14)
                    .background(tint, in: RoundedRectangle(cornerRadius: 4))
                if !modelNamesEngine || model == nil { Text(name).fontWeight(.semibold) }
            }
            if let model {
                Text(model).fontWeight(modelNamesEngine ? .semibold : .regular)
                    .lineLimit(1).truncationMode(.middle)
            }
        }
        .font(.orbitLabel)
        .foregroundStyle(engine == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
        .padding(.leading, name == nil ? 6 : 3).padding(.trailing, 6).padding(.vertical, 2)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// `Read-only`, `on orbit-macos`: a fact about the run, in a grey chip.
struct AgentFact: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.orbitSectionLabel.weight(.semibold))
            Text(text)
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// Who did the work and where: `Claude →`, the chip, the tier and type, Read-only, the machine.
struct AgentIdentityLine: View {
    let block: SubagentBlock
    var showsMeta = true
    /// What ends the line where a row has no room of its own for it: `22s · <$0.01`.
    var trailing: String? = nil

    var body: some View {
        FlowLayout(spacing: 5) {
            if let from = block.fromEngine {
                Text("\(from) →").font(.orbitLabel).foregroundStyle(.secondary)
            }
            if block.engineName != nil || block.model != nil {
                AgentEngineChip(engine: block.engine, name: block.engineName, model: block.model,
                                modelNamesEngine: block.modelNamesEngine)
            }
            if showsMeta, !block.meta.isEmpty {
                Text(block.meta).font(.orbitLabel).foregroundStyle(.secondary)
            }
            if block.readonly { AgentFact(symbol: "lock.fill", text: "Read-only") }
            if let workspace = block.workspace { AgentFact(symbol: "desktopcomputer", text: workspace) }
            if let trailing {
                Text(trailing).font(.orbitLabel).foregroundStyle(.secondary).monospacedDigit()
            }
        }
    }
}

/// An Agent's second and third lines under its row: who and where, then what came of it — or, while it
/// runs, what it is on, how long it has run and how many steps it has taken.
struct AgentBlockLines: View {
    let block: SubagentBlock
    /// What the running Agent is on right now (`ToolCardView.liveActivity`); nil once it is open.
    let live: String?
    let steps: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AgentIdentityLine(block: block)
            if block.running {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let elapsed = block.startedAt.map { context.date.timeIntervalSince($0) }
                    outcomeRow(text: live, italic: true,
                               numbers: SubagentBlock.runningNumbers(elapsed: elapsed, steps: steps))
                }
            } else if block.outcome != nil || block.numbers != nil {
                outcomeRow(text: block.outcome, italic: false, numbers: block.numbers)
            }
        }
    }

    @ViewBuilder
    private func outcomeRow(text: String?, italic: Bool, numbers: String?) -> some View {
        if text != nil || numbers != nil {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let text {
                    if !italic {
                        Image(systemName: "arrow.turn.down.right").font(.orbitMeta).foregroundStyle(.tertiary)
                    }
                    Text(text)
                        .font(italic ? .orbitMonoFine.italic() : .orbitLabel.weight(block.outcomeIsFiles ? .semibold : .regular))
                        .foregroundStyle(block.outcomeIsFailure ? AnyShapeStyle(Color.red)
                                         : italic ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                        .lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 4)
                if let numbers {
                    Text(numbers).font(.orbitMonoFine).foregroundStyle(.secondary).monospacedDigit().fixedSize()
                }
            }
        }
    }
}

/// The paths an Agent wrote, in the opened block: still in the working tree, not committed.
struct AgentChangedFiles: View {
    let paths: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Changed files").fontWeight(.semibold)
                Spacer()
                Text("not committed").foregroundStyle(.secondary)
            }
            .font(.orbitLabel)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color.primary.opacity(0.04))
            ForEach(paths, id: \.self) { path in
                Divider()
                Text(path)
                    .font(.orbitMonoFine)
                    .lineLimit(1).truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .textSelection(.enabled)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
    }
}

/// Agents started together (`TranscriptRow.agents`), as one group: a head that adds them up and a bar
/// of how far they have got, then a two-line row for each. A row opens in place to the member's Why,
/// steps, changed files and result — one at a time; the others stay as they are.
struct AgentGroupView: View {
    let cards: [ToolCard]
    var fullPayload: (@MainActor (Int) async -> JSONValue?)? = nil
    @Environment(\.taskActivity) private var taskActivity
    @State private var openID: String?

    var body: some View {
        let runs = cards.map { taskActivity?.subagentRun($0.id) }
        let blocks = zip(cards, runs).map { card, run in
            SubagentBlock.describe(input: card.input, run: run, status: card.status,
                                   parentEngine: taskActivity?.parentEngine,
                                   result: SubagentResult.text(callResult: card.result, run: run))
        }
        let group = SubagentGroup.describe(blocks, runs: runs, parentEngine: taskActivity?.parentEngine)
        VStack(alignment: .leading, spacing: 0) {
            head(group)
            ForEach(Array(cards.enumerated()), id: \.element.id) { i, card in
                Divider().padding(.leading, 27)
                member(card, blocks[i])
            }
        }
        .padding(.leading, 12).padding(.trailing, 10).padding(.top, 8).padding(.bottom, 2)
        .background(Color.purple.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.purple.opacity(0.28)))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1.5).fill(Color.purple).frame(width: 3).padding(.vertical, 8)
        }
        .animation(nil, value: openID)
    }

    private func head(_ group: SubagentGroup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Image(systemName: "sparkle")
                    .font(.orbitMeta).foregroundStyle(.purple)
                    .frame(width: 20, height: 20)
                    .background(Color.purple.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                Text(group.title).font(.orbitMono.weight(.semibold))
                Text(group.progress).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
                ToolStatusGlyph(status: group.running > 0 ? .running : group.failed > 0 ? .error : .ok)
            }
            let facts = [group.engines, group.machines].compactMap { $0 }
            if !facts.isEmpty {
                Text(facts.joined(separator: " · "))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.leading, 27)
            }
            // One segment per Agent, as far as it has got: ended well, failed, still running.
            HStack(spacing: 3) {
                ForEach(0..<(group.done + group.failed + group.running), id: \.self) { i in
                    Capsule()
                        .fill(i < group.done ? Color.green
                              : i < group.done + group.failed ? Color.red : Color.purple.opacity(0.3))
                        .frame(maxWidth: .infinity)
                        .frame(height: 4)
                }
            }
            .padding(.leading, 27).padding(.bottom, 6)
        }
    }

    @ViewBuilder
    private func member(_ card: ToolCard, _ block: SubagentBlock) -> some View {
        let open = openID == card.id
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                ToolStatusGlyph(status: block.running ? .running : block.outcomeIsFailure ? .error : card.status)
                    .frame(width: 20)
                Text(card.input["description"]?.stringValue ?? SubagentBlock.label)
                    .font(.orbitLabel.weight(open ? .semibold : .regular))
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            AgentIdentityLine(block: block, showsMeta: open, trailing: block.numbers)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 27)
            if open {
                ToolCardView(card: card, fullPayload: fullPayload, showsHeader: false)
                    .padding(.leading, 27).padding(.top, 4)
            }
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onTapGesture { openID = open ? nil : card.id }
        .accessibilityAddTraits(.isButton)
    }
}

/// The composer band's line for the session's Agents: how many, how many still run. No cost.
/// It opens their list (`AgentsSheet`). Absent until the session has started one.
struct AgentsBandRow: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    @State private var showing = false

    var body: some View {
        if let summary = SubagentSessionSummary.make(Array(console.subagentRuns.values)) {
            Button { showing = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "sparkle").font(.orbitMeta).foregroundStyle(.purple)
                    Text("Agents").font(.orbitLabel.weight(.semibold))
                    Text(line(summary)).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    if summary.running > 0 { ProgressView().controlSize(.mini) }
                    Image(systemName: "chevron.right")
                        .font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10).padding(.vertical, 3).frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .composerBandCard()
            .padding(.bottom, .composerBandGap)
            .accessibilityLabel("Agents: \(line(summary))")
            .sheet(isPresented: $showing) {
                AgentsSheet(summary: summary, parentEngine: app.session(id: console.sessionID)?.engine) { id in
                    showing = false
                    console.revealAgent(id)
                }
            }
        }
    }

    private func line(_ summary: SubagentSessionSummary) -> String {
        var parts = ["\(summary.count)"]
        if summary.running > 0 { parts.append("\(summary.running) running") }
        return parts.joined(separator: " · ")
    }
}

/// Every Agent the session started: two figures and the runs — the running ones first. No cost is shown,
/// not even a run's own. A row closes the sheet and scrolls the conversation to its block.
struct AgentsSheet: View {
    let summary: SubagentSessionSummary
    let parentEngine: String?
    let reveal: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        figure("\(summary.count)", summary.running > 0 ? "runs · \(summary.running) running" : "runs · all done")
                        figure(summary.spread.components(separatedBy: " · ").first ?? summary.spread,
                               summary.spread.components(separatedBy: " · ").dropFirst().first ?? " ")
                    }
                }
                let running = summary.rows.filter(\.isRunning)
                let ended = summary.rows.filter { !$0.isRunning }
                if !running.isEmpty { Section("Running") { ForEach(running) { row($0) } } }
                if !ended.isEmpty { Section("Done") { ForEach(ended) { row($0) } } }
            }
            .navigationTitle("Agents")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 420)
        #endif
    }

    private func figure(_ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title3.weight(.semibold)).monospacedDigit()
            Text(caption).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ run: SubagentRunView) -> some View {
        let block = SubagentBlock.describe(input: .object([:]), run: run, status: .ok,
                                           parentEngine: parentEngine)
        return Button { reveal(run.toolUseId) } label: {
            HStack(alignment: .top, spacing: 10) {
                ToolStatusGlyph(status: block.running ? .running : block.outcomeIsFailure ? .error : .ok)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 4) {
                    Text(run.description ?? run.type).font(.body).lineLimit(1)
                    AgentIdentityLine(block: block, showsMeta: false, trailing: rowNumbers(block, run))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// A writer's file count ahead of its time (`3 files · 2m 4s`); the run's cost is left out.
    private func rowNumbers(_ block: SubagentBlock, _ run: SubagentRunView) -> String? {
        var parts: [String] = []
        if block.outcomeIsFiles { parts.append(block.changedFiles.count == 1 ? "1 file" : "\(block.changedFiles.count) files") }
        if let duration = SubagentBlock.duration(run) { parts.append(duration) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
