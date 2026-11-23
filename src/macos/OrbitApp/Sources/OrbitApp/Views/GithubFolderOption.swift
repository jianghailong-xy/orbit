import SwiftUI
import OrbitKit

/// The From GitHub option's body (docs/github-workspace-design.md §8, board 01 P1–P3), the port of web's
/// `GithubFolderOption`: Connect GitHub until the account is connected, then a search of the repositories Orbit's App
/// reaches, most recently pushed first; once one is picked, its default branch (Other branch for another) and the
/// folder it is cloned into, which the machine is asked about — a folder already there can't be cloned into. Says what
/// it would pick through `onCandidate`; the card's button sends it.
struct GithubFolderOption: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let runner: Runner
    let integration: GithubIntegration
    let disabled: Bool
    let onCandidate: (PickedFolder?) -> Void
    let onEnter: () -> Void

    private enum Listing: Equatable {
        case loading
        case failed(String)
        case loaded([GithubRepository])
    }

    @State private var connecting = false
    @State private var connectError: String?
    @State private var search = ""
    /// The search as it stood once typing paused: what the list is asked for.
    @State private var settled = ""
    @State private var listing: Listing = .loading
    @State private var repo: GithubRepository?
    @State private var folder = ""
    @State private var branchOpen = false
    @State private var branch = ""
    @State private var branches: [String] = []
    /// What the machine said about `<cloneRoot>/<folder>`, and Check again.
    @State private var answer: DirProbeRelay.Outcome?
    @State private var attempt = 0

    private var machine: String { RunnerPageFormat.displayName(runner) }
    private var clones: Bool { MachineSetup.clonesRepositories(runner) }
    /// Where the server clones it (MachineSetup.cloneRootFor): home on a clone-workdir/v2 runner.
    private var cloneRoot: String { MachineSetup.cloneRoot(runner) ?? "" }
    private var name: String { folder.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var probed: DirProbe? {
        guard case .answered(let probe)? = answer else { return nil }
        return probe
    }

    private var candidate: PickedFolder? {
        guard let repo, clones else { return nil }
        return MachineSetup.githubPick(repo, name: name,
                                       ref: branchOpen ? MachineSetup.cloneRef(typed: branch, defaultBranch: repo.defaultBranch) : nil,
                                       reposRoot: cloneRoot, probe: probed)
    }

    private struct Question: Equatable {
        let path: String?
        let attempt: Int
    }

    private var folderQuestion: String? {
        guard repo != nil, !disabled, MachineSetup.isValidNewFolder(name) else { return nil }
        return MachineSetup.newFolderPath(root: cloneRoot, name: name)
    }

    var body: some View {
        Group {
            if !integration.usable {
                connectBody
            } else if let repo {
                pickedBody(repo)
            } else {
                searchBody
            }
        }
        .onChange(of: candidate, initial: true) { _, now in onCandidate(now) }
        // The list as it is typed, once typing has paused.
        .task(id: search) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            settled = search.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        .task(id: integration.usable && repo == nil && clones ? settled : nil) {
            guard integration.usable, repo == nil, clones else { return }
            listing = .loading
            do {
                let page = try await app.githubRepositories(query: settled)
                if !Task.isCancelled { listing = .loaded(page.repositories) }
            } catch {
                if !Task.isCancelled { listing = .failed(APIClient.failureReason(error)) }
            }
        }
        .task(id: branchOpen ? repo?.id : nil) {
            guard branchOpen, let repo else { return }
            branches = (try? await app.githubBranches(repoID: repo.id))?.branches ?? []
        }
        .task(id: Question(path: folderQuestion, attempt: attempt)) {
            answer = nil
            guard let asked = folderQuestion else { return }
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let outcome = await app.probeDir(runnerID: runner.id, path: asked, ask: true)
            if !Task.isCancelled { answer = outcome }
        }
    }

    // MARK: not connected

    @ViewBuilder private var connectBody: some View {
        SetupMeta(MachineSetupCopy.SETUP_GITHUB_META)
        if integration.needsReconnect {
            SetupVerdict(MachineSetupCopy.setupGithubSignInAgain(login: integration.login ?? ""), tone: .warn)
        }
        if let connectError {
            SetupVerdict(MachineSetupCopy.setupGithubConnectFailed(why: connectError), tone: .bad)
        }
        HStack(spacing: 8) {
            Button {
                connect()
            } label: {
                HStack(spacing: 5) {
                    if connecting { ProgressView().controlSize(.mini) } else { GithubMark() }
                    Text(integration.needsReconnect ? MachineSetupCopy.SETUP_RECONNECT_GITHUB : MachineSetupCopy.SETUP_CONNECT_GITHUB)
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .disabled(disabled || connecting)
            SetupMeta(MachineSetupCopy.SETUP_CONNECT_GITHUB_META)
        }
        .padding(.top, 4)
        tooOld
    }

    private func connect() {
        connecting = true
        connectError = nil
        Task {
            do {
                openURL(try await app.githubSignInURL())
            } catch {
                connectError = APIClient.failureReason(error)
            }
            connecting = false
        }
    }

    @ViewBuilder private var tooOld: some View {
        if !clones {
            SetupVerdict(MachineSetup.updatesItself(runner) ? MachineSetupCopy.setupCloneUpdating(machine: machine)
                         : MachineSetupCopy.setupCloneNeedsUpdate(machine: machine), tone: .warn)
        }
    }

    // MARK: the repository search

    private var shown: [GithubRepository] {
        guard case .loaded(let list) = listing else { return [] }
        return settled.isEmpty ? Array(list.prefix(MachineSetup.firstRepositories)) : list
    }

    @ViewBuilder private var searchBody: some View {
        HStack(spacing: 4) {
            Text(MachineSetupCopy.setupGithubAccount(login: integration.login ?? "", repositories: integration.repositoryCount))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: "·").font(.orbitLabel).foregroundStyle(.secondary)
            SetupChange { app.showGithubSettings() }
        }
        tooOld
        if clones {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(MachineSetupCopy.SETUP_GITHUB_SEARCH, text: $search)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit { if let first = shown.first { pick(first) } }
                    .accessibilityLabel(MachineSetupCopy.SETUP_GITHUB_SEARCH)
            }
            .font(.orbitLabel)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(SetupInk.card, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5) }
            .padding(.top, 4)
            VStack(alignment: .leading, spacing: 0) {
                switch listing {
                case .loading:
                    note(MachineSetupCopy.SETUP_GITHUB_LOADING)
                case .failed(let why):
                    SetupVerdict(MachineSetupCopy.setupGithubListFailed(why: why), tone: .bad).padding(8)
                case .loaded:
                    if shown.isEmpty {
                        note(MachineSetupCopy.SETUP_GITHUB_NONE)
                    } else {
                        ForEach(shown) { repository in
                            Button { pick(repository) } label: { RepositoryRow(repository: repository) }
                                .buttonStyle(.plain)
                                .disabled(disabled)
                            if repository.id != shown.last?.id { Divider().padding(.leading, 30) }
                        }
                    }
                }
                if let installUrl = integration.installUrl.flatMap(URL.init(string:)) {
                    Divider()
                    HStack(spacing: 4) {
                        Text(MachineSetupCopy.SETUP_GITHUB_NOT_LISTED).foregroundStyle(.secondary)
                        Link(destination: installUrl) {
                            HStack(spacing: 3) {
                                Text(MachineSetupCopy.SETUP_GITHUB_ADD_REPOSITORIES)
                                Image(systemName: "arrow.up.right.square")
                            }
                        }
                    }
                    .font(.orbitLabel)
                    .padding(8)
                }
            }
            .background(SetupInk.card, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5) }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(MachineSetupCopy.SETUP_GITHUB_SEARCH)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pick(_ picked: GithubRepository) {
        repo = picked
        folder = MachineSetup.repositoryFolder(picked.fullName)
        branchOpen = false
        branch = ""
    }

    // MARK: a repository picked

    @ViewBuilder private func pickedBody(_ repo: GithubRepository) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            RepositoryMark(isPrivate: repo.private)
            Text(repo.fullName).fontWeight(.medium).lineLimit(1).truncationMode(.middle)
            if !branchOpen {
                HStack(spacing: 2) {
                    Image(systemName: "arrow.triangle.branch").accessibilityLabel(MachineSetupCopy.SETUP_DEFAULT_BRANCH)
                    Text(repo.defaultBranch)
                }
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer(minLength: 4)
            SetupChange { self.repo = nil }.disabled(disabled)
        }
        if branchOpen {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
                    SetupField(repo.defaultBranch, text: $branch) { if candidate != nil { onEnter() } }
                        .accessibilityLabel(MachineSetupCopy.SETUP_BRANCH)
                }
                let typed = branch.trimmingCharacters(in: .whitespaces)
                let matching = branches.filter { $0 != typed && (typed.isEmpty || $0.localizedCaseInsensitiveContains(typed)) }.prefix(5)
                if !matching.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(matching), id: \.self) { name in
                            Button(name) { branch = name }
                                .buttonStyle(.plain)
                                .font(.orbitMono)
                                .foregroundStyle(Color.accentColor)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .padding(.top, 4)
        }
        HStack(spacing: 4) {
            Text(MachineSetup.newFolderPath(root: cloneRoot, name: ""))
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
            SetupField(MachineSetupCopy.SETUP_NEW_FOLDER_NAME, text: $folder) { if candidate != nil { onEnter() } }
                .accessibilityLabel(MachineSetupCopy.SETUP_NEW_FOLDER_NAME)
        }
        .padding(.top, 4)
        folderVerdict
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            SetupMeta(MachineSetupCopy.SETUP_GITHUB_CLONED_META)
            if !branchOpen {
                Button(MachineSetupCopy.SETUP_OTHER_BRANCH) { branchOpen = true }
                    .buttonStyle(.plain)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.accentColor)
                    .disabled(disabled)
            }
        }
    }

    @ViewBuilder private var folderVerdict: some View {
        if name.isEmpty {
            EmptyView()
        } else if !MachineSetup.isValidNewFolder(name) {
            SetupVerdict(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, tone: .bad)
        } else if let probed {
            if let error = probed.error, !error.isEmpty {
                SetupVerdict(error, tone: .bad)
            } else if probed.exists {
                SetupVerdict(MachineSetupCopy.setupGithubFolderExists(machine: machine), tone: .bad)
            }
        } else if answer != nil {
            HStack(spacing: 6) {
                SetupVerdict(MachineSetupCopy.setupNoAnswer(machine: machine), tone: .bad)
                Button(MachineSetupCopy.SETUP_CHECK_AGAIN) { attempt += 1 }
                    .buttonStyle(.plain)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.accentColor)
            }
        } else {
            Text(MachineSetupCopy.setupChecking(machine: machine))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
        }
    }
}

