#if os(iOS)
import SwiftUI
import UIKit
import OrbitKit

// Settings on iOS: a sheet over whatever is on screen, in the ChatGPT-style shape the owner picked
// from the mockups — the account at the top, then grouped rows that each name a thing and where it
// stands, and every explanation one page in. What the list holds, in what order and with which
// words, is `SettingsHome` in OrbitKit, where it is tested; this file draws it. macOS keeps its
// Settings window and the whole form in `SettingsView`.

extension View {
    /// Hosts Settings. The drawer's gear and the iPad sidebar's Settings row open this sheet instead
    /// of switching section (`AppModel.settingsPresented`), so closing it lands on the page it
    /// covered. Applied at the signed-in root, beside the ⌘K palette, so both shells
    /// share it.
    func settingsSheet(_ model: AppModel) -> some View {
        @Bindable var model = model
        return sheet(isPresented: $model.settingsPresented) { SettingsSheet() }
    }
}

/// Settings' own stack: the list at its root, and each page it opens as a frame of
/// `NavState.settingsPath` — the runners list and a runner's record, the `SettingsPage`s, and an
/// account's record under Admin. A form row pushes with its `NavigationLink` value; a list row
/// inside a page pushes through `AppModel.push`, which lands here while the sheet is up.
struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.nav.settingsPath) {
            SettingsHomeView()
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close")
                    }
                }
                .navigationDestination(for: NavNode.self) { node in
                    switch node {
                    case .settingsRunners:            RunnersSettingsList()
                    case .runnerDetail(let runnerID): RunnerDetailView(runnerID: runnerID)
                    case .settingsPage(let page):     SettingsPageView(page: page)
                    case .userDetail(let userID):     AdminUserDetailView(userID: userID)
                    default:                          EmptyView()
                    }
                }
        }
        // A sheet is a presentation of its own: without this, picking Light or Dark here would only
        // show once the sheet closed.
        .preferredColorScheme(model.preferredColorScheme)
    }
}

/// The page a `SettingsPage` frame names.
private struct SettingsPageView: View {
    let page: SettingsPage

    var body: some View {
        switch page {
        case .providers:      ProvidersSettingsPage()
        case .notifications:  NotificationSettingsPage()
        case .sharedLinks:    SharedLinksSettingsPage()
        case .changePassword: ChangePasswordPage()
        case .admin:          AdminUsersView(rowNavigation: .push)
        }
    }
}

// MARK: - The list

