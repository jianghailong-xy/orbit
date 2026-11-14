package io.orbitd.android.composer

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
        val workspaceId: String?,
        val usable: Boolean,
        val reasonCode: String?,
        val reasonMessage: String?,
        val initialProvider: String?,
        val firstSessionProvider: String?,
        val canEnsure: Boolean,
        val canWake: Boolean,
        val canRetry: Boolean,
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
            workspaceId = o.str("workspaceId"),
            usable = o.bool("usable"),
            reasonCode = reason?.str("code"),
            reasonMessage = reason?.str("message"),
            initialProvider = o.str("initialProvider"),
            firstSessionProvider = o.str("firstSessionProvider"),
            canEnsure = actions?.bool("canEnsure") == true,
            canWake = actions?.bool("canWake") == true,
            canRetry = actions?.bool("canRetry") == true,
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
        val acceptsWork = !frozen && wakeable && status.managementState in COMING_BACK
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

    /** What a first session in the managed default workspace starts on, as the server says. */
    fun firstSessionProvider(status: Status): String? = status.firstSessionProvider ?: status.initialProvider
}
