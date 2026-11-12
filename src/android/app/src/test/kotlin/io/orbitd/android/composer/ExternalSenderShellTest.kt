package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/**
 * F3n-2 over the controlled server (docs/feishu-bot-design.md §8.2; OrbitKit ExternalSenderTests, web Transcript.tsx and
 * WorkspaceView.tsx): a connected Feishu group's member's turn is headed `From Feishu · <name>` in the conversation — `From Feishu`
 * when Feishu would not say the name — and the owner's own turn still says "You"; the head a runner has taken says what its echo will;
 * and the session's row in the list names the sender in front of their words. A guest the owner invited (docs/session-guests-design.md
 * §3) is headed and named `From <name>` in the same two places.
 */
class ExternalSenderShellTest : ComposerShellTest() {
    private fun echoes() {
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Add a retry to the nightly export job."}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-0","payload":{"text":"Done: the export job retries three times."}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":3,"turnId":"t-0","payload":{"subtype":"success"}}"""),
            ComposerShell.obj("""{"type":"user","seq":4,"turnId":"t-1","payload":{"text":"Can you also check why the export failed last night?",
                "externalSender":{"source":"FEISHU","name":"Li Lei"}}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":5,"turnId":"t-1","payload":{"subtype":"success"}}"""),
            ComposerShell.obj("""{"type":"user","seq":6,"turnId":"t-2","payload":{"text":"Please rerun the export for October.",
                "externalSender":{"source":"FEISHU","name":null}}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":7,"turnId":"t-2","payload":{"subtype":"success"}}"""),
            ComposerShell.obj("""{"type":"user","seq":8,"turnId":"t-3","payload":{"text":"A source this build does not know.",
                "externalSender":{"source":"SLACK","name":"Han Meimei"}}}"""))
    }
    private fun headed(seq: Int, words: String) = has(hasText(words) and hasAnyAncestor(hasTestTag("event:$seq")), unmerged = true)

    @Test fun theConversationHeadsAFeishuMembersWordsWithTheirName() {
        echoes()
        signIn(); openSession()
        await { has(hasTestTag("event:8")) }
        assertTrue("the owner's own words are still theirs", headed(1, "You"))
        assertTrue(headed(4, "From Feishu · Li Lei"))
        assertFalse(headed(4, "You"))
        assertTrue("their words are drawn as ever", headed(4, "Can you also check why the export failed last night?"))
        assertTrue("no name, Feishu alone", headed(6, "From Feishu"))
        assertFalse(headed(6, "You"))
        assertTrue("a source this build does not know reads as before", headed(8, "You"))
        assertFalse(headed(8, "From Feishu · Han Meimei"))
    }

    @Test fun theConversationHeadsAGuestsWordsWithTheirName() {
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Add a retry to the nightly export job."}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":2,"turnId":"t-0","payload":{"subtype":"success"}}"""),
            ComposerShell.obj("""{"type":"user","seq":3,"turnId":"t-1","payload":{"text":"Can you add the October numbers too?",
                "externalSender":{"source":"ORBIT_GUEST","name":"Alice Chen"}}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":4,"turnId":"t-1","payload":{"subtype":"success"}}"""),
            ComposerShell.obj("""{"type":"user","seq":5,"turnId":"t-2","payload":{"text":"A guest with no name is no guest.",
                "externalSender":{"source":"ORBIT_GUEST","name":null}}}"""))
        signIn(); openSession()
        await { has(hasTestTag("event:5")) }
        assertTrue("the owner's own words are still theirs", headed(1, "You"))
        assertTrue("a guest the owner invited is named", headed(3, "From Alice Chen"))
        assertFalse(headed(3, "You"))
        assertTrue("their words are drawn as ever", headed(3, "Can you add the October numbers too?"))
        assertTrue("a nameless guest reads as before", headed(5, "You"))
    }

    @Test fun theHeadARunnerTookSaysWhatItsEchoWill() {
        val headId = "01a0cca7-8609-70ed-a0e2-d4b55b832b72"
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, """[{"turnId":"$headId","kind":"message",
            "placement":"accepted","content":"Check the export logs","attachments":[],"createdAt":"2026-10-15T02:00:00.000Z",
            "externalSender":{"source":"FEISHU","name":"Li Lei"}}]""".encodeToByteArray()) }
        signIn(); openSession()
        val drawn = hasTestTag("accepted:$headId")
        await { has(drawn) }
        assertTrue(has(hasText("From Feishu · Li Lei") and hasAnyAncestor(drawn), unmerged = true))
        assertFalse(has(hasText("You") and hasAnyAncestor(drawn), unmerged = true))
    }

    @Test fun theSessionRowNamesAGuestInFrontOfTheirWords() {
        ComposerShell.session = mapOf("lastUserText" to JsonPrimitive("Can you add the October numbers too?"),
            "lastUserFromExternal" to ComposerShell.obj("""{"source":"ORBIT_GUEST","name":"Alice Chen"}"""))
        signIn()
        awaitText("From Alice Chen: Can you add the October numbers too?")
        assertFalse(shows("You: Can you add the October numbers too?"))
    }

    @Test fun theSessionRowNamesTheSenderInFrontOfTheirWords() {
        ComposerShell.session = mapOf("lastUserText" to JsonPrimitive("Can you also check why the export failed last night?"),
            "lastUserFromExternal" to ComposerShell.obj("""{"source":"FEISHU","name":"Li Lei"}"""))
        signIn()
        awaitText("From Feishu · Li Lei: Can you also check why the export failed last night?")
        assertFalse(shows("You: Can you also check why the export failed last night?"))
    }
}
