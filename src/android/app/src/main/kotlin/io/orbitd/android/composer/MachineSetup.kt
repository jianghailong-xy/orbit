package io.orbitd.android.composer

import io.orbitd.android.management.RunnerPage
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What a runner reports about one path on its filesystem (`GET /runners/:id/dir-probe`, docs/first-workspace-contract.md §2).
 * [path] is the path the runner resolved (`~` expanded, trailing slash stripped).
 */
data class DirProbe(
    val path: String,
    val exists: Boolean,
    val isDir: Boolean,
    val isGit: Boolean,
    val isHome: Boolean,
    val branch: String? = null,
    val freeBytes: Long? = null,
    val error: String? = null,
) {
    companion object {
        fun fromJson(json: JsonObject): DirProbe = DirProbe(
            path = json.text("path").orEmpty(),
            exists = json.flag("exists") == true,
            isDir = json.flag("isDir") == true,
            isGit = json.flag("isGit") == true,
            isHome = json.flag("isHome") == true,
            branch = json.text("branch")?.takeIf { it.isNotEmpty() },
            freeBytes = (json["freeBytes"] as? JsonPrimitive)?.content?.toLongOrNull(),
            error = json.text("error")?.takeIf { it.isNotEmpty() },
        )
    }
}

/** What `GET /runners/:id/dir-probe` returns while or after the runner answers. */
data class DirProbeAnswer(
    val status: String,
    val path: String? = null,
    val result: DirProbe? = null,
) {
    companion object {
        fun fromJson(json: JsonObject): DirProbeAnswer = DirProbeAnswer(
            status = json.text("status") ?: "idle",
            path = json.text("path"),
            result = (json["result"] as? JsonObject)?.let(DirProbe::fromJson),
        )
    }
}

/**
 * The folder `POST /workspaces` makes a machine's workspace in (docs/first-workspace-contract.md §3).
 * Exactly one of the three is set. [workDir] is a folder the runner has confirmed, as it resolved it; [newFolder] is one path segment the
 * server joins to the runner's folder root; [github] is a clone of one of the person's repositories into its Repos Folder
 * (docs/github-workspace-design.md §5.3).
 */
data class NewWorkspaceRequest(
    val workDir: String? = null,
    val newFolder: String? = null,
    val github: GithubClone? = null,
) {
    /** `github`: the repository by GitHub's id, the branch when it isn't the default one, and the folder under the Repos Folder. */
    data class GithubClone(val repoId: Long, val ref: String? = null, val folder: String? = null)

    fun toJson(): JsonObject = buildJsonObject {
        workDir?.let { put("workDir", it) }
        newFolder?.let { put("newFolder", it) }
        github?.let { clone ->
            put("github", buildJsonObject {
                put("repoId", clone.repoId)
                clone.folder?.let { put("folder", it) }
                clone.ref?.let { put("ref", it) }
            })
        }
    }
}

/** A machine as a Set up row names it (rule 9). */
data class MachineToSetUp(val id: String, val name: String, val managed: Boolean = false)

/** A machine the drawer's New workspace + offers, with how many workspaces it has (iOS `NewWorkspaceMachine`). */
data class NewWorkspaceMachine(val id: String, val name: String, val online: Boolean, val workspaces: Int)

/**
 * How a checked path reads, and whether it may be used. Rule 4: what isn't there can't be picked; a folder that is not a git
 * repository can, and says what that costs; a repository names its branch.
 */
data class FolderVerdict(
    val tone: Tone,
    val text: String,
    /** The same, as the folder's line once it is picked: without the "Found". */
    val short: String,
    val usable: Boolean,
) {
    enum class Tone { OK, WARN, BAD }
}

/** The folder the card's name finds, which Create workspace makes the workspace in. */
sealed interface PickedFolder {
    val path: String

    data class Existing(override val path: String, val note: String) : PickedFolder
    data class New(val name: String, override val path: String) : PickedFolder
    /** A clone of one of the person's GitHub repositories into `<cloneRoot>/<name>` (cloneRootFor, docs/github-workspace-design.md §5.3). */
    data class Github(val pick: GithubPick) : PickedFolder {
        override val path: String get() = pick.path
    }

