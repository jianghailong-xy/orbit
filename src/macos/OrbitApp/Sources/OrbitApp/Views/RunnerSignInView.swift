import SwiftUI
import OrbitKit

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
    /// Offered the moment the sign-in lands: re-send whatever the failure ate. Nil where there is
    /// nothing to re-send (a proactive sign-in from the Runners screen).
    var onDone: (() async -> Void)?

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
            let m = model ?? RunnerSignInModel(runnerID: runnerID, engine: engine,
                                               baseURL: baseURL, tokenStore: app.tokenStore)
            model = m
            await m.refresh()
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
                    PasteBackForm(model: model)
                }
            case .failed, nil:
                idle(model)
            }
            if let e = model.errorText {
                Text(e).font(.orbitLabel).foregroundStyle(.red)
            }
        }
    }

    // MARK: states

    private var signedIn: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            Text("Signed in — this runner is ready.").font(.orbitLabel)
            if let onDone {
                Button("Retry my message") { Task { await onDone() } }
                    .buttonStyle(.borderless).font(.orbitLabel)
            }
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
    /// can do is show both halves and wait for the CLI to finish approving itself.
    @ViewBuilder
    private func deviceFlow(_ model: RunnerSignInModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let url = model.url { openPageButton(url) }
            Text("Sign in there, then enter this one-time code:")
                .font(.orbitLabel).foregroundStyle(.secondary)
            if let code = model.userCode {
                // Tap to copy: on a phone the page is a browser switch away, and retyping a
                // one-time code from memory is exactly what people get wrong.
                Button {
                    PlatformPasteboard.copyString(code)
                    PlatformHaptics.success()
                } label: {
                    HStack(spacing: 6) {
                        Text(code).font(.orbitMono).textSelection(.enabled)
                        Image(systemName: "doc.on.doc").font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for you to approve it…").font(.orbitLabel)
            }
            cancelButton(model)
        }
    }

    /// Idle, or a failed attempt to try again. Signing in fixes this one machine with the account
    /// the user already pays for; there is no second route out on these clients (an API key is
    /// configured from the web's Providers page), so this is the whole choice.
    @ViewBuilder
    private func idle(_ model: RunnerSignInModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.status == .failed, let m = model.relayMessage {
                Text(m).font(.orbitLabel).foregroundStyle(.orange)
            }
            Button {
                Task { await model.begin() }
            } label: {
                Text(model.busy
                     ? "Starting…"
                     : model.status == .failed
                       ? "Try signing in to \(engine.displayName) again"
                       : "Sign in to \(engine.displayName)")
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy)
        }
    }

    // MARK: pieces

    /// The sign-in page opens in the browser — Safari on iOS, the default browser on macOS — since
    /// that is where the user's session with the vendor already lives.
    private func openPageButton(_ url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            Label("Open the sign-in page", systemImage: "arrow.up.forward.square")
        }
        .buttonStyle(.borderedProminent)
    }

    private func cancelButton(_ model: RunnerSignInModel) -> some View {
        Button("Cancel") { Task { await model.cancel() } }
            .buttonStyle(.borderless)
            .font(.orbitLabel)
            .disabled(model.busy)
    }
}

/// Paste-back flow (claude): the sign-in page hands the user a code that has to come back through
/// here. Its own view so the code field can bind straight into the model.
private struct PasteBackForm: View {
    @Bindable var model: RunnerSignInModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // A rejected code lands back here with the SAME url still valid — the CLI keeps waiting
            // on that challenge — so the message is what tells the user anything changed.
            if let m = model.relayMessage {
                Text(m).font(.orbitLabel).foregroundStyle(.orange)
            }
            if let url = model.url {
                Button { openURL(url) } label: {
                    Label("Open the sign-in page", systemImage: "arrow.up.forward.square")
                }
                .buttonStyle(.borderedProminent)
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
                Button("Submit") { Task { await model.submitCode() } }
                    .buttonStyle(.bordered)
                    .disabled(model.busy || model.code.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Button("Cancel") { Task { await model.cancel() } }
                .buttonStyle(.borderless)
                .font(.orbitLabel)
                .disabled(model.busy)
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
/// machine, and any other slug is a configured API key — which these clients can't edit, so the
/// card says where it lives instead of offering a button that goes nowhere.
struct AuthErrorCardView: View {
    let console: ConsoleModel
    let message: String

    private var remedy: EngineAuth.Remedy { EngineAuth.remedy(forProvider: console.provider) }
    private var retryText: String { console.lastUserMessageText }

    var body: some View {
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
                .disabled(console.sending)
        }
    }

    private func retry() async {
        await console.retryLastMessage()
    }
}
