package io.orbitd.android.core.cards

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/*
 * Owner requests: what a session has asked the account owner to do (apiserver `owner-requests`; web lib/ownerRequests.ts and
 * components/OwnerRequestCard.tsx). One door (`/owner-requests`) is read for the card in the conversation that asked and for the
 * "Waiting on you" inbox, so the two cannot say different things.
 */

@Serializable
data class OwnerRequestOption(val label: String, val description: String? = null)

@Serializable
data class OwnerRequestStep(val text: String, val command: String? = null, val link: String? = null)

@Serializable
data class OwnerRequestSecretSpec(val name: String, val runnerId: String? = null, val envVar: String? = null, val filePath: String? = null)

/** The request's latest secret grant: where the key it delivered stands. Never the value or anything derived from it. */
@Serializable
data class OwnerRequestSecretGrant(val state: String, val endReason: String? = null, val exposure: String? = null,
    val expiresAt: String? = null, val deliveredAt: String? = null, val removedAt: String? = null, val removalNote: String? = null,
    val runnerOnline: Boolean = false, val runnerLastSeenAt: String? = null)

@Serializable
data class OwnerRequestAnswer(val option: Int? = null, val text: String? = null)

@Serializable
data class OwnerRequest(
    val id: String,
    val kind: String,
    val state: String,
    val title: String,
    val why: String = "",
    val blocksTaskIds: List<String> = emptyList(),
    val ifUnanswered: String? = null,
    val options: List<OwnerRequestOption>? = null,
    val recommendedOption: Int? = null,
    val steps: List<OwnerRequestStep>? = null,
    val secretSpec: OwnerRequestSecretSpec? = null,
    /** SECRET: what ends the key (design §6.1) — its task, or, for a session with no task, the session. */
    val secretScope: String? = null,
    val secretGrant: OwnerRequestSecretGrant? = null,
    val verifyHint: String? = null,
    val expiresAt: String? = null,
    val askedBySessionId: String = "",
    val projectId: String? = null,
    val resolvedAt: String? = null,
    val resolvedByUserId: String? = null,
    val resolvedBySessionId: String? = null,
    val resolutionNote: String? = null,
    val answer: OwnerRequestAnswer? = null,
    val resolvedClient: String? = null,
    val createdAt: String,
) {
    val pending get() = state == OwnerRequests.PENDING
}

@Serializable
data class OwnerRequestList(val requests: List<OwnerRequest> = emptyList())

/** A saved account secret, by label only: no route returns a value. */
@Serializable
data class AccountSecret(val id: String, val label: String)

@Serializable
data class AccountSecretList(val secrets: List<AccountSecret> = emptyList())

object OwnerRequests {
    const val PENDING = "PENDING"
    const val DECISION = "DECISION"
    const val SECRET = "SECRET"
    const val MANUAL_STEP = "MANUAL_STEP"
    const val CONFIRM = "CONFIRM"
    val kinds = setOf(DECISION, SECRET, MANUAL_STEP, CONFIRM)

    const val waitingOnYou = "Waiting on you"
    const val holdingUp = "Holding up"
    const val deliveredTo = "Delivered to"
    const val removed = "Removed"
    const val ifNobodyAnswers = "If nobody answers:"
    const val remindLater = "Remind me later"
    const val showNow = "Show now"
    const val keyPlaceholder = "Paste the key"
    const val saveToAccount = "Save to my account secrets for later runs"
    const val saveAsLabel = "Name to save it under"
    const val enterKeyInstead = "Enter a key instead"
    const val useSaved = "Use saved:"
    const val yourAnswer = "Your answer"
    const val notePrompt = "Add a note (optional)"
    const val ownAnswerPrompt = "Or type your own answer…"
    const val declineReason = "Why? The session that asked reads this."
    const val decline = "Decline"
    const val keepIt = "Keep it"
    const val cancel = "Cancel"
    const val revoke = "Revoke"
    const val notRecorded = "That was not recorded"
    const val recommended = "Recommended"
    const val copy = "Copy"
    const val copied = "Copied"
    const val open = "Open"
    const val task = "Task"
    /** The notification's second action: puts the request off for an hour, on this device. */
    const val later = "Later"

