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
        assertEquals("Sign out?", SETTINGS_SIGN_OUT_TITLE)
        assertEquals(listOf("Default", "Accept Edits", "Plan", "Auto", "Don't Ask", "Bypass"), personalPermissions.map { it.second })
        assertEquals("Share task", settingsTitle("share", "TASK:abc"))
    }

    /** UserPreferences.smartModelSelection: on only for an explicit true; absent, or anything but a boolean, is off. */
    @Test fun smartModelSelectionIsOnOnlyForAnExplicitTrue() {
        fun prefs(json: String) = Json.parseToJsonElement(json).jsonObject
        assertTrue(smartModelSelection(prefs("""{"modelRouting":true}""")))
        assertFalse(smartModelSelection(prefs("""{"modelRouting":false}""")))
        assertFalse(smartModelSelection(prefs("""{"theme":"dark"}""")))
        assertFalse(smartModelSelection(prefs("""{"modelRouting":"true"}""")))
        assertFalse(smartModelSelection(prefs("""{"modelRouting":1}""")))
        assertFalse(smartModelSelection(null))
    }

    @Test fun profileSavesThePhotoFirstThenTheNameOnlyWhenEitherChanged() {
        assertFalse(profileCanSave("  ", "Ada", ProfilePhoto.Removed))
        assertFalse(profileCanSave(" Ada ", "Ada", ProfilePhoto.Unchanged))
        assertEquals(listOf<ProfileStep>(ProfileStep.RemovePhoto, ProfileStep.Rename("Bea")), profileSteps(" Bea ", "Ada", ProfilePhoto.Removed))
        assertEquals(listOf<ProfileStep>(ProfileStep.RemovePhoto), profileSteps("Ada", "Ada", ProfilePhoto.Removed))
        assertTrue(profileSteps("Ada", "Ada", ProfilePhoto.Unchanged).isEmpty())
    }

    /** The workspace form's efforts are its next session's engine's (contract §2.3): never the provider slug's — a workspace on a
     * DeepSeek key under Harness offers Harness's levels, the same key under Claude Code Claude Code's. */
    @Test fun workspaceEffortOffersTheEnginesVocabulary() {
        assertEquals(listOf("", "low", "medium", "high", "xhigh", "max", "ultra"), WorkspaceEffort.options("claude", null))
        val runner = buildJsonObject {
            put("runtimeDefaultModels", buildJsonObject { put("codex", "gpt-5") })
            put("modelCatalog", buildJsonObject { put("codex", buildJsonArray { add(buildJsonObject { put("value", "gpt-5"); put("reasoningLevels", buildJsonArray { add("low"); add("high") }) }) }) })
        }
        assertEquals(listOf("", "low", "high"), WorkspaceEffort.options("codex", runner))
        assertEquals(listOf("", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"), WorkspaceEffort.options("codex", null))
        assertEquals("Harness's levels are its ACP catalogue's alone", listOf(""), WorkspaceEffort.options("dsh", null))
        val harness = buildJsonObject {
            put("runtimeDefaultModels", buildJsonObject { put("dsh", "deepseek-v4-pro") })
            put("modelCatalog", buildJsonObject { put("dsh", buildJsonArray { add(buildJsonObject { put("value", "deepseek-v4-pro"); put("reasoningLevels", buildJsonArray { add("high"); add("max") }) }) }) })
        }
        assertEquals(listOf("", "high", "max"), WorkspaceEffort.options("dsh", harness))
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

    /** The API keys list (board 1 ③④): under each key's default model, every engine it runs on — the server's `engines`, its default
     * first — a Claude subscription token saying why Claude Code is its only one; the keys of one vendor together, a Harness key's
     * with DeepSeek's. A key's page says what turning it off stops (board 2). */
    @Test fun eachKeySaysTheEnginesItRunsOn() {
        fun key(json: String) = Json.parseToJsonElement(json).jsonObject
        val deepSeek = key("""{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","engines":["claude","opencode","dsh"],
            "defaultModel":"deepseek-v4-pro","models":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro"}]}""")
        val harness = key("""{"slug":"deepseek-2","label":"DeepSeek 2","runtime":"dsh","presetSlug":"deepseek-harness","engines":["dsh","claude","opencode"],"defaultModel":""}""")
        val max = key("""{"slug":"claude-max","label":"Claude Max","runtime":"claude","presetSlug":"anthropic","engines":["claude"]}""")
        val glm = key("""{"slug":"glm","label":"Z.AI (GLM)","runtime":"claude","presetSlug":"glm","engines":["claude","opencode"]}""")
        val gemini = key("""{"slug":"gemini","label":"Gemini","runtime":"antigravity","presetSlug":"gemini","engines":["antigravity","opencode"]}""")
        val older = key("""{"slug":"openai","label":"OpenAI","runtime":"codex","presetSlug":"openai","runsOnOpenCode":true}""")
        assertEquals("Claude Code · OpenCode · DeepSeek Harness", KeyEngines.line(deepSeek))
        assertEquals("DeepSeek Harness · Claude Code · OpenCode", KeyEngines.line(harness))
        assertEquals("Claude Code · subscription token", KeyEngines.line(max))
        assertEquals("Antigravity CLI · OpenCode", KeyEngines.line(gemini))
        assertEquals("a payload from before `engines` reads as its protocol's", "Codex · OpenCode", KeyEngines.line(older))
        assertNull(KeyEngines.line(key("""{"slug":"odd","runtime":"opencode","engines":[]}""")))
        assertEquals("DeepSeek V4 Pro", providerKeyLine(deepSeek))
        assertNull("where a key runs is the engines line's to say", providerKeyLine(harness))
        assertEquals(listOf("deepseek", "deepseek-2", "glm", "claude-max", "gemini"), KeyEngines.byVendor(listOf(deepSeek, glm, harness, max, gemini)).map { it.str("slug") })
        assertEquals("Anthropic-compatible", KeyEngines.protocol("claude")); assertEquals("OpenAI-compatible", KeyEngines.protocol("codex"))
        assertEquals("Adding or changing a key happens on the web. Turning it off there stops it on Claude Code, OpenCode and DeepSeek Harness.",
            KeyEngines.footer(listOf("Claude Code", "OpenCode", "DeepSeek Harness")))
        assertEquals("Adding or changing a key happens on the web. Turning it off there stops it on Claude Code.", KeyEngines.footer(listOf("Claude Code")))
    }
}
