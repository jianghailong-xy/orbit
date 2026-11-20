import Foundation
import Observation
import OrbitKit

/// One machine's new session page: what its card has been given, kept by `AppModel` so the page can be
/// left and come back to with nothing typed twice. For this run of the app only.
@MainActor
@Observable
final class MachineSetupModel {
    let runnerID: String
    /// The machine as the page last read it, and whether the workspace list says it has none.
    private(set) var runner: Runner
    private(set) var bare = true
    /// The folder field's text, as typed.
    var typed = ""
    /// The workspace's name: the folder's until it is edited (`WorkspaceNameField`).
    var name = WorkspaceNameField()
    /// The folder field is From GitHub's picker (board 04 A), kept with the page: a card come back from GitHub's
    /// sign-in in the browser is still on it (board 01, note 2).
    var githubOpen = false
    /// What the picker would pick, as it last said: the workspace's name follows its folder until edited.
    var repository: PickedFolder?
    /// Create workspace is out: the fields and the button wait.
    private(set) var creating = false
    /// Why the last Create workspace was refused, said on the card until the next try.
    private(set) var createError: String?

    init(runner: Runner) {
        self.runnerID = runner.id
        self.runner = runner
    }

    func adopt(runner: Runner, bare: Bool) {
        self.runner = runner
        self.bare = bare
    }

    var online: Bool { AgentListLogic.isOnline(runner) }

    /// A create is out: its answer settles what this page does next.
    var busy: Bool { creating }

    /// The folder field's text trimmed: the name asked about and the one the workspace's name follows.
    var folder: String { typed.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The folder the workspace's name follows: the typed one (a full path's last segment), or on From GitHub the
    /// picked repository's.
    var followed: String {
        guard githubOpen else { return MachineSetup.followedName(folder: folder) }
        if case .github(let pick)? = repository { return pick.name }
        return ""
    }

    /// Create workspace: the workspace alone, in this folder and under this name. On success the app moves on
    /// to its new session page; a refusal stays on the card, with what was typed.
    func create(_ pick: PickedFolder, in app: AppModel) async {
        guard !creating else { return }
        creating = true
        createError = nil
        let why = await app.createMachineWorkspace(runnerID: runnerID, folder: pick,
                                                   name: name.name(folder: followed))
        creating = false
        createError = why
    }
}