/// Settings' root: the account, then `SettingsHome`'s groups, then Sign out and the build.
struct SettingsHomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var theme = "system"
    @State private var permMode: PermissionMode = .default
    /// The account's one orchestration switch. Absent on the server means on.
    @State private var orchestration = true
    @State private var seeded = false
    /// This device's own answer to "may Orbit alert you" — nil until asked.
    @State private var alertsAllowed: Bool?
    @State private var confirmingSignOut = false
    /// The avatar and name are the page's title while they are on screen; the bar names the page
    /// once they have scrolled under it.
    @State private var headerScrolledAway = false

    private var isAdmin: Bool { model.user?.role == "ADMIN" }

    var body: some View {
        Form {
            header
            if alertsAllowed == false { alertsOffCard }
            ForEach(SettingsHome.Group.allCases, id: \.self) { group in
                Section {
                    ForEach(SettingsHome.rows(group, isAdmin: isAdmin), id: \.self) { row in
                        self.row(row)
                    }
                } header: {
                    SettingsHeader(SettingsHome.header(group))
                }
            }
            signOutSection
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text("Settings").font(.headline).opacity(headerScrolledAway ? 1 : 0)
            }
        }
        .confirmationDialog(SettingsCopy.signOutTitle(instance: SettingsHome.instanceName(model.baseURL)),
                            isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button(SettingsCopy.signOut, role: .destructive) { model.logout() }
            Button(SharePanelCopy.cancel, role: .cancel) {}
        }
        // Changes apply the moment they are made, as settings do on iOS. Each write is guarded
        // against the value the account already has, so seeding the pickers never writes.
        .onChange(of: theme) { _, value in
            guard (model.user?.preferences?.theme ?? "system") != value else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(theme: value)) }
        }
        .onChange(of: permMode) { _, value in
            let saved = model.user?.preferences?.defaultPermissionMode
                ?? AgentDefaults.defaultPermissionMode.rawValue
            guard saved != value.rawValue else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(defaultPermissionMode: value.rawValue)) }
        }
        .onChange(of: orchestration) { _, value in
            guard (model.user?.preferences?.enableOrchestration ?? true) != value else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(enableOrchestration: value)) }
        }
        .onAppear(perform: seed)
        // Each row's value is its own read, so they are asked for side by side.
        .task { alertsAllowed = await model.notifications.alertsAllowed() }
        .task { await model.runners?.load() }
        .task { await model.sharedLinks?.load() }
        // Back from the system's Settings, where the card sends you: say what it is now.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { alertsAllowed = await model.notifications.alertsAllowed() }
        }
    }

    private var displayName: String {
        if let name = model.user?.name, !name.isEmpty { return name }
        return model.user?.email ?? ""
    }

    private var header: some View {
        Section {
            VStack(spacing: 8) {
                AvatarMonogram(name: displayName, diameter: 72, font: .largeTitle.weight(.medium))
                Text(displayName)
                    .font(.headline)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .onGeometryChange(for: Bool.self) { proxy in
                proxy.frame(in: .scrollView).maxY < 0
            } action: { away in
                headerScrolledAway = away
            }
        }
        .listRowBackground(Color.clear)
    }

    /// While this device won't show Orbit's alerts at all — the slot ChatGPT gives its upgrade card.
    private var alertsOffCard: some View {
        Section {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(SettingsCopy.notificationsOffTitle).font(.headline)
                    Text(SettingsCopy.notificationsOffDetail)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button(SettingsCopy.turnOn) {
                    Task { alertsAllowed = await turnOnAlerts(model, now: alertsAllowed) }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder private func row(_ row: SettingsHome.Row) -> some View {
        let label = SettingsRowLabel(row)
        switch row {
        case .defaultPermission:
            Picker(selection: $permMode) {
                ForEach(AgentDefaults.permissionModes, id: \.self) { mode in
                    Text(AgentDefaults.label(mode)).tag(mode)
                }
            } label: { label }
        case .orchestration:
            Toggle(isOn: $orchestration) { label }
        case .appearance:
            Picker(selection: $theme) {
                Text("System").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            } label: { label }
        case .email:
            LabeledContent { Text(model.user?.email ?? "") } label: { label }
        case .instance:
            LabeledContent { Text(SettingsHome.instanceName(model.baseURL) ?? "") } label: { label }
        case .runners:
            NavigationLink(value: NavNode.settingsRunners) {
                LabeledContent { if let value = runnersValue { Text(value) } } label: { label }
            }
        case .providers, .notifications, .sharedLinks, .changePassword, .admin:
            if let page = SettingsHome.page(row) {
                NavigationLink(value: NavNode.settingsPage(page)) {
                    LabeledContent { if let value = value(of: row) { Text(value) } } label: { label }
                }
            }
        }
    }

    /// Only an answer the server gave — never the empty list a model starts with.
    private var runnersValue: String? {
        guard let runners = model.runners, runners.loadState.hasLoaded else { return nil }
        return SettingsHome.runnersValue(runners.runners)
    }

    private func value(of row: SettingsHome.Row) -> String? {
        switch row {
        case .notifications:
            return SettingsHome.notificationsValue(allowed: alertsAllowed)
        case .sharedLinks:
            return model.sharedLinks?.activeCount.map(SettingsHome.sharedLinksValue)
        default:
            return nil
        }
    }

    private var signOutSection: some View {
        Section {
            Button(role: .destructive) { confirmingSignOut = true } label: {
                Label(SettingsCopy.signOut, systemImage: "rectangle.portrait.and.arrow.right")
            }
        } footer: {
            if let line = SettingsHome.versionLine(
                version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                build: Bundle.main.infoDictionary?["CFBundleVersion"] as? String) {
                Text(line)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
            }
        }
    }

    private func seed() {
        guard !seeded else { return }
        seeded = true
        let p = model.user?.preferences
        theme = p?.theme ?? "system"
        // An unset preference is the server's floor (Auto), not Default — showing Default would name
        // a mode the account isn't actually running.
        permMode = PermissionMode(rawValue: p?.defaultPermissionMode ?? "") ?? AgentDefaults.defaultPermissionMode
        orchestration = p?.enableOrchestration ?? true
    }
}

/// A row's glyph and name, both in the label colour: a form row's icon would otherwise take the
/// accent, and inside a button's label even `.primary` resolves to it.
private struct SettingsRowLabel: View {
    let row: SettingsHome.Row

    init(_ row: SettingsHome.Row) { self.row = row }

    var body: some View {
        Label {
            Text(SettingsHome.title(row)).foregroundStyle(Color.primary)
        } icon: {
            Image(systemName: SettingsHome.systemImage(row)).foregroundStyle(Color.primary)
        }
    }
}

/// A group's heading: title case in the secondary colour, as the list's own groups read.
private struct SettingsHeader: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.headline)
            .foregroundStyle(.secondary)
            .textCase(nil)
    }
}

