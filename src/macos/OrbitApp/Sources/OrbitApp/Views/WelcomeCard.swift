import SwiftUI
import OrbitKit

// A new account's first sign-in (docs/mocks/new-user-onboarding, boards 02–03, the owner's A/A/A/A): one
// card, in the page the account lands on, with three steps — a computer, a model, a first message. The
// web's WelcomeCard.tsx, drawn with the setup card's own pieces (`SetupStepRow`, `setupCardSurface`,
// `SetupInk`). The words are OrbitKit's `WelcomeCopy`, held to the web's welcomeCopy.ts; the rules are
// `Welcome`'s. Only while the account has never had a session (`AppModel.newAccount`).

/// The card's head: who it greets and what Orbit is, in one sentence.
struct WelcomeHead: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "sparkles")
                .font(.orbitGlyph)
                .foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(WelcomeCopy.welcomeTitle(name: app.user?.name))
                    .font(.headline)
                Text(WelcomeCopy.WELCOME_LEAD)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A step's title and the line under it.
private struct WelcomeStepHead: View {
    let title: String
    var help: String? = nil

    var body: some View {
        Text(title).fontWeight(.semibold)
        if let help {
            Text(help)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// What a step does once an earlier one is done.
private struct WelcomeLater: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.tertiary)
            .padding(.top, 6)
    }
}

/// A step drawn as one line once it is done.
private struct WelcomeDoneLine: View {
    let title: String
    let detail: String
    var onChange: (() -> Void)? = nil

    var body: some View {
        SetupStepRow(number: 0, done: true) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).fontWeight(.semibold)
                Text(detail)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let onChange {
                    Button(MachineSetupCopy.SETUP_CHANGE, action: onChange)
                        .buttonStyle(.plain)
                        .font(.orbitLabel)
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
    }
}

/// The last step: three first messages to try. Picking one only fills the composer.
struct WelcomeExamplesStep: View {
    let step: Int
    let console: ConsoleModel

    var body: some View {
        SetupStepRow(number: step, done: false) {
            WelcomeStepHead(title: WelcomeCopy.WELCOME_FIRST, help: WelcomeCopy.WELCOME_FIRST_HELP)
            VStack(spacing: 6) {
                ForEach(WelcomeCopy.WELCOME_EXAMPLES, id: \.self) { example in
                    let picked = Welcome.picked(console.composerText, example)
                    Button { console.fillFromWelcome(example) } label: {
                        Text(example)
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(picked ? Color.accentColor.opacity(0.12) : SetupInk.options,
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(picked ? Color.accentColor : .clear, lineWidth: 1)
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(picked ? .isSelected : [])
                }
            }
            .padding(.top, 8)
        }
    }
}

// MARK: - the managed runner's default workspace (board 02, P1 and P2)

/// A new account's first draft in its managed runner's default workspace: the runner Orbit starts for it,
/// a model to run on, and a first message. It stands where the managed runner's notice and the engine
/// hero stand for everybody else; the composer under it is the page's own.
struct ManagedWelcomeCard: View {
    @Environment(AppModel.self) private var app
    let draft: ConsoleModel
    let managed: ManagedRunnerConsole
    /// The managed runner's row, once the runner list has it.
    let runner: Runner?
    /// The engine a sign-in is offered for (`Welcome.engine`).
    let engine: LoginEngine
    let credential: SetupCredential
    /// The first key or pool that can run here, for Use an API Key; nil offers none.
    let keyToUse: EnginePick?
    /// The machine's name as the page shows it.
    let machine: String
    @State private var addingRunner = false

    private var online: Bool { runner.map(AgentListLogic.isOnline) ?? false }
    private var up: Bool { Welcome.computerUp(managed.display.kind, runnerOnline: online) }
    private var startsNow: Bool { !managed.blocksNewSession }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WelcomeHead()
            Divider().padding(.top, 12)
            computerStep
            Divider()
            modelStep
            Divider()
            WelcomeExamplesStep(step: 3, console: draft)
            Divider()
            foot
        }
        .setupCardSurface()
        .sheet(isPresented: $addingRunner) { AddRunnerSheet() }
    }

    @ViewBuilder private var computerStep: some View {
        if up {
            WelcomeDoneLine(title: WelcomeCopy.WELCOME_COMPUTER_DONE,
                            detail: WelcomeCopy.welcomeComputerReady(machine: machine))
        } else {
            SetupStepRow(number: 1, done: false) {
                WelcomeStepHead(title: WelcomeCopy.WELCOME_COMPUTER, help: WelcomeCopy.WELCOME_COMPUTER_MANAGED)
                // The managed runner's own state, its Retry and Set up included: the same words as everywhere.
                ManagedRunnerBanner(display: managed.display, runnerID: managed.runnerID)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .padding(.top, 8)
                Button(WelcomeCopy.WELCOME_OWN_INSTEAD) { addingRunner = true }
                    .buttonStyle(.plain)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.accentColor)
                    .padding(.top, 8)
            }
        }
    }

    @ViewBuilder private var modelStep: some View {
        switch credential {
        case .signedIn:
            WelcomeDoneLine(title: WelcomeCopy.WELCOME_MODEL_DONE,
                            detail: WelcomeCopy.welcomeSignedIn(engine: engine.displayName, machine: machine))
        case .onKey(let label, let pool):
            WelcomeDoneLine(title: WelcomeCopy.WELCOME_MODEL_DONE,
                            detail: "\(label) · \(pool ? MachineSetupCopy.SETUP_ON_A_POOL : MachineSetupCopy.SETUP_ON_A_KEY)",
                            onChange: { draft.pickDraft(engine: engine.rawValue, provider: engine.rawValue) })
        case .signIn, .notInstalled:
            SetupStepRow(number: 2, done: false) {
                WelcomeStepHead(title: WelcomeCopy.WELCOME_MODEL, help: WelcomeCopy.WELCOME_MODEL_HELP)
                if let runner, online {
                    RunnerSignInView(runnerID: runner.id, engine: engine,
                                     onSignedIn: { Task { await app.agents?.refreshRunnerSnapshot() } },
                                     signInTitle: RunnerPageCopy.RUNNER_SIGN_IN,
                                     onUseApiKey: keyToUse.map { key in
                                         { draft.pickDraft(engine: key.engine, provider: key.provider) }
                                     })
                        .id(engine)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .padding(.top, 7)
                } else {
                    WelcomeLater(text: WelcomeCopy.WELCOME_AFTER_COMPUTER)
                }
            }
        }
    }

    private var foot: some View {
        let foot = Welcome.foot(startsNow: startsNow, up: up, signedIn: credential.done)
        return Text(foot.text)
            .font(.orbitLabel)
            .foregroundStyle(foot == .ready ? SetupInk.found : .secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
    }
}

