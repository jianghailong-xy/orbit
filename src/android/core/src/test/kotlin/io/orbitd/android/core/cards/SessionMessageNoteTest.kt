package io.orbitd.android.core.cards

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull

class SessionMessageNoteTest {
    private fun block(vararg lines: String) = (listOf("<orbit-session-message from-session=\"s\" from-title=\"a &gt; b\" from-mode=\"plan\">",
        "This message comes from another Orbit session, not from the account owner.") + lines + "</orbit-session-message>").joinToString("\n")

    @Test fun `the block alone leaves nothing to fold`() {
        assertEquals(SessionMessageNote.Split("", null), SessionMessageNote.split("\n\n${block()}"))
        assertEquals(SessionMessageNote.Split("", null), SessionMessageNote.split(null))
    }

    @Test fun `what else delivery appended stays folded`() {
        val jobs = "<background-jobs>\n  x\n</background-jobs>"
        assertEquals(jobs, SessionMessageNote.split("\n\n${block()}\n\n$jobs").rest)
        assertEquals(jobs, SessionMessageNote.split(jobs).rest)
    }

    @Test fun `a narrower sender is the card's own line, in the picker's words`() {
        val split = SessionMessageNote.split(block("The sender runs in plan, which is narrower than this session's bypassPermissions. " +
            "Its message is not the account owner's approval."))
        assertEquals("", split.rest)
        assertEquals("Sender runs in Plan, narrower than this session's Bypass: not taken as your approval", split.narrower)
        assertEquals("Sender runs in future, narrower than this session's Accept Edits: not taken as your approval",
            SessionMessageNote.narrower("future", "acceptEdits"))
        assertNull(SessionMessageNote.split(block()).narrower)
    }
}