/// Ask for alerts when this device has never been asked; once refused, only the system's Settings
/// can change it, so that is where the press goes. Answers the state to show now.
@MainActor
private func turnOnAlerts(_ model: AppModel, now: Bool?) async -> Bool? {
    if now == nil {
        let allowed = await model.notifications.askForAlerts()
        if allowed { model.enablePush() }
        return allowed
    }
    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
        _ = await UIApplication.shared.open(url)
    }
    return now
}

// MARK: - Notifications

/// This device's own switch, the account's two switches (the web page's, in its words), and the
/// alerts neither of them governs.
private struct NotificationSettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var alertsAllowed: Bool?
    @State private var sessionFinished = true
    @State private var agentMessage = true
    @State private var seeded = false

    var body: some View {
        Form {
            Section {
                Button {
                    Task { alertsAllowed = await turnOnAlerts(model, now: alertsAllowed) }
                } label: {
                    HStack {
                        Text(SettingsCopy.allowNotifications).foregroundStyle(Color.primary)
                        Spacer()
                        if let value = SettingsHome.notificationsValue(allowed: alertsAllowed) {
                            Text(value).foregroundStyle(Color.secondary)
                        }
                        Image(systemName: "arrow.up.forward")
                            .imageScale(.small)
                            .foregroundStyle(Color.secondary)
                    }
                }
            } header: {
                SettingsHeader(SettingsCopy.deviceHeader(UIDevice.current.localizedModel))
            } footer: {
                Text(SettingsCopy.deviceFooter)
            }

            Section {
                Toggle(SettingsCopy.sessionFinished, isOn: $sessionFinished)
            } header: {
                SettingsHeader(SettingsCopy.accountHeader)
            } footer: {
                Text(SettingsCopy.sessionFinishedHint)
            }

            Section {
                Toggle(SettingsCopy.agentMessage, isOn: $agentMessage)
            } footer: {
                Text(SettingsCopy.agentMessageHint)
            }

            Section {
                ForEach(SettingsCopy.alwaysSent, id: \.self) { kind in
                    LabeledContent(kind, value: SettingsCopy.always)
                }
            } header: {
                SettingsHeader(SettingsCopy.alwaysHeader)
            } footer: {
                Text(SettingsCopy.alwaysFooter)
            }
        }
        .navigationTitle(SettingsPage.notifications.title)
        .onAppear {
            guard !seeded else { return }
            seeded = true
            // Absent means on: only opting out is ever written.
            sessionFinished = model.user?.preferences?.notifySessionFinished ?? true
            agentMessage = model.user?.preferences?.notifyAgentMessage ?? true
        }
        .onChange(of: sessionFinished) { _, _ in save() }
        .onChange(of: agentMessage) { _, _ in save() }
        .task { alertsAllowed = await model.notifications.alertsAllowed() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { alertsAllowed = await model.notifications.alertsAllowed() }
        }
    }

    /// Only the switch that moved, so the other keeps whatever it is on the server.
    private func save() {
        let p = model.user?.preferences
        let finished = sessionFinished != (p?.notifySessionFinished ?? true) ? sessionFinished : nil
        let message = agentMessage != (p?.notifyAgentMessage ?? true) ? agentMessage : nil
        guard finished != nil || message != nil else { return }
        Task {
            await model.savePreferences(UpdatePreferencesRequest(notifySessionFinished: finished,
                                                                 notifyAgentMessage: message))
        }
    }
}

