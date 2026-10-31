package io.orbitd.android.composer

import io.orbitd.android.management.RunnerPage
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
 * Sent on `POST /sessions` when the session makes its machine's first workspace (docs/first-workspace-contract.md §3).
 * Exactly one of [workDir] or [newFolder] is set.
 */
data class NewWorkspaceRequest(
    val workDir: String? = null,
    val newFolder: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        workDir?.let { put("workDir", it) }
        newFolder?.let { put("newFolder", it) }
    }
}

/** A machine as a Set up row names it (rule 9). */
data class MachineToSetUp(val id: String, val name: String)

enum class FolderChoice { SUGGESTED, NEW, OTHER }

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

/** The folder step's answer, once the person has pressed Use This Folder. */
sealed interface PickedFolder {
    val path: String

    data class Existing(override val path: String, val note: String) : PickedFolder
    data class New(val name: String, override val path: String) : PickedFolder

    /** What `POST /sessions` is told. An existing folder is sent as the runner resolved it. */
    val newWorkspace: NewWorkspaceRequest
        get() = when (this) {
            is Existing -> NewWorkspaceRequest(workDir = path)
            is New -> NewWorkspaceRequest(newFolder = name)
        }

    /** The workspace it makes, as the server names it (§3.2). */
    val workspaceName: String
        get() = when (this) {
            is Existing -> MachineSetup.folderName(path)
            is New -> name
        }
}

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

    /**
     * Whether the directory `orbit register` ran in is worth asking about: the two answers a path can give on its face are left
     * unasked. Null when there is nothing to ask.
     */
    fun registerDirToProbe(registerDir: String?): String? {
        var dir = registerDir?.trim().orEmpty()
        while (dir.length > 1 && dir.endsWith("/")) dir = dir.dropLast(1)
        return if (dir.isEmpty() || dir == "~" || dir == "/") null else dir
    }

    /**
     * Rule 2: a checked register directory is offered only when it is a folder that exists and is neither the home directory nor the
     * root. The installer runs where the terminal stands, which is usually home, and all of home is no default.
     */
    fun isOfferedFolder(probe: DirProbe?): Boolean =
        probe != null && probe.error.isNullOrEmpty() && probe.exists && probe.isDir && !probe.isHome && probe.path != "/"

    /**
     * Rule 2 again: the register directory leads when it is a git repository; otherwise a new folder. The rest is what a machine
     * that can't make one leaves.
     */
    fun defaultFolderChoice(suggested: DirProbe?, offersNewFolder: Boolean): FolderChoice {
        if (suggested?.isGit == true) return FolderChoice.SUGGESTED
        if (offersNewFolder) return FolderChoice.NEW
        return if (suggested != null) FolderChoice.SUGGESTED else FolderChoice.OTHER
    }

    /** Whether a machine can be asked about a path at all: the capability it declares (§2). */
    fun answersDirProbe(runner: JsonObject): Boolean =
        DIR_PROBE_CAPABILITY in runner.strings("capabilities")

    /** Whether it can make a new folder: the capability, and the Repos Folder it goes in (§3.1). */
    fun makesNewFolders(runner: JsonObject): Boolean =
        CREATE_WORKDIR_CAPABILITY in runner.strings("capabilities") && !runner.text("reposRoot")?.trim().isNullOrEmpty()

    /**
     * Whether a machine too old to answer gets there by itself: not one that reports its updater off, or unable to write where it is
     * installed. One too old to report anything still updates itself.
     */
    fun updatesItself(runner: JsonObject): Boolean {
        val state = (runner["selfUpdate"] as? JsonObject)?.text("state")
        return state != "disabledByEnv" && state != "dirNotWritable"
    }

    /** `newFolder`'s rule on the server (§3.1): one path segment, nothing a shell or a path could read anything into. */
    fun isValidNewFolder(name: String): Boolean {
        if (name.length !in 1..64 || name == "." || name == "..") return false
        return name.all { ch -> ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '.' || ch == '_' || ch == '-' }
    }

    /** Where a new folder lands: `<reposRoot>/<name>`, as the server joins it. */
    fun newFolderPath(reposRoot: String, name: String): String {
        val separator = if ('\\' in reposRoot && '/' !in reposRoot) "\\" else "/"
        var root = reposRoot
        while (root.endsWith("/") || root.endsWith("\\")) root = root.dropLast(1)
        return "$root$separator$name"
    }

    /** The workspace name a folder gives, as the server derives it (§3.2): its last segment. */
    fun folderName(path: String): String =
        path.trimEnd('/', '\\').split('/', '\\').lastOrNull()?.takeIf { it.isNotEmpty() } ?: path

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

    /** Rule 5's Use X instead: the other sign-ins installed here, among the engines this app draws. */
    fun otherEngines(runner: JsonObject, engine: String, fleet: List<JsonObject>? = null): List<String> =
        installedLogins(runner).filter {
            it != engine && ProviderEngines.androidShowsEngine(it, fleet ?: listOf(runner))
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

    /** Rule 1 and §3: both steps are done and the machine is here, so the next send makes the workspace. */
    fun isReady(bare: Boolean, folder: PickedFolder?, online: Boolean, credential: SetupCredential): Boolean =
        bare && folder != null && online && credential.done

    /**
     * Rule 9: the machines that get a Set up row in the drawer, in the runner list's order. Online, with no workspace of this account
     * on them: an offline one is already what Machines & models says needs you.
     */
    fun machinesToSetUp(
        runners: List<JsonObject>?,
        workspaces: List<JsonObject>,
        nowMs: Long = System.currentTimeMillis(),
    ): List<MachineToSetUp> {
        if (runners == null) return emptyList()
        return runners.mapNotNull { runner ->
            val id = runner.text("id") ?: return@mapNotNull null
            if (RunnerPage.isOffline(runner, nowMs)) return@mapNotNull null
            if (workspaces.any {
                    (it["deletedAt"] == null || it["deletedAt"] is JsonNull) && ObjectId.same(it.text("runnerId"), id)
                }
            ) return@mapNotNull null
            MachineToSetUp(id = id, name = RunnerPage.displayName(runner))
        }
    }

    /**
     * Rule 11: the first online machine in the runner list's order, for landing or New session when the account has no workspaces.
     */
    fun firstOnlineRunnerId(runners: List<JsonObject>, nowMs: Long = System.currentTimeMillis()): String? =
        runners.firstOrNull { !RunnerPage.isOffline(it, nowMs) }?.text("id")

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
 * The first message, waiting for a machine's two steps (rule 6). Files are on the control plane already, so they wait as
 * [StagedAttachment]s, ready to restore to the composer if withdrawn.
 */
data class HeldMessage(
    val content: String,
    val shell: Boolean = false,
    val attachments: List<StagedAttachment> = emptyList(),
    val error: String? = null,
)

/** What a composer's send does on a machine's new session page. */
sealed interface MachineSend {
    data object Nothing : MachineSend
    data object AlreadyWaiting : MachineSend
    data object Hold : MachineSend
    data class Create(val newWorkspace: NewWorkspaceRequest) : MachineSend
}

/**
 * What a machine's new session page has been told so far: the folder and the message waiting on it. The page is left and come back
 * to on the way (a key is picked elsewhere, a sign-in goes through a browser), and neither answer should have to be given twice.
 */
data class MachineSetupState(
    val folder: PickedFolder? = null,
    val held: HeldMessage? = null,
    val sendingHeld: Boolean = false,
) {
    fun pick(folder: PickedFolder?): MachineSetupState = copy(folder = folder)

    fun send(bare: Boolean, ready: Boolean): MachineSend {
        if (!bare) return MachineSend.Nothing
        if (held != null) return MachineSend.AlreadyWaiting
        if (ready && folder != null) return MachineSend.Create(folder.newWorkspace)
        return MachineSend.Hold
    }

    fun hold(message: HeldMessage): MachineSetupState = copy(held = message)

    /**
     * Both steps done with a message waiting: it goes, with nobody pressing anything (rule 6). Once per waiting message, because the
     * send makes a workspace: while it is out this answers null, and a refusal leaves it waiting on the person (`error`) rather than
     * on another try.
     */
    fun takeHeldToSend(ready: Boolean, busy: Boolean): Pair<MachineSetupState, Pair<HeldMessage, NewWorkspaceRequest>>? {
        val currentHeld = held ?: return null
        val currentFolder = folder ?: return null
        if (!ready || busy || sendingHeld || currentHeld.error != null) return null
        return copy(sendingHeld = true) to (currentHeld to currentFolder.newWorkspace)
    }

    fun failHeld(why: String): MachineSetupState =
        copy(sendingHeld = false, held = held?.copy(error = why))

    fun retryHeld(): MachineSetupState =
        copy(held = held?.copy(error = null))

    fun withdraw(): Pair<MachineSetupState, HeldMessage?> {
        if (sendingHeld) return this to null
        return copy(held = null) to held
    }

    fun finish(): MachineSetupState = MachineSetupState()
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
            return CreatedWorkspaceLine(
                workspaceId = workspaceId,
                name = name,
                machine = machine,
                path = path,
                live = !deleted,
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
