package io.orbitd.android.core.cards

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Settings from a conversation, decoded and worded as iOS's `SettingsFromConversationTests` and the web card do. */
class SettingsChangeTest {
    private val request = Wire.decode("""{"id":"01a0d6a9-d763-70e1-b4cf-8793e971b505","kind":"SETTINGS_CHANGE","state":"PENDING","title":"Change 3 settings?",
        "why":"You asked for Chinese.","createdAt":"2026-11-20T08:00:00.000Z","payload":{"changes":[
        {"key":"translationEnabled","from":false,"to":true,"tier":1},
        {"key":"translationLanguage","from":"en","to":"zh-Hans","tier":1},
        {"key":"defaultPermissionMode","from":"default","to":"plan","tier":2},
        {"key":"notAKnownKey","from":1,"to":2,"tier":1}]}}""".encodeToByteArray(), OwnerRequest.serializer())

    @Test fun thePayloadDecodesInTheOrderFiledAndLeavesOutUnknownKeys() {
        val entries = SettingsFromConversation.entries(request.payload)
        assertEquals(listOf("translationEnabled", "translationLanguage", "defaultPermissionMode"), entries.map { it.key })
        assertEquals(listOf(1, 1, 2), entries.map { it.tier })
        assertEquals(JsonPrimitive("zh-Hans"), entries[1].to)
        assertTrue(OwnerRequests.SETTINGS_CHANGE in OwnerRequests.kinds)
        assertTrue(SettingsFromConversation.entries(null).isEmpty())
    }

    @Test fun anOlderRequestWithNoPayloadStillDecodes() {
        val bare = Wire.decode("""{"id":"x","kind":"CONFIRM","state":"PENDING","title":"t","createdAt":"2026-11-20T08:00:00.000Z"}""".encodeToByteArray(), OwnerRequest.serializer())
        assertNull(bare.payload)
    }

    @Test fun rowsOnOnePageShareOnePathLine() {
        val groups = SettingsFromConversation.groups(SettingsFromConversation.entries(request.payload))
        assertEquals(listOf("Settings › General › Translation", "Settings › General › New sessions"), groups.map { it.first })
        assertEquals(listOf(2, 1), groups.map { it.second.size })
    }

    @Test fun valuesReadAsSettingsShowThem() {
        assertEquals("On", SettingsFromConversation.valueLabel("translationEnabled", JsonPrimitive(true)))
        assertEquals("Off", SettingsFromConversation.valueLabel("recaps", JsonPrimitive(false)))
        assertEquals("Chinese (Simplified)", SettingsFromConversation.valueLabel("translationLanguage", JsonPrimitive("zh-Hans")))
        assertEquals("Dark", SettingsFromConversation.valueLabel("theme", JsonPrimitive("dark")))
        assertEquals("Accept Edits", SettingsFromConversation.valueLabel("defaultPermissionMode", JsonPrimitive("acceptEdits")))
        assertEquals("Intelligence", SettingsFromConversation.valueLabel("optimizeFor", JsonPrimitive("intelligence")))
        assertEquals("None", SettingsFromConversation.valueLabel("subagentBlockedProviders", JsonArray(emptyList())))
        assertEquals("Default", SettingsFromConversation.valueLabel("theme", JsonNull))
    }

    @Test fun theCopyIsTheWebAndIosStrings() {
        assertEquals("⚙️ Confirm: change 2 settings?", SettingsChangeCopy.heading(2))
        assertEquals("⚙️ Confirm: change 1 setting?", SettingsChangeCopy.heading(1))
        assertEquals("The agent says: because", SettingsChangeCopy.agentSays("because"))
        assertEquals("Applies to new sessions only.", SettingsChangeCopy.newSessionsOnly)
        assertEquals("Only these change. You can change them back in Settings.", SettingsChangeCopy.foot)
        assertEquals("Save changes", SettingsChangeCopy.save)
        assertEquals("💬 Chat about this", SettingsChangeCopy.chat)
        assertEquals("✓ Changed 2 settings", SettingsChangeCopy.changed(2))
        assertEquals("This setting changed since it was proposed.", SettingsChangeCopy.stale)
        assertEquals("Open in Settings", SettingsChangeCopy.openInSettings)
        assertFalse(listOf(SettingsChangeCopy.save, SettingsChangeCopy.chat, SettingsChangeCopy.foot).any { it.contains("Always allow") })
    }