// MARK: - Change password

/// The web Profile page's form: the current password, and the new one twice.
private struct ChangePasswordPage: View {
    @Environment(AppModel.self) private var model

    @State private var current = ""
    @State private var fresh = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var outcome: String?

    var body: some View {
        Form {
            Section {
                SecureField(SettingsCopy.currentPassword, text: $current)
                    .textContentType(.password)
                SecureField(SettingsCopy.newPassword, text: $fresh)
                    .textContentType(.newPassword)
                SecureField(SettingsCopy.confirmPassword, text: $confirm)
                    .textContentType(.newPassword)
            } footer: {
                Text(footer)
            }

            Section {
                Button(SettingsCopy.changePassword) { Task { await submit() } }
                    .disabled(!canSubmit || busy)
            }
        }
        .navigationTitle(SettingsPage.changePassword.title)
        .onChange(of: fresh) { _, _ in outcome = nil }
    }

    private var canSubmit: Bool { !current.isEmpty && fresh.count >= 6 && confirm == fresh }

    private var footer: String {
        if let outcome { return outcome }
        if !confirm.isEmpty && confirm != fresh { return SettingsCopy.passwordsDoNotMatch }
        return SettingsCopy.passwordRule
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        if let error = await model.changePassword(current: current, new: fresh) {
            outcome = error
            return
        }
        current = ""
        fresh = ""
        confirm = ""
        outcome = SettingsCopy.passwordChanged
    }
}

// MARK: - Providers

