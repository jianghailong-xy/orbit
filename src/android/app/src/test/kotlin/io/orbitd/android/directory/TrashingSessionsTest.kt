package io.orbitd.android.directory

import io.orbitd.android.navigation.ObjectId
import org.junit.Assert.*
import org.junit.Test

/** A05-9 (iOS 62b7009ca `trashingSessions`): what is held out of the lists, by either spelling of a session's id, and the count of
 * releases a list read checks to tell whether one overlapped it. */
class TrashingSessionsTest {
    private val uuid = "0199c3a1-7a2b-7c3d-8e4f-123456789abc"
    private data class Row(val id: String?)

    @Test fun aHeldSessionIsLeftOutUnderEitherSpellingOfItsId() {
        val trashing = TrashingSessions()
        val rows = listOf(Row(ObjectId.toPublic(uuid)), Row("other"), Row(null))
        assertEquals(rows, trashing.without(rows) { it.id })
        trashing.hide(uuid)
        assertEquals(listOf(Row("other"), Row(null)), trashing.without(rows) { it.id })
        assertEquals(setOf(uuid), trashing.ids.value)
    }

    @Test fun onlyALetGoCountsAsARelease() {
        val trashing = TrashingSessions()
        trashing.reveal(uuid)
        assertEquals("nothing was held", 0L, trashing.releases)
        trashing.hide(uuid)
        assertEquals(0L, trashing.releases)
        trashing.reveal(ObjectId.toPublic(uuid))
        assertEquals(1L, trashing.releases)
        assertTrue(trashing.ids.value.isEmpty())
        trashing.reveal(uuid)
        assertEquals("a second let-go of the same session is no release", 1L, trashing.releases)
    }
}
