import SwiftUI
import OrbitKit

// Batch E (1/2): the Skills directory + the Runners list/detail, both reading the shared
// `RunnersModel` off `AppModel`. Skills grouping comes from the verified OrbitKit `SkillsLogic`.
// SwiftUI is parse-checked only — verify on a Mac.

// MARK: - Skills

/// Skills directory: every runner's skills/commands grouped by owning agent (Shared last),
/// searchable. A browse-only page, so it lives entirely in the middle column.
struct SkillsView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""

    var body: some View {
        if let runners = model.runners {
            let groups = SkillsLogic.grouped(runners: runners.runners,
                                             agentName: { runners.agentName($0) },
                                             search: search)
            List {
                ForEach(groups) { g in
                    Section {
                        ForEach(g.skills) { SkillRow(item: $0, isSkill: true) }
                        ForEach(g.commands) { SkillRow(item: $0, isSkill: false) }
                    } header: {
                        HStack(spacing: 6) {
                            Text(g.title)
                            Text(g.runnerName).font(.orbitLabel).foregroundStyle(.secondary)
                            if !g.online { Image(systemName: "moon.zzz").font(.orbitMeta).foregroundStyle(.secondary) }
                            Spacer()
                            Text("\(g.count)").font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .searchable(text: $search)
            .overlay {
                if groups.isEmpty {
                    ContentUnavailableView(runners.loading ? "Loading…" : "No skills",
                                           systemImage: "wand.and.stars")
                }
            }
            .navigationTitle("Skills")
            .task { await runners.load() }
        } else {
            ProgressView()
        }
    }
}

struct SkillRow: View {
    let item: SlashCommandInfo
    let isSkill: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: isSkill ? "wand.and.stars" : "terminal")
                    .font(.orbitMeta).foregroundStyle(.secondary)
                Text("/\(item.name)").font(.callout).fontDesign(.monospaced)
            }
            if let d = item.description, !d.isEmpty {
                Text(d).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 1)
    }
}

// MARK: - Runners

struct RunnersListView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        @Bindable var model = model
        if let runners = model.runners {
            List(selection: $model.selectedRunnerID) {
                ForEach(runners.runners) { r in
                    RunnerRow(runner: r).tag(r.id)
                }
            }
            .overlay {
                if runners.runners.isEmpty {
                    ContentUnavailableView(runners.loading ? "Loading…" : "No runners",
                                           systemImage: "desktopcomputer")
                }
            }
            .navigationTitle("Runners")
            .task { await runners.load() }
        } else {
            ProgressView()
        }
    }
}

struct RunnerRow: View {
    let runner: Runner
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(runner.online == true ? Color.green : Color.secondary).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName).lineLimit(1)
                Text(subtitle).font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
    private var displayName: String { runner.displayName?.isEmpty == false ? runner.displayName! : runner.name }
    private var subtitle: String {
        let slots = "\(runner.activeSessions ?? 0)/\(runner.maxConcurrent ?? 0) running"
        return runner.version.map { "\(slots) · v\($0)" } ?? slots
    }
}

struct RunnerDetailView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if let runners = model.runners, let id = model.selectedRunnerID, let r = runners.runner(id) {
            RunnerDetailContent(runners: runners, runner: r).id(r.id)
        } else {
            ContentUnavailableView("Select a runner", systemImage: "desktopcomputer",
                                   description: Text("Status, quota, and enrollment appear here."))
        }
    }
}

struct RunnerDetailContent: View {
    let runners: RunnersModel
    let runner: Runner
    @State private var maxConc = 1
    @State private var renameText = ""

    var body: some View {
        Form {
            Section {
                LabeledContent("Status", value: runner.online == true ? "Online" : "Offline")
                LabeledContent("Slots", value: "\(runner.activeSessions ?? 0) / \(runner.maxConcurrent ?? 0)")
                if let v = runner.version { LabeledContent("Version", value: v) }
            }

            if let pu = runner.planUsage {
                ForEach(pu.snapshots, id: \.0) { entry in
                    Section(entry.0) {
                        ForEach(entry.1.rows) { row in
                            quotaRow(row.label, row.window)
                        }
                    }
                }
            }

            Section("Settings") {
                HStack {
                    Stepper("Max concurrent: \(maxConc)", value: $maxConc, in: 1...64)
                    Button("Save") { Task { await runners.setMaxConcurrent(runner.id, maxConc) } }
                }
                HStack {
                    TextField("Display name", text: $renameText)
                    Button("Rename") { Task { await runners.rename(runner.id, renameText) } }
                }
            }

            Section("Agents") {
                let ags = runners.agents(forRunner: runner.id)
                if ags.isEmpty {
                    Text("No agents on this runner.").font(.orbitLabel).foregroundStyle(.secondary)
                } else {
                    ForEach(ags) { a in
                        HStack {
                            Text(a.name)
                            Spacer()
                            if a.enabled == false { Text("disabled").font(.orbitMeta).foregroundStyle(.secondary) }
                        }
                    }
                }
            }

            Section("Enrollment & danger zone") {
                Button("Rotate runner token") { Task { await runners.rotateToken(runner.id) } }
                Button("Create enrollment token") { Task { await runners.createEnrollmentToken(label: nil) } }
                Button("Delete runner", role: .destructive) { Task { await runners.delete(runner.id) } }
            }

            if let token = runners.revealedToken {
                Section("Token — copy now, shown once") {
                    Text(token).font(.callout).fontDesign(.monospaced).textSelection(.enabled)
                    Button("Dismiss") { runners.revealedToken = nil }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(runner.displayName?.isEmpty == false ? runner.displayName! : runner.name)
        .onAppear {
            maxConc = runner.maxConcurrent ?? 1
            renameText = runner.displayName ?? ""
        }
    }

    @ViewBuilder private func quotaRow(_ label: String, _ w: PlanUsageWindow?) -> some View {
        if let w {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(label).font(.orbitLabel)
                    Spacer()
                    Text("\(Int(w.utilization.rounded()))%").font(.orbitLabel).foregroundStyle(.secondary)
                }
                ProgressView(value: min(max(w.utilization, 0), 100), total: 100)
            }
        }
    }
}