    /** What `POST /workspaces` is told. An existing folder is sent as the runner resolved it. */
    val newWorkspace: NewWorkspaceRequest
        get() = when (this) {
            is Existing -> NewWorkspaceRequest(workDir = path)
            is New -> NewWorkspaceRequest(newFolder = name)
            is Github -> NewWorkspaceRequest(github = NewWorkspaceRequest.GithubClone(pick.repoId, pick.ref, pick.name))
        }
}

/** The repository From GitHub picked, and the folder it is cloned into. [ref] null is the repository's default branch, which
 *  [defaultBranch] names. */
data class GithubPick(
    val repoId: Long,
    val repository: String,
    val isPrivate: Boolean,
    val defaultBranch: String,
    val ref: String?,
    val name: String,
    val path: String,
)

/** The second step's answer for the draft's engine and credential. */
sealed interface SetupCredential {
    val done: Boolean

    data object SignedIn : SetupCredential { override val done = true }
    /** A login that isn't signed in here: `RunnerSignInCard`. */
    data object SignIn : SetupCredential { override val done = false }
    data object NotInstalled : SetupCredential { override val done = false }
    /** A key or a pool: nothing to sign in on this machine. */
    data class OnKey(val label: String, val pool: Boolean) : SetupCredential { override val done = true }
}

data class EnginePick(val engine: String, val provider: String)

/**
 * A machine with no workspace: what its first one is made from (docs/first-workspace-contract.md and rules 1–12 of
 * docs/mocks/first-workspace-in-conversation/04-rules). Port of OrbitKit's `MachineSetup.swift` and web's `lib/machineSetup.ts`.
 * Pure: nothing here fetches or stores.
 */
object MachineSetup {
    const val DIR_PROBE_CAPABILITY = "dir-probe/v1"
    const val CREATE_WORKDIR_CAPABILITY = "create-workdir/v1"
    /** What a runner declares when it clones a GitHub repository on request (docs/github-workspace-design.md §6). */
    const val CLONE_WORKDIR_CAPABILITY = "clone-workdir/v1"
    /** A runner that clones into its home, the directory its reposRoot sits in, rather than into reposRoot. */
    const val CLONE_WORKDIR_HOME_CAPABILITY = "clone-workdir/v2"

    /** A runner that makes a new folder in its home, the directory its reposRoot (`<home>/orbit-repos`) sits in. */
    const val CREATE_WORKDIR_HOME_CAPABILITY = "create-workdir/v2"

    /** Whether a machine can be asked about a path at all: the capability it declares (§2). */
    fun answersDirProbe(runner: JsonObject): Boolean =
        DIR_PROBE_CAPABILITY in runner.strings("capabilities")

    /** Whether it can make a new folder: the capability, and the Repos Folder it goes in (§3.1). */
    fun makesNewFolders(runner: JsonObject): Boolean =
        CREATE_WORKDIR_CAPABILITY in runner.strings("capabilities") && !runner.text("reposRoot")?.trim().isNullOrEmpty()

    /**
     * Whether a machine clones a GitHub repository on request: it declares clone-workdir/v1 and has reported the Repos Folder the clone
     * goes in. POST /sessions refuses either missing.
     */
    fun clonesRepositories(runner: JsonObject): Boolean = cloneRootOf(runner) != null

    /**
     * Where a GitHub workspace's clone goes, as the server puts it: port of @orbit/shared `cloneRootFor`, held to
     * src/shared/src/new-folder-root.fixture.json `clones`. Home on a runner that declares clone-workdir/v2, reposRoot on an older one,
     * null on one that does not clone or has not reported its reposRoot.
     */
    fun cloneRootFor(reposRoot: String?, capabilities: List<String>?): String? {
        val root = reposRoot?.trim().orEmpty()
        if (root.isEmpty() || capabilities?.contains(CLONE_WORKDIR_CAPABILITY) != true) return null
        return if (CLONE_WORKDIR_HOME_CAPABILITY in capabilities) homeOfReposRoot(root) else trimReposRoot(root)
    }

    fun cloneRootOf(runner: JsonObject): String? = cloneRootFor(runner.text("reposRoot"), runner.strings("capabilities"))

    private val homePrefix = Regex("""^(?:/Users/[^/]+|/home/[^/]+|/root)(?=/|$)""")

