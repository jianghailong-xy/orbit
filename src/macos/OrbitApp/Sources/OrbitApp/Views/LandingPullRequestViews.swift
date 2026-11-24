import SwiftUI
import OrbitKit

/// The landing's pull request states (docs/mocks/protected-branch-landing 02/03, owner 2026-11-23), drawn from
/// OrbitKit's `LandingPullRequestCard` — the port of web's `LandingPullRequest`. One block under a landing's card:
/// its head and count, a segment per required check, one sentence, its doors, and — under a pull request that waits
/// for review — the dismissible Faster tip.
struct LandingPullRequestBlock: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @AppStorage("orbit.landing.fasterTipHidden") private var tipHidden = false
    let pullRequest: LandingPullRequestView
    let main: String
    /// Where "Open session" goes, on a failed check.
    var openSession: (() -> Void)? = nil
    @State private var settingsFor: Agent?

    private var card: LandingPullRequestCard { .make(pullRequest, main: main) }

    private var ink: Color {
        switch card.tone {
        case .blue: return .accentColor
        case .green: return .green
        case .red: return .red
        case .amber: return ProjectPalette.warningInk
        }
    }

    private var workspace: Agent? {
        pullRequest.workspaceId.flatMap { app.agents?.agent($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(card.head).font(.orbitLabel.weight(.semibold)).foregroundStyle(ink)
                Spacer(minLength: 8)
                if let right = card.right {
                    Text(right).font(.orbitMeta).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            if !card.segments.isEmpty {
                HStack(spacing: 3) {
                    ForEach(Array(card.segments.enumerated()), id: \.offset) { _, seg in
                        Capsule().fill(color(seg)).frame(height: 4)
                    }
                }
                .accessibilityHidden(true)
            }
            Text(card.detail).font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if openSessionShown || !card.actions.isEmpty {
                HStack(spacing: 12) {
                    if openSessionShown, let openSession {
                        Button(LandingPullRequestWords.openSession, action: openSession)
                    }
                    ForEach(Array(card.actions.enumerated()), id: \.offset) { _, action in
                        Button(action.label) { perform(action) }
                    }
                }
                .font(.orbitLabel.weight(.semibold)).buttonStyle(.plain).foregroundStyle(Color.accentColor)
            }
            if card.showsTip(workspaceMode: workspace?.landingMode, hidden: tipHidden) { tip }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ink.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("landing-pr-\(card.stage.rawValue)")
        .sheet(item: $settingsFor) { agent in
            if let agents = app.agents { AgentSettingsSheet(agents: agents, agent: agent) }
        }
    }

    private var openSessionShown: Bool { card.stage == .checkFailed && openSession != nil }

    private var tip: some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(LandingPullRequestWords.tip).font(.orbitMeta).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(LandingPullRequestWords.tipLink) { settingsFor = workspace }
                    .font(.orbitLabel.weight(.semibold)).buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor).disabled(workspace == nil)
            }
            Spacer(minLength: 4)
            Button { tipHidden = true } label: { Image(systemName: "xmark") }
                .font(.orbitMeta).buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityLabel(LandingPullRequestWords.dismiss)
        }
        .padding(.top, 4)
    }

    private func color(_ seg: LandingPullRequestCard.Segment) -> Color {
        switch seg {
        case .passed: return .green
        case .failed: return .red
        case .pending: return Color.secondary.opacity(0.3)
        }
    }

    private func perform(_ action: LandingPullRequestCard.Action) {
        switch action.destination {
        case .web(let url): if let url = URL(string: url) { openURL(url) }
        case .workspaceLanding: settingsFor = workspace
        }
    }
}

