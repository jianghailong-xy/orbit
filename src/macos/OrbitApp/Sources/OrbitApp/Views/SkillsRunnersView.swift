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
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
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
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
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

#if os(iOS)
/// iOS: the runners list surfaced inside Settings, where Runners moved after leaving the drawer rail.
/// A plain push list — each runner pushes its detail within the Settings navigation stack — reusing
/// `RunnerRow`/`RunnerDetailContent` instead of the sidebar's split-view selection.
struct RunnersSettingsList: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Group {
            if let runners = model.runners {
                List {
                    ForEach(runners.runners) { r in
                        NavigationLink {
                            RunnerDetailContent(runners: runners, runner: r)
                        } label: {
                            RunnerRow(runner: r)
                        }
                    }
                }
                .overlay {
                    if runners.runners.isEmpty {
                        ContentUnavailableView(runners.loading ? "Loading…" : "No runners",
                                               systemImage: "desktopcomputer")
                    }
                }
                .task { await runners.load() }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Runners")
    }
}
#endif

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
    /// Which engine's sign-in card is open, if any. One at a time — the runner runs one sign-in
    /// relay at a time, so two open cards would be two views of the same thing.
    @State private var signingIn: LoginEngine?

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
                            quotaRow(row)
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

            // Signing an engine in here, rather than only after a session has failed on it: the
            // credentials live on that machine, and until now these clients had no way to renew
            // them without a terminal on it (the web's Providers page is the other one).
            Section("Engines") {
                ForEach(LoginEngine.allCases) { engine in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(engine.displayName)
                                // The status line reads the last heartbeat's probe, which the
                                // runner only re-runs once the CLI exits — so while a sign-in is
                                // open the card is the newer truth and this would contradict it.
                                if signingIn != engine {
                                    Text(engineStatus(engine)).font(.orbitLabel).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if signingIn != engine {
                                Button(runner.engineHealth(engine)?.signedIn == true ? "Sign in again" : "Sign in") {
                                    signingIn = engine
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        if signingIn == engine {
                            RunnerSignInView(runnerID: runner.id, engine: engine)
                            // Re-read the list on the way out so the row speaks from that
                            // machine's own probe again, rather than the state it was opened on.
                            Button("Close") {
                                signingIn = nil
                                Task { await runners.load() }
                            }
                            .buttonStyle(.borderless).font(.orbitLabel)
                        }
                    }
                    .padding(.vertical, 2)
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
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
        .formStyle(.grouped)
        .navigationTitle(runner.displayName?.isEmpty == false ? runner.displayName! : runner.name)
        .onAppear {
            maxConc = runner.maxConcurrent ?? 1
            renameText = runner.displayName ?? ""
        }
    }

    /// What this machine's last heartbeat probe said about one engine. "Unknown" is not a yes — a
    /// CLI that wouldn't answer must never read as signed in (web parity: `rowKindOf`).
    private func engineStatus(_ engine: LoginEngine) -> String {
        guard let health = runner.engineHealth(engine) else { return "Not reported yet" }
        guard health.installed == true else { return "Not installed" }
        let version = health.version.map { " · v\($0)" } ?? ""
        switch health.auth {
        case "yes": return "Signed in" + version
        case "no":  return "Signed out" + version
        default:    return "Sign-in state unknown" + version
        }
    }

    @ViewBuilder private func quotaRow(_ row: PlanUsageRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let groupLabel = row.groupLabel {
                Text(groupLabel).font(.orbitLabel).foregroundStyle(.secondary)
            }
            HStack {
                Text(row.label).font(.orbitLabel)
                Spacer()
                Text("\(row.percent)%").font(.orbitLabel).foregroundStyle(.secondary)
            }
            ProgressView(value: Double(row.percent), total: 100)
        }
    }
}
