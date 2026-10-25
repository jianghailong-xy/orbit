package io.orbitd.android.projects

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test

/** A08-5 (iOS 698b707ea): the project page names a refused source by the same words the run's own card uses (OrbitKit
 * ProjectPageSectionsTests `testASourceUnresolvedBlockerNamesTheRefusalAndWhoseRunsItRefuses`). */
class ProjectSourceBlockerTest {
    @Test fun aSourceUnresolvedBlockerIsHeadedByTheRefusalsOwnWords() {
        val blocker = buildJsonObject {
            put("kind", "SOURCE_UNRESOLVED"); put("owner", "USER")
            putJsonObject("detail") { put("code", "BASE_REF_NOT_FOUND"); put("fixAction", "FIX_REF"); put("ref", "refs/heads/project/p") }
        }
        val headline = ProjectPage.blockerHeadline(blocker)
        assertEquals("Needs you", headline.tag)
        assertEquals(TagTone.WARNING, headline.tone)
        assertEquals("Its baseline is a branch that doesn't exist yet", headline.title)
    }
}
