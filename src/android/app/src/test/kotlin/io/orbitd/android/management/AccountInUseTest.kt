package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A removal the machine refused over sessions running in the account (`accountRemove.sessions`): which sessions the page lists, and
 * what it says over them and beside each. */
class AccountInUseTest {
    private fun state(sessions: String?, status: String = "failed", engine: String = "claude", account: String = ACCOUNT) = Json.parseToJsonElement(
        """{"engine":"$engine","account":"$account","status":"$status","message":"in use"${sessions?.let { ""","sessions":$it""" }.orEmpty()}}""").jsonObject
    private val two = """[{"id":"a","title":"Fix login","status":"RUNNING"},{"id":"b","title":"","status":"SOMETHING_NEW"}]"""

    @Test fun theSessionsAreReadOnlyFromARefusalThatNamesThem() {
        assertEquals(listOf(RunnerPage.InUseSession("a", "Fix login", "RUNNING"), RunnerPage.InUseSession("b", "", "SOMETHING_NEW")),
            RunnerPage.inUseSessions(state(two), "claude", ACCOUNT))
        assertEquals("an older server sends none", emptyList<RunnerPage.InUseSession>(), RunnerPage.inUseSessions(state(null), "claude", ACCOUNT))
        assertEquals(emptyList<RunnerPage.InUseSession>(), RunnerPage.inUseSessions(state("[]"), "claude", ACCOUNT))
        assertEquals("not refused", emptyList<RunnerPage.InUseSession>(), RunnerPage.inUseSessions(state(two, "pending"), "claude", ACCOUNT))
        assertEquals("another account's", emptyList<RunnerPage.InUseSession>(), RunnerPage.inUseSessions(state(two, account = "other"), "claude", ACCOUNT))
        assertEquals("another engine's", emptyList<RunnerPage.InUseSession>(), RunnerPage.inUseSessions(state(two), "codex", ACCOUNT))
        assertEquals(emptyList<RunnerPage.InUseSession>(), RunnerPage.inUseSessions(null, "claude", ACCOUNT))
        // The machine's sentence still reads as before.
        assertEquals(false to "in use", RunnerPage.removal(state(two), "claude", ACCOUNT))
    }

    @Test fun theHeadingNamesTheEngineAsItsCliAndCountsTheSessions() {
        assertEquals("This Claude Code account can’t be removed while a session is on it — to keep the session, switch it to another account and send it a message, or end it below; then remove the account",
            RunnerPage.inUseHeading("claude", 1))
        assertEquals("This Codex account can’t be removed while 3 sessions are on it — to keep them, switch each to another account and send it a message, or end them; then remove the account",
            RunnerPage.inUseHeading("codex", 3))
    }

    @Test fun eachSessionSaysItsStateAndItsTitleOrUntitled() {
        assertEquals("Running" to "ok", RunnerPage.inUseStatus("RUNNING"))
        assertEquals("Running" to "ok", RunnerPage.inUseStatus("PENDING"))
        assertEquals("Waiting for input" to "warn", RunnerPage.inUseStatus("AWAITING_INPUT"))
        for (other in listOf("SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "SOMETHING_NEW", null))
            assertEquals(other, null to null, RunnerPage.inUseStatus(other))
        assertEquals("Fix login", RunnerPage.inUseTitle(RunnerPage.InUseSession("a", "Fix login", "RUNNING")))
        assertEquals("Untitled session", RunnerPage.inUseTitle(RunnerPage.InUseSession("b", "  ", "RUNNING")))
    }

    private companion object { const val ACCOUNT = "5dd14473" }
}
