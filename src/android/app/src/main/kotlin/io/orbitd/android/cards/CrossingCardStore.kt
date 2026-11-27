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
 * The cross-project requests a conversation draws as cards (`CrossingCards`): the coordinated project's crossings as
 * `GET /projects/:id/handoffs` last answered, the move batches `GET /sessions/:id/task-moves` serves a session — the ones it asked for,
 * and the ones into a project it coordinates — and what this process knows beside them — which cards it saw waiting, which it answered
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
        /** Each session's move batches as its task-moves read last answered, by session id. */
        val sessionMoves: Map<String, List<CrossingBatch>> = emptyMap(),
        /** What the batch door said to a move batch's one answer it did not record, by card id: it names every move whose key no longer
         * matched, and nothing was written. */
        val batchRefusals: Map<String, ProjectCrossings.Refusal> = emptyMap(),
    ) {
        fun batches(projectId: String) = CrossingCards.batches(rows[projectId].orEmpty(), projectId)
        /** The cards a conversation draws: the crossings into the project it coordinates, if any, and the move batches it is served. */
        fun batches(projectId: String?, sessionId: String?) =
            CrossingCards.merged(projectId?.let(::batches).orEmpty(), sessionId?.let { sessionMoves[it] }.orEmpty())
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

    /** Read the move batches [sessionId] draws again. An answered card this conversation already drew stays when the read's window
     * slides past it: a record that disappeared would be a decision the conversation forgot. */
    fun loadMoves(sessionId: String) { scope.launch { readMoves(sessionId) } }

    private suspend fun readMoves(sessionId: String) {
        try {
            val read = api.taskMoves(sessionId) as? kotlinx.serialization.json.JsonArray ?: return
            val next = read.mapNotNull { (it as? JsonObject)?.let(CrossingCards::batch) }
            if (!live()) return
            mutable.update { state ->
                val kept = state.sessionMoves[sessionId].orEmpty().filter { old -> !old.live && next.none { it.id == old.id } }
                state.copy(sessionMoves = state.sessionMoves + (sessionId to next + kept),
                    seenLive = state.seenLive + next.filter { it.live }.map { it.id })
            }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* The cards keep the last read. */ }
    }

    fun open(batchId: String) = mutable.update { it.copy(review = batchId) }
    fun close() = mutable.update { it.copy(review = null) }

    /** Approve or Refuse every row of [batch] still waiting. A move batch is ONE answer through the session's batch door, every move
     * with the crossing key the card read ([CrossingCards.moveRequest]); if the server refuses it nothing was written, and its words
     * stay on the card. Any other kind is one answer per row with its own crossing key, one after another (the project's writes go one
     * at a time): a refused one keeps the door's words on its row, and the ones taken stay taken. Then both reads run again. */
    fun decide(projectId: String?, sessionId: String?, batch: CrossingBatch, approve: Boolean) {
        if (batch.id in mutable.value.sending) return
        val rows = batch.pending
        if (rows.isEmpty()) return
        val byBatch = batch.kind == ProjectCrossings.moveKind && sessionId != null
        if (!byBatch && projectId == null) return
        mutable.update { it.copy(sending = it.sending + batch.id) }
        scope.launch {
            try {
                if (byBatch) {
                    val refusal = try { api.decideMoveBatch(sessionId!!, batch, approve); null }
                        catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { ProjectCrossings.refusal(failure) }
                    mutable.update { state ->
                        if (refusal != null) state.copy(batchRefusals = state.batchRefusals + (batch.id to refusal))
                        else state.copy(batchRefusals = state.batchRefusals - batch.id,
                            pressed = if (batch.id in state.pressed) state.pressed else state.pressed + (batch.id to Instant.now()))
                    }
                } else rows.forEach { row ->
                    val door = ProjectCrossings.doorId(row)
                    val refusal = try { api.decideCrossing(projectId!!, row, approve); null }
                        catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { ProjectCrossings.refusal(failure) }
                    mutable.update { state ->
                        if (refusal != null) state.copy(refusals = state.refusals + (door to refusal))
                        else state.copy(refusals = state.refusals - door,
                            pressed = if (batch.id in state.pressed) state.pressed else state.pressed + (batch.id to Instant.now()))
                    }
                }
                projectId?.let { read(it) }
                sessionId?.let { readMoves(it) }
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
