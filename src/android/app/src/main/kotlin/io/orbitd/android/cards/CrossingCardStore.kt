package io.orbitd.android.cards

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.projects.CrossingBatch
import io.orbitd.android.projects.CrossingCards
import io.orbitd.android.projects.CrossingReceipt
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectCrossings
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * The cross-project requests a coordinator conversation draws as cards (`CrossingCards`): the coordinated project's crossings as
 * `GET /projects/:id/handoffs` last answered, and what this process knows beside them — which cards it saw waiting, which it answered
 * itself and when, and what the door refused, by row. One store per signed-in handle, so a conversation opened again keeps them.
 */
class CrossingCardStore internal constructor(private val auth: AuthSession, val handle: SessionHandle, private val scope: CoroutineScope,
    private val api: ProjectApi) {

    data class State(
        /** The crossings each project was last read with. */
        val rows: Map<String, List<JsonObject>> = emptyMap(),
        /** Cards this process saw waiting. */
        val seenLive: Set<String> = emptySet(),
        /** Cards this process answered, and when the press was. */
        val pressed: Map<String, Instant> = emptyMap(),
        /** Cards whose answers are on their way. */
        val sending: Set<String> = emptySet(),
        /** What the door said to a row's answer it did not record, by the row's door id. */
        val refusals: Map<String, ProjectCrossings.Refusal> = emptyMap(),
        /** The card whose review is open. */
        val review: String? = null,
    ) {
        fun batches(projectId: String) = CrossingCards.batches(rows[projectId].orEmpty(), projectId)
        /** The rows still waiting that the door refused an answer for. */
        fun refused(batch: CrossingBatch) = batch.pending.filter { ProjectCrossings.doorId(it) in refusals }
        fun receipt(batch: CrossingBatch): CrossingReceipt? = CrossingCards.receipt(batch,
            CrossingCards.answerer(batch.id in seenLive, batch.id in pressed), pressed[batch.id])
    }

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    private fun live() = (auth.state.value as? AuthState.SignedIn)?.handle === handle

    /** Read the project's crossings again; a read that fails keeps what the cards last showed. */
    fun load(projectId: String) { scope.launch { read(projectId) } }

    private suspend fun read(projectId: String) {
        try {
            val rows = api.crossings(projectId)
            if (!live()) return
            mutable.update { state ->
                val waiting = CrossingCards.batches(rows, projectId).filter { it.live }.map { it.id }
                state.copy(rows = state.rows + (projectId to rows), seenLive = state.seenLive + waiting)
            }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* The cards keep the last read. */ }
    }

    fun open(batchId: String) = mutable.update { it.copy(review = batchId) }
    fun close() = mutable.update { it.copy(review = null) }

    /** Approve or Refuse every row of [batch] still waiting, one answer each with its own crossing key, one after another (the
     * project's writes go one at a time). A refused one keeps the door's words on its row; the ones taken stay taken. Then the
     * crossings are read again. */
    fun decide(projectId: String, batch: CrossingBatch, approve: Boolean) {
        if (batch.id in mutable.value.sending) return
        val rows = batch.pending
        if (rows.isEmpty()) return
        mutable.update { it.copy(sending = it.sending + batch.id) }
        scope.launch {
            try {
                rows.forEach { row ->
                    val door = ProjectCrossings.doorId(row)
                    val refusal = try { api.decideCrossing(projectId, row, approve); null }
                        catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { ProjectCrossings.refusal(failure) }
                    mutable.update { state ->
                        if (refusal != null) state.copy(refusals = state.refusals + (door to refusal))
                        else state.copy(refusals = state.refusals - door,
                            pressed = if (batch.id in state.pressed) state.pressed else state.pressed + (batch.id to Instant.now()))
                    }
                }
                read(projectId)
            } finally { mutable.update { it.copy(sending = it.sending - batch.id) } }
        }
    }

    companion object {
        private var shared: CrossingCardStore? = null

        fun of(auth: AuthSession, handle: SessionHandle, scope: CoroutineScope, writable: () -> Boolean): CrossingCardStore {
            shared?.takeIf { it.handle === handle }?.let { return it }
            return CrossingCardStore(auth, handle, scope, ProjectApi(auth, handle, writable)).also { shared = it }
        }
    }
}
