package io.orbitd.android.cards

import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import kotlinx.coroutines.CancellationException

/**
 * Where `orbit://owner-request/<id>` — an owner request push's action — lands (iOS 0efaa61e4 `openOwnerRequest`): the conversation
 * that asked, opened on the request's card. The link names the request only, so its read says which conversation that is
 * (`askedBySessionId`); the card is asked for ([CardFocus]) before the conversation opens, and brought into view once drawn.
 */
object OwnerRequestLinks {
    /** The conversation's route, or null when the request could not be read or names no conversation. */
    suspend fun open(id: String, read: suspend (String) -> OwnerRequest): OrbitRoute? {
        val asked = try { read(id).askedBySessionId } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return null }
        val session = ObjectId.canonical(asked) ?: return null
        CardFocus.request(session, CardFocus.ownerRequest(id))
        return OrbitRoute(Destination.SESSION, session, origin = Origin.EXTERNAL)
    }

    const val unreadable = "Couldn't open that request. Check your connection and try again."
}
