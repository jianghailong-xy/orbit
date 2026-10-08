package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** Settings home rows, the profile card's save steps, the workspace form's effort and the share panel's words. */
class SettingsLogicTest {
    @Test fun homeRowsSayWhatSettingsHomeSays() {
        assertEquals("None", settingsRunnersValue(emptyList()))
        assertEquals("1 of 2 online", settingsRunnersValue(listOf(buildJsonObject { put("online", true) }, buildJsonObject { put("online", false) })))
        assertEquals("None", settingsSharedLinksValue(0))
        assertEquals("25 active", settingsSharedLinksValue(25))
        assertEquals("orbit.example.com", settingsInstanceName("https://orbit.example.com/"))
        assertEquals("10.0.2.2:3000", settingsInstanceName("http://10.0.2.2:3000/orbit/"))
        assertEquals("Sign out of orbit.example.com?", settingsSignOutTitle("orbit.example.com"))
        assertEquals("Sign out?", settingsSignOutTitle(null))
        assertEquals(listOf("Default", "Accept Edits", "Plan", "Auto", "Don't Ask", "Bypass"), personalPermissions.map { it.second })
        assertEquals("Share task", settingsTitle("share", "TASK:abc"))
    }

    @Test fun profileSavesThePhotoFirstThenTheNameOnlyWhenEitherChanged() {
        assertFalse(profileCanSave("  ", "Ada", ProfilePhoto.Removed))
        assertFalse(profileCanSave(" Ada ", "Ada", ProfilePhoto.Unchanged))
        assertEquals(listOf<ProfileStep>(ProfileStep.RemovePhoto, ProfileStep.Rename("Bea")), profileSteps(" Bea ", "Ada", ProfilePhoto.Removed))
        assertEquals(listOf<ProfileStep>(ProfileStep.RemovePhoto), profileSteps("Ada", "Ada", ProfilePhoto.Removed))
        assertTrue(profileSteps("Ada", "Ada", ProfilePhoto.Unchanged).isEmpty())
    }

    @Test fun workspaceEffortOffersTheRuntimesVocabulary() {
        assertEquals(listOf("", "low", "medium", "high", "xhigh", "max", "ultra"), WorkspaceEffort.options("claude", null))
        assertEquals(listOf("", "low", "medium", "high", "xhigh", "max", "ultra"), WorkspaceEffort.options("anthropic-2", null))
        val runner = buildJsonObject {
            put("runtimeDefaultModels", buildJsonObject { put("codex", "gpt-5") })
            put("modelCatalog", buildJsonObject { put("codex", buildJsonArray { add(buildJsonObject { put("value", "gpt-5"); put("reasoningLevels", buildJsonArray { add("low"); add("high") }) }) }) })
        }
        assertEquals(listOf("", "low", "high"), WorkspaceEffort.options("codex", runner))
        assertEquals(listOf("", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"), WorkspaceEffort.options("codex", null))
        assertEquals("high", WorkspaceEffort.normalize("medium", "kimi"))
        assertEquals("high", WorkspaceEffort.normalize("max", "antigravity"))
        assertEquals("xHigh", WorkspaceEffort.label("xhigh"))
        assertEquals("Default", WorkspaceEffort.label(""))
    }

    @Test fun sharedLinksAndThePanelSayWhatSharePanelSays() {
        val now = Instant.parse("2026-10-07T12:00:00Z").toEpochMilli()
        assertEquals("Not opened yet", ShareCopy.viewsLine(0, null, now))
        assertEquals("Viewed once · last 2h 5m ago", ShareCopy.viewsLine(1, "2026-10-07T09:55:00Z", now))
        assertEquals("Viewed 4 times · last just now", ShareCopy.viewsLine(4, "2026-10-07T11:59:55Z", now))
        assertEquals("1d 4h", ShareCopy.span(100_800)); assertEquals("9d", ShareCopy.span(9 * 86_400 + 3_600))
        fun link(kind: String, state: String, root: JsonObject, reason: String? = null) = buildJsonObject {
            put("kind", kind); put("state", state); put("root", root); reason?.let { put("stateReason", it) }; put("expiresAt", "2026-10-01T00:00:00Z")
        }
        assertEquals("Task · In progress", ShareCopy.whereLine(link("TASK", "ACTIVE", buildJsonObject { put("status", "IN_PROGRESS") })))
        assertEquals("Project · Completed", ShareCopy.whereLine(link("PROJECT", "ACTIVE", buildJsonObject { put("status", "DONE") })))
        assertEquals("Session · Open", ShareCopy.whereLine(link("SESSION", "ACTIVE", buildJsonObject { put("lifecycleState", "OPEN") })))
        assertEquals("Paused · in Trash — restoring the session turns this link back on", ShareCopy.whereLine(link("SESSION", "PAUSED", JsonObject(emptyMap()))))
        assertTrue(ShareCopy.whereLine(link("SESSION", "ENDED", JsonObject(emptyMap()), "EXPIRED")).startsWith("Session · Expired "))
        assertEquals("Link turned off", ShareCopy.turnedOff(1)); assertEquals("3 links turned off", ShareCopy.turnedOff(3))
        val counts = buildJsonObject { put("comments", 1); put("files", 2); put("transcripts", 3); put("runs", 2); put("tasks", 5) }
        val project = ShareCopy.layers("PROJECT", buildJsonObject { put("taskPages", false) }, counts)
        assertEquals(listOf("Overview", "Task pages", "Comments & files", "Conversations"), project.map { it.name })
        assertEquals(listOf(false, true, false, false), project.map { it.editable })
        assertEquals("1 comment · 2 files", project[2].count)
        assertEquals("2 runs and the coordinator. Can include command output and file contents.", project[3].detail)
        val task = ShareCopy.layers("TASK", JsonObject(emptyMap()), counts)
        assertTrue(task.last().on && task.last().warns)
        assertEquals("Anyone with the link can view — no sign-in. They can’t reply or change anything.", ShareCopy.publicDetail("SESSION"))
        assertFalse(sharingLayerEnabled("PROJECT", "conversations", buildJsonObject { put("taskPages", false) }))
        assertTrue(sharingLayerEnabled("PROJECT", "conversations", JsonObject(emptyMap())))
        assertEquals("Sep 30", ShareCopy.shortDate("2026-09-30T23:00:00Z", ZoneOffset.UTC))
    }
}
