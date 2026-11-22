package io.orbitd.android.core.protocol

import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.*
import org.junit.Test

/** Plan step 0.7: a session list with a status word this build does not know, or a row with no status, still decodes whole. */
class SessionStatusDecodeTest {
    private val list = """[
        {"id":"new-word","status":"SOME_NEW_WORD"},
        {"id":"no-status","title":"Untitled"},
        {"id":"known","status":"RUNNING"}
    ]"""

    private fun rows() = Wire.decode(list.encodeToByteArray(), ListSerializer(SessionSummary.serializer()))

    @Test fun anUnknownStatusRowDecodes() {
        val row = rows().single { it.id == "new-word" }
        assertEquals("SOME_NEW_WORD", row.status)
        assertTrue(SessionAction.entries.none(row::allows))
    }

    @Test fun aMissingStatusRowDecodesAsUnknown() {
        val row = rows().single { it.id == "no-status" }
        assertEquals("UNKNOWN", row.status)
        assertTrue(SessionAction.entries.none(row::allows))
    }

    @Test fun theWholeListIsPresent() {
        assertEquals(listOf("new-word", "no-status", "known"), rows().map { it.id })
        assertEquals("RUNNING", rows().single { it.id == "known" }.status)
    }
}
