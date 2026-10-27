package io.orbitd.android.core.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** A04c: rows read through Wire.objects are compacted; nothing that reads them may tell. */
class CompactJsonTest {
    private val source = """{"id":"s1","title":"会话目录 cache","status":"COMPLETED","costUsd":0.25,"numTurns":3,"pinnedAt":null,""" +
        """"shared":false,"tags":[{"id":"t1","name":"red","isSystem":false},{"id":"t2","name":"blue","isSystem":false}],""" +
        """"capabilities":{"canSend":true,"canDelete":true},"escaped":"line\nbreak \"quoted\" \\ \u0001","empty":{},"none":[]}"""
    private fun plain(json: String) = Wire.decode(json.encodeToByteArray(), JsonObject.serializer())

    @Test fun aCompactedObjectIsTheObjectItWasMadeFrom() {
        val original = plain(source)
        val compact = JsonCompactor().compact(original)
        assertEquals(original, compact)
        assertEquals(compact, original)
        assertEquals(original.hashCode(), compact.hashCode())
        assertEquals(original.keys.toList(), compact.keys.toList())
        assertEquals(original.toString(), compact.toString())
        assertEquals(Wire.json.encodeToString(JsonObject.serializer(), original), Wire.json.encodeToString(JsonObject.serializer(), compact))
        assertEquals(original, plain(compact.toString()))
        for ((key, value) in original) {
            assertTrue(key in compact)
            assertEquals(value, compact[key])
        }
        assertNull(compact["missing"])
        assertFalse("missing" in compact)
        assertEquals(original["tags"], compact["tags"])
        assertEquals(original.size, compact.size)
        assertEquals(original.entries, compact.entries)
        assertEquals(original.values.toList(), compact.values.toList())
        assertEquals(original["capabilities"]!!.jsonObject, compact["capabilities"]!!.jsonObject)
    }

    @Test fun rowsOfOneReadShareTheirKeysAndEqualValues() {
        val rows = Wire.objects("""[$source,${source.replace("\"s1\"", "\"s2\"").replace("0.25", "0.5")}]""".encodeToByteArray())
        val (first, second) = rows
        assertEquals(listOf(plain(source).keys.toList(), plain(source).keys.toList()), rows.map { it.keys.toList() })
        first.keys.zip(second.keys).forEach { (a, b) -> assertSame(a, b) }
        assertSame(first["status"], second["status"])
        assertSame(first["title"], second["title"])
        assertSame((first["tags"] as JsonArray)[0].jsonObject["name"], (second["tags"] as JsonArray)[0].jsonObject["name"])
        assertNotSame(first["id"], second["id"])
        assertEquals("s2", (second["id"] as JsonPrimitive).content)
        assertEquals(plain(source), first)
    }
}
