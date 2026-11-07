package io.orbitd.android.core.realtime

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** OrbitKit `OpenListDelta.applied(to:)`: a delta that cannot be the server's list over its base says so, and the reader reads whole. */
class OpenListDeltaTest {
    private fun row(id: String) = JsonObject(mapOf("id" to JsonPrimitive(id)))

    @Test fun aDeltaThatDoesNotFitItsBaseIsNoList() {
        val base = listOf(row("s1"))
        assertNull("the order names a row neither side has", OpenListRead.Delta(emptyList(), emptyList(), listOf("s1", "s9"), "c1").applied(base))
        assertNull("an upsert outside the order", OpenListRead.Delta(listOf(row("s9")), emptyList(), listOf("s1"), "c1").applied(base))
        assertNull("no order, and an upsert of a row the base does not have", OpenListRead.Delta(listOf(row("s9")), emptyList(), null, "c1").applied(base))
    }

    @Test fun aDeltaWithNoOrderKeepsEveryPlace() {
        val base = listOf(row("s1"), row("s2"), row("s3"))
        val changed = JsonObject(mapOf("id" to JsonPrimitive("s3"), "title" to JsonPrimitive("moved")))
        assertEquals(listOf(row("s1"), changed), OpenListRead.Delta(listOf(changed), listOf("s2"), null, "c1").applied(base))
    }

    @Test fun theWireIsReadAsTheServerSendsIt() {
        assertEquals(OpenListRead.Full(listOf(row("s1")), null), OpenListRead.decode("""[{"id":"s1"}]""".encodeToByteArray()))
        assertEquals(OpenListRead.Full(listOf(row("s1")), "c1"), OpenListRead.decode("""{"full":true,"sessions":[{"id":"s1"}],"cursor":"c1"}""".encodeToByteArray()))
        assertEquals(OpenListRead.Delta(emptyList(), listOf("s2"), null, "c2"),
            OpenListRead.decode("""{"full":false,"upserts":[],"removedIds":["s2"],"cursor":"c2"}""".encodeToByteArray()))
    }
}