    /** The tag beside a card's title. */
    fun kindTag(kind: String) = when (kind) { MANUAL_STEP -> "STEPS"; else -> kind }
    /** The card's primary button. */
    fun primary(kind: String) = when (kind) { DECISION -> "Send answer"; SECRET -> "Provide key"; MANUAL_STEP -> "Mark done"; else -> "Confirm" }
    /** An inbox row's button. */
    fun inboxAction(kind: String) = when (kind) { DECISION -> "Answer"; SECRET -> "Provide"; MANUAL_STEP -> "Open steps"; else -> "Review" }
    /** A push's primary action, which opens the card on its input. */
    fun pushAction(kind: String): String? = when (kind) {
        SECRET -> "Provide key"; DECISION -> "Answer"; MANUAL_STEP -> "Mark done"; CONFIRM -> "Review"; else -> null
    }
    fun declineLabel(kind: String) = if (kind == MANUAL_STEP) "Can’t do this…" else "Decline…"

    /** A pending request whose deadline has passed. The door refuses it; the sweep writes EXPIRED within a minute. */
    fun pastDeadline(request: OwnerRequest, now: Instant): Boolean = parse(request.expiresAt)?.let { !it.isAfter(now) } == true

    /** "2m ago", as the web's `ago` writes it. */
    fun ago(iso: String?, now: Instant): String {
        val at = parse(iso) ?: return "unknown"
        val diff = Duration.between(at, now)
        return if (diff.seconds < 10) "just now" else "${BackgroundWakeCard.duration(diff.seconds)} ago"
    }

    /** The header's right half: "Asked 2m ago · expires in 3d". */
    fun askedLine(request: OwnerRequest, now: Instant): String {
        val expiry = parse(request.expiresAt)?.let { at ->
            val left = Duration.between(now, at)
            if (left.isZero || left.isNegative) "expired" else "expires in ${BackgroundWakeCard.duration(left.seconds)}"
        }
        return "Asked ${ago(request.createdAt, now)}" + (expiry?.let { " · $it" } ?: "")
    }

    /** Where the key goes and what it can do there, in the wording of the secrets design (§7.3). */
    fun secretNotice(spec: OwnerRequestSecretSpec, runner: String): String {
        val where = if (spec.filePath != null)
            "Goes straight to $runner as a file. Orbit keeps it out of this conversation, but any program running as the runner’s user on $runner can read the file until it is removed."
        else "Goes straight to $runner. Orbit keeps it out of this conversation and away from the agent; only commands the agent runs with it can use it."
        return "$where Use a key you can revoke."
    }

    fun destination(spec: OwnerRequestSecretSpec, runner: String) =
        "Runner $runner ${if (spec.filePath != null) "at" else "as"} ${spec.filePath ?: spec.envVar.orEmpty()}"

    fun removedFact(request: OwnerRequest) =
        if (request.secretScope == "SESSION") "When the session ends, or after 7 days" else "When the task ends, or after 7 days"

    fun onItsWay(runner: String) = "Key is on its way to $runner."
    fun offline(runner: String, until: String?) = "$runner is offline. Orbit will deliver this when it comes back${until?.let { ", until $it" } ?: ""}."
    fun enterAgain(runner: String) = "You can enter a key again once $runner confirms the earlier one is gone."
    fun didNotReach(runner: String) = "The key did not reach $runner"
    fun usingSaved(label: String?) = "Using saved “${label ?: "secret"}”"
    fun verifyHint(hint: String) = "How to check: $hint"
    fun reminder(time: String?) = "Reminder ${time.orEmpty()}".trim()

