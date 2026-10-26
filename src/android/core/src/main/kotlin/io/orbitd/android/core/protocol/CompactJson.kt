package io.orbitd.android.core.protocol

import java.util.AbstractMap.SimpleImmutableEntry
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What the rows of one list read repeat, held once (A04c: an owner's 5,945 Completed rows took 72 MB of heap, 4.2 times their
 * JSON, mostly a key string, a map entry and a wrapper for each of their ~360k values). Objects with the same keys share one
 * key table and keep their values in an array; equal primitives are one object. A compacted object is a read-only map with
 * the order, equality, hash and JSON of the one it was made from.
 */
internal class JsonCompactor {
    private val shapes = HashMap<List<String>, Shape>()
    private val primitives = HashMap<JsonPrimitive, JsonPrimitive>()

    fun compact(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> compact(element)
        is JsonArray -> JsonArray(element.map(::compact))
        is JsonPrimitive -> primitives.getOrPut(element) { element }
    }

    fun compact(row: JsonObject): JsonObject {
        val keys = row.keys.toList()
        val shape = shapes.getOrPut(keys) { Shape(keys.toTypedArray()) }
        val cells = arrayOfNulls<JsonElement>(keys.size)
        row.values.forEachIndexed { index, value -> cells[index] = compact(value) }
        @Suppress("UNCHECKED_CAST")
        return JsonObject(Row(shape, cells as Array<JsonElement>))
    }

    private class Shape(val keys: Array<String>) {
        val index = HashMap<String, Int>(keys.size * 2).also { index -> keys.forEachIndexed { at, key -> index[key] = at } }
    }

    private class Row(private val shape: Shape, private val cells: Array<JsonElement>) : AbstractMap<String, JsonElement>() {
        override val size get() = cells.size
        override fun containsKey(key: String) = key in shape.index
        override fun get(key: String) = shape.index[key]?.let { cells[it] }
        override val entries: Set<Map.Entry<String, JsonElement>> get() = object : AbstractSet<Map.Entry<String, JsonElement>>() {
            override val size get() = cells.size
            override fun iterator() = cells.indices.asSequence().map { SimpleImmutableEntry(shape.keys[it], cells[it]) }.iterator()
        }
    }
}