// MARK: - an account with no machine (board 02, P3)

/// Where an account with no machine lands (`DefaultLanding.runners`): the welcome card when the account
/// is new, with no machine and no managed runner to set up, else what the page shows everybody. Decided
/// once, as the web's guide latches its first list: a machine registering but not yet online keeps the
/// card, which moves on to that machine's new session page as it comes online.
struct NoMachineWelcomeGate<Fallback: View>: View {
    @Environment(AppModel.self) private var app
    @ViewBuilder let fallback: () -> Fallback
    @State private var welcomes: Bool?

    var body: some View {
        Group {
            if welcomes == true {
                NoMachineWelcomePage()
            } else {
                fallback()
            }
        }
        // Asked only of an account with no machine: nobody else can be shown the card here.
        .task(id: noMachine) {
            if noMachine { await app.readNewAccount() }
        }
        .onChange(of: decision, initial: true) { _, decided in
            if welcomes == nil, let decided { welcomes = decided }
        }
    }

    /// The machine list has answered, and it is empty.
    private var noMachine: Bool {
        guard let runners = app.runners, runners.loadState.hasLoaded, !runners.loadState.lastLoadFailed
        else { return false }
        return runners.runners.isEmpty
    }

    /// Nil while it can't be told yet: the machines or the sessions not read.
    private var decision: Bool? {
        guard let runners = app.runners, runners.loadState.hasLoaded, !runners.loadState.lastLoadFailed
        else { return nil }
        guard noMachine else { return false }
        guard let new = app.newAccount else { return nil }
        return new && ManagedRunnerLogic.onboarding(app.managedRunner?.display, runnerCount: 0) == nil
    }
}

/// The card on a page of its own, centred in the room it has.
private struct NoMachineWelcomePage: View {
    var body: some View {
        ScrollView {
            NoMachineWelcomeCard()
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
                .padding(14)
        }
        .orbitRevealSurface()
    }
}

/// Step 1 is connecting a computer — the install command, as Add Runner gives it — and steps 2–3 open
/// after it. The machine list is read every 5 s, as the web's guide reads it, until one comes online.
private struct NoMachineWelcomeCard: View {
    @Environment(AppModel.self) private var app
    @State private var platform = RunnerPageFormat.Platform.macOS
    @State private var baseline: Set<String>?
    @State private var addingRunner = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WelcomeHead()
            Divider().padding(.top, 12)
            SetupStepRow(number: 1, done: false) {
                WelcomeStepHead(title: WelcomeCopy.WELCOME_COMPUTER, help: WelcomeCopy.WELCOME_COMPUTER_OWN)
                Picker(WelcomeCopy.WELCOME_COMPUTER, selection: $platform) {
                    ForEach(RunnerPageFormat.Platform.allCases) { platform in
                        Text(platform.label).tag(platform)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .padding(.top, 8)
                RunnerInstallCommandBox(platform: platform)
                    .padding(.top, 8)
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(WelcomeCopy.WELCOME_WAITING_CONNECT)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 8)
                // Add Runner has the other way in: a machine with no browser, by its code.
                Button(WelcomeCopy.WELCOME_HAVING_TROUBLE) { addingRunner = true }
                    .buttonStyle(.plain)
                    .font(.orbitLabel)
                    .foregroundStyle(Color.accentColor)
                    .padding(.top, 6)
            }
            Divider()
            SetupStepRow(number: 2, done: false) {
                WelcomeStepHead(title: WelcomeCopy.WELCOME_MODEL, help: WelcomeCopy.WELCOME_MODEL_HELP)
                WelcomeLater(text: WelcomeCopy.WELCOME_AFTER_STEP_ONE)
            }
            Divider()
            SetupStepRow(number: 3, done: false) {
                WelcomeStepHead(title: WelcomeCopy.WELCOME_FIRST)
                WelcomeLater(text: WelcomeCopy.WELCOME_AFTER_STEP_ONE)
            }
        }
        .setupCardSurface()
        .sheet(isPresented: $addingRunner) { AddRunnerSheet() }
        .task { await waitForAMachine() }
    }

    /// Until a machine that wasn't online comes online; then its new session page, where the card greets
    /// it again with steps 2 and 3 (web `RunnerRegisterGuide`'s welcome branch).
    private func waitForAMachine() async {
        guard let runners = app.runners else { return }
        while !Task.isCancelled {
            if let baseline {
                if let arrived = RunnerPageFormat.newlyOnline(runners.runners, baseline: baseline) {
                    app.openMachineDraft(arrived.id)
                    return
                }
            } else if runners.loadState.hasLoaded, !runners.loadState.lastLoadFailed {
                baseline = RunnerPageFormat.onlineIDs(runners.runners)
            }
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            await runners.load()
        }
    }
}