    /** Whether the primary button can be pressed with what has been put in. */
    fun ready(request: OwnerRequest, value: String, save: Boolean, saveAs: String, savedId: String?, option: Int?, text: String) = when (request.kind) {
        SECRET -> savedId != null || (value.isNotBlank() && (!save || saveAs.isNotBlank()))
        DECISION -> option != null || text.isNotBlank()
        else -> true
    }

    /** The summary's second line: what came of it. */
    fun outcomeLine(request: OwnerRequest, runner: String): String {
        val note = request.resolutionNote?.trim()?.takeIf { it.isNotEmpty() }
        return when (request.state) {
            "DECLINED" -> note?.let { "Declined: “$it”" } ?: "Declined"
            "EXPIRED" -> "Expired before anyone answered"
            "WITHDRAWN" -> note?.let { "Withdrawn: “$it”" } ?: "Withdrawn"
            else -> when {
                request.kind == SECRET && request.secretSpec != null -> request.secretSpec.let {
                    "Delivered to $runner ${if (it.filePath != null) "at" else "as"} ${it.filePath ?: it.envVar.orEmpty()}"
                }
                request.kind == DECISION -> {
                    val label = request.answer?.option?.let { request.options?.getOrNull(it)?.label }
                    val said = request.answer?.text?.trim()?.takeIf { it.isNotEmpty() }
                    when {
                        label != null -> said?.let { "$label: “$it”" } ?: label
                        said != null -> "“$said”"
                        else -> "Answered"
                    }
                }
                request.kind == CONFIRM -> "Confirmed"
                else -> "Marked done"
            }
        }
    }

    fun endedBy(request: OwnerRequest): String? = when {
        request.state == "EXPIRED" -> null
        request.resolvedByUserId != null -> "by you"
        else -> "by the session that asked"
    }