    /** A path as the board writes it: the home folder as `~` (`/Users/austin/orbit-repos/x` → `~/orbit-repos/x`). */
    fun homeShortPath(path: String): String = homePrefix.replaceFirst(path, "~")

    /** The folder a repository is cloned into by default, as the server derives it: its name, when that is a folder name. */
    fun repositoryFolder(fullName: String): String {
        val name = fullName.split('/').last()
        return if (isValidNewFolder(name)) name else ""
    }

    /** The branch a clone is asked for: what was typed under Other branch, unless it is empty or the default. */
    fun cloneRef(typed: String?, defaultBranch: String): String? {
        val ref = typed?.trim().orEmpty()
        return if (ref.isEmpty() || ref == defaultBranch) null else ref
    }

    /** How many repositories the picker shows before anything is typed (board 01, note 4). */
    const val FIRST_REPOSITORIES = 8

    /** What From GitHub would pick, on the machine's answer about the folder: only a folder that isn't there yet can be cloned into. */
    fun githubPick(repository: GithubRepository, name: String, ref: String?, reposRoot: String, probe: DirProbe?): PickedFolder? {
        if (!isValidNewFolder(name) || probe == null || !probe.error.isNullOrEmpty() || probe.exists) return null
        return PickedFolder.Github(GithubPick(repository.id, repository.fullName, repository.private, repository.defaultBranch, ref, name,
            newFolderPath(reposRoot, name)))
    }

    /**
     * The directory a runner's new folders go in: its home, the parent of its reposRoot, when it declares create-workdir/v2, else
     * reposRoot itself. The separator is the one the root is written with. Port of @orbit/shared `newFolderRoot`.
     */
    fun newFolderRoot(reposRoot: String, capabilities: List<String>?): String =
        if (capabilities?.contains(CREATE_WORKDIR_HOME_CAPABILITY) == true) homeOfReposRoot(reposRoot) else trimReposRoot(reposRoot)

    private fun trimReposRoot(reposRoot: String): String {
        var root = reposRoot.trim()
        while (root.length > 1 && (root.endsWith("/") || root.endsWith("\\"))) root = root.dropLast(1)
        return root
    }

    /** The directory a reported reposRoot sits in: the machine's home (`<home>/orbit-repos`). */
    private fun homeOfReposRoot(reposRoot: String): String {
        val root = trimReposRoot(reposRoot)
        val cut = maxOf(root.lastIndexOf('/'), root.lastIndexOf('\\'))
        if (cut < 0) return root
        // `/orbit-repos` sits in `/`, and `C:\orbit-repos` in `C:\`.
        return if (cut == 0 || root[cut - 1] == ':') root.take(cut + 1) else root.take(cut)
    }

    /**
     * Where a new folder named on this runner goes, as the server makes it: port of @orbit/shared `newFolderRootFor`, held to
     * src/shared/src/new-folder-root.fixture.json. A managed runner that is not up, or has not reported yet, takes its image's home,
     * whatever an earlier process declared; a runner that makes new folders and has reported its Repos Folder takes [newFolderRoot]; any
     * other makes none (null).
     */
    fun newFolderRootFor(managed: Boolean, up: Boolean, reposRoot: String?, capabilities: List<String>?): String? {
        if (managed && (!up || capabilities.isNullOrEmpty())) return ManagedRunner.HOME
        val root = reposRoot?.trim().orEmpty()
        if (root.isEmpty() || capabilities?.contains(CREATE_WORKDIR_CAPABILITY) != true) return null
        return newFolderRoot(root, capabilities)
    }

    /** The setup card's root: [newFolderRootFor], the account's managed runner read as managed while it is set up or asleep. Only a
     *  usable card shows or sends it, and a managed runner always has one, so "" is never drawn. */
    fun setupFolderRoot(runner: JsonObject, managedSetup: Boolean): String =
        newFolderRootFor(
            managed = managedSetup || RunnerPage.isManaged(runner),
            up = (runner["online"] as? JsonPrimitive)?.booleanOrNull == true,
            reposRoot = runner.text("reposRoot"),
            capabilities = runner.strings("capabilities"),
        ).orEmpty()

