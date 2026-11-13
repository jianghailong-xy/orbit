package io.orbitd.android.management

import java.io.File
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** People who can reply in a session's Share panel (docs/session-guests-design.md §3): web `SessionGuests.tsx` and OrbitKit
 * `SessionGuestsPanelTests`, case for case, and every word held to both sources — a missing counterpart is a failure, never a skip. */
class SessionGuestsTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun read(path: String) = File(root, path).also { assertTrue("$path is missing", it.isFile) }.readText()

    private fun person(name: String = "Alice Chen", today: Int = 0, opened: Boolean = false) =
        SessionGuestPerson("u-${name.length}", name, "alice@example.com", today, opened)

    @Test fun everyWordIsTheWebsAndTheSwifts() {
        val web = read("src/web/src/components/SessionGuests.tsx")
        val modal = read("src/web/src/components/ShareModal.tsx")
        val swift = read("src/macos/OrbitKit/Sources/OrbitKit/App/SessionGuestsPanel.swift")
        fun both(word: String, inWeb: String = word) {
            assertTrue("SessionGuests.tsx/ShareModal.tsx no longer says \"$inWeb\"", web.contains(inWeb) || modal.contains(inWeb))
            assertTrue("SessionGuestsPanel.swift no longer says \"$word\"", swift.contains("\"$word\""))
        }
        both(SessionGuestsCopy.peopleWhoCanReply, ">${SessionGuestsCopy.peopleWhoCanReply}<")
        both(SessionGuestsCopy.emailPlaceholder, "placeholder=\"${SessionGuestsCopy.emailPlaceholder}\"")
        both(SessionGuestsCopy.invite)
        both(SessionGuestsCopy.remove)
        both(SessionGuestsCopy.acknowledge, "export const GUESTS_ACKNOWLEDGE = '${SessionGuestsCopy.acknowledge}';")
        both(SessionGuestsCopy.privateDetail, "'${SessionGuestsCopy.privateDetail}'")
        both(SessionGuestsCopy.couldNotRemove, "\"${SessionGuestsCopy.couldNotRemove}\"")
        assertTrue(web.contains("'${SessionGuestsCopy.notOpenedYet}'"))
        for ((mode, words) in listOf("default" to "Default", "plan" to "Plan", "acceptEdits" to "Accept edits", "auto" to "Auto",
            "dontAsk" to "Don’t ask", "bypassPermissions" to "Bypass permissions")) {
            assertEquals(words, SessionGuestsCopy.modeWords(mode))
            assertTrue("SessionGuests.tsx no longer says $mode as $words", web.contains("  $mode: '$words',"))
            assertTrue("SessionGuestsPanel.swift no longer says $mode as $words", swift.contains("case \"$mode\": return \"$words\""))
        }
        assertTrue(web.contains("const UNASKING_MODES = new Set(['auto', 'dontAsk', 'bypassPermissions']);"))
        assertEquals(setOf("auto", "dontAsk", "bypassPermissions"), SessionGuestsCopy.unaskingModes)
        // The consequence line: the same runner, mode, and either ending.
        assertTrue(web.contains("They can send messages to this session. The agent runs them on \${runnerName} as \${MODE_WORDS[permissionMode] ?? permissionMode}, using your accounts"))
        assertTrue(web.contains("`\${runs} — it won’t ask before acting.`") && web.contains("`\${runs}. Approvals and the agent’s questions still come only to you.`"))
    }

    @Test fun theConsequenceNamesTheRunnerAndModeAndWarnsWhereTheAgentWontAsk() {
        assertEquals(SessionGuestsCopy.Consequence("They can send messages to this session. The agent runs them on austin as Default, using your " +
            "accounts. Approvals and the agent’s questions still come only to you.", false), SessionGuestsCopy.consequence("austin", "default"))
        assertEquals(SessionGuestsCopy.Consequence("They can send messages to this session. The agent runs them on austin as Bypass permissions, " +
            "using your accounts — it won’t ask before acting.", true), SessionGuestsCopy.consequence("austin", "bypassPermissions"))
        assertTrue(SessionGuestsCopy.consequence("austin", "dontAsk").warns)
        assertTrue(SessionGuestsCopy.consequence("austin", "auto").warns)
        assertFalse(SessionGuestsCopy.consequence("austin", "acceptEdits").warns)
        assertEquals("a mode this build does not know is said as it came", true,
            SessionGuestsCopy.consequence("austin", "yolo").text.contains(" as yolo, "))
    }

    @Test fun todaysMessagesOrNotOpenedYet() {
        assertEquals("Not opened yet", SessionGuestsCopy.activity(person()))
        assertEquals("0 messages today", SessionGuestsCopy.activity(person(opened = true)))
        assertEquals("1 message today", SessionGuestsCopy.activity(person(today = 1)))
        assertEquals("12 messages today", SessionGuestsCopy.activity(person(today = 12, opened = true)))
    }

    /** The tick is asked for only before the first guest of a session that will not ask, and Invite waits for it. */
    @Test fun bypassAsksForTheTickBeforeTheFirstInviteOnly() {
        var panel = SessionGuestsPanel(SessionGuestContext("austin", "bypassPermissions"))
        assertFalse("nothing is asked before the server has answered", panel.needsAcknowledge)
        panel = panel.loaded(emptyList()).editEmail("  alice@example.com ")
        assertTrue(panel.needsAcknowledge)
        assertFalse(panel.canInvite)
        panel = panel.copy(acknowledged = true)
        assertTrue(panel.canInvite)
        assertEquals("alice@example.com", panel.trimmedEmail)
        panel = panel.copy(inviting = true)
        assertFalse("one invite at a time", panel.canInvite)
        panel = panel.invited(listOf(person()))
        assertEquals("", panel.email)
        assertFalse(panel.inviting)
        assertFalse("a session that already has a guest asks no more", panel.needsAcknowledge)
        assertTrue(panel.editEmail("bob@example.com").copy(acknowledged = false).canInvite)

        val asks = SessionGuestsPanel(SessionGuestContext("austin", "default")).loaded(emptyList()).editEmail("a@b.c")
        assertFalse(asks.needsAcknowledge)
        assertTrue(asks.canInvite)
        assertFalse("a blank email invites nobody", asks.editEmail("   ").canInvite)
    }

    @Test fun aRefusedInviteSaysWhyUntilTheEmailChanges() {
        val panel = SessionGuestsPanel(SessionGuestContext("austin", "default")).loaded(emptyList()).editEmail("nobody@example.com")
            .copy(inviting = true).inviteFailed("No Orbit account uses this email.")
        assertEquals("No Orbit account uses this email.", panel.error)
        assertFalse(panel.inviting)
        assertEquals("nobody@example.com", panel.email)
        assertNull(panel.editEmail("nobody@example.co").error)
    }

    @Test fun readsTheGuestListTheOwnerRoutesAnswer() {
        val list = SessionGuestPerson.list(Json.parseToJsonElement("""{"guests":[{"userId":"u1","name":"Alice Chen","email":"alice@example.com",
            "addedAt":"2026-11-12T02:00:00.000Z","messagesToday":3,"opened":true}]}"""))
        assertEquals(listOf(SessionGuestPerson("u1", "Alice Chen", "alice@example.com", 3, true)), list)
        assertEquals(emptyList<SessionGuestPerson>(), SessionGuestPerson.list(Json.parseToJsonElement("""{"guests":[]}""")))
        assertTrue(runCatching { SessionGuestPerson.list(Json.parseToJsonElement("""{"people":[]}""")) }.isFailure)
    }
}
