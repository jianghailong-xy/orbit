package io.orbitd.android.core.realtime

import io.orbitd.android.core.protocol.JsonCompactor
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** One answer to `GET sessions?view=open&since=<cursor>` (docs/list-freshness-design.md §3; OrbitKit `OpenListRead`). */
internal sealed interface OpenListRead {
    /** The whole list, and the cursor to ask the next delta against: the server's answer to a first read and to a cursor it no
     * longer holds (`full: true`). [cursor] is null from a server that has no delta read and answers the plain array. */
    data class Full(val rows: List<JsonObject>, val cursor: String?) : OpenListRead

    /** What changed since the cursor the read was asked against: rows whose content moved (new ones included), ids that left the
     * list, and the whole id order — only when it moved. */
    data class Delta(val upserts: List<JsonObject>, val removedIds: List<String>, val order: List<String>?, val cursor: String) : OpenListRead {
        /** [base] — the list as the server last sent it under the cursor this answers — brought up to the server's list now, in the
         * server's order. Null when the two cannot be the same list (a row the order names that neither side has, or an upsert
         * outside the order or the base), which the caller answers by reading the whole list again. */
        fun applied(base: List<JsonObject>): List<JsonObject>? {
            val fresh = upserts.associateBy { it.text("id") }
            if (order != null) {
                if (!order.toSet().containsAll(fresh.keys)) return null
                val held = base.associateBy { it.text("id") }
                return order.map { id -> fresh[id] ?: held[id] ?: return null }
            }
            // No order: every row kept its place, so nothing can have been added.
            val removed = removedIds.toSet()
            var replaced = 0
            val list = base.filter { it.text("id") !in removed }.map { row -> fresh[row.text("id")]?.also { replaced++ } ?: row }
            return if (replaced == fresh.size) list else null
        }
    }

    @Serializable
    private class Body(val full: Boolean = false, val sessions: List<JsonObject>? = null, val upserts: List<JsonObject>? = null,
        val removedIds: List<String>? = null, val order: List<String>? = null, val cursor: String)

    companion object {
        /** The wire body: the delta object, or — from a server that predates it — the plain array. A row [held] answers with an
         * equal one the caller already holds is that one; the rest are compacted, as [Wire.objects] does. */
        fun decode(bytes: ByteArray, held: (JsonObject) -> JsonObject? = { null }): OpenListRead {
            val first = bytes.firstOrNull { it != ' '.code.toByte() && it != '\n'.code.toByte() && it != '\r'.code.toByte() && it != '\t'.code.toByte() }
            if (first == '['.code.toByte()) return Full(Wire.objects(bytes, held), null)
            val body = Wire.stream(bytes, Body.serializer())
            val compactor = JsonCompactor()
            fun rows(list: List<JsonObject>?) = list.orEmpty().map { row -> held(row) ?: compactor.compact(row) }
            return if (body.full) Full(rows(body.sessions), body.cursor)
                else Delta(rows(body.upserts), body.removedIds.orEmpty(), body.order, body.cursor)
        }
    }
}