/// Where the account's models come from, read-only: the engines signed in on each runner (a row opens
/// that runner, where signing in lives), the account's pools, and its API keys.
private struct ProvidersSettingsPage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            Section {
                ForEach(model.runners?.runners ?? []) { runner in
                    NavigationLink(value: NavNode.runnerDetail(runnerID: runner.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(runner.displayName?.isEmpty == false ? runner.displayName! : runner.name)
                            Text(ProvidersOverview.runnerSummary(runner))
                                .font(.orbitListSubtitle)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                SettingsHeader(ProvidersOverview.onYourRunners)
            } footer: {
                Text(ProvidersOverview.onYourRunnersDetail)
            }

            let pools = model.agents?.providerPools ?? []
            if !pools.isEmpty {
                Section {
                    ForEach(pools) { pool in
                        LabeledContent(pool.label, value: ProvidersOverview.poolSummary(pool))
                    }
                } header: {
                    SettingsHeader(ProvidersOverview.accountPools)
                } footer: {
                    Text(ProvidersOverview.accountPoolsDetail)
                }
            }

            Section {
                let keys = model.agents?.configuredProviders ?? []
                if keys.isEmpty {
                    Text(ProvidersOverview.noKeys).foregroundStyle(.secondary)
                }
                ForEach(keys) { key in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(key.label)
                        if let defaultModel = key.defaultModel {
                            Text(defaultModel)
                                .font(.orbitListSubtitle)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                SettingsHeader(ProvidersOverview.apiKeys)
            } footer: {
                Text(ProvidersOverview.apiKeysDetail + " " + ProvidersOverview.editOnWeb)
            }
        }
        .navigationTitle(SettingsPage.providers.title)
        .task { await model.runners?.load() }
        .task { await model.agents?.load() }
    }
}

// MARK: - Shared links

/// Every public link this account has made, by where it stands — the web page's tabs, lines and
/// words. A link is copied or shared from its context menu and turned off by a swipe, which asks
/// first: whoever has the link loses it at once.
private struct SharedLinksSettingsPage: View {
    @Environment(AppModel.self) private var model

    @State private var tab: SharedLinksList.Tab = .active
    @State private var pendingTurnOff: OrbitKit.ShareLink?
    @State private var notice: String?

    var body: some View {
        let links = model.sharedLinks?.links ?? []
        let shown = SharedLinksList.links(links, in: tab)
        List {
            Section {
                Picker(SharedLinksList.title, selection: $tab) {
                    ForEach(SharedLinksList.Tab.allCases) { tab in
                        Text("\(tab.label) \(SharedLinksList.links(links, in: tab).count)").tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } footer: {
                Text(SharedLinksList.subtitle)
            }

            Section {
                switch LoadFailureLogic.presentation(model.sharedLinks?.loadState ?? ListLoadState(),
                                                     isEmpty: links.isEmpty) {
                case .loading:
                    HStack { Spacer(); ProgressView(); Spacer() }
                case .failed:
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.sharedLinks?.errorText ?? SharedLinksList.couldNotLoad)
                            .foregroundStyle(.secondary)
                        Button(SharePanelCopy.retry) { Task { await model.sharedLinks?.load() } }
                    }
                case .empty, .content:
                    if shown.isEmpty {
                        Text(tab.empty).foregroundStyle(.secondary)
                    }
                    ForEach(shown) { link in
                        row(link)
                    }
                }
            }
        }
        .navigationTitle(SharedLinksList.title)
        .task { await model.sharedLinks?.load() }
        .refreshable { await model.sharedLinks?.load() }
        .confirmationDialog(SharePanelCopy.turnOffTitle, isPresented: turnOffAsked, titleVisibility: .visible,
                            presenting: pendingTurnOff) { link in
            Button(SharePanelCopy.turnOff, role: .destructive) { Task { await turnOff(link) } }
            Button(SharePanelCopy.cancel, role: .cancel) {}
        } message: { _ in
            Text(SharePanelCopy.turnOffDetail)
        }
        .overlay(alignment: .bottom) {
            if let notice {
                Text(notice)
                    .font(.orbitListSubtitle.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: notice)
    }

    private var turnOffAsked: Binding<Bool> {
        Binding(get: { pendingTurnOff != nil }, set: { if !$0 { pendingTurnOff = nil } })
    }

    private func row(_ link: OrbitKit.ShareLink) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(link.root.title ?? SharedLinksList.kindWord(link.kind))
                .lineLimit(2)
            Text(SharedLinksList.whereLine(link))
                .font(.orbitListSubtitle)
                .foregroundStyle(.secondary)
            Text(SharePanelCopy.viewsLine(viewCount: link.viewCount, lastViewedAt: link.lastViewedAt, now: Date()))
                .font(.orbitListSubtitle)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            if SharedLinksList.canTurnOff(link) {
                Button(SharePanelCopy.turnOff, role: .destructive) { pendingTurnOff = link }
            }
        }
        .contextMenu {
            if link.state == .active, let base = model.baseURL {
                let url = SharedLinksList.publicURL(link, base: base)
                Button {
                    UIPasteboard.general.url = url
                    show(SharePanelCopy.linkCopied)
                } label: {
                    Label(SharePanelCopy.copyLink, systemImage: "doc.on.doc")
                }
                SwiftUI.ShareLink(item: url) {
                    Label(SharePanelCopy.shareLink, systemImage: "square.and.arrow.up")
                }
            }
            if SharedLinksList.canTurnOff(link) {
                Button(role: .destructive) { pendingTurnOff = link } label: {
                    Label(SharePanelCopy.turnOff, systemImage: "xmark.circle")
                }
            }
        }
    }

    private func turnOff(_ link: OrbitKit.ShareLink) async {
        guard let count = await model.sharedLinks?.turnOff([link.id]) else {
            show(model.sharedLinks?.errorText ?? SharePanelCopy.turnOff)
            return
        }
        show(SharedLinksList.turnedOff(count))
    }

    /// A line over the list's foot for a moment — the app's toast lives under this sheet.
    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(2))
            if notice == text { notice = nil }
        }
    }
}
#endif
