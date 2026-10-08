import SwiftUI
import OrbitKit

struct GoogleSignInTermsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(EngineAuth.googleTermsWarning)
            Link("Google terms", destination: EngineAuth.googleTermsURL)
        }
        .font(.orbitLabel)
        .foregroundStyle(Color.secondary)
    }
}

// Signing an engine CLI back in on the runner's own machine, from here. Two views:
//
//   • RunnerSignInView — the relay itself (start → open the page → paste the code / enter the
//     one-time code → done), backed by `RunnerSignInModel`. Web parity: RunnerSignIn.tsx.
//   • AuthErrorCardView — the transcript's remedy card for a sign-in failure, which hosts the
//     above and offers to re-send the message the failure ate. Web parity: AuthErrorCard.
//
// The engine CLIs also live behind the Runners screen's Engines section, so a machine can be
// signed in before a session ever fails on it (see SkillsRunnersView).

/// The relay card: one engine, one runner, from idle to signed in.
struct RunnerSignInView: View {
    let runnerID: String
    let engine: LoginEngine
    /// Sign in this account the runner already has — `default` or the id of one it added — of an
    /// engine that keeps several. Nil: the runner's own login, exactly as before accounts.
    var account: String? = nil
    /// Sign in a NEW account, which the runner adds under this name. The button waits for one: a
    /// blank name would read as no account at all, which is the runner's own login.
    var accountName: String? = nil
    /// Start signing in as the card appears, not on its button: the press that raised it — Add Account,
    /// an account's Sign In or Renew — already asked for the sign-in. A card for an account the runner
    /// has follows a sign-in already under way for it instead (another device may have started it).
    /// Kimi's starts on the site it is asked for, so its card opens on that choice (`kimiSites`),
    /// and this card never starts one by appearing.
    var autoStart = false
    /// Offered the moment the sign-in lands: re-send whatever the failure ate. Nil where there is
    /// nothing to re-send (a proactive sign-in from the Runners screen).
    var onDone: (() async -> Void)?
    /// The page's way to put this card away. Given, the card offers the one control for it: Cancel
    /// while a sign-in is under way, which cancels that sign-in first, and Close otherwise — never the
    /// two side by side.
    var onClose: (() -> Void)? = nil
    /// Told once the sign-in this card watched has landed, so the page can fold the card away.
    var onSignedIn: (() -> Void)? = nil

    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var model: RunnerSignInModel?

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                // Only until the first `task` runs — or forever on a signed-out app, which has no
                // instance to drive the relay against.
                ProgressView().controlSize(.small)
            }
        }
        .task(id: runnerID) {
            guard let baseURL = app.baseURL else { return }
            let fresh = model == nil
            let m = model ?? RunnerSignInModel(runnerID: runnerID, engine: engine, account: account,
                                               adding: accountName != nil,
                                               baseURL: baseURL, tokenStore: app.tokenStore)
            model = m
            // Started by the card's first appearance only: a later one picks the relay back up. A card
            // adding an account owns only the sign-in it starts; one for an account the runner has
            // follows a sign-in already running for it rather than starting it over.
            if autoStart, fresh, engine != .kimi {
                if accountName == nil { await m.refresh() }
                if m.status?.inFlight != true { await m.begin(accountName: accountName) }
            } else {
                await m.refresh()
            }
        }
        // The card can go off-screen while a sign-in runs (the transcript scrolls, the sheet
        // closes). Stop the poll with it; the `task` above picks the relay back up on return.
        .onDisappear { model?.stop() }
    }

    @ViewBuilder
    private func content(_ model: RunnerSignInModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            switch model.status {
            case .done:
                signedIn
            case .pending:
                waiting(model, "Starting sign-in on the runner…",
                        hint: "The runner picks it up on its next check-in, so the link can take up to a minute to show here.")
            case .awaitingApproval:
                deviceFlow(model)
            case .awaitingCode:
                if model.verifying {
                    waiting(model, "Signing in with your code…",
                            hint: "The runner picks it up on its next check-in, so this can take up to a minute.")
                } else {
                    PasteBackForm(model: model, onClose: onClose)
                }
            case .failed, nil:
                idle(model)
            }
            if let e = model.errorText {
                Text(e).font(.orbitLabel).foregroundStyle(.red)
            }
        }
        .onChange(of: model.status == .done) { _, done in
            if done { onSignedIn?() }
        }
    }

    // MARK: states

    private var signedIn: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Signed in — this runner is ready.").font(.orbitLabel)
                if let onDone {
                    Button("Retry my message") { Task { await onDone() } }
                        .buttonStyle(.borderless).font(.orbitLabel)
                }
            }
            closeButton
        }
    }

    private func waiting(_ model: RunnerSignInModel, _ title: String, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(title).font(.orbitLabel)
            }
            Text(hint).font(.orbitLabel).foregroundStyle(.secondary)
            cancelButton(model)
        }
    }

    /// Device flow (codex/kimi): the code goes to the browser, not back through here, so all this
    /// can do is show both halves and wait for the CLI to finish approving itself. The code comes
    /// first, and one press both copies it and opens the page it goes into (VS Code's "Copy &
    /// Continue to GitHub"): on a phone that page is a browser switch away, and retyping a one-time
    /// code from memory is exactly what people get wrong — over there, all that is left is a paste.
    @ViewBuilder
    private func deviceFlow(_ model: RunnerSignInModel) -> some View {
        // Kimi's page belongs to one of its two sites, named so the user knows which account it wants.
        let site = model.site
        VStack(alignment: .leading, spacing: 8) {
            Text(site?.enterCode ?? "Enter this one-time code on the sign-in page:")
                .font(.orbitLabel).foregroundStyle(.secondary)
            if let code = model.userCode {
                Text(code)
                    .font(.title3.monospaced().weight(.semibold))
                    .textSelection(.enabled)
            }
            if let url = model.url {
                Button {
                    if let code = model.userCode {
                        PlatformPasteboard.copyString(code)
                        PlatformHaptics.success()
                    }
                    openURL(url)
                } label: {
                    if model.userCode != nil {
                        Label(site?.copyCodeAndOpen ?? "Copy Code & Open Sign-In Page", systemImage: "doc.on.doc")
                    } else {
                        Label(site?.openPage ?? "Open the sign-in page", systemImage: "arrow.up.forward.square")
                    }
                }
                .buttonStyle(.borderedProminent)
            }
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for you to approve it…").font(.orbitLabel)
            }
            // The wrong site is the one mistake the user can't see until they are on its page: their
            // account isn't there. Starting over on the other one is a single press.
            HStack(spacing: 16) {
                cancelButton(model)
                if let site {
                    Button(site.other.useInstead) { Task { await model.begin(site: KimiSite.named(site.other, on: model.runner)) } }
                        .buttonStyle(.borderless)
                        .font(.orbitLabel)
                        .disabled(model.busy)
                }
            }
        }
    }

    /// Idle, or a failed attempt to try again. Signing in fixes this one machine with the account
    /// the user already pays for; there is no second route out on these clients (an API key is
    /// configured from the web's Providers page), so this is the whole choice.
    @ViewBuilder
    private func idle(_ model: RunnerSignInModel) -> some View {
        if engine == .kimi {
            kimiSites(model)
        } else {
            signInButton(model)
        }
    }

    /// Kimi's sign-in is itself a choice: kimi.com and kimi.ai keep separate accounts, and left to
    /// itself the CLI goes to the site its installer came from. So the press that starts it picks the
    /// site, and nothing is picked for the user (web RunnerSignIn).
    @ViewBuilder
    private func kimiSites(_ model: RunnerSignInModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.status == .failed, let m = model.relayMessage {
                Text(m).font(.orbitLabel).foregroundStyle(.orange)
            }
            Text(KimiSite.question).font(.orbitLabel)
            ForEach(KimiSite.allCases) { site in
                Button {
                    Task { await model.begin(site: KimiSite.named(site, on: model.runner)) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(site.domain).font(.headline)
                            Text(site.place).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        if model.currentSite == site {
                            Text(KimiSite.currentMark)
                                .font(.orbitLabel.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(Color.accentColor.opacity(0.14), in: Capsule())
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .disabled(model.busy || !model.runnerRead)
            }
            Text(KimiSite.separateAccounts)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
            closeButton
        }
    }

    @ViewBuilder
    private func signInButton(_ model: RunnerSignInModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if engine == .antigravity { GoogleSignInTermsView() }
            if model.status == .failed, let m = model.relayMessage {
                Text(m).font(.orbitLabel).foregroundStyle(.orange)
            }
            Button {
                Task { await model.begin(accountName: accountName) }
            } label: {
                Text(model.busy
                     ? "Starting…"
                     : model.status == .failed
                       ? "Try signing in to \(engine.displayName) again"
                       : engine == .antigravity ? "Sign in with Google" : "Sign in to \(engine.displayName)")
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy || !nameReady)
            closeButton
        }
    }

    /// A card adding an account has a name to start with; any other card is ready as it is.
    private var nameReady: Bool {
        guard let accountName else { return true }
        return !accountName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: pieces

    /// Cancel: the sign-in under way is cancelled on the runner, and a card the page can put away goes
    /// with it — unless cancelling failed, which leaves the card up to say so. (The page's own button
    /// is gone: the device flow's one press copies the code and opens the page itself.)
    private func cancelButton(_ model: RunnerSignInModel) -> some View {
        Button("Cancel") {
            Task {
                await model.cancel()
                if model.errorText == nil { onClose?() }
            }
        }
        .buttonStyle(.borderless)
        .font(.orbitLabel)
        .disabled(model.busy)
    }

    /// Close, where nothing is under way to cancel: before a sign-in starts, after one failed, and once
    /// one has landed and the page has yet to fold the card.
    @ViewBuilder private var closeButton: some View {
        if let onClose {
            Button("Close", action: onClose)
                .buttonStyle(.borderless)
                .font(.orbitLabel)
        }
    }
}

/// Paste-back flow (claude): the sign-in page hands the user a code that has to come back through
/// here. Its own view so the code field can bind straight into the model.
///
/// The prominent press follows the next step: Open the sign-in page until the page has been opened
/// from here and the app brought back, then Paste. Paste is the system's paste control, which hands
/// over what was copied on that page without asking to read the pasteboard, and the code goes
/// straight to the runner; a code typed by hand is sent with Submit, or Return.
private struct PasteBackForm: View {
    @Bindable var model: RunnerSignInModel
    var onClose: (() -> Void)?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var opened = false
    @State private var returned = false

    private var typed: Bool { !model.code.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // A rejected code lands back here with the SAME url still valid — the CLI keeps waiting
            // on that challenge — so the message is what tells the user anything changed.
            if let m = model.relayMessage {
                Text(m).font(.orbitLabel).foregroundStyle(.orange)
            }
            if let url = model.url {
                if returned {
                    Button { openURL(url) } label: {
                        Label("Open the sign-in page", systemImage: "arrow.up.forward.square")
                    }
                    .buttonStyle(.borderless)
                    .font(.orbitLabel)
                } else {
                    Button {
                        opened = true
                        openURL(url)
                    } label: {
                        Label("Open the sign-in page", systemImage: "arrow.up.forward.square")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            Text("Approve it there, then paste the code the page gives you:")
                .font(.orbitLabel).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                TextField("Paste the code", text: $model.code)
                    .textFieldStyle(.roundedBorder)
                    .font(.orbitControl)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit { Task { await model.submitCode() } }
                if typed {
                    Button("Submit") { Task { await model.submitCode() } }
                        .buttonStyle(.bordered)
                        .disabled(model.busy)
                } else {
                    PasteButton(payloadType: String.self) { pasted in
                        guard let code = pasted.first?.trimmingCharacters(in: .whitespacesAndNewlines),
                              !code.isEmpty else { return }
                        Task { @MainActor in
                            model.code = code
                            await model.submitCode()
                        }
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                    .tint(returned ? Color.accentColor : Color.secondary)
                    .disabled(model.busy)
                }
            }
            Button("Cancel") {
                Task {
                    await model.cancel()
                    if model.errorText == nil { onClose?() }
                }
            }
            .buttonStyle(.borderless)
            .font(.orbitLabel)
            .disabled(model.busy)
        }
        // Back from the page this opened: the code is on the pasteboard now, so Paste is the press.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, opened { returned = true }
        }
    }
}

/// A sign-in failure in the transcript, rendered as a remedy rather than an error line.
///
/// The runtime reports it as ordinary assistant text ("Failed to authenticate: OAuth session
/// expired…"), which reads like the agent's own reply and tells the user nothing about what to do —
/// so this card names the machine, signs it back in from here, and offers to re-send once it is.
///
/// The remedy depends on where the credentials live (see `EngineAuth.remedy`): a built-in engine
/// signs in on the runner itself, OpenCode's provider-specific login can only be run on that
/// machine, Antigravity connects Gemini in Providers, and any other slug is a configured
/// API key — which these clients can't edit, so the card says where it lives instead of offering a
/// button that goes nowhere.
struct AuthErrorCardView: View {
    let console: ConsoleModel
    let message: String

    private var remedy: EngineAuth.Remedy { EngineAuth.remedy(forProvider: console.provider, googleLogin: console.runnerAntigravity?.googleLogin) }
    private var retryText: String { console.lastUserMessageText }

    var body: some View {
        if console.provider == "antigravity" || (console.executesAntigravity && EngineAuth.antigravityRepair(message) == .needsKey) {
            AntigravityRepairCardView(console: console, repair: .needsKey)
        } else {
            ordinaryCard
        }
    }

    private var ordinaryCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange).font(.orbitProse.bold())
            Text(message).font(.orbitLabel).foregroundStyle(.secondary).textSelection(.enabled)
            remedyView
            retryView
        }
        .padding(10)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private var title: String {
        switch remedy {
        case .signIn:
            guard let name = console.runnerName, !name.isEmpty else { return "Sign-in expired" }
            return "Sign-in expired on “\(name)”"
        case .runCommand:
            return "Sign-in expired"
        case .connectGemini:
            return EngineAuth.antigravityTitle(.needsKey, runnerName: console.runnerName)
        case .apiKey:
            return "Provider authentication failed"
        }
    }

    @ViewBuilder
    private var remedyView: some View {
        switch remedy {
        case .signIn(let engine):
            if let runnerID = console.runnerID {
                RunnerSignInView(runnerID: runnerID, engine: engine, onDone: retry)
            } else {
                // No runner on the session record (an older payload, or a session that never got
                // assigned): there is no machine to point the relay at, so say so rather than
                // offering a button with nowhere to send it.
                Text("Sign in to \(engine.displayName) on the runner this session belongs to.")
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        case .runCommand(let command):
            Text("Run \(Text(command).font(.orbitMono)) on that machine and choose the provider there — OpenCode's sign-in is provider-specific, so it can't be driven from here.")
                .font(.orbitLabel).foregroundStyle(.secondary)
        case .connectGemini:
            EmptyView()
        case .apiKey(let slug):
            Text("The API key for \(Text(slug).font(.orbitMono)) was rejected. Update it in Providers on the Orbit web app, then send your message again.")
                .font(.orbitLabel).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var retryView: some View {
        if !retryText.isEmpty {
            // "my last message" is a promise the reader can't check — by this point it has usually
            // scrolled away. Quote it, clamped, so the button is a decision rather than a leap of
            // faith.
            Text(retryText)
                .font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            Button("Retry — re-send my last message") { Task { await retry() } }
                .buttonStyle(.bordered)
                // A press already in flight is not offered a second one (criterion 19).
                .disabled(console.sending || console.retryInFlight)
        }
    }

    private func retry() async {
        await console.retryLastMessage()
    }
}


/// Antigravity's key, CLI install, and runner-version repairs, shared by transcript and queue state.
struct AntigravityRepairCardView: View {
    let console: ConsoleModel
    let repair: EngineAuth.AntigravityRepair
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(EngineAuth.antigravityTitle(repair, runnerName: console.runnerName),
                  systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange).font(.orbitProse.bold())
            Text(EngineAuth.antigravityBody(repair, runnerName: console.runnerName,
                                           runnerVersion: console.runnerVersion))
                .font(.orbitLabel).foregroundStyle(.secondary)
            if repair == .needsKey, console.provider == "antigravity" {
                if console.runnerAntigravity?.googleLogin == .available, let runnerID = console.runnerID {
                    RunnerSignInView(runnerID: runnerID, engine: .antigravity,
                                     onDone: { await console.retryLastMessage() })
                } else if let hint = EngineAuth.antigravityLoginHint(console.runnerAntigravity?.googleLogin) {
                    Text(hint).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            HStack {
                if repair == .needsKey {
                    Button("Connect Gemini") { Task { openURL(await console.connectGeminiURL()) } }
                        .buttonStyle(.borderedProminent)
                    Button("Switch to Gemini") {
                        if let choice = console.geminiSwitchChoice {
                            Task { await console.selectProvider(choice.slug) }
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(console.geminiSwitchChoice == nil)
                } else {
                    if repair == .notInstalled {
                        Button("Install") { Task { await console.installAntigravity() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(!console.canInstallAntigravity)
                    }
                    Button("Open in Providers") {
                        if let url = console.antigravityProvidersURL { openURL(url) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(console.antigravityProvidersURL == nil)
                }
            }
            .font(.orbitLabel)
        }
        .padding(10)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .task { await console.refreshAntigravityRepairContext() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await console.refreshAntigravityRepairContext() } }
        }
        // Follow this runner's one install relay only while the repair card remains visible.
        .task(id: console.runnerInstall?.inFlight == true) {
            while console.runnerInstall?.inFlight == true {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) }
                catch { return }
                guard !Task.isCancelled else { return }
                await console.refreshAntigravityRunner()
            }
        }
    }
}

/// A DeepSeek Harness session that could not run, as the remedy rather than the runner's sentence
/// (web's `DshRepairCard`). Its credential is a configured key, never a sign-in on the runner, so a
/// key problem is fixed on that key's page in Providers; everything else is about the machine.
struct DshRepairCardView: View {
    let console: ConsoleModel
    let repair: DshRuntime.Repair
    @Environment(\.openURL) private var openURL

    private var title: String {
        let machine = console.runnerName.flatMap { $0.isEmpty ? nil : "“\($0)”" }
        switch repair {
        case .notInstalled:
            return machine.map { "DeepSeek Harness isn't installed on \($0)" } ?? repair.title
        case .unsupportedPlatform:
            return machine.map { "DeepSeek Harness can't run on \($0)" } ?? repair.title
        default:
            return repair.title
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange).font(.orbitProse.bold())
            Text(repair.detail)
                .font(.orbitLabel).foregroundStyle(.secondary)
            HStack {
                if repair.isKeyProblem {
                    Button("Update the API key") { Task { openURL(await console.dshKeyURL()) } }
                        .buttonStyle(.borderedProminent)
                    if !console.retryMessageText.isEmpty {
                        Button("Retry — re-send my last message") { Task { await console.retryLastMessage() } }
                            .buttonStyle(.bordered)
                            .disabled(console.sending || console.retryInFlight)
                    }
                } else if repair == .notInstalled {
                    Button("Install") { Task { await console.installDsh() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!console.canInstallDsh)
                }
            }
            .font(.orbitLabel)
        }
        .padding(10)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("dsh-repair-\(repair.rawValue)")
    }
}
