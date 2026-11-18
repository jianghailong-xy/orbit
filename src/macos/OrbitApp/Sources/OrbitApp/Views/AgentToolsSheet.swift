import SwiftUI
import OrbitKit

/// Agent Tools (docs/mocks/agent-tools/01-board.png ⑤, approved 2026-11-14): what an agent in Orbit can reach
/// and what it was told. Read-only, as drawn — no switch, field or form lives here; the switches stay where they
/// are and the sheet says where. The words and the order are the web drawer's (AgentToolsDrawer.tsx), worked out
/// in OrbitKit (`AgentTools`) from the same generated guide.
///
/// On a session it shows that session's real connection, from the report its runner sent: whether the engine
/// started Orbit's MCP server and, if not, in the engine's own words why; the tools it lists and why some are
/// short; what its permission mode means for Orbit's calls; and the instructions it reads, in order, with their
/// role. On a workspace it shows what a session there is given, per engine. Both end with "How agents use Orbit".
///
/// It is given values and closures only — the call sites read the session's detail and the account's switch — so
/// a probe can host this very file with fixtures.
struct AgentToolsSheet: View {
    enum Mode {
        /// A session: its report (nil until its runner sends one), its engine, the permission mode the server
        /// resolves for it, the account's Session orchestration switch, and the moment "Reported …" counts from.
        case session(report: AgentToolsReport?, engine: String?, permissionMode: String?, orchestrationOn: Bool,
                     now: Date)
        /// A workspace: its name, its runtime instructions, whether it replaces the engine's own prompt, and the
        /// account's Session orchestration switch.
        case workspace(name: String, instructions: String, baseInstructions: Bool, orchestrationOn: Bool)
    }

    let mode: Mode
    let onDone: () -> Void
    /// The workspace layer's Edit, where its instructions can be edited from here.
    var onEditInstructions: (() -> Void)? = nil

    /// The engine a workspace's instructions are laid out for.
    @State private var workspaceEngine = AgentTools.engines[0]

    private let guide = AgentToolsGuide.shared

