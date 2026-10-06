package io.orbitd.android.watch

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*

/** Preserve the wire record for A08's authoritative bindings and forward-compatible vocabulary. */
data class WatchRecord(val raw: JsonObject) {
    val id: String get() = requireNotNull(raw.text("id"))
    val state get() = raw.text("state") ?: "UNKNOWN"
    val live get() = state in setOf("ACTIVE", "PAUSED")
    val action get() = raw.text("action")
    val observer get() = raw.text("observerSessionId")
    val targets get() = raw.objects("targets")
    val liveTargets get() = targets.filter { it.text("state") != "GONE" }
    val predicate get() = raw.obj("predicate") ?: JsonObject(emptyMap())
    val matches get() = raw.objects("matches")
    val ends get() = raw.objects("expiryDeliveries")
    val deliveries get() = matches.flatMap { it.objects("deliveries") } + ends
    val card get() = requireNotNull(AuxiliaryCards.watch(observer.orEmpty(), raw))
}

class WatchApi(private val api: OrbitApi, private val handle: SessionHandle, private val canMutate: () -> Boolean = { true }) {
    private suspend fun read(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(api.request(handle, ApiRequest(path, query = query)).body, JsonElement.serializer())

    suspend fun get(id: String) = WatchRecord(read(listOf("watches", id)).jsonObject)

    /** Four reads match APIClient.followedWatches: a long history cannot evict live/attention rows. */
    suspend fun followed(): List<WatchRecord> {
        val lists = listOf(listOf("state" to "ACTIVE"), listOf("state" to "PAUSED"), emptyList(), listOf("needsAttention" to "true"))
            .map { query -> read(listOf("watches"), query).jsonArray.map { WatchRecord(it.jsonObject) } }
        return lists.flatten().distinctBy { ObjectId.canonical(it.id) ?: it.id }
            .sortedByDescending { WatchProjection.instant(it.raw.text("createdAt")) }
    }

    /** The same card authority, binding and request builders as the session interaction cards. */
    suspend fun control(shown: WatchRecord, verb: CardVerb): WatchRecord {
        if (!canMutate()) throw WatchChanged()
        require(verb in shown.card.actions)
        val fresh = requireNotNull(CardAuthority(api, handle).read(shown.card))
        if (!canMutate() || fresh.binding != shown.card.binding || verb !in fresh.actions) throw WatchChanged()
        return WatchRecord(Wire.decode(api.request(handle, CardRequests.build(fresh, verb)).body, JsonObject.serializer()))
    }

    suspend fun followTask(taskId: String, predicate: JsonObject, ttlSeconds: Int, idempotencyKey: String): WatchRecord {
        if (!canMutate()) throw WatchChanged()
        require(predicate in WatchProjection.followConditions && ttlSeconds in WatchProjection.deadlines)
        require(idempotencyKey.isNotBlank())
        val body = buildJsonObject {
            put("predicateVersion", 1); put("predicate", predicate)
            putJsonArray("targets") { add(buildJsonObject { put("kind", "TASK"); put("id", taskId) }) }
            put("action", "NOTIFY_USER"); put("ttlSeconds", ttlSeconds); put("idempotencyKey", idempotencyKey)
        }
        return WatchRecord(Wire.decode(api.request(handle,
            ApiRequest(listOf("watches"), HttpMethod.POST, body = body.toString().encodeToByteArray())).body, JsonObject.serializer()))
    }
}

private class WatchChanged : Exception()

data class WatchState(
    val watches: List<WatchRecord> = emptyList(), val loading: Boolean = false, val fresh: Boolean = false,
    val loaded: Boolean = false, val busy: Boolean = false, val error: String? = null,
    val unavailable: Boolean = false,
)

/** No optimistic mutations or replay after recreation: the next view reads the server record. */
class WatchModel(private val api: WatchApi, private val id: String? = null) {
    private val mutable = MutableStateFlow(WatchState())
    val state = mutable.asStateFlow()
    private var generation = 0L

    fun invalidate() { generation++; mutable.value = mutable.value.copy(fresh = false, loading = false) }

    suspend fun load() {
        if (mutable.value.busy) return
        val request = ++generation
        mutable.value = mutable.value.copy(loading = true, fresh = false, error = null, unavailable = false)
        try {
            val rows = if (id == null) api.followed() else listOf(api.get(id))
            if (request == generation) mutable.value = WatchState(watches = rows, fresh = true, loaded = true)
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { if (request == generation) failed(failure) }
        finally { if (request == generation) mutable.value = mutable.value.copy(loading = false) }
    }

    suspend fun control(watch: WatchRecord, verb: CardVerb) {
        if (!mutable.value.fresh || mutable.value.busy || verb !in watch.card.actions) return
        val current = mutable.value.watches.firstOrNull { ObjectId.same(it.id, watch.id) } ?: return
        if (current.card.binding != watch.card.binding) return
        val request = ++generation
        mutable.value = mutable.value.copy(busy = true, error = null)
        try {
            val updated = api.control(watch, verb)
            if (request == generation) mutable.value = mutable.value.copy(
                watches = mutable.value.watches.map { if (ObjectId.same(it.id, updated.id)) updated else it }, fresh = true)
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            if (request == generation) {
                // An ambiguous answer is read back, never automatically replayed.
                val message = if (failure is WatchChanged) "This watch changed. Review its current state before trying again."
                    else directoryError(failure)
                try {
                    val actual = api.get(watch.id)
                    if (request == generation) mutable.value = mutable.value.copy(
                        watches = mutable.value.watches.map { if (ObjectId.same(it.id, actual.id)) actual else it }, fresh = true)
                } catch (cancel: CancellationException) { throw cancel }
                catch (readFailure: Exception) { if (request == generation) failed(readFailure) }
                if (request == generation) mutable.value = mutable.value.copy(error = message)
            }
        } finally { mutable.value = mutable.value.copy(busy = false) }
    }

    private fun failed(failure: Exception) {
        val inaccessible = failure is ApiError && failure.status in setOf(401, 403, 404)
        mutable.value = mutable.value.copy(watches = if (inaccessible) emptyList() else mutable.value.watches,
            fresh = false, loaded = true, unavailable = failure is ApiError && failure.status == 404,
            error = directoryError(failure))
    }
}