    /** "by you · 16:00 · via Android" — who, when and from which device. */
    fun byLine(request: OwnerRequest, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String =
        listOfNotNull(endedBy(request), request.resolvedAt?.let { OwnerReview.receiptTime(it, now, zone) },
            device(request.resolvedClient)?.let { "via $it" }).joinToString(" · ")

    fun device(client: String?): String? = when (client) { "web" -> "Web"; "ios" -> "iPhone"; "macos" -> "Mac"; "android" -> "Android"; else -> null }

    private val grantEndings = mapOf(
        "TASK_ENDED" to "Removed when the task ended",
        "SESSION_ENDED" to "Removed when the session ended",
        "EXPIRED" to "Removed when it expired",
        "WITHDRAWN" to "Removed: the agent released it",
        "REVOKED" to "Removed: you revoked it",
        "MOVED" to "Removed when the session moved to another runner",
        "RUNNER_DELETED" to "The runner was deleted; removal unconfirmed",
        "KEY_UNREADABLE" to "Removed: the stored key could not be read",
        "DELIVERY_FAILED" to "Delivery failed",
    )

    /** A removal the card must state on any request, not only a DONE one (design §6.1, §6.3, §6.4). */
    fun removalToTell(grant: OwnerRequestSecretGrant?): Boolean {
        if (grant == null) return false
        if (grant.state == "REMOVING") return true
        if (grant.state != "REMOVED" || grant.endReason == "DELIVERY_FAILED") return false
        return grant.endReason == "RUNNER_DELETED" || !grant.removalNote.isNullOrBlank()
    }

    /** Where a delivered key stands now (design §6): in, being removed, or gone and why. */
    fun grantLine(grant: OwnerRequestSecretGrant, runner: String, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String? {
        fun at(iso: String?) = iso?.let { OwnerReview.receiptTime(it, now, zone) }.orEmpty()
        return when (grant.state) {
            "ACTIVE" -> "Key is in · expires ${at(grant.expiresAt)}"
            "REMOVING" -> if (!grant.runnerOnline && grant.runnerLastSeenAt != null)
                "Removal pending: $runner has not been online since ${at(grant.runnerLastSeenAt)}"
                else "Removal pending: waiting for $runner to confirm"
            "REMOVED" -> {
                val note = grant.removalNote
                if (note != null && note.startsWith("Removal unconfirmed")) note
                else {
                    val why = grant.endReason?.let(grantEndings::get) ?: "Removed"
                    if (!note.isNullOrEmpty()) "$why. $note" else why
                }
            }
            else -> null
        }
    }

    /** The grant line a resolved request shows: a DONE one's whole story, any other's only a removal it must tell. */
    fun resolvedGrant(request: OwnerRequest): OwnerRequestSecretGrant? =
        request.secretGrant?.takeIf { request.kind == SECRET && (request.state == "DONE" || removalToTell(it)) }

    /** An inbox row's detail: "3 steps", "decision · recommended: Ship it", "confirmation". */
    fun requestDetail(request: OwnerRequest): String? = when (request.kind) {
        MANUAL_STEP -> request.steps.orEmpty().size.let { "$it ${if (it == 1) "step" else "steps"}" }
        DECISION -> request.recommendedOption?.let { request.options?.getOrNull(it)?.label }?.let { "decision · recommended: $it" } ?: "decision"
        CONFIRM -> "confirmation"
        else -> null
    }

    /** "holds 2 tasks", and for how long once that has passed a day. */
    fun holdsText(request: OwnerRequest, now: Instant): String? {
        val count = request.blocksTaskIds.size
        if (count == 0) return null
        val waited = parse(request.createdAt)?.let { Duration.between(it, now) } ?: Duration.ZERO
        return "holds $count ${if (count == 1) "task" else "tasks"}" +
            (if (waited >= Duration.ofDays(1)) " for ${BackgroundWakeCard.duration(waited.seconds)}" else "")
    }

    /** The row's detail line: the kind's own words, then what it holds up. */
    fun rowDetail(request: OwnerRequest, now: Instant): String = listOfNotNull(requestDetail(request), holdsText(request, now)).joinToString(" · ")

    data class SnoozeChoice(val label: String, val duration: Duration)
    val snoozeChoices = listOf(SnoozeChoice("In 1 hour", Duration.ofHours(1)), SnoozeChoice("In 4 hours", Duration.ofHours(4)),
        SnoozeChoice("Tomorrow", Duration.ofDays(1)))
    /** The push's Later: an hour. */
    val laterDuration: Duration = Duration.ofHours(1)

    /** The choices that come back before the deadline: a reminder after it would remind nobody. */
    fun snoozeChoices(request: OwnerRequest, now: Instant): List<SnoozeChoice> {
        val deadline = parse(request.expiresAt) ?: return snoozeChoices
        return snoozeChoices.filter { now.plus(it.duration).isBefore(deadline) }
    }

    /** How many requests are waiting: a request put off for later is not counted until it comes back. */
    fun waitingCount(requests: List<OwnerRequest>, snoozes: Map<String, Long>, now: Instant): Int =
        requests.count { it.pending && (snoozes[key(it.id)] ?: 0) <= now.toEpochMilli() }

    /** The one spelling a request is kept under on this device (a push names the UUID, a read may name the short id). */
    fun key(id: String): String = canonicalId(id) ?: id

    /** This session's requests, oldest first, each once: pending ones come from their own read as well. */
    fun forSession(sessionId: String, vararg lists: List<OwnerRequest>): List<OwnerRequest> {
        val byId = LinkedHashMap<String, OwnerRequest>()
        lists.forEach { list -> list.filter { same(it.askedBySessionId, sessionId) }.forEach { byId[key(it.id)] = it } }
        return byId.values.sortedBy { parse(it.createdAt) ?: Instant.MIN }
    }

    /**
     * Where each request goes in a conversation (web `decisionReceiptAnchor`): after the last row stamped at or before it was filed,
     * by the row's index, or -1 ahead of every row. Requests with no readable moment are left out.
     */
    fun place(rowTimes: List<String?>, requests: List<OwnerRequest>): Map<Int, List<OwnerRequest>> {
        val times = rowTimes.map(::parse)
        return requests.mapNotNull { request ->
            val at = parse(request.createdAt) ?: return@mapNotNull null
            times.indexOfLast { it != null && !it.isAfter(at) } to request
        }.groupBy({ it.first }, { it.second })
    }

    /** A link the card may open: only a web page, because the address is an agent's words. */
    fun openableLink(link: String): String? = runCatching { java.net.URI(link) }.getOrNull()
        ?.takeIf { it.scheme?.lowercase() in setOf("http", "https") }?.let { link }

    internal fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    private fun same(a: String?, b: String?) = a == b || (a != null && b != null && canonicalId(a) != null && canonicalId(a) == canonicalId(b))

    /** The UUID a public id spells (OrbitKit `PublicID`), lowercase. */
    private fun canonicalId(value: String): String? {
        if (value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))) return value.lowercase()
        val alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        if (value.isEmpty() || value.length > 22 || value.any { it !in alphabet }) return null
        var number = java.math.BigInteger.ZERO
        value.forEach { number = number * java.math.BigInteger.valueOf(62) + java.math.BigInteger.valueOf(alphabet.indexOf(it).toLong()) }
        if (number.bitLength() > 128) return null
        val hex = number.toString(16).padStart(32, '0')
        return "${hex.take(8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }
}

/**
 * The owner's doors on owner requests. A secret's value goes in one request body built here and is never kept: not in a cache, a
 * log, a saved state or an error (the transport redacts both request and response).
 */
class OwnerRequestsApi(private val api: OrbitApi, private val handle: SessionHandle) {
    suspend fun list(state: String): List<OwnerRequest> =
        Wire.decode(api.request(handle, ApiRequest(listOf("owner-requests"), query = listOf("state" to state))).requireSuccess().body,
            OwnerRequestList.serializer()).requests