/// One repository in the picker: its mark (a lock for a private one), `owner/` dimmed then the name, and when it was
/// last pushed.
private struct RepositoryRow: View {
    let repository: GithubRepository

    var body: some View {
        HStack(spacing: 8) {
            RepositoryMark(isPrivate: repository.private).frame(width: 14)
            (Text(repository.owner).foregroundStyle(.secondary) + Text(repository.name).foregroundStyle(.primary))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            Text(MachineSetupCopy.pushedAgo(repository.pushedAt))
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .font(.orbitLabel)
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }
}

/// A private repository's lock, or GitHub's mark.
struct RepositoryMark: View {
    let isPrivate: Bool

    var body: some View {
        if isPrivate {
            Image(systemName: "lock.fill")
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .accessibilityLabel(MachineSetupCopy.SETUP_GITHUB_PRIVATE)
        } else {
            GithubMark().foregroundStyle(.secondary)
        }
    }
}

/// GitHub's mark where these apps have no brand glyph: a branch-like symbol stands in, hidden from VoiceOver.
struct GithubMark: View {
    var body: some View {
        Image(systemName: "chevron.left.forwardslash.chevron.right")
            .font(.orbitMeta)
            .accessibilityHidden(true)
    }
}

// MARK: - the setup card's small parts, shared with FolderOptions' look

struct SetupMeta: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct SetupVerdict: View {
    let text: String
    let tone: FolderVerdict.Tone
    init(_ text: String, tone: FolderVerdict.Tone) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(tone == .ok ? SetupInk.found : tone == .warn ? SetupInk.warn : Color.red)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct SetupChange: View {
    let action: () -> Void

    var body: some View {
        Button(MachineSetupCopy.SETUP_CHANGE, action: action)
            .buttonStyle(.plain)
            .font(.orbitLabel)
            .foregroundStyle(Color.accentColor)
    }
}

struct SetupField: View {
    let prompt: String
    @Binding var text: String
    let onSubmit: () -> Void

    init(_ prompt: String, text: Binding<String>, onSubmit: @escaping () -> Void) {
        self.prompt = prompt
        self._text = text
        self.onSubmit = onSubmit
    }

    var body: some View {
        TextField(prompt, text: $text)
            .textFieldStyle(.roundedBorder)
            .font(.orbitMono)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            .onSubmit(onSubmit)
    }
}
