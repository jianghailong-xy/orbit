package io.orbitd.android.watch

import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*

// The Watch API's wire vocabulary (`/api/watches`), transcribed from OrbitKit `Models/Watches.swift`, whose
// authority is `contracts/watch.contract.json` (`WatchContractTest` holds the states, leaves, transitions and
// limits below to it).
//
// Every closed set reads a value this build doesn't know as UNKNOWN rather than failing: a newer server may add
// a state or a leaf, and one watch this build can't name must not blank the list. Where OrbitKit's decoder would
// throw on a missing field, a row here is read with the field's empty value instead — and a row with no id at all
// is left out — so one malformed watch never fails the whole list either.

/** OrbitKit `PublicID.storageKey`: either spelling of an id in, one stable key out. */
internal fun watchKey(id: String): String = ObjectId.canonical(id) ?: id

internal fun JsonElement?.watchText(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.takeIf { !it.isString }
    ?.let { it.intOrNull ?: it.doubleOrNull?.takeIf { d -> d == Math.floor(d) }?.toInt() }
private fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
private fun JsonElement?.objects(): List<JsonObject> = (this as? JsonArray).orEmpty().filterIsInstance<JsonObject>()

/** Where a watch stands (contract §3). It starts ACTIVE; the last five are terminal. */
internal enum class WatchState { ACTIVE, PAUSED, MATCHED, EXPIRED, CANCELLED, REVOKED, UNRESOLVABLE, UNKNOWN;
    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

/** The two kinds a watch observes. */
internal enum class WatchTargetKind { SESSION, TASK, UNKNOWN;
    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

/** One target's state: SATISFIED once a leaf the predicate names holds for it, GONE once its row is deleted. */
internal enum class WatchTargetState { OBSERVED, SATISFIED, GONE, UNKNOWN;
    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

/** Whether what a Match (or a watch's end) caused got done. DEAD_LETTER is the only terminal state. */
internal enum class WatchDeliveryState { PENDING, IN_FLIGHT, DELIVERED, DEAD_LETTER, UNKNOWN;
    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

/** What a watch does when it matches (contract §6): one notification, or one turn queued on its observer. */
internal enum class WatchAction { NOTIFY_USER, RESUME_SESSION, UNKNOWN;
    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

internal enum class WatchMode { ONE_SHOT, CONTINUOUS, UNKNOWN;
    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

internal enum class WatchObserverType { USER, SESSION, UNKNOWN;
    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

/** The v1 leaves (contract §2.2), each evaluated against one kind of target. */
internal enum class WatchLeaf {
    SESSION_TURN_SETTLED, SESSION_RUN_TERMINAL, SESSION_LIFECYCLE_TERMINAL, SESSION_NEEDS_ATTENTION,
    TASK_TERMINAL, TASK_FAILED, TASK_DONE, UNKNOWN;

    /** The only kind of target the leaf is evaluated against; null for a leaf this build doesn't know. */
    val targetKind: WatchTargetKind? get() = when (this) {
        SESSION_TURN_SETTLED, SESSION_RUN_TERMINAL, SESSION_LIFECYCLE_TERMINAL, SESSION_NEEDS_ATTENTION -> WatchTargetKind.SESSION
        TASK_TERMINAL, TASK_FAILED, TASK_DONE -> WatchTargetKind.TASK
        UNKNOWN -> null
    }

    companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
}

/** The contract's `limits` a client acts on. */
internal object WatchLimits {
    const val MIN_TTL_SECONDS = 60
    const val DEFAULT_TTL_SECONDS = 86_400
    const val MAX_TTL_SECONDS = 2_592_000
    const val MAX_PREDICATE_DEPTH = 2
    const val MAX_OPERANDS_PER_COMPOSITE = 4
    /** The failed attempt that brings a delivery's `attempts` here makes it a dead letter. */
    const val MAX_DELIVERY_ATTEMPTS = 8
}

/** A typed condition over the whole target set (contract §2): one leaf aggregated over every target, or a
 * composite of those. A term this build can't read is [Unknown], drawn as such and never sent back. */
internal sealed interface WatchPredicate {
    /** Holds when the leaf holds for every target. */
    data class All(val leaf: WatchLeaf) : WatchPredicate
    /** Holds when the leaf holds for at least one target. */
    data class Any(val leaf: WatchLeaf) : WatchPredicate
    data class AllOf(val operands: List<WatchPredicate>) : WatchPredicate
    data class AnyOf(val operands: List<WatchPredicate>) : WatchPredicate
    /** A term this build can't read, named by its `kind`. */
    data class Unknown(val kind: String) : WatchPredicate

    /** Every leaf the predicate names, in order. */
    val leaves: List<WatchLeaf> get() = when (this) {
        is All -> listOf(leaf)
        is Any -> listOf(leaf)
        is AllOf -> operands.flatMap { it.leaves }
        is AnyOf -> operands.flatMap { it.leaves }
        is Unknown -> emptyList()
    }

    /** Whether this build can read every term — and so describe it, or offer to keep it. */
    val isKnown: Boolean get() = when (this) {
        is All -> leaf != WatchLeaf.UNKNOWN
        is Any -> leaf != WatchLeaf.UNKNOWN
        is AllOf -> operands.all { it.isKnown }
        is AnyOf -> operands.all { it.isKnown }
        is Unknown -> false
    }

    /** The grammar as the contract spells it (docs/watch-contract.md §2.1). */
    fun json(): JsonObject = buildJsonObject {
        when (val p = this@WatchPredicate) {
            is All -> { put("kind", "ALL"); put("over", ALL_TARGETS); put("leaf", p.leaf.name) }
            is Any -> { put("kind", "ANY"); put("over", ALL_TARGETS); put("leaf", p.leaf.name) }
            is AllOf -> { put("kind", "ALL_OF"); put("operands", JsonArray(p.operands.map { it.json() })) }
            is AnyOf -> { put("kind", "ANY_OF"); put("operands", JsonArray(p.operands.map { it.json() })) }
            is Unknown -> put("kind", p.kind)
        }
    }

    companion object {
        /** The grammar version this build reads and writes. */
        const val VERSION = 1
        private const val ALL_TARGETS = "ALL_TARGETS"

        fun decode(element: JsonElement?): WatchPredicate {
            val c = element as? JsonObject ?: return Unknown("")
            val kind = c["kind"].watchText() ?: return Unknown("")
            return when (kind) {
                // v1 has one selector. A term over some other set means something this build can't say.
                "ALL", "ANY" -> if (c["over"].watchText() != ALL_TARGETS) Unknown(kind) else {
                    val leaf = WatchLeaf.of(c["leaf"].watchText())
                    if (kind == "ALL") All(leaf) else Any(leaf)
                }
                "ALL_OF", "ANY_OF" -> {
                    val operands = (c["operands"] as? JsonArray)?.map(::decode) ?: return Unknown(kind)
                    if (kind == "ALL_OF") AllOf(operands) else AnyOf(operands)
                }
                else -> Unknown(kind)
            }
        }
    }
}

/** One target's own standing: a task's status with its `running`/`queued` overlays, or a session's run state. */
internal data class WatchTargetStatus(val status: String, val running: Boolean, val queued: Boolean) {
    companion object {
        fun decode(element: JsonElement?): WatchTargetStatus? {
            val c = element as? JsonObject ?: return null
            val status = c["status"].watchText() ?: return null
            return WatchTargetStatus(status, c["running"].bool() ?: false, c["queued"].bool() ?: false)
        }
    }
}

/** One frozen target and what the evaluator last recorded about it. */
internal data class WatchTarget(
    val targetKind: WatchTargetKind,
    /** The session's or task's id, as the public id like every other id above the API line. */
    val targetResourceId: String,
    val state: WatchTargetState,
    val targetEpoch: Int = 0,
    /** When an evaluation last MOVED this target's state. */
    val lastEvaluatedAt: String? = null,
    /** The target's own title, read with the watch; null when this account can't read the row. */
    val targetTitle: String? = null,
    val targetStatus: WatchTargetStatus? = null,
) {
    companion object {
        fun decode(c: JsonObject) = WatchTarget(WatchTargetKind.of(c["targetKind"].watchText()), c["targetResourceId"].watchText().orEmpty(),
            WatchTargetState.of(c["state"].watchText()), c["targetEpoch"].int() ?: 0, c["lastEvaluatedAt"].watchText(),
            c["targetTitle"].watchText(), WatchTargetStatus.decode(c["targetStatus"]))
    }
}

internal data class WatchObservedFacts(val status: String, val endReason: String?, val runState: String?,
    val lifecycleState: String?, val pendingApproval: Boolean?)

/** What a target looked like to the evaluation that recorded a Match or an expiry. */
internal data class WatchTargetObservation(val kind: WatchTargetKind, val id: String, val epoch: Int, val state: WatchTargetState,
    val changed: Boolean, val leaves: Map<String, Boolean>?, val observed: WatchObservedFacts?) {
    companion object {
        fun decode(c: JsonObject) = WatchTargetObservation(WatchTargetKind.of(c["kind"].watchText()), c["id"].watchText().orEmpty(),
            c["epoch"].int() ?: 0, WatchTargetState.of(c["state"].watchText()), c["changed"].bool() ?: false,
            (c["leaves"] as? JsonObject)?.mapNotNull { (key, value) -> value.bool()?.let { key to it } }?.toMap(),
            (c["observed"] as? JsonObject)?.let { o -> o["status"].watchText()?.let { status ->
                WatchObservedFacts(status, o["endReason"].watchText(), o["runState"].watchText(), o["lifecycleState"].watchText(), o["pendingApproval"].bool())
            } })
    }
}

/** A Match's `perTargetSnapshot`, and an expiry's `expirySnapshot`. */
internal data class WatchSnapshot(val evaluatedAt: String, val targets: List<WatchTargetObservation>) {
    companion object {
        fun decode(element: JsonElement?): WatchSnapshot? = (element as? JsonObject)?.let { c ->
            WatchSnapshot(c["evaluatedAt"].watchText().orEmpty(), c["targets"].objects().map(WatchTargetObservation::decode))
        }
    }
}

/** What a Match (or a watch's end) caused, and whether it got done. `attempts` counts the attempts that failed. */
internal data class WatchDelivery(
    val id: String, val action: WatchAction, val state: WatchDeliveryState, val attempts: Int,
    val nextAttemptAt: String? = null, val lastError: String? = null, val deliveredAt: String? = null,
    val deadLetteredAt: String? = null, val createdAt: String = "", val updatedAt: String = "",
) {
    companion object {
        fun decode(c: JsonObject) = WatchDelivery(c["id"].watchText().orEmpty(), WatchAction.of(c["action"].watchText()),
            WatchDeliveryState.of(c["state"].watchText()), c["attempts"].int() ?: 0, c["nextAttemptAt"].watchText(),
            c["lastError"].watchText(), c["deliveredAt"].watchText(), c["deadLetteredAt"].watchText(),
            c["createdAt"].watchText().orEmpty(), c["updatedAt"].watchText().orEmpty())
    }
}

/** A Match: the condition held at one moment (contract §1). */
internal data class WatchMatch(val id: String, val generation: Int, val matchedAt: String,
    /** The evaluator's own account in the contract's vocabulary (`ALL TASK_TERMINAL 7/7`). */
    val reason: String, val predicateVersion: Int, val perTargetSnapshot: WatchSnapshot?, val deliveries: List<WatchDelivery>) {
    companion object {
        fun decode(c: JsonObject) = WatchMatch(c["id"].watchText().orEmpty(), c["generation"].int() ?: 0, c["matchedAt"].watchText().orEmpty(),
            c["reason"].watchText().orEmpty(), c["predicateVersion"].int() ?: WatchPredicate.VERSION,
            WatchSnapshot.decode(c["perTargetSnapshot"]), c["deliveries"].objects().map(WatchDelivery::decode))
    }
}

/** The turn a RESUME_SESSION watch that ended unmatched owes its observer. The wire flattens the delivery's own
 * fields into the same object as `kind`. */
internal data class WatchEndDelivery(val kind: Kind, val delivery: WatchDelivery, val expirySnapshot: WatchSnapshot?) {
    enum class Kind { EXPIRY, REVOKED, UNRESOLVABLE, UNKNOWN;
        companion object { fun of(raw: String?) = entries.firstOrNull { it.name == raw } ?: UNKNOWN }
    }
    companion object {
        fun decode(c: JsonObject) = WatchEndDelivery(Kind.of(c["kind"].watchText()), WatchDelivery.decode(c), WatchSnapshot.decode(c["expirySnapshot"]))
    }
}

/** `GET /watches` and `GET /watches/:id`, and what every control answers with. */
internal data class Watch(
    /** The public id. A push names the watch by its UUID instead, so match ids through [watchKey]. */
    val id: String,
    val observerType: WatchObserverType = WatchObserverType.UNKNOWN,
    /** The session a RESUME_SESSION watch resumes; null when the account's user is the observer. */
    val observerSessionId: String? = null,
    val predicateVersion: Int = WatchPredicate.VERSION,
    val predicate: WatchPredicate = WatchPredicate.Unknown(""),
    val mode: WatchMode = WatchMode.UNKNOWN,
    val action: WatchAction = WatchAction.UNKNOWN,
    val state: WatchState = WatchState.UNKNOWN,
    /** How many Matches the watch has recorded. */
    val generation: Int = 0,
    val expiresAt: String = "",
    val nextEvaluateAt: String? = null,
    /** When the evaluator last looked — what freshness reads. */
    val lastEvaluatedAt: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
    /** Frozen at create. */
    val targets: List<WatchTarget> = emptyList(),
    /** Oldest first. */
    val matches: List<WatchMatch> = emptyList(),
    /** At most one, and only for a RESUME_SESSION watch that ended unmatched and uncancelled. */
    val expiryDeliveries: List<WatchEndDelivery> = emptyList(),
) {
    companion object {
        /** The fields the server always sends (OrbitKit `Watch`'s non-optional properties), by the JSON kind each is. */
        private val texts = listOf("observerType", "mode", "action", "state", "expiresAt", "createdAt", "updatedAt")
        private val numbers = listOf("predicateVersion", "generation")
        private val lists = listOf("targets", "matches", "expiryDeliveries")

        /** A watch as the server sends it; null for a row that isn't one — any row missing a field the server always
         * sends, or holding another kind of value there, is left out rather than drawn as a watch out of defaults
         * (iOS fails the whole list on such a row). A value this version doesn't know still reads, as unknown. */
        fun decode(element: JsonElement?): Watch? {
            val c = element as? JsonObject ?: return null
            val id = c["id"].watchText()?.takeIf(String::isNotEmpty) ?: return null
            if (texts.any { c[it].watchText() == null } || numbers.any { c[it].int() == null } || lists.any { c[it] !is JsonArray }
                || c["predicate"] !is JsonObject) return null
            return Watch(id, WatchObserverType.of(c["observerType"].watchText()), c["observerSessionId"].watchText(),
                c["predicateVersion"].int() ?: WatchPredicate.VERSION, WatchPredicate.decode(c["predicate"]), WatchMode.of(c["mode"].watchText()),
                WatchAction.of(c["action"].watchText()), WatchState.of(c["state"].watchText()), c["generation"].int() ?: 0,
                c["expiresAt"].watchText().orEmpty(), c["nextEvaluateAt"].watchText(), c["lastEvaluatedAt"].watchText(),
                c["createdAt"].watchText().orEmpty(), c["updatedAt"].watchText().orEmpty(),
                c["targets"].objects().map(WatchTarget::decode), c["matches"].objects().map(WatchMatch::decode),
                c["expiryDeliveries"].objects().map(WatchEndDelivery::decode))
        }
    }
}