    var body: some View {
        NavigationStack {
            Form {
                switch mode {
                case let .session(report, engine, permissionMode, orchestrationOn, now):
                    sessionSections(report: report, engine: engine, permissionMode: permissionMode,
                                    orchestrationOn: orchestrationOn, now: now)
                case let .workspace(_, instructions, baseInstructions, orchestrationOn):
                    workspaceSections(instructions: instructions, baseInstructions: baseInstructions,
                                      orchestrationOn: orchestrationOn)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(AgentToolsCopy.done, action: onDone)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, idealWidth: 560, minHeight: 560, idealHeight: 720)
        #endif
    }

    private var title: String {
        switch mode {
        case .session: return AgentToolsCopy.title
        case let .workspace(name, _, _, _): return AgentToolsCopy.workspaceTitle(name)
        }
    }

    // MARK: - A session

    @ViewBuilder
    private func sessionSections(report: AgentToolsReport?, engine: String?, permissionMode: String?,
                                 orchestrationOn: Bool, now: Date) -> some View {
        let status = AgentTools.status(report, engine: engine)
        let reportedEngine: String? = report?.engine.isEmpty == false ? report?.engine : nil
        let shown: String = reportedEngine ?? engine ?? ""
        let permission = AgentTools.mode(permissionMode ?? report?.permissionMode)
        Section(AgentToolsCopy.thisSession) {
            statusRow(status, reported: report.flatMap { AgentTools.reported($0, now: now) })
            if let report, let versions = AgentTools.versions(report) {
                factRow(AgentToolsCopy.versions, value: versions, notes: [])
            }
            if let permission {
                factRow(AgentToolsCopy.permissionMode, value: permission.label, notes: [permission.orbit])
            }
            factRow(AgentToolsCopy.orchestration, value: orchestrationOn ? AgentToolsCopy.on : AgentToolsCopy.off,
                    notes: orchestrationNotes(report, on: orchestrationOn))
        }
        if let report {
            // Session orchestration's own reason is said on its row above; the rest are said here.
            let reasons = AgentTools.withheldReasons(report, excluding: ["orchestration"])
            Section {
                ForEach(AgentTools.toolsRows(report)) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(row.text)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 12)
                        Text(row.word)
                            .foregroundStyle(row.tone == .bad ? Color.red : Color.secondary)
                            .fixedSize()
                    }
                }
            } header: {
                Text(AgentToolsCopy.toolsListed(report.mcp.tools))
            } footer: {
                if !reasons.isEmpty { notes(reasons) }
            }
        } else {
            Section(AgentToolsCopy.tools) {
                note(AgentToolsCopy.toolsPending)
            }
        }
        if AgentTools.engines.contains(shown) {
            Section {
                layerRows(AgentTools.layers(shown, AgentTools.facts(report, engine: shown)),
                          workspaceChars: report?.instructions?.workspaceChars, skill: report?.skill)
            } header: {
                Text(AgentToolsCopy.instructions(shown))
            } footer: {
                Text(guide.instructionsNote)
            }
        } else {
            Section(AgentToolsCopy.instructionsUnmeasured) {
                note(AgentToolsCopy.unmeasured(shown))
            }
        }
        howAgentsUseOrbit(examplesFolded: true)
    }

    /// The dot, the word and when the runner reported it; the line under them; and, when the server is not
    /// connected, the engine's own words and what still works.
    private func statusRow(_ status: AgentTools.Status, reported: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle()
                    .fill(tint(status.tone))
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(status.word).fontWeight(.semibold)
                Spacer(minLength: 12)
                if let reported {
                    Text(reported).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            note(status.line)
            if let detail = status.detail {
                Text(detail)
                    .font(.orbitMono)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            }
            if let fallback = status.fallback { note(fallback) }
        }
        .padding(.vertical, 2)
    }

    /// What Session orchestration means as the switch is now, and what changed since the engine started.
    private func orchestrationNotes(_ report: AgentToolsReport?, on: Bool) -> [String] {
        var notes = [AgentTools.orchestration(on)]
        if let changed = AgentTools.orchestrationChanged(report, orchestrationOn: on) { notes.append(changed) }
        return notes
    }

    private func tint(_ tone: AgentTools.Tone) -> Color {
        switch tone {
        case .ok: return .green
        case .bad: return .red
        case .quiet: return .secondary
        }
    }

    /// A row's name and its value on one line, and what the value means under them.
    private func factRow(_ label: String, value: String, notes lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(label)
                Spacer(minLength: 12)
                Text(value)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in note(line) }
        }
    }

    // MARK: - A workspace

    @ViewBuilder
    private func workspaceSections(instructions: String, baseInstructions: Bool, orchestrationOn: Bool) -> some View {
        let chars = AgentTools.characters(instructions)
        let facts = AgentTools.LayerFacts(base: baseInstructions, workspace: chars > 0,
                                          carrier: AgentTools.defaultCarrier(workspaceEngine))
        Section {
            note(AgentToolsCopy.workspaceLead)
        }
        Section {
            Picker(AgentToolsCopy.engine, selection: $workspaceEngine) {
                ForEach(AgentTools.engines, id: \.self) { engine in
                    Text(AgentTools.engineName(engine)).tag(engine)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            layerRows(AgentTools.layers(workspaceEngine, facts), workspaceChars: chars, skill: nil)
        } header: {
            Text(AgentToolsCopy.instructions(workspaceEngine))
        } footer: {
            Text(guide.instructionsNote)
        }
        Section(AgentToolsCopy.orchestration) {
            note(AgentTools.orchestration(orchestrationOn))
        }
        Section(AgentToolsCopy.tryAsking) {
            ForEach(guide.examples) { example in exampleRow(example) }
        }
        howAgentsUseOrbit(examplesFolded: false)
    }

    // MARK: - Both

    /// The layers in the order the engine reads them: number and title, the role on the right, and what each is.
    private func layerRows(_ layers: [AgentToolsGuide.Layer], workspaceChars: Int?,
                           skill: AgentToolsReport.Skill?) -> some View {
        ForEach(Array(layers.enumerated()), id: \.offset) { index, layer in
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(verbatim: "\(index + 1) · \(layer.title)")
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 12)
                    Text(layer.roleLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                note(AgentTools.detail(layer, skill: skill, workspaceChars: workspaceChars))
                if layer.id == "workspace", let onEditInstructions {
                    Button(AgentToolsCopy.edit, action: onEditInstructions)
                }
            }
        }
    }

    /// "How agents use Orbit": the guide's sections folded, as the web's drawer folds them, and on a session the
    /// four examples folded with them.
    private func howAgentsUseOrbit(examplesFolded: Bool) -> some View {
        Section(AgentToolsCopy.howAgentsUseOrbit) {
            ForEach(guide.sections) { section in
                DisclosureGroup {
                    sectionBody(section)
                } label: {
                    foldLabel(section.title,
                              hint: section.id == "troubleshooting"
                                  ? AgentToolsCopy.symptoms(guide.troubleshooting.count) : nil)
                }
            }
            if examplesFolded {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(guide.examples) { example in exampleRow(example) }
                    }
                } label: {
                    foldLabel(AgentToolsCopy.tryAsking, hint: AgentToolsCopy.examples(guide.examples.count))
                }
            }
        }
    }

    private func foldLabel(_ title: String, hint: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
            Spacer(minLength: 12)
            if let hint {
                Text(hint).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
    }

    private func sectionBody(_ section: AgentToolsGuide.Section) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(section.lead)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(section.points.enumerated()), id: \.offset) { _, point in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: "•")
                    Text(point).fixedSize(horizontal: false, vertical: true)
                }
            }
            if section.id == "troubleshooting" {
                ForEach(guide.troubleshooting) { trouble in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(trouble.symptom)
                            .fontWeight(.semibold)
                            .fixedSize(horizontal: false, vertical: true)
                        if let code = trouble.code {
                            Text(code).font(.orbitMono).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Text(verbatim: "\(trouble.cause) \(trouble.fix)")
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if let asks = section.asks, !asks.isEmpty {
                Text(AgentToolsCopy.asks(asks))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.orbitLabel)
        .padding(.vertical, 4)
    }

    /// One example: what you would ask, what the agent does, and what proves it.
    private func exampleRow(_ example: AgentToolsGuide.Example) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(AgentToolsCopy.quoted(example.ask))
                .fontWeight(.medium)
                .fixedSize(horizontal: false, vertical: true)
            note(example.does)
            note(AgentToolsCopy.proof(example.proof))
        }
    }

    private func notes(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in Text(line) }
        }
    }

    /// Secondary text that wraps rather than truncates.
    private func note(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