    suspend fun get(id: String): OwnerRequest =
        Wire.decode(api.request(handle, ApiRequest(listOf("owner-requests", id))).requireSuccess().body, OwnerRequest.serializer())

    suspend fun done(id: String, option: Int? = null, text: String? = null): OwnerRequest = post(id, listOf("done"), buildJsonObject {
        option?.let { put("option", it) }; text?.let { put("text", it) }
    })

    suspend fun decline(id: String, reason: String): OwnerRequest = post(id, listOf("decline"), buildJsonObject { put("reason", reason) })

    /** The key itself, optionally saved under [saveAs]. */
    suspend fun provide(id: String, value: String, saveAs: String? = null): OwnerRequest =
        post(id, listOf("secret"), buildJsonObject { put("value", value); saveAs?.let { put("saveAs", it) } })

    /** A saved secret instead of a typed key. */
    suspend fun provideSaved(id: String, savedSecretId: String): OwnerRequest =
        post(id, listOf("secret"), buildJsonObject { put("savedSecretId", savedSecretId) })

    suspend fun cancelSecret(id: String): OwnerRequest = post(id, listOf("secret", "cancel"), null)
    suspend fun revokeSecret(id: String): OwnerRequest = post(id, listOf("secret", "revoke"), null)

    suspend fun accountSecrets(): List<AccountSecret> =
        Wire.decode(api.request(handle, ApiRequest(listOf("account-secrets"))).requireSuccess().body, AccountSecretList.serializer()).secrets

    private suspend fun post(id: String, door: List<String>, body: JsonObject?): OwnerRequest {
        val bytes = body?.toString()?.encodeToByteArray()
        try {
            val response = api.request(handle, ApiRequest(listOf("owner-requests", id) + door, HttpMethod.POST, body = bytes)).requireSuccess()
            return Wire.decode(response.body, OwnerRequest.serializer())
        } finally { bytes?.fill(0) }
    }
}
