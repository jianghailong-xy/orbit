package io.orbitd.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BuildIdentityTest {
    private val sourceRevision = "0123456789abcdef0123456789abcdef01234567"

    @Test
    fun displayIdKeepsVersionVariantAndShortRevision() {
        val identity = BuildIdentity("0.1.0-a02", sourceRevision, "debug", false)

        assertEquals("0.1.0-a02-debug (0123456789ab)", identity.displayId)
        assertEquals(sourceRevision, identity.sourceRevision)
    }

    @Test
    fun uncommittedSourceIsVisibleInBuildId() {
        val identity = BuildIdentity("0.1.0-a02", sourceRevision, "debug", true)

        assertEquals("0.1.0-a02-debug (0123456789ab-dirty)", identity.displayId)
    }

    @Test
    fun rejectsMissingShortOrMalformedSourceRevisions() {
        listOf("", "unknown", sourceRevision.take(12), "g".repeat(40)).forEach { invalid ->
            assertThrows(IllegalArgumentException::class.java) {
                BuildIdentity("0.1.0-a02", invalid, "debug", false)
            }
        }
    }
}