    /**
     * Whether a machine too old to answer gets there by itself: not one that reports its updater off, or unable to write where it is
     * installed. One too old to report anything still updates itself.
     */
    fun updatesItself(runner: JsonObject): Boolean {
        val state = (runner["selfUpdate"] as? JsonObject)?.text("state")
        return state != "disabledByEnv" && state != "dirNotWritable"
    }

    /**
     * A machine approved a moment ago that has not connected yet: never heard from, so it reads offline and has declared nothing
     * (contract §2). Not one too old to check folders, nor one that went away: it is waited for.
     */
    fun isConnecting(runner: JsonObject, nowMs: Long = System.currentTimeMillis()): Boolean =
        RunnerPage.isOffline(runner, nowMs) && runner.text("lastHeartbeatAt").isNullOrEmpty()

    /**
     * How often a machine's new session page reads the machine again while its card is up, as iOS and the web do: a sign-in
     * landing or the machine going away moves the card by itself. One still connecting is read more often, so the folder step
     * opens within seconds of its first heartbeat.
     */
    const val POLL_MS = 5_000L
    const val CONNECTING_POLL_MS = 2_000L

    fun refreshMs(runner: JsonObject?, nowMs: Long = System.currentTimeMillis()): Long =
        if (runner != null && isConnecting(runner, nowMs)) CONNECTING_POLL_MS else POLL_MS

    /** `newFolder`'s rule on the server (§3.1): one path segment, nothing a shell or a path could read anything into. */
    fun isValidNewFolder(name: String): Boolean {
        if (name.length !in 1..64 || name == "." || name == "..") return false
        return name.all { ch -> ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '.' || ch == '_' || ch == '-' }
    }

    /** Where a new folder lands: `<root>/<name>`, as the server joins it. */
    fun newFolderPath(root: String, name: String): String {
        val separator = if ('\\' in root && '/' !in root) "\\" else "/"
        var dir = root
        while (dir.endsWith("/") || dir.endsWith("\\")) dir = dir.dropLast(1)
        return "$dir$separator$name"
    }

    fun folderVerdict(probe: DirProbe, machine: String): FolderVerdict {
        fun refused(text: String) = FolderVerdict(FolderVerdict.Tone.BAD, text, text, usable = false)
        if (!probe.error.isNullOrEmpty()) return refused(MachineSetupCopy.setupCouldNotCheck(machine, probe.error))
        if (!probe.exists) return refused(MachineSetupCopy.setupNoSuchDirectory(machine))
        if (!probe.isDir) return refused(MachineSetupCopy.setupNotADirectory(machine))
        val short = if (probe.isGit) MachineSetupCopy.setupGit(probe.branch) else MachineSetupCopy.SETUP_NOT_GIT
        return FolderVerdict(
            tone = if (probe.isGit) FolderVerdict.Tone.OK else FolderVerdict.Tone.WARN,
            text = MachineSetupCopy.SETUP_FOUND_PREFIX + short,
            short = short,
            usable = true,
        )
    }

    /**
     * What the folder step's name finds at `<root>/<name>`, asked before anything is sent. Nothing there is a new folder, made as the
     * session starts; a directory is used as it stands, read as any folder is; a file can't become one.
     */
    fun newFolderVerdict(probe: DirProbe, machine: String): FolderVerdict {
        fun refused(text: String) = FolderVerdict(FolderVerdict.Tone.BAD, text, text, usable = false)
        if (!probe.error.isNullOrEmpty()) return refused(MachineSetupCopy.setupCouldNotCheck(machine, probe.error))
        if (!probe.exists) {
            return FolderVerdict(
                FolderVerdict.Tone.OK,
                MachineSetupCopy.SETUP_NEW_FOLDER_META,
                MachineSetupCopy.SETUP_NEW_FOLDER_DONE,
                usable = true,
            )
        }
        if (!probe.isDir) return refused(MachineSetupCopy.setupNewFolderIsFile(machine))
        return folderVerdict(probe, machine)
    }

    /** What Create workspace makes the workspace in on that answer: a new folder while nothing is there, else the directory that is, sent by its path. */
    fun newFolderPick(probe: DirProbe, name: String, root: String, machine: String): PickedFolder? {
        val verdict = newFolderVerdict(probe, machine)
        if (!verdict.usable) return null
        return if (probe.exists) PickedFolder.Existing(probe.path, verdict.short)
        else PickedFolder.New(name, newFolderPath(root, name))
    }

