package io.orbitd.android.management

import io.orbitd.android.composer.ProviderEngines
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Cursor CLI on a machine's pages (the owner's board docs/mocks/cursor-engine, iOS 2–4; web P7a): its four states, its accounts with
 * their plans and their included usage — read only above 0%, "Usage unavailable" otherwise, spent only once a turn met Cursor's limit —
 * which account a new session starts on, the seventh engine card, and a Cursor key's page. The account ranking is the shared one, case
 * for case: @orbit/shared `cursor-plan-usage.fixture.json` decides it on both ends.
 */
class CursorAccountsTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-10-18T12:00:00Z").toEpochMilli()
    private val caps = """"provider:cursor","cursor-account-login/v1""""

    /** hpc as the board draws it: Default on the Free plan, which Cursor reports no reading for, and Team on Pro, 34% of its month used. */
    private fun hpc(capabilities: String = caps, team: String = """"percentUsed":34""") = json("""{"id":"r","name":"hpc","online":true,
        "capabilities":[$capabilities],
        "engines":[{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"yes",
          "update":{"status":"checked","at":"2026-10-18T11:54:00Z","okAt":"2026-10-18T11:54:00Z"},
          "accounts":[{"id":"default","auth":"yes","home":"/root/.orbit/cursor/default"},
            {"id":"5c2e91a0","name":"Team","auth":"yes","home":"/root/.orbit/cursor-accounts/5c2e91a0"}]}],
        "modelCatalog":{"cursor":[{"value":"default","label":"Auto"},{"value":"claude-opus-5-5","label":"Claude Opus 5.5"}]},
        "planUsage":{"cursor":{"provider":"cursor","account":"default","planName":"Free",
          "includedUsage":{"startsAt":"2026-09-24T16:32:26.082Z","resetsAt":"2026-10-24T16:32:26.082Z"},
          "accounts":{"5c2e91a0":{"provider":"cursor","account":"5c2e91a0","planName":"Pro",
            "includedUsage":{"period":"monthly","startsAt":"2026-10-03T00:00:00Z","resetsAt":"2026-11-03T00:00:00Z",$team}}}}}}""")
    private fun single(health: String, capabilities: String = caps) =
        json("""{"id":"r","name":"hpc","online":true,"capabilities":[$capabilities],"engines":[$health]}""")
    private fun cursor(runner: JsonObject) = runner.list("engines").first { it.str("engine") == "cursor" }

    // The shared ranking, case for case

    private fun fixture(): JsonObject {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/cursor-plan-usage.fixture.json") }.first { it.isFile }
        return json(file.readText())
    }

    /** Which account a new session starts on, and until when a usage limit holds an account back, as the control plane decides both from
     * the heartbeat's planUsage: a paid account's reading before a Free one that has none, a limit met spends an account until its
     * reset, a reading at 100% holds nothing, a limit met before the period began is over, an unanswered account comes last. */
    @Test fun theAccountANewSessionStartsOnIsTheSharedFixturesEveryCase() {
        val fixture = fixture()
        val accounts = fixture.list("accounts")
        val at = Instant.parse(fixture.text("now")).toEpochMilli()
        val cases = fixture.list("cases")
        assertTrue(cases.size >= 9)
        for (case in cases) {
            val usage = planUsageSnapshot(case.obj("planUsage"), ProviderEngines.CURSOR)
            assertEquals(case.text("name"), case.text("startOn"), EngineAccounts.toStartOn(accounts, usage, at))
            for ((account, until) in case.obj("blockedUntil")!!) {
                val spent = cursorUsageLimit(accountSnapshotReported(usage, account), at)
                assertEquals("${case.text("id")} $account", (until as? JsonPrimitive)?.contentOrNull, spent?.resetsAt)
            }
        }
    }

    // Included usage

    @Test fun includedUsageIsAReadingOnlyAboveZeroAndAnAccountIsSpentOnlyOnceATurnMetTheLimit() {
        val usage = planUsageSnapshot(hpc().obj("planUsage"), ProviderEngines.CURSOR)!!
        assertEquals("Free", usage.str("planName"))
        // Default's 0% (Free: none reported) is no reading: no row at all.
        assertEquals(emptyList<UsageRow>(), usageRows(accountSnapshotReported(usage, "default")!!))
        val team = usageRows(accountSnapshot(usage, "5c2e91a0")!!).single()
        assertEquals("Monthly limit" to 34, team.label to team.percent)
        assertEquals("2026-11-03T00:00:00Z", team.window.str("resetsAt"))
        val week = json("""{"provider":"cursor","includedUsage":{"period":"weekly","percentUsed":0.5}}""")
        assertEquals("Weekly limit", usageRows(week).single().label)
        assertEquals(emptyList<UsageRow>(), usageRows(json("""{"provider":"cursor","includedUsage":{"period":"weekly","percentUsed":0}}""")))
        // A flat snapshot names itself; another engine's is never read as Cursor CLI's.
        assertEquals("cursor", planUsageSnapshot(json("""{"provider":"cursor","planName":"Pro"}"""), "cursor")?.str("provider"))
        assertNull(planUsageSnapshot(json("""{"provider":"codex"}"""), "cursor"))
        assertNull(planUsageSnapshot(json("""{"cursor":{"provider":"cursor"}}"""), "claude")?.get("cursor"))
        // Spent: a limit met this period, until the reset — or with no reset to go by — and not once the reset passed or before the period.
        fun spent(included: String) = cursorUsageLimit(json("""{"provider":"cursor","includedUsage":{$included}}"""), now)
        assertEquals(CursorSpent("2026-10-24T16:32:26.082Z"),
            spent(""""startsAt":"2026-09-24T16:32:26.082Z","resetsAt":"2026-10-24T16:32:26.082Z","limitReachedAt":"2026-10-16T17:52:00Z""""))
        assertEquals(CursorSpent(null), spent(""""limitReachedAt":"2026-10-18T09:00:00Z""""))
        assertNull(spent(""""startsAt":"2026-10-17T00:00:00Z","resetsAt":"2026-10-24T00:00:00Z","limitReachedAt":"2026-10-16T17:52:00Z""""))
        assertNull(spent(""""resetsAt":"2026-10-18T11:00:00Z","limitReachedAt":"2026-10-16T17:52:00Z""""))
        assertNull(spent(""""percentUsed":100"""))
    }

    // A machine's Cursor CLI row and its engine page

    @Test fun theRowCountsItsAccountsAndNamesTheNextOneAboveItsReading() {
        val runner = hpc()
        assertEquals("2 accounts signed in" to "ok", RunnerPage.engineStatus(cursor(runner), runner))
        // Team's month expires before the Free plan's, which has no reading: a new session starts on Team.
        assertEquals("Team", RunnerPage.engineNextAccount(runner, "cursor", now))
        assertTrue(RunnerPage.marksNext(runner, "cursor", "5c2e91a0", now))
        assertEquals(listOf("Monthly limit"), RunnerPage.engineWindows(runner, "cursor", now).map { it.label })
        // Each account says its plan before its directory; Default's usage is unavailable, Team's month is a reading.
        val lines = RunnerPage.accountLines(cursor(runner), EngineAccounts.usage("cursor", runner))
        assertEquals(listOf("Free plan · ~/.orbit/cursor/default", "Pro plan · ~/.orbit/cursor-accounts/5c2e91a0"), lines.map { it.subtitle })
        assertEquals(emptyList<UsageRow>(), RunnerPage.accountWindows(runner, "cursor", "default"))
        assertEquals(listOf(34), RunnerPage.accountWindows(runner, "cursor", "5c2e91a0").map { it.percent })
        // Why, as the board's iOS 2 ③ says it (OrbitKit CursorRuntime.usageUnavailable): the Free plan's requests by their own name.
        assertEquals("Cursor doesn’t report how many of the Free plan’s requests are left.", CursorCopy.usageUnavailable("Free"))
        assertEquals("Cursor doesn’t report how much of the Pro plan’s usage is left.", CursorCopy.usageUnavailable("Pro"))
        assertEquals("Cursor doesn’t report how much of this account’s usage is left.", CursorCopy.usageUnavailable(null))
        assertEquals("Cursor doesn’t report how much of this account’s usage is left.", CursorCopy.usageUnavailable(""))
        // An account a turn met the limit on is spent until its reset.
        val spent = hpc(team = """"percentUsed":34,"limitReachedAt":"2026-10-18T09:00:00Z"""")
        assertEquals(CursorSpent("2026-11-03T00:00:00Z"), RunnerPage.cursorSpent(spent, "5c2e91a0", now))
        assertNull(RunnerPage.cursorSpent(spent, "default", now))
        assertEquals("Spent · resets Tue, Nov 3 at 8:00 AM", CursorCopy.spent(RunnerPage.resetsWhen("2026-11-03T00:00:00Z", now, java.time.ZoneId.of("Asia/Shanghai"))))
        // The build Orbit pins says so beside when it was checked.
        assertEquals("quiet" to "pinned · checked 6m ago", RunnerPage.updateNoteOf(cursor(runner).obj("update"), now, pinned = true))
        assertEquals("quiet" to "checked 6m ago", RunnerPage.updateNoteOf(cursor(runner).obj("update"), now))
    }

    /** iOS 2's four states, as the row and the engine page say them. */
    @Test fun aRunnerThatCantRunCursorCliSaysWhyAndWhatFixesIt() {
        val older = json("""{"id":"o","name":"mac-studio","online":true,"capabilities":[],"engines":[{"engine":"claude","installed":true,"auth":"yes"}]}""")
        val row = RunnerPage.engines(older, listOf(older, hpc())).last()
        assertEquals("cursor", row.str("engine"))
        assertEquals("Update runner" to "warn", RunnerPage.engineStatus(row, older))
        assertFalse(RunnerPage.needsSignIn(row, older))
        val wrong = single("""{"engine":"cursor","installed":true,"version":"2026.10.16-e3cb207",
            "installationError":"CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e"}""", "")
        assertEquals("Unsupported version" to "warn", RunnerPage.engineStatus(cursor(wrong), wrong))
        val missing = single("""{"engine":"cursor","installed":false,"installationError":"CURSOR_NOT_INSTALLED: not installed"}""", "")
        assertEquals(RunnerCopy.NOT_INSTALLED to "muted", RunnerPage.engineStatus(cursor(missing), missing))
        assertEquals("Install Cursor CLI", Infrastructure.install("cursor"))
        assertTrue(Infrastructure.installable(missing, "cursor"))
        assertEquals("Reinstall Cursor CLI", CursorCopy.REINSTALL)
        val out = single("""{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"no"}""")
        assertEquals(RunnerCopy.SIGNED_OUT to "warn", RunnerPage.engineStatus(cursor(out), out))
        assertTrue(RunnerPage.needsSignIn(cursor(out), out))
    }

    /** Add Account, the section's name and the sign-in itself need a runner that signs a named account into its own directory
     * (cursor-account-login/v1): the server hands no Cursor CLI sign-in to any other, and says so. */
    @Test fun signingInNeedsARunnerThatSignsCursorCliAccountsIn() {
        assertTrue(RunnerPage.keepsAccounts("cursor"))
        assertTrue(RunnerPage.canAddAccount(hpc(), "cursor"))
        assertEquals("Accounts", RunnerPage.accountsTitle(hpc(), "cursor"))
        assertTrue(RunnerPage.canSignIn(hpc(), "cursor"))
        assertNull(RunnerPage.signInHint(hpc(), "cursor"))
        val declaresOnly = single("""{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"no"}""", "\"provider:cursor\"")
        assertFalse(RunnerPage.canAddAccount(declaresOnly, "cursor"))
        assertEquals("Sign-In", RunnerPage.accountsTitle(declaresOnly, "cursor"))
        assertFalse(RunnerPage.canSignIn(declaresOnly, "cursor"))
        assertEquals("This runner is too old to sign in to Cursor CLI — update it, then try again.", RunnerPage.signInHint(declaresOnly, "cursor"))
        // A session moves on Cursor CLI's own capability, which no runner declares yet (D5); Automatic is decided by its own variables.
        assertEquals("cursor-account-move/v1", EngineAccounts.moveCapability("cursor"))
        assertTrue(EngineAccounts.automaticOffered("cursor", null, null, 2))
        for (key in listOf("ORBIT_CURSOR_ACCOUNT_DIR", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN")) {
            assertFalse(key, EngineAccounts.automaticOffered("cursor", null, json("""{"$key":"x"}"""), 2))
        }
        assertFalse(EngineAccounts.automaticOffered("cursor", "5c2e91a0", null, 2))
    }

    // Infrastructure

    @Test fun cursorCliIsCountedWhereverItsRowCanSignItIn() {
        // Counted wherever its row can get it signed in: on hpc, beside the three engines it doesn't have.
        assertEquals("1 of 4 signed in", Infrastructure.summary(hpc(), now))
    }

    // A Cursor key's page (iOS 4)

    @Test fun aCursorKeySaysWhatCursorAnsweredItsLastCheck() {
        fun key(state: String?, at: String? = "2026-10-18T11:56:00Z") = json("""{"id":"k","slug":"cursor-api","label":"Cursor","runtime":"cursor",
            "keyCheckState":${state?.let { "\"$it\"" } ?: "null"},"keyCheckedAt":${at?.let { "\"$it\"" } ?: "null"}}""")
        assertTrue(CursorCopy.isKey(key("VALID")))
        assertFalse(CursorCopy.isKey(json("""{"runtime":"claude"}""")))
        // Connected from the Cursor preset, whatever its row's runtime says (OrbitKit CursorRuntime.isKey).
        assertTrue(CursorCopy.isKey(json("""{"runtime":null,"presetSlug":"cursor-api"}""")))
        assertFalse(CursorCopy.isKey(json("""{"runtime":"claude","presetSlug":"glm"}""")))
        assertEquals("Valid · 4 min ago", CursorCopy.lastCheck(key("VALID"), now))
        assertEquals("Rejected · 4 min ago", CursorCopy.lastCheck(key("INVALID"), now))
        assertEquals("Couldn’t check · 4 min ago", CursorCopy.lastCheck(key("UNREACHABLE"), now))
        assertEquals("Not checked yet", CursorCopy.lastCheck(key(null, null), now))
        assertEquals(CursorCopy.CHECK_FOOTER, CursorCopy.checkFooter(key("VALID")))
        assertEquals("Cursor said “The provided API key is invalid.” Paste a new key on the web, then check again.", CursorCopy.checkFooter(key("INVALID")))
        assertEquals("Couldn’t reach Cursor from the runner that checks keys. The key itself may be fine.", CursorCopy.checkFooter(key("UNREACHABLE")))
        assertEquals(PoolStatus("Rejected", "warning"), CursorCopy.rowValue(key("INVALID")))
        assertNull(CursorCopy.rowValue(key("UNREACHABLE")))
        // Its key section: Cursor's own API, Auto, and that turning it off stops it on Cursor CLI alone.
        assertEquals("Cursor API", KeyEngines.protocol("cursor"))
        assertEquals(listOf("cursor"), KeyEngines.engines(json("""{"slug":"cursor-api","runtime":"cursor","engines":["cursor"]}""")))
        assertEquals("Adding or changing a key happens on the web. Turning it off there stops it on Cursor CLI.", KeyEngines.footer(listOf("Cursor CLI")))
    }
}
