package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * Removing a runner's Default from Orbit, as Android's runner engine page decides it (the web's RunnerEngines.removeDefault.test.tsx,
 * whose runner and accounts these are): when Default offers Remove…, what its confirmation and an added account's say, the lines of
 * the removed state, where a new session starts, and what sums up the engine. Served as the server serves it (usedRunnerEngines):
 * while Default is removed, `accounts` are the ones that remain, `removedDefault` names Default, and the engine's sign-in and quota
 * are theirs.
 */
class RemoveDefaultTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-08-03T13:00:00Z").toEpochMilli()

    private fun account(id: String, name: String?, auth: String = "yes") = buildJsonObject {
        put("id", id); name?.let { put("name", it) }; put("home", if (id == "default") "/root/.codex" else "/root/.orbit/codex-accounts/$id")
        put("auth", auth)
    }
    private val default = account("default", null)
    private fun work(auth: String = "yes") = account(WORK, "Work", auth)
    private fun personal(auth: String = "yes") = account(PERSONAL, "Personal", auth)
    /** One login's 5-hour window, [used] percent of it gone. */
    private fun window(used: Int) = buildJsonObject {
        put("provider", "codex"); putJsonObject("primary") { put("utilization", used); put("windowDurationMins", 300) }
    }
    private fun usageOf(accounts: List<JsonObject>) = buildJsonObject { accounts.forEach { put(it.text("id"), window(USED.getValue(it.text("id")))) } }
    private fun leaving(account: String, status: String, engine: String = "codex") = buildJsonObject {
        put("engine", engine); put("account", account); put("status", status); put("message", JsonNull)
    }
    private fun runner(codex: JsonObject, planUsage: JsonObject, accountRemove: JsonObject? = null) = buildJsonObject {
        put("id", "r"); put("name", "wikova"); put("online", true); put("engines", buildJsonArray { add(codex) }); put("planUsage", planUsage)
        accountRemove?.let { put("accountRemove", it) }
    }

    /** Codex with Default listed first, as the runner reports it, beside [others]. */
    private fun withDefault(vararg others: JsonObject, accountRemove: JsonObject? = null) = runner(buildJsonObject {
        put("engine", "codex"); put("installed", true); put("auth", "yes"); put("accounts", JsonArray(listOf(default) + others))
    }, JsonObject(window(USED.getValue("default")) + ("accounts" to usageOf(others.toList()))), accountRemove)

    /** Codex as the server serves it with Default removed: the remaining accounts, the marker, the engine's sign-in read from the
     * first of them signed in, and Default's windows gone from its quota — one remaining account's becoming the snapshot's own. */
    private fun removed(vararg remaining: JsonObject, name: String? = null, accountRemove: JsonObject? = null) = runner(buildJsonObject {
        put("engine", "codex"); put("installed", true)
        put("auth", (remaining.firstOrNull { it.text("auth") == "yes" } ?: remaining.first()).text("auth"))
        put("accounts", JsonArray(remaining.toList()))
        putJsonObject("removedDefault") { put("home", "/root/.codex"); name?.let { put("name", it) }; put("fingerprintPrefix", "cxa1_2b7e9013") }
    }, buildJsonObject {
        put("provider", "codex")
        if (remaining.size == 1) window(USED.getValue(remaining[0].text("id"))).filterKeys { it != "provider" }.forEach { (key, value) -> put(key, value) }
        put("accounts", usageOf(remaining.toList()))
    }, accountRemove)

    private fun health(runner: JsonObject) = runner.list("engines").first()
    private fun lines(runner: JsonObject) = RunnerPage.accountLines(health(runner), EngineAccounts.usage("codex", runner))
    private fun question(runner: JsonObject, line: Int) = RunnerPage.removeQuestion(runner, health(runner), lines(runner)[line])

    @Test fun defaultOffersRemoveWhileAnotherAccountOfItsEngineStays() {
        fun offered(runner: JsonObject) = RunnerPage.offersRemove(runner, health(runner), lines(runner).first())
        val two = withDefault(work())
        assertEquals(listOf("default", WORK), lines(two).map { it.id })
        assertTrue("Default, with Work beside it", offered(two))
        assertTrue("an added account's, as before", RunnerPage.offersRemove(two, health(two), lines(two)[1]))
        assertFalse("Default alone is the engine's own sign-in", offered(withDefault()))
        assertFalse("nor on a runner that lists no accounts", offered(runner(buildJsonObject {
            put("engine", "codex"); put("installed", true); put("auth", "yes")
        }, buildJsonObject { })))
        assertFalse("its only other account on its way off the machine", offered(withDefault(work(), accountRemove = leaving(WORK, "pending"))))
        assertFalse("removed there, and listed until the next check-in", offered(withDefault(work(), accountRemove = leaving(WORK, "done"))))
        assertTrue("a removal the machine refused leaves it there", offered(withDefault(work(), accountRemove = leaving(WORK, "failed"))))
        assertTrue("another engine's removal counts for nothing here", offered(withDefault(work(), accountRemove = leaving(WORK, "pending", "claude"))))
        assertTrue(offered(withDefault(work(), personal(), accountRemove = leaving(WORK, "pending"))))
    }

    @Test fun itsConfirmationIsTheWebsQuestion() {
        assertEquals("Remove Default?" to "Orbit stops using it on wikova. Its sign-in stays on the machine, and Codex in a terminal there " +
            "keeps working. Workspaces set to it run on Automatic.", question(withDefault(work(), personal()), 0))
        // A renamed Default goes by its name, the CLI is its own engine's, and the runner goes by the name it was given.
        val claude = json("""{"id":"r","name":"wikova","displayName":"Mac Studio","online":true,"engines":[{"engine":"claude","installed":true,
            "auth":"yes","accounts":[{"id":"default","name":"jianghailong.main","home":"/root/.claude","auth":"yes"},
            {"id":"a1b2c3d4","name":"Work","home":"/root/.orbit/claude-accounts/a1b2c3d4","auth":"yes"}]}]}""")
        assertEquals("Remove jianghailong.main?" to "Orbit stops using it on Mac Studio. Its sign-in stays on the machine, and Claude Code in " +
            "a terminal there keeps working. Workspaces set to it run on Automatic.",
            RunnerPage.removeQuestion(claude, health(claude), RunnerPage.accountLines(health(claude)).first()))
    }

    @Test fun removingAnAddedAccountWhileDefaultIsRemovedSaysAutomaticOrThatOrbitGoesBackToDefault() {
        val automatic = question(removed(work(), personal()), 1)
        assertEquals("Remove Personal?" to "Its sign-in is deleted from wikova. Workspaces set to this account run on Automatic.", automatic)
        val last = question(removed(work(), name = "jianghailong.main"), 0)
        assertEquals("Remove Work?" to "Its sign-in is deleted from wikova. Without it, Orbit uses jianghailong.main there again, and " +
            "workspaces set to this account run on it.", last)
        // Personal on its way off the machine leaves Work the last account Orbit uses there.
        assertEquals(RunnerAccountCopy.removeDetailLast("wikova", "Default"),
            question(removed(work(), personal(), accountRemove = leaving(PERSONAL, "pending")), 0).second)
        for (said in listOf(automatic, last)) assertFalse(said.second, said.second.contains("run on Default"))
        // While Default is in use, an added account's question is the page's own, as it was.
        assertEquals("Remove “Work” from wikova?" to "~/.orbit/codex-accounts/$WORK goes from this machine, and sessions stop running on it. " +
            "Default is untouched.", question(withDefault(work()), 1))
    }

    @Test fun theRemovedStateListsTheAccountsThatRemainEachWithItsOwnStateThenDefaultsLine() {
        val two = removed(work(), personal("no"))
        assertEquals(listOf(WORK, PERSONAL), lines(two).map { it.id })
        assertEquals(listOf("Work", "Personal"), lines(two).map { it.name })
        assertEquals(listOf("yes", "no"), lines(two).map { it.auth })
        assertEquals("each signs in as itself", listOf(WORK, PERSONAL), lines(two).map { it.signInAccount })
        assertEquals(listOf(8), RunnerPage.accountWindows(two, "codex", WORK).map { it.percent })
        assertEquals("Default · ~/.codex isn’t used by Orbit", RunnerPage.removedDefaultLine(RunnerPage.removedDefault(health(two))!!))
        // One that remains is a line of its own, never the engine's: its name, its directory, its own sign-in.
        val one = lines(removed(work("no"))).single()
        assertEquals(listOf(WORK, "Work", "~/.orbit/codex-accounts/$WORK", "no", WORK), listOf(one.id, one.name, one.home, one.auth, one.signInAccount))
        assertEquals("~/.orbit/codex-accounts/$WORK", one.subtitle)
        assertEquals("jianghailong.main · ~/.codex isn’t used by Orbit",
            RunnerPage.removedDefaultLine(RunnerPage.removedDefault(health(removed(work(), name = "jianghailong.main")))!!))
        // With Default in use there is no such line, and a lone Default is the engine's sign-in, as before.
        assertNull(RunnerPage.removedDefault(health(withDefault(work()))))
        assertEquals(listOf("default" to null), lines(withDefault()).map { it.id to it.signInAccount })
    }

    /** shared planUsage.spec's "with Default removed from Orbit, chooses among the accounts that remain — the only one too". */
    @Test fun automaticStartsOnTheAccountsThatRemainTheOnlyOneToo() {
        val pro = "1fda3f43"; val team = "7b02d9e1"
        val later = "2026-08-09T05:26:43Z"; val earlier = "2026-08-04T01:00:00Z"
        fun account(id: String, auth: String = "yes") = json("""{"id":"$id","auth":"$auth"}""")
        fun win(used: Int, mins: Int, resetsAt: String = later) = """{"utilization":$used,"windowDurationMins":$mins,"resetsAt":"$resetsAt"}"""
        // Default a Plus login (a 5-hour and a weekly window), Pro reporting only a weekly one.
        fun usage(fiveHour: Int, weekly: Int, proUsed: Int?) = json("""{"provider":"codex","primary":${win(fiveHour, 300, earlier)},""" +
            """"secondary":${win(weekly, 10080)}""" + (proUsed?.let { ""","accounts":{"$pro":{"provider":"codex","primary":${win(it, 10080)}}}""" } ?: "") + "}")
        val both = listOf(account("default"), account(pro))
        fun pick(accounts: List<JsonObject>, usage: JsonObject, removed: Boolean = true) = EngineAccounts.toStartOn(accounts, usage, now, removed)
        // Default has room and Pro has none: Pro all the same, as the only account left.
        assertEquals(pro, pick(listOf(account(pro)), usage(5, 18, 100)))
        assertEquals(pro, pick(both, usage(5, 18, 100)))
        assertEquals("Pro signed out: still Pro, whose sign-in the session waits on", pro, pick(listOf(account("default"), account(pro, "no")), usage(5, 18, 0)))
        // Two remaining, both spent: the one that frees up first.
        val spent = json("""{"provider":"codex","primary":${win(5, 300, earlier)},"accounts":{"$pro":{"provider":"codex","primary":${win(100, 10080)}},
            "$team":{"provider":"codex","primary":${win(100, 10080, "2026-08-03T14:00:00Z")}}}}""")
        assertEquals(team, pick(both + account(team), spent))
        assertNull("nothing remains: nothing to choose", pick(listOf(account("default")), usage(5, 18, null)))
        assertEquals("not removed, the answers are the ones they were", "default", pick(both, usage(5, 18, 100), removed = false))
        assertNull(pick(listOf(account(pro)), usage(5, 18, 100), removed = false))
    }

    /** NEXT, and the runner page's Engines row, are where a new session starts: the one account that remains, too. */
    @Test fun nextIsTheAccountThatRemains() {
        val one = removed(work())
        assertTrue(RunnerPage.marksNext(one, "codex", WORK, now))
        assertEquals("Work", RunnerPage.engineNextAccount(one, "codex", now))
        assertEquals(listOf(8), RunnerPage.engineWindows(one, "codex", now).map { it.percent })
        // Of two, the one with more room; never Default, whose 62% is nowhere.
        val two = removed(work(), personal())
        assertEquals(listOf(true, false), listOf(WORK, PERSONAL).map { RunnerPage.marksNext(two, "codex", it, now) })
        assertEquals("Work", RunnerPage.engineNextAccount(two, "codex", now))
        // Signed out, it is still where a session starts — and waits for its sign-in — but the row draws no window for it.
        val out = removed(work("no"))
        assertTrue(RunnerPage.marksNext(out, "codex", WORK, now))
        assertEquals(emptyList<UsageRow>(), RunnerPage.engineWindows(out, "codex", now))
        assertNull(RunnerPage.engineNextAccount(out, "codex", now))
        // Default in use alone: nothing to choose between, as before.
        assertFalse(RunnerPage.marksNext(withDefault(), "codex", "default", now))
        assertNull(RunnerPage.engineNextAccount(withDefault(), "codex", now))
    }

    /** What sums up the engine elsewhere — its row, the machine's line, Needs Attention — speaks for the accounts that remain. */
    @Test fun whatSumsUpTheEngineSpeaksForTheAccountsThatRemain() {
        val one = removed(work())
        assertEquals(RunnerCopy.SIGNED_IN to "ok", RunnerPage.engineStatus(health(one), one))
        assertFalse(RunnerPage.needsSignIn(health(one), one))
        assertEquals(1, Infrastructure.logins(one, "codex"))
        val two = removed(work(), personal("no"))
        assertEquals(RunnerCopy.SIGNED_OUT to "warn", RunnerPage.engineStatus(health(two), two))
        assertTrue("Personal's sign-in", RunnerPage.needsSignIn(health(two), two))
        assertEquals(1, Infrastructure.logins(two, "codex"))
        assertEquals(emptyList<String>(), Infrastructure.signedOutEngines(two))
        // Every one that remains signed out: Codex is signed out there for Orbit, whatever Default's sign-in on the machine.
        val out = removed(work("no"), personal("no"))
        assertEquals(listOf("codex"), Infrastructure.signedOutEngines(out))
        val workspace = json("""{"id":"w","name":"Alpha","lastProvider":"codex"}""")
        assertEquals(listOf("Codex is signed out"), RunnerPage.attention(out, listOf(workspace), now, null).map { it.title })
        assertEquals(emptyList<String>(), RunnerPage.attention(two, listOf(workspace), now, null).map { it.title })
    }

    private companion object {
        const val WORK = "3fa91c2e"
        const val PERSONAL = "7c21de40"
        /** What each account has used: Default's window is the Codex snapshot's own, the others' sit under their ids. */
        val USED = mapOf("default" to 62, WORK to 8, PERSONAL to 30)
    }
}