    /**
     * A folder field's text that names a whole path (`/srv/app`, `~/code/app`) rather than one folder in the machine's home
     * (docs/mocks/new-workspace-form, decision 2 A; web `isFolderPath`): the machine is asked about that path itself.
     */
    fun isFolderPath(typed: String): Boolean = typed.startsWith("/") || typed.startsWith("~")

    /** A path's last segment, what the workspace's name follows for a full path (web `folderName`). */
    fun folderName(path: String): String {
        val trimmed = path.trimEnd('/', '\\')
        return trimmed.split('/', '\\').last().ifEmpty { path }
    }

    /**
     * What Create workspace picks on a full path's answer: the directory as it stands. Nothing is made for a path outside the machine's
     * home, so one that isn't there is refused as any folder is (web `folderPathPick`).
     */
    fun folderPathPick(probe: DirProbe, machine: String): PickedFolder? {
        val verdict = folderVerdict(probe, machine)
        return if (verdict.usable) PickedFolder.Existing(probe.path, verdict.short) else null
    }

    /**
     * The path the card's folder field asks the machine about: a full path as typed, a name where it would go, and nothing for anything
     * else. Null too where nothing can be asked (a managed runner not up, a machine offline or too old to check folders).
     */
    fun folderQuestion(folder: String, root: String, canAsk: Boolean): String? {
        if (!canAsk) return null
        if (isFolderPath(folder)) return folder
        return if (isValidNewFolder(folder)) newFolderPath(root, folder) else null
    }

    /**
     * What the typed folder would make the workspace in, on the machine's answer about it ([found]). A managed runner that isn't up
     * ([managedSetup] non-null) takes a name unchecked, but a full path only once it has been checked.
     */
    fun typedPick(folder: String, found: DirProbe?, root: String, machine: String, managedSetup: String?): PickedFolder? {
        val fullPath = isFolderPath(folder)
        if (managedSetup != null) return if (!fullPath && isValidNewFolder(folder)) PickedFolder.New(folder, newFolderPath(root, folder)) else null
        if (found == null) return null
        if (fullPath) return folderPathPick(found, machine)
        return if (isValidNewFolder(folder)) newFolderPick(found, folder, root, machine) else null
    }

    /** The folder the workspace's Name follows: the typed name, or a full path's last segment. */
    fun followedName(folder: String): String = if (isFolderPath(folder)) folderName(folder) else folder

    /** The line under the card's folder field (iOS `MachineSetup.folderLine`). */
    sealed interface FolderLine {
        data class Meta(val text: String) : FolderLine
        data class Verdict(val text: String, val tone: FolderVerdict.Tone) : FolderLine
        data object NoAnswer : FolderLine
        data object Checking : FolderLine
    }

    /**
     * What the folder field's line says. [folder] is the field's text trimmed, [found] the machine's answer about the path
     * [folderQuestion] asked (null while there is none for it), and [unanswered] that the machine gave no answer to that question.
     * [pathHintRoot] is set where the card's hint says a full path is taken too (New workspace on a machine that has one): the directory a
     * name goes in.
     */
    fun folderLine(
        folder: String,
        createError: String?,
        found: DirProbe?,
        unanswered: Boolean,
        machine: String,
        managedSetup: String? = null,
        pathHintRoot: String? = null,
    ): FolderLine {
        // Why the last Create workspace was refused stands in for the rest until the next try.
        if (createError != null) return FolderLine.Verdict(MachineSetupCopy.setupCreateFailed(createError), FolderVerdict.Tone.BAD)
        if (folder.isEmpty()) {
            return FolderLine.Meta(pathHintRoot?.let { MachineSetupCopy.setupFolderOrPathHint(it.trimEnd('/', '\\')) } ?: MachineSetupCopy.SETUP_FOLDER_HINT)
        }
        val fullPath = isFolderPath(folder)
        if (!fullPath && !isValidNewFolder(folder)) return FolderLine.Verdict(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, FolderVerdict.Tone.BAD)
        if (managedSetup != null) {
            return FolderLine.Meta(if (fullPath) MachineSetupCopy.setupPathUnchecked(machine) else ManagedRunner.Setup.FOLDER_UNCHECKED.getValue(managedSetup))
        }
        if (found != null) {
            // A full path must already be there: it says what it found, or that nothing is.
            if (fullPath) return folderVerdict(found, machine).let { FolderLine.Verdict(it.text, it.tone) }
            val verdict = newFolderVerdict(found, machine)
            // Nothing there yet reads as a note; anything there, or a check that failed, says what it is.
            return if (found.exists || !verdict.usable) FolderLine.Verdict(verdict.text, verdict.tone)
            else FolderLine.Meta(MachineSetupCopy.SETUP_NEW_FOLDER_WITH_WORKSPACE)
        }
        return if (unanswered) FolderLine.NoAnswer else FolderLine.Checking
    }

