package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * OrbitKit RunnerPageFormatTests and CodexAccountsTests on the Android port, for what A13-5 and A13-9 added: the one window
 * an Engines row shows and the account it names, Automatic passing over a paused account, a login about to lapse, and what
 * a signed-out account costs.
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

    /** Mirrors shared planUsage.spec.ts: where the server counted the sessions, an account takes no more than its share of them. */
    @Test fun aNewSessionGoesPastAnAccountThatHasItsShare() {
        val now = ms("2026-08-03T13:00:00Z")
        val pro = "1fda3f43"
        val third = "3fa91c2e"
        fun window(used: Int, resetsAt: String) = """{"provider":"codex","primary":{"utilization":$used,"windowDurationMins":300,"resetsAt":"$resetsAt"}}"""
        fun usage(default: Int, two: Int, three: Int, defaultResets: String = "2026-08-04T01:00:00Z") = json("""{"provider":"codex",
            "primary":{"utilization":$default,"windowDurationMins":300,"resetsAt":"$defaultResets"},
            "accounts":{"$pro":${window(two, "2026-08-09T05:26:43Z")},"$third":${window(three, "2026-08-10T00:00:00Z")}}}""")
        fun spread(default: Int, two: Int, three: Int) = listOf("default" to default, pro to two, third to three)
            .map { (id, active) -> json("""{"id":"$id","auth":"yes","activeSessions":$active}""") }
        val room = usage(10, 20, 30)
        assertEquals("default", EngineAccounts.toStartOn(spread(2, 0, 0), room, now))
        assertEquals("three stay, the next spreads", pro, EngineAccounts.toStartOn(spread(3, 0, 0), room, now))
        assertEquals("11 and this one make four each", third, EngineAccounts.toStartOn(spread(4, 4, 3), room, now))
        assertEquals("default", EngineAccounts.toStartOn(spread(3, 4, 4), room, now))
        assertEquals("every one full: the order stands", "default", EngineAccounts.toStartOn(spread(4, 4, 4), room, now))
        assertEquals("a nearly spent account is no home for a session", pro, EngineAccounts.toStartOn(spread(0, 5, 5), usage(85, 20, 30), now))
        assertEquals("never a spent one", pro, EngineAccounts.toStartOn(spread(1, 6, 6), usage(100, 20, 30), now))
        // Back in two hours, Default keeps its place: 20 over three is seven each. Out for days it has none: ten each.
        assertEquals(third, EngineAccounts.toStartOn(spread(6, 7, 6), usage(100, 20, 30, "2026-08-03T15:00:00Z"), now))
        assertEquals(pro, EngineAccounts.toStartOn(spread(6, 7, 6), usage(100, 20, 30, "2026-08-08T13:00:00Z"), now))
        val uncounted = listOf("default", pro, third).map { json("""{"id":"$it","auth":"yes"}""") }
        assertEquals("nothing counted, nothing held back", "default", EngineAccounts.toStartOn(uncounted, room, now))
    }

    /** A signed-in account whose login lapses within three days says so, in whole days rounded up the way Claude Code counts. */
    @Test fun aLoginAboutToLapseSaysHowManyDaysAreLeft() {
        val now = ms("2026-09-14T02:00:00Z")
        fun line(auth: String, lapses: String?) = RunnerPage.accountLines(buildJsonObject {
            put("engine", "claude"); put("installed", true); put("auth", "yes")
            put("accounts", buildJsonArray {
                add(buildJsonObject { put("id", "default"); put("auth", "yes") })
                add(buildJsonObject { put("id", "29e631a9"); put("auth", auth); lapses?.let { put("loginExpiresAt", it) } })
            })
        })[1]
        fun at(hours: Long) = Instant.ofEpochMilli(now).plusSeconds(hours * 3600).toString()
        assertEquals("2026-09-17T02:00:00.000Z", line("yes", "2026-09-17T02:00:00.000Z").loginExpiresAt)
        assertEquals("Login expires in 3 days", RunnerPage.loginExpiresLine(line("yes", at(72)), now))
        assertEquals("rounded up, as Claude Code counts", "Login expires in 3 days", RunnerPage.loginExpiresLine(line("yes", at(49)), now))
        assertEquals("Login expires in 2 days", RunnerPage.loginExpiresLine(line("yes", at(30)), now))
        assertEquals("Login expires in 1 day", RunnerPage.loginExpiresLine(line("yes", at(5)), now))
        assertNull("further off than Claude Code warns", RunnerPage.loginExpiresLine(line("yes", at(73)), now))
        assertNull("past it, the runner says signed out", RunnerPage.loginExpiresLine(line("yes", at(-1)), now))
        assertNull(RunnerPage.loginExpiresLine(line("no", at(5)), now))
        assertNull(RunnerPage.loginExpiresLine(line("yes", null), now))
    }

    /** Under Signed out, what it costs: this account — or, the engine's only account on that machine, the engine there. */
    @Test fun aSignedOutAccountSaysWhatItCosts() {
        val lines = RunnerPage.accountLines(json("""{"engine":"claude","installed":true,"auth":"yes","accounts":[
            {"id":"default","auth":"yes"},{"id":"29e631a9","auth":"no"},{"id":"b93d5a17","auth":"unknown"}]}"""))
        assertNull(RunnerPage.signedOutNote(lines[0], false, "claude"))
        assertEquals("Sessions can’t use this account until you sign in again.", RunnerPage.signedOutNote(lines[1], false, "claude"))
        assertNull(RunnerPage.signedOutNote(lines[2], false, "claude"))
        assertEquals("Sessions on this runner can’t use Claude Code until you sign in again.", RunnerPage.signedOutNote(lines[1], true, "claude"))
        assertEquals("Sessions on this runner can’t use Antigravity CLI until you sign in again.", RunnerPage.signedOutNote(lines[1], true, "antigravity"))
    }
}
