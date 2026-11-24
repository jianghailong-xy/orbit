package io.orbitd.android.composer

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The signed-in owner's managed runner as the welcome card shows it: Android's reading of `@orbit/shared`'s `managedRunnerDisplay`
 * (and OrbitKit's `ManagedRunnerLogic`), held by `ManagedRunnerFixtureTest` to `src/shared/src/managed-runner-states.fixture.json`,
 * so the same state is said in the same words on every client. Only the capability and the status are read.
 */
object ManagedRunner {
    const val CONTRACT_VERSION = 1
    private const val MANAGED_RUNNER_UNAVAILABLE = "MANAGED_RUNNER_UNAVAILABLE"
    private const val MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"

    /** How often the status is read again, in seconds: soon while it moves by itself, rarely otherwise. */
    const val POLL_MOVING_SECONDS = 5
    const val POLL_SETTLED_SECONDS = 30

    const val RETRY = "Retry"
    const val ENSURE = "Set up"
    const val SIGN_IN = "Open Machines & models"

    private val TITLE = mapOf(
        "setup" to "Set up a managed runner",
        "notOffered" to "No managed runner",
        "preparing" to "Preparing your managed runner",
        "waking" to "Waking your managed runner",
        "modelUnavailable" to "Your managed runner needs a model",
        "waitingCapacity" to "Waiting for capacity",
        "available" to "Managed runner ready",
        "unresponsive" to "Managed runner not responding",
        "stopping" to "Managed runner going to sleep",
        "sleeping" to "Managed runner asleep",
        "waitingOperator" to "Waiting for an operator",
        "failed" to "Managed runner failed",
        "removing" to "Removing managed runner",
        "removed" to "Managed runner removed",
    )
    private val DETAIL = mapOf(
        "setup" to "This Orbit server can run a runner for you, so you can start sessions without setting up a machine of your own.",
        "notOffered" to "This Orbit server does not give your account a managed runner. Your own runners are unaffected.",
        "preparing" to "Orbit is setting up a runner for you. Sessions can start here once it is ready.",
        "waking" to "It is starting again. Messages sent meanwhile wait for it and run once it is up.",
        "modelUnavailable" to "None of its runtimes is signed in yet and none of your model keys runs on it, so it cannot start a session. " +
            "Sign one in, or add a model key, from the Machines & models page.",
        "waitingCapacity" to "The managed environment has no room for it right now. It starts by itself when room frees up.",
        "available" to "Sessions here run on the runner Orbit manages for you.",
        "unresponsive" to "Orbit has not heard from it recently. Messages sent meanwhile wait for it.",
        "stopping" to "It was idle and is stopping. Work sent now waits, and starts it again once it has stopped.",
        "sleeping" to "It went to sleep while idle. Send a message to wake it; its workspace and files are kept.",
        "waitingOperator" to "Nothing proves its previous instance stopped, so no new one starts and its data is kept until an operator acts.",
        "failed" to "It could not be started.",
        "removing" to "It is being removed and is not recreated.",
        "removed" to "It was removed. Signing in again does not recreate it.",
    )
    /** The kinds that ask for somebody's attention rather than time (the web notice's amber tone). */
    val ATTENTION = setOf("failed", "waitingOperator", "removed", "removing", "notOffered", "modelUnavailable")
    /** Kinds where the runner is up, whatever it still lacks (the welcome card's step 1 is done). */
    val UP = setOf("available", "modelUnavailable")

    private val COMING_BACK = setOf("REQUESTED", "WAITING_CAPACITY", "PROVISIONING", "STARTING", "READY", "DRAINING", "SLEEPING")
    private val SLEEP_STATES = setOf("DRAINING", "SLEEPING")
    private val MOVING = setOf("preparing", "waking", "modelUnavailable", "waitingCapacity", "unresponsive", "stopping", "removing")

    data class Status(
        val contractVersion: Int?,
        val enabled: Boolean,
        val revision: Int,
        val managementState: String,
        val desiredState: String?,
        val runnerId: String?,
        val usable: Boolean,
        val reasonCode: String?,
        val reasonMessage: String?,
        val initialProvider: String?,
        val firstSessionProvider: String?,
        val canEnsure: Boolean,
        val canWake: Boolean,
        val canRetry: Boolean,
        /** The runner runs an older build than the current image's (docs/managed-runner-update-now-design.md); null when current or unknown. */
        val update: ManagedUpdate? = null,
        /** Whether the server's reason says a retry may cure it. */
        val reasonRetryable: Boolean = false,
        /** Its next automatic try, as the server stored it; null when none is scheduled (and from an older server). */
        val nextAttemptAt: String? = null,
    )

    data class Display(
        val kind: String,
        val title: String,
        val detail: String,
        val retry: Boolean,
        val ensure: Boolean,
        val signIn: Boolean,
        val acceptsWork: Boolean,
        val startsNewSession: Boolean,
        val moving: Boolean,
    )

    /** A status and the display it gets. */
    data class Shown(val status: Status, val display: Display)

    /** `GET /auth/capabilities`: managed UI only for this contract, switched on. Anything else, a failed read included, means none. */
    fun offered(capabilities: JsonElement?): Boolean {
        val member = (capabilities as? JsonObject)?.get("managedRunners") as? JsonObject ?: return false
        val enabled = (member["enabled"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        val version = (member["contractVersion"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        return enabled == true && version == CONTRACT_VERSION
    }

    /** `GET /managed-runner`'s body; null when it isn't one. */
    fun status(body: JsonElement?): Status? {
        val o = body as? JsonObject ?: return null
        val reason = o["reason"] as? JsonObject
        val actions = o["actions"] as? JsonObject
        fun JsonObject.str(name: String) = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        fun JsonObject.bool(name: String) = (this[name] as? JsonPrimitive)?.booleanOrNull == true
        return Status(
            contractVersion = (o["contractVersion"] as? JsonPrimitive)?.intOrNull,
            enabled = o.bool("enabled"),
            revision = (o["revision"] as? JsonPrimitive)?.intOrNull ?: 0,
            managementState = o.str("managementState") ?: return null,
            desiredState = o.str("desiredState"),
            runnerId = o.str("runnerId"),
            usable = o.bool("usable"),
            reasonCode = reason?.str("code"),
            reasonMessage = reason?.str("message"),
            initialProvider = o.str("initialProvider"),
            firstSessionProvider = o.str("firstSessionProvider"),
            canEnsure = actions?.bool("canEnsure") == true,
            canWake = actions?.bool("canWake") == true,
            canRetry = actions?.bool("canRetry") == true,
            update = ManagedRunnerUpdateLogic.update(o),
            reasonRetryable = reason?.bool("retryable") == true,
            nextAttemptAt = o.str("nextAttemptAt"),
        )
    }

    private fun kind(status: Status): String? = when (status.managementState) {
        "NOT_PROVISIONED" -> if (status.canEnsure) "setup" else "notOffered"
        "REQUESTED", "PROVISIONING", "STARTING" -> when {
            status.reasonCode == MODEL_UNAVAILABLE -> "modelUnavailable"
            // `initialProvider` is recorded when the runner becomes READY and kept: starting with one is starting again.
            status.initialProvider != null -> "waking"
            else -> "preparing"
        }
        "WAITING_CAPACITY" -> "waitingCapacity"
        "READY" -> if (status.usable) "available" else "unresponsive"
        "DRAINING" -> "stopping"
        "SLEEPING" -> if (status.desiredState == "RUNNING") "waking" else "sleeping"
        "FENCING" -> "waitingOperator"
        "FAILED" -> "failed"
        "DELETING" -> "removing"
        "DELETED" -> "removed"
        else -> null
    }

    /** The display for a status, or null when there is no managed UI for it. */
    fun display(status: Status?): Display? {
        if (status == null || !status.enabled || status.contractVersion != CONTRACT_VERSION) return null
        val kind = kind(status) ?: return null
        val frozen = status.reasonCode == MANAGED_RUNNER_UNAVAILABLE
        val wakeable = status.managementState !in SLEEP_STATES || status.canWake
        // FAILED with its slow retry scheduled comes back by itself too (managed-runner-demand.ts `slowRetryScheduled`).
        val slowRetry = status.managementState == "FAILED" && !status.nextAttemptAt.isNullOrEmpty() && status.reasonRetryable
        val acceptsWork = !frozen && wakeable && (status.managementState in COMING_BACK || slowRetry)
        return Display(
            kind = kind,
            title = TITLE.getValue(kind),
            detail = status.reasonMessage?.takeIf { kind != "available" && it.isNotEmpty() } ?: DETAIL.getValue(kind),
            retry = status.managementState == "FAILED" && status.canRetry,
            ensure = status.managementState == "NOT_PROVISIONED" && status.canEnsure,
            signIn = status.reasonCode == MODEL_UNAVAILABLE && status.runnerId != null,
            acceptsWork = acceptsWork,
            startsNewSession = acceptsWork && firstSessionProvider(status) != null,
            moving = !frozen && kind in MOVING,
        )
    }

    /** What a first session on the managed runner starts on, as the server says. */
    fun firstSessionProvider(status: Status): String? = status.firstSessionProvider ?: status.initialProvider

    // The managed runner as one machine in the machine list (docs/managed-runner-existing-account-entry-design.md), MANAGED_RUNNER_COPY's
    // short, entry, confirm and asleep words and MANAGED_RUNNER_ROW_TONE, held to the fixture by ManagedRunnerFixtureTest.

    /** The row's label per display kind, in place of the heartbeat's Online/Offline: asleep is Asleep, never Offline. */
    val SHORT = mapOf(
        "setup" to "Set up",
        "preparing" to "Preparing",
        "waking" to "Waking up…",
        "modelUnavailable" to "Needs a model",
        "waitingCapacity" to "Waiting for capacity",
        "available" to "Ready",
        "unresponsive" to "Not responding",
        "stopping" to "Going to sleep",
        "sleeping" to "Asleep",
        "waitingOperator" to "Waiting for an operator",
        "failed" to "Failed",
        "removing" to "Removing",
        "removed" to "Removed",
    )

    /** How a row marks the state: READY green, PROGRESS a spinner, IDLE grey (asleep is never a fault's colour), ATTENTION orange. */
    enum class Tone { READY, PROGRESS, IDLE, ATTENTION }
    val ROW_TONE = mapOf(
        "setup" to Tone.IDLE, "preparing" to Tone.PROGRESS, "waking" to Tone.PROGRESS, "modelUnavailable" to Tone.ATTENTION,
        "waitingCapacity" to Tone.PROGRESS, "available" to Tone.READY, "unresponsive" to Tone.PROGRESS, "stopping" to Tone.PROGRESS,
        "sleeping" to Tone.IDLE, "waitingOperator" to Tone.ATTENTION, "failed" to Tone.ATTENTION, "removing" to Tone.PROGRESS,
        "removed" to Tone.IDLE,
    )

    /** Machines & models' Managed runner section, for an account with no mapping that the server offers one. */
    object Entry {
        const val TITLE = "Managed runner"
        const val ACTION = "Set up"
        const val SUBTITLE = "Orbit runs a runner for you on this server."
    }

    /** Asked before Set up on an account that already has a machine or a workspace. */
    object Confirm {
        const val TITLE = "Set up a managed runner?"
        const val BODY = "Orbit will start a runner for you on this server. Your own machines and workspaces stay as they are."
        const val CANCEL = "Cancel"
        const val CONFIRM = "Set up"
    }

    /** Sleep is not a fault: sending wakes it, and nothing says it is offline. */
    object Asleep {
        const val ROW = "Wakes automatically when you start a session"
        const val COMPOSER = "Your managed runner is asleep. Sending wakes it (about 10 s)."
    }

    /** The managed runner's home, fixed by its image: a new folder goes here before it has reported (@orbit/shared MANAGED_RUNNER_HOME). */
    const val HOME = "/home/orbit"
    object Setup {
        val NOTICE = mapOf(
            "preparing" to "Orbit is setting up your managed runner. You can create the workspace now; your first session starts when it’s ready.",
            "asleep" to "Your managed runner is asleep. Your first message wakes it (about 10 s)."
        )
        val FOLDER_UNCHECKED = mapOf(
            "preparing" to "Not checked until your managed runner is up: used if it’s there, created if not.",
            "asleep" to "Not checked while it’s asleep: used if it’s there, created if not."
        )
    }

    fun managedSetupState(runnerId: String?, status: Status?): String? {
        val row = row(runnerId, status) ?: return null
        if (!row.acceptsWork || row.kind == "available" || row.kind == "unresponsive" || row.kind == "failed") return null
        return if (!status?.initialProvider.isNullOrEmpty()) "asleep" else "preparing"
    }

    /** A machine row's (or a workspace's runner's) reading of the account's managed runner (`managedRunnerRow`). */
    data class Row(val kind: String, val label: String, val tone: Tone, val detail: String?, val acceptsWork: Boolean, val asleep: Boolean)

    /** Whether [runnerId] is the account's managed runner and how to show it; null when it is not, or there is no managed UI. */
    fun row(runnerId: String?, status: Status?): Row? {
        // Lists name a runner by its public id or its UUID: the same runner either way.
        if (runnerId.isNullOrEmpty() || status?.runnerId == null || !ObjectId.same(status.runnerId, runnerId)) return null
        val display = display(status) ?: return null
        val kind = display.kind.takeIf { it != "notOffered" } ?: return null
        val tone = ROW_TONE.getValue(kind)
        return Row(
            kind = kind,
            label = SHORT.getValue(kind),
            // A spinner only while it moves by itself (not while the environment is unavailable).
            tone = if (tone == Tone.PROGRESS && !display.moving) Tone.IDLE else tone,
            detail = if (kind == "sleeping" && display.acceptsWork) Asleep.ROW else null,
            acceptsWork = display.acceptsWork,
            asleep = (kind == "sleeping" || kind == "stopping") && display.acceptsWork,
        )
    }
}

/**
 * The account's managed runner status as the signed-in shell last read it (null without the capability, or before it answers): pages that
 * name a runner — a session's composer, the coordinator's workspace picker — read it here rather than asking the server again, and show
 * that runner by [ManagedRunner.row] (Asleep, Waking up…, never Offline). Other runners are unchanged.
 */
val LocalManagedRunnerStatus = staticCompositionLocalOf<ManagedRunner.Status?> { null }

/**
 * The account's managed runner's id, as the last read of its status said (null with no managed UI): what names that runner Orbit Cloud
 * wherever a machine's name is shown (RunnerPage.displayName), the web's useManagedRunnerId. Snapshot state, so a name read in
 * composition follows it; a failed read leaves it as it was.
 */
object ManagedRunnerIdentity {
    var runnerId by mutableStateOf<String?>(null)
}