    /**
     * The machines the drawer's New workspace + offers (docs/mocks/new-workspace-form/02-apple-entry, owner A 2026-11-20; iOS
     * `AgentListLogic.newWorkspaceMachines`): every machine of the account, whatever it already holds, in the runner list's order with
     * the managed runner first.
     */
    fun newWorkspaceMachines(
        runners: List<JsonObject>?,
        workspaces: List<JsonObject>,
        nowMs: Long = System.currentTimeMillis(),
        managedStatus: ManagedRunner.Status? = null,
    ): List<NewWorkspaceMachine> {
        if (runners == null) return emptyList()
        val managedId = managedStatus?.runnerId ?: ManagedRunnerIdentity.runnerId
        return RunnerPage.managedRunnerFirst(runners, managedId).mapNotNull { runner ->
            val id = runner.text("id") ?: return@mapNotNull null
            NewWorkspaceMachine(
                id = id,
                name = RunnerPage.displayName(runner, managedId),
                online = !RunnerPage.isOffline(runner, nowMs),
                workspaces = workspaces.count {
                    (it["deletedAt"] == null || it["deletedAt"] is JsonNull) && ObjectId.same(it.text("runnerId"), id)
                },
            )
        }
    }

    /**
     * The workspace's name on the card: the folder's until it is edited ([edited] non-null), and from then on what was typed, empty
     * included: an emptied name is never filled in again.
     */
    fun shownName(edited: String?, folder: String): String = edited ?: folder

    /** The line under the Name field, and whether it is a refusal. */
    fun nameLine(edited: String?): Pair<String, Boolean> = when {
        edited != null && edited.trim().isEmpty() -> MachineSetupCopy.SETUP_NAME_EMPTY to true
        edited != null -> MachineSetupCopy.SETUP_NAME_EDITED to false
        else -> MachineSetupCopy.SETUP_NAME_HINT to false
    }

    /** Whether Create workspace can be pressed: a folder found usable, a name, a machine that can check and make folders, nothing out. */
    fun canCreate(pick: PickedFolder?, name: String, usable: Boolean, creating: Boolean): Boolean =
        pick != null && name.trim().isNotEmpty() && usable && !creating

    /** `POST /workspaces`: the workspace alone, in [folder] on the runner, under [name] (trimmed). */
    fun createWorkspaceBody(name: String, runnerId: String, folder: PickedFolder): JsonObject = buildJsonObject {
        put("name", name.trim())
        put("runnerId", runnerId)
        folder.newWorkspace.toJson().forEach { (key, value) -> put(key, value) }
    }

    /** The login CLIs installed here, in the app's order. */
    fun installedLogins(runner: JsonObject): List<String> {
        val engines = runner.objects("engines")
        return ProviderEngines.LOGIN_ENGINES.filter { engine ->
            engines.firstOrNull { it.text("engine") == engine }?.flag("installed") == true
        }
    }

    /**
     * Which engine a machine's first draft starts on, with nothing picked: one that can run now, else one it has, else Claude Code,
     * which is what a machine that has reported nothing yet will have.
     */
    fun firstEngineOn(runner: JsonObject): String {
        val engines = runner.objects("engines")
        val installed = installedLogins(runner)
        val running = installed.firstOrNull { engine ->
            engines.firstOrNull { it.text("engine") == engine }?.text("auth") == "yes"
        }
        return running ?: installed.firstOrNull() ?: ProviderEngines.CLAUDE
    }

