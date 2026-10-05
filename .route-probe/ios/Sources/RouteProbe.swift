import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). The real iOS surfaces smart model selection
// (docs/model-routing-design.md §9) touches, signed in to the fixture API `stub.py` serves, one per
// launch, picked with `-probe.surface`:
//
//   task    — the compact Tasks stack as `CompactShell` declares it (`TasksListView` with
//             `TaskDetailPage(taskID:)` pushed for `.taskDetail`), routed to task T1 the way a link
//             opens a task (`AppModel.route(to: .task)`).
//   agent   — `AgentSettingsSheet` for workspace a1, presented as a sheet over the compact Agents
//             stack (the session list's options menu presents it the same way).
//   console — the compact Agents stack routed to session S2 (run 2 of T1): `ConsoleView` with its
//             composer, as `CompactShell`'s `.console` destination draws it.
//   settings — the Settings sheet (`SettingsSheet`) over the Agents stack, as the drawer's gear opens it.
//
// Before routing, the account is read from the stub (`GET /users/me`) as the polling loop's first
// read would, so `preferences.modelRouting` — the master switch — is this launch's.
//
// `-orbit.instance http://127.0.0.1:8765` points `AppModel` at the stub; `-dark` for dark.

@main
struct RouteProbeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("-dark") ? .dark : .light)
        }
    }
}

private enum ProbeSurface: String {
    case task, agent, console, settings

    static var current: ProbeSurface {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-probe.surface"), i + 1 < args.count,
              let surface = ProbeSurface(rawValue: args[i + 1]) else { return .task }
        return surface
    }
}

private struct ProbeRoot: View {
    @Environment(AppModel.self) private var app
    @State private var settingsAgent: Agent?

    var body: some View {
        Group {
            // One section at a time, as `CompactSections` switches them.
            switch app.selectedSection {
            case .tasks: TasksProbeStack()
            default:     AgentsProbeStack()
            }
        }
        .toastHost()
        // The shells' stream lifecycle (CompactShell / MainView): start exactly the focused
        // session's console — without it a pushed console never loads its transcript or its cards.
        .onChange(of: app.focusedConsoleSessionID, initial: true) { _, _ in app.syncConsoleFocus() }
        .settingsSheet(app)
        .sheet(item: $settingsAgent) { agent in
            if let agents = app.agents {
                AgentSettingsSheet(agents: agents, agent: agent)
            }
        }
        .task {
            if let me = await probeMe() { app.user = me }
            // What the launch landing does once the workspace list is in: open the one workspace.
            await app.agents?.load()
            app.selectedAgentID = "a1"
            switch ProbeSurface.current {
            case .task:
                app.route(to: .task("T1"))
            case .console:
                app.route(to: .session("S2"))
            case .agent:
                settingsAgent = app.agents?.agent("a1")
            case .settings:
                app.settingsPresented = true
            }
        }
    }

    /// The account as the stub has it; nil if it can't be read (then everything reads as off).
    private func probeMe() async -> User? {
        guard let url = URL(string: "http://127.0.0.1:8765/api/users/me"),
              let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
        return try? JSONDecoder().decode(User.self, from: data)
    }
}

/// `CompactSections`' Tasks case, minus the drawer toggle: the path is the section's stack.
private struct TasksProbeStack: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.taskStack) {
            TasksListView(rowNavigation: .push)
                .navigationDestination(for: NavNode.self) { node in
                    switch node {
                    case .taskDetail(let taskID): TaskDetailPage(taskID: taskID)
                    case .taskListsDirectory:     TaskListsDirectoryPage()
                    default:                      EmptyView()
                    }
                }
        }
    }
}

/// `CompactSections`' Agents case, minus the drawer toggle: the session list, its console frames
/// (`AgentConsolePage` is private there, so its body is spelled out) and a task page over them.
private struct AgentsProbeStack: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.nav.path) {
            AgentContentColumn(rowNavigation: .push)
                .navigationDestination(for: NavNode.self) { node in
                    switch node {
                    case .console(let sessionID, _):
                        if let registry = model.consoleRegistry {
                            ConsoleView(sessionID: sessionID,
                                        agentID: model.agentID(for: sessionID) ?? model.selectedAgentID,
                                        registry: registry)
                                .environment(\.opensPagesOverConsole, true)
                        }
                    case .taskDetail(let taskID):
                        TaskDetailPage(taskID: taskID)
                    default:
                        EmptyView()
                    }
                }
        }
    }
}