/// The workspace's Landing section (docs/mocks/protected-branch-landing, option A, owner 2026-11-23): two full-width
/// rows, Pull request (Default) and Push as me (Faster), with the permissions notice and the refusal notice under
/// them. The port of web's `WorkspaceLandingSetting`; it reads the `landing` block of the workspace's own read.
struct WorkspaceLandingSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let agent: Agent
    @State private var detail: Agent?
    @State private var saving = false
    @State private var error: String?
    /// The workspace's own read has been tried: until then the section holds its place, so the read has a view to run on.
    @State private var loaded = false

    private var landing: WorkspaceLandingView? { (detail ?? agent).landing }

    var body: some View {
        Group {
            if let landing {
                section(landing)
            } else if !loaded {
                Section { ProgressView().frame(maxWidth: .infinity) } header: { Text(WorkspaceLandingCopy.section) }
            }
        }
        .task {
            detail = await app.workspaceDetail(agent.id)
            loaded = true
        }
    }

    @ViewBuilder private func section(_ landing: WorkspaceLandingView) -> some View {
        Section {
            if landing.mode == nil {
                Text(WorkspaceLandingCopy.notGithub).font(.orbitLabel).foregroundStyle(.secondary)
            } else {
                Text(WorkspaceLandingCopy.lead).font(.orbitLabel).foregroundStyle(.secondary)
                choice(WorkspaceLandingCopy.pullRequest, badge: WorkspaceLandingCopy.defaultBadge,
                       body: WorkspaceLandingCopy.pullRequestBody, mode: "PULL_REQUEST", landing: landing)
                choice(WorkspaceLandingCopy.pushAsMe, badge: WorkspaceLandingCopy.fasterBadge,
                       body: WorkspaceLandingCopy.pushAsMeBody, mode: "PUSH_AS_ME", landing: landing)
                if landing.pushAsMe.reason == "GITHUB_NOT_CONNECTED" {
                    Text(WorkspaceLandingCopy.notConnected).font(.orbitLabel).foregroundStyle(.secondary)
                    Button(WorkspaceLandingCopy.connect) { connect() }
                }
                if let pending = landing.permissionsPending {
                    notice(WorkspaceLandingCopy.permissionsText(account: pending.account), linkTitle: WorkspaceLandingCopy.review,
                           url: pending.reviewUrl, identifier: "landing-permissions-pending")
                }
                if let refusal = WorkspaceLandingCopy.refusal(landing) {
                    notice(WorkspaceLandingCopy.refusalText(
                        branch: refusal.branch, repo: WorkspaceLandingCopy.repoSlug(agent.repoUrl), message: refusal.message),
                           title: WorkspaceLandingCopy.refused,
                           linkTitle: WorkspaceLandingCopy.connectAgain, url: nil, identifier: "landing-refused")
                }
                if let error { Text(error).font(.orbitMeta).foregroundStyle(.red) }
            }
        } header: {
            Text(WorkspaceLandingCopy.section)
        }
    }

    private func choice(_ name: String, badge: String, body: String, mode: String, landing: WorkspaceLandingView) -> some View {
        let selected = landing.mode == mode
        let disabled = saving || (mode == "PUSH_AS_ME" && !landing.pushAsMe.available)
        return Button { choose(mode) } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(name).font(.body.weight(.semibold))
                        Text(badge).font(.orbitMeta.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background((mode == "PULL_REQUEST" ? Color.accentColor : Color.secondary).opacity(0.15), in: Capsule())
                    }
                    Text(body).font(.orbitLabel).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(mode == "PUSH_AS_ME" && !landing.pushAsMe.available ? 0.55 : 1)
        .accessibilityIdentifier("landing-choice-\(mode)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The board's amber notice box, as web (`.landing-setting-notice`) and Android draw it: a warning tint, a border
    /// and the warning ink for the title, the sentence and the link.
    private func notice(_ text: String, title: String? = nil, linkTitle: String, url: String?, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title { Text(title).font(.orbitLabel.weight(.bold)) }
            Text(text).font(.orbitLabel).fixedSize(horizontal: false, vertical: true)
            Button(linkTitle) { if let url { if let u = URL(string: url) { openURL(u) } } else { connect() } }
                .font(.orbitLabel.weight(.semibold)).buttonStyle(.plain).underline()
        }
        .foregroundStyle(ProjectPalette.warningInk)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.orange.opacity(0.4), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private func choose(_ mode: String) {
        guard (detail ?? agent).landing?.mode != mode else { return }
        saving = true
        error = nil
        Task {
            if let why = await app.setLandingMode(mode, inWorkspace: agent.id) { error = why }
            else { detail = await app.workspaceDetail(agent.id) }
            saving = false
        }
    }

    private func connect() {
        Task {
            do { openURL(try await app.githubSignInURL()) }
            catch { app.showToast(GithubCopy.CONNECT_FAILED, detail: APIClient.failureReason(error), tone: .error) }
        }
    }
}
