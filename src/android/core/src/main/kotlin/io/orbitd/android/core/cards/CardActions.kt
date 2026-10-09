package io.orbitd.android.core.cards

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.security.MessageDigest

data class CardActionState(val busy: Boolean = false, val message: String? = null,
    val response: JsonObject? = null, val uncertain: Boolean = false, val settled: Boolean = false,
    val binding: String? = null)

/** No optimistic removal. RealtimeStore owns authority and re-reads after every write attempt.
 * A lost response leaves a durable fence, never an automatic replay of a business decision. */
class CardActions(private val auth: AuthSession, private val store: RealtimeStore,
    private val scope: CoroutineScope) {
    private val mutable = MutableStateFlow<Map<String, CardActionState>>(emptyMap())
    val state = mutable.asStateFlow()

    fun valid(handle: SessionHandle, sessionId: String) = store.canAct(handle, sessionId)

    suspend fun restore(handle: SessionHandle, cards: List<InteractionCard>) {
        for (card in cards.filter { it.actions.isNotEmpty() }) {
            val known = mutable.value[card.key]
            if (known?.busy == true || known?.binding == card.binding && (known.settled || known.uncertain)) continue
            if (mutable.value[card.key]?.binding != card.binding) mutable.update { it - card.key }
            val saved = auth.readData(handle, DataKind.CACHE, fenceKey(card))?.decodeToString()
            if (saved == "sent" || saved == "uncertain") mutable.update { it + (card.key to CardActionState(
                message = if (saved == "sent") "Request accepted. Checking the server's current state…" else uncertainMessage,
                uncertain = saved == "uncertain", settled = saved == "sent", binding = card.binding)) }
        }
    }

    fun submit(handle: SessionHandle, card: InteractionCard, verb: CardVerb, input: CardInput = CardInput()): Job = scope.launch {
        // Shared across screens/instances: navigation cannot create a second simultaneous press.
        if (!writeLock.tryLock()) {
            if (mutable.value[card.key]?.busy != true) mutable.update { it + (card.key to CardActionState(
                message = "Another decision is being sent. Check status before answering this card.", binding = card.binding)) }
            return@launch
        }
        var posted = false
        val key = fenceKey(card)
        fun update(value: CardActionState) { mutable.update { it + (card.key to value.copy(binding = card.binding)) } }
        try {
            check(valid(handle, card.sessionId)) { "Reconnect to check this card before answering." }
            val request = CardRequests.build(card, verb, input)
            val old = auth.readData(handle, DataKind.CACHE, key)?.decodeToString()
            if (old in setOf("sent", "uncertain")) {
                update(CardActionState(message = if (old == "sent") "Request already accepted. Refresh its server record." else uncertainMessage,
                    uncertain = old == "uncertain", settled = old == "sent")); return@launch
            }
            update(CardActionState(busy = true, message = "Checking current state…"))
            val epoch = store.state.value.invalidationRevision
            val current = CardAuthority(auth, handle).read(card)
            check(valid(handle, card.sessionId) && epoch == store.state.value.invalidationRevision) { "The session changed. Refresh this card." }
            check(current != null && current.binding == card.binding && verb in current.actions) { "This card changed or was handled elsewhere. Refresh to read the current state." }
            // Written before transport: a process killed while POST is in flight must not forget it.
            auth.writeData(handle, DataKind.CACHE, key, "uncertain".encodeToByteArray())
            if (!valid(handle, card.sessionId) || epoch != store.state.value.invalidationRevision) {
                auth.writeData(handle, DataKind.CACHE, key, ByteArray(0))
                error("The session changed. Refresh this card.")
            }
            update(CardActionState(busy = true, message = "Sending…"))
            posted = true
            val response = auth.request(handle, request)
            val body = response.body.takeIf { it.isNotEmpty() }?.let { Wire.decode(it, JsonElement.serializer()) }
            val objectBody = body as? JsonObject
            check(objectBody?.get("ok") != JsonPrimitive(false)) { "The server did not accept this request." }
            // In an approval race the door returns the winning decision, possibly NOT this click.
            val message = when {
                card.key.startsWith("approval:") -> when (objectBody?.text("status")) {
                    "ALLOWED" -> "Allowed · recorded by the server"
                    "DENIED" -> "Denied · recorded by the server"
                    "EXPIRED" -> "This approval expired."
                    else -> "Request answered. Refresh to read the server record."
                }
                verb == CardVerb.OWNER_ANSWER -> if (objectBody?.obj("delivery") != null) "Answer recorded and delivered." else "Answer recorded. Waiting for a coordinator."
                else -> "Request accepted. Refreshing the server's current state…"
            }
            auth.writeData(handle, DataKind.CACHE, key, "sent".encodeToByteArray())
            update(CardActionState(message = message, response = objectBody, settled = true))
        } catch (cancel: CancellationException) {
            if (posted) update(CardActionState(message = uncertainMessage, uncertain = true))
            throw cancel
        } catch (error: Exception) {
            val definitive = error is ApiError && error.status in 400..499 && error.status !in setOf(408, 429)
            if (posted && definitive) auth.writeData(handle, DataKind.CACHE, key, ByteArray(0))
            val unknown = posted && !definitive
            if (error is ApiError && error.status in setOf(403, 404)) {
                // A decision's 404 can mean only that item vanished. Withdraw the session only
                // when its own door confirms lost access, using A06's durable revocation path.
                try { auth.request(handle, ApiRequest(listOf("sessions", card.sessionId))) }
                catch (denied: ApiError) { if (denied.status in setOf(403, 404)) store.reportReadDenial(handle, card.sessionId, denied) }
                catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { /* Uncertain session access remains stale until A04 re-reads. */ }
            }
            val reason = (error as? ApiError)?.let { it.messages.joinToString("\n").ifBlank { null } ?: "the server returned ${it.status}" }
            val message = when {
                unknown -> uncertainMessage
                error is ApiError && error.status == 403 -> "Permission denied. Refresh to check your access."
                // The confirmation door's refusals in its own words (OrbitKit `OwnerConfirmations.refusalTitle`): an out-of-date
                // card says so, whatever else refused it says "Not recorded".
                error is ApiError && card.family == CardFamily.OWNER_CONFIRMATION && verb in setOf(CardVerb.CONFIRM_OWNER, CardVerb.SEND_BACK) ->
                    "${OwnerReview.refusalTitle(error.code)} — $reason."
                error is ApiError && verb == CardVerb.REOPEN_TASK -> "Task status was not changed — $reason."
                error is ApiError && error.status in setOf(404, 409, 410) -> listOfNotNull("This card changed, expired, or was handled elsewhere.", error.code,
                    (error.body as? JsonObject)?.text("requiredAction")).joinToString("\n")
                error is ApiError -> (error.messages.firstOrNull() ?: "The request was refused.") + (error.code?.let { "\n$it" } ?: "")
                error is IllegalArgumentException || error is IllegalStateException -> error.message ?: "Refresh this card."
                else -> "Couldn't check this card. Reconnect and refresh."
            }
            update(CardActionState(message = message, uncertain = unknown, response = (error as? ApiError)?.body as? JsonObject))
        } finally {
            store.refreshSession(); store.refreshDirectory()
            writeLock.unlock()
        }
    }

    companion object {
        private val writeLock = Mutex()
        const val uncertainMessage = "The request may have reached the server. Check status before taking another action; it has not been resent."
        private fun fenceKey(card: InteractionCard): String = "card-write-" + MessageDigest.getInstance("SHA-256")
            .digest("${card.key}:${card.binding}".encodeToByteArray()).joinToString("") { "%02x".format(it) }
    }
}

