package io.orbitd.android.watch

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement

/** OrbitKit `APIClient`'s watch reads and controls (docs/watch-contract.md) on the signed-in handle. */
internal class WatchClient(private val api: OrbitApi, private val handle: SessionHandle) {
    private suspend fun send(path: List<String>, method: HttpMethod = HttpMethod.GET, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(api.request(handle, ApiRequest(path, method, query)).body, JsonElement.serializer())

    private suspend fun one(path: List<String>, method: HttpMethod = HttpMethod.GET): Watch =
        Watch.decode(send(path, method)) ?: throw ProtocolException()

    private suspend fun list(query: List<Pair<String, String>>): List<Watch> =
        (send(listOf("watches"), query = query) as? JsonArray ?: throw ProtocolException()).mapNotNull(Watch::decode)

    /** `GET /watches`: the newest 100, narrowed to one state when `state` is given. */
    suspend fun watches(state: WatchState? = null): List<Watch> = list(state?.let { listOf("state" to it.name) }.orEmpty())

    /** `GET /watches?needsAttention=true`: the newest 100 watches that need attention, whatever state each is in. */
    suspend fun watchesNeedingAttention(): List<Watch> = list(listOf("needsAttention" to "true"))

    /** Everything Following, a watch's detail and the Watching strip draw from, as one list. Each read answers with
     * at most 100 watches, so the live states and the ones that need attention are read on their own beside the
     * newest of every state: neither a live watch nor a failure waiting to be seen is pushed out by however many
     * watches ended after it. */
    suspend fun followedWatches(): List<Watch> {
        val active = watches(WatchState.ACTIVE)
        val paused = watches(WatchState.PAUSED)
        val recent = watches()
        val attention = watchesNeedingAttention()
        return WatchIndex.merge(listOf(active, paused, recent, attention))
    }

    suspend fun watch(id: String): Watch = one(listOf("watches", id))
    suspend fun pauseWatch(id: String): Watch = one(listOf("watches", id, "pause"), HttpMethod.POST)
    suspend fun resumeWatch(id: String): Watch = one(listOf("watches", id, "resume"), HttpMethod.POST)
    /** Stop: the contract's CANCELLED. */
    suspend fun cancelWatch(id: String): Watch = one(listOf("watches", id, "cancel"), HttpMethod.POST)
}
