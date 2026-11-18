import SwiftUI
import OrbitKit

/// Settings → GitHub (docs/github-workspace-design.md §8, board 02), the port of web's `GithubIntegrationPage`: the
/// account's GitHub connection, where Orbit's app is installed, and the workspaces cloned from GitHub with the
/// credential each uses. Sections of a grouped form: the iOS sheet's page wraps them in a form of their own
/// (`GithubSettingsPage`), and the Mac's Settings form has them as its GitHub group. The words are `GithubCopy`'s.
struct GithubSettingsSections: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var connecting = false
    @State private var disconnecting = false
    @State private var confirmingDisconnect = false
    /// A sign-in was opened from here: the connection's arrival is said once, as the web's callback page says it.
    @State private var awaitingConnect = false

    var body: some View {
        Group {
            if let view = model.github {
                sections(view)
            } else if let why = model.githubLoadError {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(GithubCopy.LOAD_FAILED).foregroundStyle(Color.red)
                        Text(why).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                    Button(GithubCopy.RETRY) { Task { await model.loadGithub() } }
                } header: {
                    Text(GithubCopy.TITLE)
                }
            } else {
                Section {
                    ProgressView().frame(maxWidth: .infinity)
                } header: {
                    Text(GithubCopy.TITLE)
                }
            }
        }
        .task { await model.loadGithub() }
        // Back from GitHub's sign-in in the browser: what it changed is read again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.loadGithub() } }
        }
        .onChange(of: model.github?.usable) { _, usable in
            guard awaitingConnect, usable == true else { return }
            awaitingConnect = false
            model.showToast(GithubCopy.CONNECTED_TOAST)
        }
    }

    @ViewBuilder private func sections(_ view: GithubIntegration) -> some View {
        Section {
            if !view.available {
                Label(GithubCopy.GITHUB_NOT_SET_UP, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(SetupInk.warn)
            }
            if view.connected {
                connectedAccount(view)
            } else {
                Text(GithubCopy.CONNECT_LEAD)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if view.available { connectButton(GithubCopy.CONNECT) }
            }
        } header: {
            HStack {
                Text(GithubCopy.ACCOUNT)
                Spacer()
                if view.connected {
                    Text(view.needsReconnect ? GithubCopy.BADGE_SIGN_IN_AGAIN : GithubCopy.BADGE_CONNECTED)
                        .font(.orbitMeta.weight(.semibold))
                        .foregroundStyle(view.needsReconnect ? SetupInk.warn : SetupInk.found)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background((view.needsReconnect ? SetupInk.warn : SetupInk.found).opacity(0.12), in: Capsule())
                }
            }
        } footer: {
            Text(GithubCopy.GITHUB_ROW_HINT)
        }
        .orbitConfirmation(GithubCopy.DISCONNECT_TITLE, isPresented: $confirmingDisconnect) {
            Button(GithubCopy.DISCONNECT, role: .destructive) { disconnect() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(view.workspaceCount > 0 ? GithubCopy.disconnectWarning(workspaceCount: view.workspaceCount)
                 : GithubCopy.DISCONNECT_NO_WORKSPACES)
        }

        if view.usable {
            Section {
                if let installations = view.installations {
                    ForEach(installations) { installation in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(installation.account).fontWeight(.medium)
                                Spacer()
                                if let url = GithubCopy.installationSettingsURL(installation) {
                                    externalLink(GithubCopy.CONFIGURE_ON_GITHUB, url)
                                }
                            }
                            Text(GithubCopy.installationText(installation))
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let url = view.installUrl.flatMap(URL.init(string:)) {
                        externalLink(installations.isEmpty ? GithubCopy.INSTALL_ON_GITHUB : GithubCopy.INSTALL_ON_ANOTHER, url)
                    }
                } else {
                    Text(GithubCopy.NO_ANSWER).foregroundStyle(.secondary)
                }
            } header: {
                Text(GithubCopy.INSTALLED_WHERE)
            }
        }

        if let workspaces = view.workspaces, !workspaces.isEmpty {
            Section {
                ForEach(workspaces) { workspace in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(workspace.name).fontWeight(.semibold)
                            if let machine = workspace.machine {
                                Text(GithubCopy.onMachine(machine)).foregroundStyle(.secondary)
                            }
                        }
                        if let repository = workspace.repository {
                            Text(repository).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                        Text(GithubCopy.credentialText(credential: workspace.credential, cloneState: workspace.cloneState))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text(GithubCopy.WORKSPACES_FROM_GITHUB)
            }
        }
    }

    @ViewBuilder private func connectedAccount(_ view: GithubIntegration) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: String((view.login ?? "?").prefix(1)).uppercased())
                .font(.headline)
                .frame(width: 34, height: 34)
                .background(Color.secondary.opacity(0.15), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "@\(view.login ?? "")").fontWeight(.semibold)
                Text(view.needsReconnect ? GithubCopy.needsSignInAgain(login: view.login ?? "")
                     : GithubCopy.connectedSince(view.connectedAt))
                    .font(.orbitLabel)
                    .foregroundStyle(view.needsReconnect ? SetupInk.warn : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        if view.needsReconnect, view.available { connectButton(GithubCopy.RECONNECT) }
        Button(role: .destructive) { confirmingDisconnect = true } label: {
            HStack(spacing: 6) {
                Text(GithubCopy.DISCONNECT)
                if disconnecting { ProgressView().controlSize(.small) }
            }
        }
        .disabled(disconnecting)
    }

    private func connectButton(_ title: String) -> some View {
        Button {
            connecting = true
            Task {
                do {
                    openURL(try await model.githubSignInURL())
                    awaitingConnect = true
                } catch {
                    model.showToast(GithubCopy.CONNECT_FAILED, detail: APIClient.failureReason(error), tone: .error)
                }
                connecting = false
            }
        } label: {
            HStack(spacing: 6) {
                GithubMark()
                Text(title)
                if connecting { ProgressView().controlSize(.small) }
            }
        }
        .disabled(connecting)
    }

    private func externalLink(_ title: String, _ url: URL) -> some View {
        Link(destination: url) {
            HStack(spacing: 3) {
                Text(title)
                Image(systemName: "arrow.up.right.square")
            }
        }
        .font(.orbitLabel)
    }

    private func disconnect() {
        disconnecting = true
        Task {
            if let why = await model.disconnectGithub() {
                model.showToast(GithubCopy.DISCONNECT_FAILED, detail: why, tone: .error)
            } else {
                model.showToast(GithubCopy.DISCONNECTED_TOAST)
            }
            disconnecting = false
        }
    }
}

#if os(iOS)
/// Settings → GitHub as a page of the iOS sheet.
struct GithubSettingsPage: View {
    var body: some View {
        Form { GithubSettingsSections() }
            .navigationTitle(GithubCopy.TITLE)
    }
}
#endif