    @Test fun theOrbitSettingsLinkNamesARowInEitherSpelling() {
        assertEquals("Settings › General › Translation", SettingsFromConversation.pathLabel(SettingsFromConversation.loneLink("[Open](orbit-settings:translationEnabled)")!!))
        assertEquals("translationAgentLanguage", SettingsFromConversation.loneLink("[x](orbit-settings:agentLanguage)")?.key)
        assertEquals("Settings › Appearance", SettingsFromConversation.pathLabel(SettingsFromConversation.place("theme")!!))
        assertNull(SettingsFromConversation.loneLink("see [x](orbit-settings:translationEnabled) now"))
        assertNull(SettingsFromConversation.loneLink("[x](orbit-settings:nothing)"))
    }

    private val user = Wire.decode("""{"id":"u","changedBy":{
        "translationEnabled":{"sessionId":"s1","requestId":"01a0d6a9-d763-70e1-b4cf-8793e971b505","at":"2026-11-20T07:58:00.000Z","from":false,"sessionTitle":"Translate the docs"},
        "translationLanguage":{"sessionId":"s1","requestId":"01a0d6a9-d763-70e1-b4cf-8793e971b505","at":"2026-11-20T07:58:00.000Z","from":"en"},
        "recaps":{"sessionId":"s2","requestId":"01a0d6a9-d763-70e1-b4cf-8793e971b999","at":"2026-11-20T07:00:00.000Z","from":true,"sessionTitle":""},
        "broken":7}}""".encodeToByteArray(), JsonObject.serializer())

    @Test fun theChangedByMarksDecodeAndABrokenOneCostsOnlyItself() {
        val marks = SettingsFromConversation.changedBy(user)
        assertEquals(setOf("translationEnabled", "translationLanguage", "recaps"), marks.keys)
        assertTrue(SettingsFromConversation.changedBy(null).isEmpty())
    }

    @Test fun theSettingsRowLineNamesTheConversation() {
        val now = Instant.parse("2026-11-20T08:00:00Z")
        val marks = SettingsFromConversation.changedBy(user)
        assertEquals("Turned on from Translate the docs · 2m ago · ", SettingsFromConversation.changedLine(marks.getValue("translationEnabled"), now))
        assertEquals("Set from a conversation · 2m ago · ", SettingsFromConversation.changedLine(marks.getValue("translationLanguage"), now))
        assertEquals("Turned off from Untitled conversation · 1h ago · ", SettingsFromConversation.changedLine(marks.getValue("recaps"), now))
    }

    @Test fun undoPutsBackOnlyTheKeysThisRequestStillMarks() {
        val body = SettingsFromConversation.undoBody(request, user)
        assertEquals(setOf("translationEnabled", "translationLanguage"), body.keys)
        assertEquals(JsonPrimitive(false), body["translationEnabled"])
        assertEquals(JsonPrimitive("en"), body["translationLanguage"])
        assertTrue(SettingsFromConversation.undoBody(request, null).isEmpty())
    }

    @Test fun aStaleApplyIsA409WithItsCode() {
        fun error(status: Int, body: String) = ApiError.parse(status, body.encodeToByteArray())
        assertTrue(SettingsFromConversation.isStale(error(409, """{"code":"SETTINGS_STALE","message":"SETTINGS_STALE"}""")))
        assertFalse(SettingsFromConversation.isStale(error(409, """{"message":"another conflict"}""")))
        assertFalse(SettingsFromConversation.isStale(error(500, """{"code":"SETTINGS_STALE"}""")))
        assertFalse(SettingsFromConversation.isStale(IllegalStateException()))
    }
}