/** Re-read the specific door at the press, then compare the version that was actually shown. */
class CardAuthority(private val api: OrbitApi, private val handle: SessionHandle) {
    suspend fun get(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(api.request(handle, ApiRequest(path, query = query)).body, JsonElement.serializer())

    suspend fun read(card: InteractionCard): InteractionCard? {
        if (card.family == CardFamily.WIKI || card.family == CardFamily.BACKGROUND) return readAuxiliary(card)
        // Session REST verifies ownership, active approvals, queues and standing questions together.
        val snapshot = RealtimeRest(api).session(handle, card.sessionId)
        return CardCatalog.session(card.sessionId, snapshot).firstOrNull { it.key == card.key }
    }

    private suspend fun readAuxiliary(card: InteractionCard): InteractionCard? = when (card.context.text("resource")) {
        "wikiChangeset" -> AuxiliaryCards.wikiChangeset(card.sessionId,
            get(listOf("wiki", "changesets", requireNotNull(card.source.text("changesetId")))) as JsonObject).firstOrNull { it.key == card.key }
        "wikiEntry" -> AuxiliaryCards.wikiEntry(card.sessionId, get(listOf("wiki", "entries", card.objectId)) as JsonObject)
        "wikiPlan" -> AuxiliaryCards.wikiPlan(card.sessionId,
            get(listOf("wiki", "spaces", requireNotNull(card.source.text("spaceId")), "plan")) as JsonObject).firstOrNull { it.key == card.key }
        "watch" -> AuxiliaryCards.watch(card.sessionId, get(listOf("watches", card.objectId)) as JsonObject)
        else -> null
    }
}
