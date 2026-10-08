package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * OrbitKit RunnerPageFormatTests and CodexAccountsTests on the Android port, for what A13-5 added: the one window
 * an Engines row shows and the account it names, and Automatic passing over a paused account.
 */
class RunnerAccountsTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    /** HPC's Claude row names the account a new session starts on and carries its window: Default's 5 hours are nearly
     * spent (84%), and of the other two rd's week runs out first. */
    @Test fun theRowNamesTheAccountANewSessionStartsOn() {
        val at = ms("2026-10-06T22:18:26Z")
        assertEquals("jianghailong.rd@gmail.com", RunnerPage.engineNextAccount(hpcRunner, "claude", at))
        val row = RunnerPage.engineWindows(hpcRunner, "claude", at).single()
        assertEquals(listOf("Weekly · all models", "41"), listOf(row.label, "${row.percent}"))
    }

    @Test fun oneAccountNamesNone() {
        val runner = json("""{"id":"r","name":"one","engines":[{"engine":"claude","installed":true,"auth":"yes"}],
            "planUsage":{"claude":{"fiveHour":{"utilization":14},"sevenDay":{"utilization":98}}}}""")
        assertNull("one account: none to name", RunnerPage.engineNextAccount(runner, "claude", 0))
        assertEquals(listOf(98), RunnerPage.engineWindows(runner, "claude", 0).map { it.percent })
    }

    /** PlanUsageSnapshot.bindingRow: a spent window first — of several, the one that resets last — else the fullest; a window
     * whose reset has passed reads as the fresh window it is. */
    @Test fun theBindingWindowIsTheSpentOneThatResetsLastElseTheFullest() {
        val now = ms("2026-10-06T00:00:00Z")
        val spent = json("""{"fiveHour":{"utilization":100,"resetsAt":"2026-10-06T03:00:00Z"},"sevenDay":{"utilization":100,"resetsAt":"2026-10-09T00:00:00Z"},
            "sevenDayOpus":{"utilization":99}}""")
        assertEquals("sevenDay", bindingRow(spent, now)?.key)
        assertEquals("a spent window with no reset holds the login longest", "sevenDayOpus",
            bindingRow(json("""{"fiveHour":{"utilization":100,"resetsAt":"2026-10-06T03:00:00Z"},"sevenDayOpus":{"utilization":100}}"""), now)?.key)
        val rolled = json("""{"fiveHour":{"utilization":100,"resetsAt":"2026-10-05T23:00:00Z"},"sevenDay":{"utilization":30,"resetsAt":"2026-10-09T00:00:00Z"}}""")
        assertEquals("a reset that passed is a fresh window", "sevenDay", bindingRow(rolled, now)?.key)
        assertEquals(0.0, currentUsageRows(rolled, now).first().utilization, 0.0)
        assertEquals("a tie goes to the first", "fiveHour", bindingRow(json("""{"fiveHour":{"utilization":40},"sevenDay":{"utilization":40}}"""), now)?.key)
        assertNull(bindingRow(json("{}"), now))
    }

    /** Paused by hand, an account waits as a spent one does until its pause ends (shared rankAccounts). */
    @Test fun aPausedAccountWaitsUntilItsPauseEnds() {
        val now = ms("2026-08-03T13:00:00Z")
        val pro = "1fda3f43"
        fun usage(default: Int, proFive: Int, proWeek: Int) = json("""{"provider":"codex",
            "primary":{"utilization":$default,"windowDurationMins":300,"resetsAt":"2026-08-04T01:00:00Z"},
            "secondary":{"utilization":10,"windowDurationMins":10080,"resetsAt":"2026-08-08T00:00:00Z"},
            "accounts":{"$pro":{"provider":"codex","primary":{"utilization":$proFive,"windowDurationMins":300,"resetsAt":"2026-08-03T17:00:00Z"},
              "secondary":{"utilization":$proWeek,"windowDurationMins":10080,"resetsAt":"2026-08-05T13:00:00Z"}}}}""")
        fun accounts(pausedUntil: String) = listOf(json("""{"id":"default","auth":"yes"}"""), json("""{"id":"$pro","auth":"yes","pausedUntil":"$pausedUntil"}"""))
        // Pro's week ends first, so it would go first — but it is paused for two more hours.
        assertEquals("default", EngineAccounts.toStartOn(accounts("2026-08-03T15:00:00Z"), usage(5, 18, 40), now))
        assertEquals("a pause that has ended holds nothing", pro, EngineAccounts.toStartOn(accounts("2026-08-03T12:00:00Z"), usage(5, 18, 40), now))
        // Default spent until its 5 hours reset tomorrow at 01:00, Pro paused until 15:00 today: Pro.
        assertEquals(pro, EngineAccounts.toStartOn(accounts("2026-08-03T15:00:00Z"), usage(100, 18, 40), now))
        assertNull(EngineAccounts.toStartOn(listOf(json("""{"id":"default","auth":"yes"}""")), usage(5, 18, 40), now))
        assertNull("none signed in", EngineAccounts.toStartOn(listOf(json("""{"id":"default","auth":"no"}"""), json("""{"id":"$pro","auth":"no"}""")), usage(0, 0, 0), now))
    }
}
