import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). The real iOS session list — `AgentContentColumn`
// in the compact shell's push shape on a phone (a `NavigationStack` and the same destinations
// `CompactShell` declares, minus the drawer), and the three-column shape on an iPad (the session
// column beside the console detail, as `MainView` arranges them) — both signed in to the fixture
// API `stub.py` serves, with the app's toast host as `CompactShell` attaches it.
// `-orbit.instance http://127.0.0.1:8765` points `AppModel` at it (the key `AppModel.init` restores
// its instance from); `-dark` for dark.

@main
struct MoveProbeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("-dark") ? .dark : .light)
        }
    }
}

private struct ProbeRoot: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
            if horizontalSizeClass == .compact {
                CompactProbeShell()
            } else {
                WideProbeShell()
            }
        }
        .toastHost()
        // The shells' stream lifecycle (CompactShell / MainView): start exactly the focused
        // session's console — without it a pushed console never loads its transcript or its cards.
        .onChange(of: app.focusedConsoleSessionID, initial: true) { _, _ in app.syncConsoleFocus() }
        .task {
            // What the launch landing does once the workspace list is in: open the one workspace.
            await app.agents?.load()
            app.selectedAgentID = "a1"
        }
    }
}

/// The phone: the compact shell's Agents section without the drawer — `AgentContentColumn` pushes
/// its own rows, and the section's stack carries the folder page, the draft and the console.
private struct CompactProbeShell: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.nav.path) {
            AgentContentColumn(rowNavigation: .push)
                .navigationDestination(for: NavNode.self) { node in
                    switch node {
                    case .compose(let agentID, let folderID):
                        ProbeComposePage(agentID: agentID, folderID: folderID)
                    case .folder(let address):
                        SessionFolderPage(address: address)
                    case .console(let sessionID, _):
                        if let registry = model.consoleRegistry {
                            ConsoleView(sessionID: sessionID,
                                        agentID: model.agentID(for: sessionID) ?? model.selectedAgentID,
                                        registry: registry)
                        }
                    default:
                        EmptyView()
                    }
                }
        }
    }
}

/// The iPad: `MainView`'s columns for the Agents section — the session column (which a folder's
/// page replaces) beside the detail pane that follows the selected session. The sidebar is hidden,
/// as it starts on iPad (`shell.sidebarVisible` false).
private struct WideProbeShell: View {
    var body: some View {
        NavigationSplitView(columnVisibility: .constant(.doubleColumn)) {
            Color.clear
        } content: {
            AgentContentColumn()
                .navigationSplitViewColumnWidth(min: 320, ideal: 420, max: 480)
        } detail: {
            AgentConsoleDetail()
        }
    }
}

/// The compact shell's `.compose` destination, which is `private` there (see `AgentComposePage`).
private struct ProbeComposePage: View {
    @Environment(AppModel.self) private var model
    let agentID: String
    var folderID: String? = nil

    var body: some View {
        if let registry = model.consoleRegistry, let agents = model.agents,
           let agent = agents.agent(agentID) {
            NewSessionView(agent: agent, registry: registry,
                           defaultModel: agents.effectiveDefaultModel(for: agent),
                           configuredProviders: agents.configuredProviders,
                           configuredProvidersLoaded: agents.configuredProvidersLoaded,
                           providerPools: agents.providerPools,
                           sharedPools: agents.sharedPools,
                           modelCatalog: agents.modelCatalog(for: agent.runnerId),
                           defaultEffort: model.user?.preferences?.defaultEffort,
                           folderID: folderID) { session in
                model.openCreatedAgentSession(session)
            }
            .navigationTitle(agent.name)
            .id(newSessionDraftIdentity(agent, folderID: folderID))
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("Select a workspace", systemImage: "folder")
        }
    }
}