    /**
     * Whether the runner's own probe says [engine] is signed in. "unknown" is not a yes. Antigravity's sign-in is its Google
     * account: a yes off a machine's Gemini key is a key, not a sign-in.
     */
    fun signedIn(engine: String, runner: JsonObject): Boolean {
        val health = runner.objects("engines").firstOrNull { it.text("engine") == engine } ?: return false
        val authSource = health.text("authSource") ?: (runner["antigravity"] as? JsonObject)?.text("authSource")
        return health.text("auth") == "yes" && (engine != ProviderEngines.ANTIGRAVITY || authSource == "google")
    }

    /**
     * Rule 5's step for the draft's engine and credential. Nothing reported is not "nothing installed": a machine that has only just
     * come up says soon.
     */
    fun credential(runner: JsonObject, engine: String, provider: ProviderOption?): SetupCredential {
        if (provider != null && provider.kind in setOf(CredentialKind.KEY, CredentialKind.POOL, CredentialKind.OPENCODE)) {
            return SetupCredential.OnKey(provider.label, pool = provider.kind == CredentialKind.POOL)
        }
        if (signedIn(engine, runner)) return SetupCredential.SignedIn
        val engines = runner["engines"] as? kotlinx.serialization.json.JsonArray
        if (engines != null) {
            val health = runner.objects("engines").firstOrNull { it.text("engine") == engine }
            if (health?.flag("installed") != true) return SetupCredential.NotInstalled
        }
        return SetupCredential.SignIn
    }

    /**
     * Rule 5's Use an API Key: the first key or pool that can run here, the draft's own engine's first. Null with none, and then the
     * card doesn't offer it: a key is connected on the web.
     */
    fun firstKey(engines: List<EngineOption>, preferring: String): EnginePick? {
        val ordered = engines.filter { it.engine == preferring } + engines.filter { it.engine != preferring }
        for (row in ordered) {
            val key = row.providers.firstOrNull {
                (it.kind == CredentialKind.KEY || it.kind == CredentialKind.POOL) && it.unavailable == null
            }
            if (key != null) return EnginePick(engine = row.engine, provider = key.id)
        }
        return null
    }

    /**
     * Rule 9: the machines that get a Set up row in the drawer, managed first and the rest in the runner list's order. Online, with no
     * workspace of this account on them: an offline one is already what Machines & models says needs you.
     */
    fun machinesToSetUp(
        runners: List<JsonObject>?,
        workspaces: List<JsonObject>,
        nowMs: Long = System.currentTimeMillis(),
        managedStatus: ManagedRunner.Status? = null,
    ): List<MachineToSetUp> {
        if (runners == null) return emptyList()
        val managedId = managedStatus?.runnerId ?: ManagedRunnerIdentity.runnerId
        return RunnerPage.managedRunnerFirst(runners, managedId).mapNotNull { runner ->
            val id = runner.text("id") ?: return@mapNotNull null
            if (RunnerPage.isOffline(runner, nowMs) && ManagedRunner.managedSetupState(id, managedStatus) == null) return@mapNotNull null
            if (workspaces.any {
                    (it["deletedAt"] == null || it["deletedAt"] is JsonNull) && ObjectId.same(it.text("runnerId"), id)
                }
            ) return@mapNotNull null
            MachineToSetUp(id = id, name = RunnerPage.displayName(runner, managedId), managed = RunnerPage.isManaged(runner, managedId))
        }
    }

    /**
     * Rule 11: the first online machine in the runner list's order, for landing or New session when the account has no workspaces.
     */
    fun firstOnlineRunnerId(runners: List<JsonObject>, nowMs: Long = System.currentTimeMillis(), managedStatus: ManagedRunner.Status? = null): String? =
        runners.firstOrNull { !RunnerPage.isOffline(it, nowMs) || ManagedRunner.managedSetupState(it.text("id"), managedStatus) != null }?.text("id")

    /**
     * What a machine's first draft stands on (`Agent.machineDraft` in OrbitKit). The composer's engine, model and account pickers
     * read a workspace, and a machine with none has a name and a runner to give them, and an empty `id`.
     */
    fun machineDraft(runnerId: String, name: String, engine: String): JsonObject = buildJsonObject {
        put("id", "")
        put("name", name)
        put("runnerId", runnerId)
        put("lastProvider", engine)
        put("lastEngine", engine)
    }

