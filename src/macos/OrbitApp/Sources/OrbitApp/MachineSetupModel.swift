import Foundation
import Observation
import OrbitKit

/// One machine's new session page: its draft and what the card has been told, kept by `AppModel` so the
/// page can be left and come back to on the way (a sign-in goes through a browser, a key is picked in the
/// composer's menu) with neither answer given twice. For this run of the app only, as the web keeps them
/// for its tab: a message waiting in two places would be sent by both, and each send makes a workspace.
@MainActor
@Observable
final class MachineSetupModel {
    let runnerID: String
    /// The composer's draft. Its create names the machine and a folder (`ConsoleModel.draftRequest`).
    let draft: ConsoleModel
    private(set) var state = MachineSetupState()
    /// The machine as the page last read it, and whether the workspace list says it has none.
    private(set) var runner: Runner
    private(set) var bare = true
    /// Every runner of the account, which decides whether Cursor CLI is drawn at all.
    private(set) var fleet: [Runner] = []

    init(runner: Runner, draft: ConsoleModel) {
        self.runnerID = runner.id
        self.runner = runner
        self.draft = draft
        draft.machineSetup = self
    }

    func adopt(runner: Runner, bare: Bool, fleet: [Runner]) {
        self.runner = runner
        self.bare = bare
        self.fleet = fleet
        draft.adoptMachine(runner)
    }

    var online: Bool { AgentListLogic.isOnline(runner) }

    /// A first send is out: its answer settles what this page does next.
    var busy: Bool { state.sendingHeld || draft.sending }

    // MARK: the two steps

    /// The engines the draft can land on here, and the credentials of each: the same list the composer's
    /// Provider menu reads.
    private var engines: [EngineChoice] {
        SessionProviderChoices.engines(sources: draft.choiceSources,
                                       preferred: [EnginePick(engine: draft.engine, provider: draft.provider)])
    }

    /// The second step's answer. Rule 5: it follows the composer, so a key picked in the Provider menu
    /// answers it as well as a sign-in does.
    var credential: SetupCredential {
        let provider = SessionProviderChoices.currentEngine(engine: draft.engine, provider: draft.provider,
                                                            engines: engines, sources: draft.choiceSources).provider
        return MachineSetup.credential(runner: runner, engine: draft.engine, provider: provider)
    }

    /// Both steps are done and the machine is here: the next send makes the workspace.
    var ready: Bool {
        MachineSetup.isReady(bare: bare, folder: state.folder, online: online, credential: credential)
    }

    /// Rule 5's Use X instead.
    var otherEngines: [LoginEngine] { MachineSetup.otherEngines(on: runner, than: draft.engine, fleet: fleet) }

    /// Rule 5's Use an API Key.
    var keyToUse: EnginePick? { MachineSetup.firstKey(in: engines, preferring: draft.engine) }

    func pick(_ folder: PickedFolder?) {
        state.pick(folder)
    }

    func useEngine(_ engine: LoginEngine) {
        draft.pickDraft(engine: engine.rawValue, provider: engine.rawValue)
    }

    func useKey() {
        guard let keyToUse else { return }
        draft.pickDraft(engine: keyToUse.engine, provider: keyToUse.provider)
    }

    // MARK: the message

    /// The composer's send on this page.
    func composerSend() -> MachineSend {
        state.send(bare: bare, ready: ready)
    }

    func hold(_ message: HeldMessage) {
        state.hold(message)
    }

    /// Both steps done with a message waiting: it goes, with nobody pressing anything (rule 6).
    func sendHeldIfReady() {
        guard let (message, folder) = state.takeHeldToSend(ready: ready, busy: draft.sending) else { return }
        Task {
            // Sent by itself, so a refusal stays where it waited and says so there: it is in no composer
            // to keep, and a toast would be gone by the time anyone looks.
            if let why = await draft.sendHeld(message, folder: folder) { state.failHeld(why) }
        }
    }

    func retryHeld() {
        state.retryHeld()
    }

    /// Its words and files go back to the composer.
    func withdraw() {
        if let held = state.withdraw() { draft.restoreHeld(held) }
    }

    /// The machine got a workspace some other way (another device, the web's form): what was waiting,
    /// for the draft that takes over. Nil while a send of it is out, whose answer settles it.
    func handOff() -> HeldMessage? {
        state.withdraw()
    }
}
