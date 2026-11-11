package io.orbitd.android.projects

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LandingCheckSettingsTest {
    @Test fun commandAndBudgetSaveIndependentlyWithoutTrimmingTheCommand() {
        val view = Json.parseToJsonElement("""{"landingCheckCommand":null,"landingCheckTimeoutSeconds":null}""").jsonObject
        val set = landingCheckWrite(view, "  make fast  ", 600)!!
        assertEquals("  make fast  ", set["landingCheckCommand"]!!.jsonPrimitive.content)
        assertEquals(600, set["landingCheckTimeoutSeconds"]!!.jsonPrimitive.int)
        val clear = landingCheckWrite(set, " ", null)!!
        assertEquals(JsonNull, clear["landingCheckCommand"])
        assertEquals(JsonNull, clear["landingCheckTimeoutSeconds"])
        assertNull(landingCheckWrite(view, "", null))
    }
}