    fun standsInForMachine(workspace: JsonObject): Boolean = workspace.text("id").isNullOrEmpty()
}

/**
 * The first line of a conversation that made its workspace (rule 8): what was made, where, and the two ways to change it.
 */
data class CreatedWorkspaceLine(
    val workspaceId: String,
    val name: String,
    val machine: String,
    val path: String?,
    val live: Boolean,
    /** A workspace cloned from GitHub (docs/github-workspace-design.md §8): its `owner/name`, and where its clone stood when the detail
     *  was read ([cloneError] is why it failed). All null for one that is not. */
    val repository: String? = null,
    val cloneState: String? = null,
    val cloneError: String? = null,
) {
    companion object {
        fun fromSession(
            detail: JsonObject,
            runners: List<JsonObject>,
            workspaces: List<JsonObject> = emptyList(),
        ): CreatedWorkspaceLine? {
            if (detail.flag("createdWorkspace") != true) return null
            val agent = detail["agent"] as? JsonObject
            val workspaceId = agent?.text("id") ?: detail.text("agentId") ?: detail.text("workspaceId") ?: return null
            val liveWorkspace = workspaces.firstOrNull { ObjectId.same(it.text("id"), workspaceId) }
            val name = liveWorkspace?.text("name")?.takeIf { it.isNotEmpty() }
                ?: agent?.text("name")?.takeIf { it.isNotEmpty() }
                ?: detail.text("agentName")?.takeIf { it.isNotEmpty() }
                ?: return null
            val runnerId = detail.text("assignedRunnerId")
                ?: liveWorkspace?.text("runnerId")
                ?: agent?.text("runnerId")
                ?: (detail["workspace"] as? JsonObject)?.text("runnerId")
            val runner = runnerId?.let { id -> runners.firstOrNull { ObjectId.same(it.text("id"), id) } }
            val machine = runner?.let(RunnerPage::displayName)
                ?: detail.text("runnerName")?.takeIf { it.isNotEmpty() }
                ?: runnerId
                ?: return null
            val path = liveWorkspace?.text("workDir")?.takeIf { it.isNotEmpty() }
                ?: agent?.text("workDir")?.takeIf { it.isNotEmpty() }
            val deleted = agent != null && agent["deletedAt"] != null && agent["deletedAt"] !is JsonNull
            // The clone's fields ride on the detail's workspace; the web reads them as `workspace`, OrbitKit as `agent`.
            val made = listOfNotNull(agent, detail["workspace"] as? JsonObject)
            fun cloneField(key: String) = made.firstNotNullOfOrNull { it.text(key)?.takeIf(String::isNotEmpty) }
            return CreatedWorkspaceLine(
                workspaceId = workspaceId,
                name = name,
                machine = machine,
                path = path,
                live = !deleted,
                repository = WorkspaceClone.repositoryOf(cloneField("repoUrl")),
                cloneState = cloneField("cloneState"),
                cloneError = cloneField("cloneError"),
            )
        }
    }
}

/**
 * How the directory probe relay is read (contract §2): ask, then read until the runner has answered or the time is up.
 */
object DirProbeRelay {
    const val POLL_MS = 1_500L
    const val WAIT_MS = 75_000L

    sealed interface Outcome {
        data class Answered(val probe: DirProbe) : Outcome
        data object Replaced : Outcome
        data object Unanswered : Outcome
    }

    suspend fun probe(
        ask: (suspend () -> Unit)?,
        read: suspend () -> DirProbeAnswer,
        sleep: suspend (Long) -> Unit,
        nowMs: () -> Long = System::currentTimeMillis,
    ): Outcome {
        ask?.invoke()
        val deadline = nowMs() + WAIT_MS
        while (true) {
            val answer = read()
            if (answer.status == "done" && answer.result != null) return Outcome.Answered(answer.result)
            if (answer.status != "pending") return Outcome.Replaced
            if (nowMs() >= deadline) return Outcome.Unanswered
            sleep(POLL_MS)
        }
    }
}
