package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Kimi Code's accounts on Android (docs/mocks/kimi-accounts/02-ios and its Android notes, with the owner's calls of
 * 2026-10-08): Kimi keeps accounts like the other three engines, Add Account only where the runner signs a named one into a
 * KIMI_CODE_HOME of its own, each line says its site before its directory, three windows per account with the month drawn
 * once, the account a new session starts on marked NEXT on every engine page, and the site chosen before a sign-in.
 */
class KimiAccountsTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-10-09T09:40:00Z").toEpochMilli()
    private fun at(hours: Long) = Instant.ofEpochMilli(now).plusSeconds(hours * 3600).toString()
    private fun window(used: Int, resetsInHours: Long) = """{"utilization":$used,"resetsAt":"${at(resetsInHours)}"}"""
    private fun kimiUsage(five: Int, week: Int, month: Int, code: Int, weekIn: Long = 96, monthIn: Long = 552) =
        """"provider":"kimi","fiveHour":${window(five, 2)},"sevenDay":${window(week, weekIn)},"month":${window(month, monthIn)},"monthCode":${window(code, monthIn)}"""
    private val allKimi = """"kimi-account-login/v1","kimi-account-remove/v1","kimi-account-move/v1","kimi-login-region/v1""""

    /** HPC as the board draws it: Default on kimi.ai, Work added on kimi.com, Work's five hours 91% used. */
    private fun twoKimi(capabilities: String = allKimi, work: String = kimiUsage(91, 61, 22, 20, weekIn = 25, monthIn = 487)) = json("""{"id":"r","name":"hpc",
        "capabilities":[$capabilities],
        "engines":[{"engine":"kimi","installed":true,"version":"2.1.1","auth":"yes","kimiRegion":"global",
          "accounts":[{"id":"default","auth":"yes","home":"/root/.kimi-code","kimiRegion":"global"},
            {"id":"5c2e91a0","name":"Work","auth":"yes","home":"/root/.orbit/kimi-accounts/5c2e91a0","kimiRegion":"mainland-cn"}]}],
        "planUsage":{"kimi":{${kimiUsage(12, 34, 8, 5)},"accounts":{"5c2e91a0":{$work}}}}}""")
    private fun oneKimi(capabilities: String = allKimi, accounts: String? = """[{"id":"default","auth":"yes","home":"/root/.kimi-code","kimiRegion":"global"}]""") =
        json("""{"id":"r","name":"hpc","capabilities":[$capabilities],
        "engines":[{"engine":"kimi","installed":true,"version":"2.1.1","auth":"yes","kimiRegion":"global"${accounts?.let { ""","accounts":$it""" }.orEmpty()}}],
        "planUsage":{"kimi":{${kimiUsage(12, 34, 8, 5)}}}}""")
    private fun kimi(runner: JsonObject) = runner.list("engines").first { it.str("engine") == "kimi" }

    // the list of engines that keep accounts, and what lets Kimi add one

    @Test fun kimiKeepsAccountsAndAddsOneOnlyOnARunnerThatSignsItIntoItsOwnHome() {
        assertTrue(RunnerPage.keepsAccounts("kimi"))
        assertTrue(RunnerPage.canAddAccount(oneKimi(), "kimi"))
        assertEquals("Accounts", RunnerPage.accountsTitle(oneKimi(), "kimi"))
        // An older runner would sign Default in again in its place: its page reads as it always has.
        val older = oneKimi(capabilities = "\"kimi-login-region/v1\"", accounts = null)
        assertFalse(RunnerPage.canAddAccount(older, "kimi"))
        assertEquals("Sign-In", RunnerPage.accountsTitle(older, "kimi"))
        // The other engines are as they were.
        assertTrue(RunnerPage.canAddAccount(older, "codex"))
        assertEquals("Accounts", RunnerPage.accountsTitle(older, "claude"))
        assertEquals("Sign-In", RunnerPage.accountsTitle(older, "opencode"))
    }

    /** A Kimi session moves where the runner carries its conversation across: kimi-account-move/v1, never Codex's. */
    @Test fun aKimiSessionMovesOnKimisOwnCapability() {
        assertEquals("kimi-account-move/v1", EngineAccounts.moveCapability("kimi"))
        assertEquals("codex-account-move/v1", EngineAccounts.moveCapability("codex"))
        assertEquals("claude-account-move/v1", EngineAccounts.moveCapability("claude"))
        assertEquals("antigravity-account-login/v1", EngineAccounts.moveCapability("antigravity"))
        assertEquals("kimi-account-login/v1", EngineAccounts.KIMI_ACCOUNT_LOGIN)
    }

    // site · directory

    @Test fun eachLineSaysItsOwnSiteBeforeItsDirectory() {
        val lines = RunnerPage.accountLines(kimi(twoKimi()))
        assertEquals(listOf("Default", "Work"), lines.map { it.name })
        assertEquals(listOf("kimi.ai · ~/.kimi-code", "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0"), lines.map { it.subtitle })
        // One account: Default's site is the engine's.
        assertEquals("kimi.ai · ~/.kimi-code", RunnerPage.accountLines(kimi(oneKimi())).single().subtitle)
        // A runner too old to list accounts still says which site its one login is on.
        assertEquals("kimi.ai", RunnerPage.accountLines(kimi(oneKimi(accounts = null))).single().subtitle)
        // A Default renamed in Orbit is still the machine's own login.
        val renamed = json("""{"engine":"kimi","installed":true,"auth":"yes","kimiRegion":"global","accounts":[
            {"id":"default","name":"Home","auth":"yes","home":"/root/.kimi-code","kimiRegion":"global"},
            {"id":"5c2e91a0","name":"Work","auth":"yes","home":"/root/.orbit/kimi-accounts/5c2e91a0"}]}""")
        assertEquals(listOf("kimi.ai · ~/.kimi-code · Default", "~/.orbit/kimi-accounts/5c2e91a0"), RunnerPage.accountLines(renamed).map { it.subtitle })
        // No other engine's line names a site.
        val codex = json("""{"engine":"codex","installed":true,"auth":"yes","kimiRegion":"global","accounts":[
            {"id":"default","auth":"yes","home":"/root/.codex","kimiRegion":"global"},{"id":"1a2b3c4d","auth":"yes","home":"/root/.orbit/codex-accounts/1a2b3c4d"}]}""")
        assertEquals(listOf("~/.codex", "~/.orbit/codex-accounts/1a2b3c4d"), RunnerPage.accountLines(codex).map { it.subtitle })
    }

    /** The Engines row says the site after the version while Kimi has one login; with two, which can be on different sites, the
     * row says how many are signed in and each line says its own. */
    @Test fun theEnginesRowNamesTheSiteOnlyWhileThereIsOneLogin() {
        assertEquals("kimi.ai", RunnerPage.engineSite(kimi(oneKimi())))
        assertEquals("kimi.ai", RunnerPage.engineSite(kimi(oneKimi(accounts = null))))
        assertNull(RunnerPage.engineSite(kimi(twoKimi())))
        assertEquals("2 accounts signed in" to "ok", RunnerPage.engineStatus(kimi(twoKimi())))
        assertNull(RunnerPage.engineSite(json("""{"engine":"codex","installed":true,"kimiRegion":"global"}""")))
        assertNull("before Kimi's first sign-in", RunnerPage.engineSite(json("""{"engine":"kimi","installed":true,"auth":"no"}""")))
    }

    // three windows each, the month once

    @Test fun eachAccountHasItsOwnThreeWindowsWithTheMonthDrawnOnce() {
        val runner = twoKimi()
        val default = RunnerPage.accountWindows(runner, "kimi", "default")
        assertEquals(listOf("5h limit", "Weekly limit", "Monthly limit"), default.map { it.label })
        assertEquals(listOf(12, 34, 8), default.map { it.percent })
        val work = RunnerPage.accountWindows(runner, "kimi", "5c2e91a0")
        assertEquals(listOf(91, 61, 22), work.map { it.percent })
        assertEquals("Work's five hours turn amber", listOf(true, false, false), work.map { it.nearLimit })
        assertTrue("the coding share of the month is not a row", (default + work).none { it.key == "monthCode" })
        // The Engines row carries the next account's window nearest its limit.
        assertEquals("Default", RunnerPage.engineNextAccount(runner, "kimi", now))
        assertEquals(listOf("Weekly limit" to 34), RunnerPage.engineWindows(runner, "kimi", now).map { it.label to it.percent })
        // One account: its windows on the row, no account named above them.
        assertNull(RunnerPage.engineNextAccount(oneKimi(), "kimi", now))
        assertEquals(listOf(34), RunnerPage.engineWindows(oneKimi(), "kimi", now).map { it.percent })
    }

    // no quota limit (web kimiNoQuotaLimit)

    /** "No quota limit" is a Kimi login whose quota was read and held no window at all — told apart from a login never
     * read or whose read failed, which still says "No quota reported" — and Kimi only: a windowless Codex or Claude
     * snapshot is a failed read. */
    @Test fun aWindowlessKimiSnapshotReadsAsNoQuotaLimitOnlyWhereOneWasRead() {
        fun runner(usage: String?) = json("""{"id":"r","name":"hpc",
            "engines":[{"engine":"kimi","installed":true,"auth":"yes","kimiRegion":"global",
              "accounts":[{"id":"default","auth":"yes","home":"/root/.kimi-code","kimiRegion":"global"},
                {"id":"5c2e91a0","name":"Work","auth":"yes","home":"/root/.orbit/kimi-accounts/5c2e91a0","kimiRegion":"mainland-cn"}]}]
            ${usage?.let { ""","planUsage":$it""" }.orEmpty()}}""")
        // A plan with no quota limit: the answer held no window, only when it was read — Default's and Work's alike.
        val read = runner("""{"kimi":{"provider":"kimi","fetchedAt":"${at(0)}","accounts":{"5c2e91a0":{"provider":"kimi","fetchedAt":"${at(0)}"}}}}""")
        assertTrue(RunnerPage.accountNoQuotaLimit(read, "kimi", "default"))
        assertTrue(RunnerPage.accountNoQuotaLimit(read, "kimi", "5c2e91a0"))
        // accountSnapshot collapses a windowless Default to null; the reported lookup keeps it, and an unread account
        // has no snapshot to judge.
        val usage = EngineAccounts.usage("kimi", read)!!
        assertNull(accountSnapshot(usage, "default"))
        assertTrue(kimiNoQuotaLimit(accountSnapshotReported(usage, "default")))
        assertFalse(kimiNoQuotaLimit(accountSnapshotReported(usage, "deadbeef")))
        // The coding share of the month is never drawn, but a plan reporting it has a limit.
        val monthCodeOnly = runner("""{"kimi":{"provider":"kimi","fetchedAt":"${at(0)}","monthCode":${window(20, 552)}}}""")
        assertFalse(RunnerPage.accountNoQuotaLimit(monthCodeOnly, "kimi", "default"))
        // A snapshot with windows has quota to gauge.
        assertFalse(RunnerPage.accountNoQuotaLimit(twoKimi(), "kimi", "default"))
        assertFalse(RunnerPage.accountNoQuotaLimit(twoKimi(), "kimi", "5c2e91a0"))
        // Never read: no planUsage at all, a snapshot whose own part is its provider alone, an added account with no entry.
        assertFalse(RunnerPage.accountNoQuotaLimit(runner(null), "kimi", "default"))
        val onlyWork = runner("""{"kimi":{"provider":"kimi","accounts":{"5c2e91a0":{${kimiUsage(12, 34, 8, 5)}}}}}""")
        assertFalse(RunnerPage.accountNoQuotaLimit(onlyWork, "kimi", "default"))
        assertFalse(RunnerPage.accountNoQuotaLimit(read, "kimi", "deadbeef"))
        // Kimi only: a windowless Codex or Claude snapshot is a read that failed.
        val codex = json("""{"id":"r","engines":[{"engine":"codex","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"}]}],
            "planUsage":{"codex":{"provider":"codex","fetchedAt":"${at(0)}"}}}""")
        assertFalse(RunnerPage.accountNoQuotaLimit(codex, "codex", "default"))
        val claude = json("""{"id":"r","engines":[{"engine":"claude","installed":true,"auth":"yes"}],
            "planUsage":{"claude":{"provider":"claude","fetchedAt":"${at(0)}"}}}""")
        assertFalse(RunnerPage.accountNoQuotaLimit(claude, "claude", "default"))
    }

    // NEXT

    /** NEXT marks the account a new session starts on: Work's five hours are past 80%, so Default — and only with two accounts. */
    @Test fun nextMarksTheAccountANewSessionStartsOn() {
        val runner = twoKimi()
        assertTrue(RunnerPage.marksNext(runner, "kimi", "default", now))
        assertFalse(RunnerPage.marksNext(runner, "kimi", "5c2e91a0", now))
        assertFalse("one account: nothing to choose between", RunnerPage.marksNext(oneKimi(), "kimi", "default", now))
        // Work's five hours back to 12%: its month runs out first (Oct 29 before Nov 1), so it goes first.
        val roomy = twoKimi(work = kimiUsage(12, 61, 22, 20, weekIn = 25, monthIn = 487))
        assertTrue(RunnerPage.marksNext(roomy, "kimi", "5c2e91a0", now))
        assertFalse(RunnerPage.marksNext(roomy, "kimi", "default", now))
    }

    /** As shared weighs it, the month is Kimi's longest window: the account whose month ends first goes first even when its
     * week ends later; and a spent coding share holds the account as any spent window does. */
    @Test fun theMonthDecidesWhichKimiAccountGoesFirst() {
        fun pick(work: String) = EngineAccounts.toStartOn(kimi(twoKimi()).list("accounts"),
            json("""{${kimiUsage(10, 10, 10, 10, weekIn = 20, monthIn = 552)},"accounts":{"5c2e91a0":{$work}}}"""), now)
        // Work's week ends after Default's, its month before.
        assertEquals("5c2e91a0", pick(kimiUsage(10, 10, 10, 10, weekIn = 90, monthIn = 487)))
        assertEquals("default", pick(kimiUsage(10, 10, 10, 10, weekIn = 10, monthIn = 600)))
        assertEquals("Work's coding share spent: Default", "default", pick(kimiUsage(10, 10, 10, 100, weekIn = 90, monthIn = 487)))
    }

    /** The four engines mark NEXT by the same rule. */
    @Test fun everyEngineMarksItsNextAccount() {
        val runner = json("""{"id":"r","capabilities":["antigravity-account-login/v1"],
            "antigravity":{"googleLogin":"available"},
            "engines":[{"engine":"claude","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"1fda3f43","name":"Work","auth":"yes"}]},
              {"engine":"codex","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"1a2b3c4d","name":"Second","auth":"yes"}]},
              {"engine":"antigravity","installed":true,"auth":"yes","authSource":"google","accounts":[{"id":"default","auth":"yes"},{"id":"5c2e91a0","name":"Work","auth":"yes"}],
                "planUsage":{"provider":"antigravity","buckets":[{"id":"gemini-5h","window":"5h","remainingFraction":0.9}],
                  "accounts":{"5c2e91a0":{"provider":"antigravity","buckets":[{"id":"gemini-5h","window":"5h","remainingFraction":0.04}]}}}},
              {"engine":"kimi","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"5c2e91a0","name":"Work","auth":"yes"}]}],
            "planUsage":{"claude":{"fiveHour":${window(95, 2)},"accounts":{"1fda3f43":{"fiveHour":${window(10, 2)}}}},
              "codex":{"provider":"codex","primary":{"utilization":30,"windowDurationMins":300},"accounts":{"1a2b3c4d":{"provider":"codex","primary":{"utilization":85,"windowDurationMins":300}}}},
              "kimi":{${kimiUsage(12, 34, 8, 5)},"accounts":{"5c2e91a0":{${kimiUsage(91, 61, 22, 20)}}}}}}""")
        fun marked(engine: String) = runner.list("engines").first { it.str("engine") == engine }
            .list("accounts").map { it.text("id") }.filter { RunnerPage.marksNext(runner, engine, it, now) }
        assertEquals(listOf("1fda3f43"), marked("claude"))
        assertEquals(listOf("default"), marked("codex"))
        assertEquals(listOf("default"), marked("antigravity"))
        assertEquals(listOf("default"), marked("kimi"))
        assertFalse(RunnerPage.marksNext(runner, "opencode", "default", now))
    }

    /** Needs Attention raises a nearly spent Kimi quota only when every account that can run is near its limit, naming the
     * roomiest account's fullest window in that window's own words. */
    @Test fun aNearlySpentKimiQuotaIsRaisedOnlyWhenEveryAccountIsNear() {
        val workspaces = listOf(json("""{"id":"w1","name":"Kimi work","lastProvider":"kimi"}"""))
        fun raised(default: String, work: String): AttentionItem? {
            val runner = JsonObject(twoKimi(work = work) + ("online" to JsonPrimitive(true)) +
                ("planUsage" to json("""{"kimi":{$default,"accounts":{"5c2e91a0":{$work}}}}""")))
            return RunnerPage.attention(runner, workspaces, now, null).singleOrNull { it.kind == "quotaNearLimit" }
        }
        assertNull("Default has room", raised(kimiUsage(12, 34, 8, 5), kimiUsage(91, 61, 22, 20)))
        assertEquals("Kimi 5-hour limit 91%", raised(kimiUsage(12, 34, 95, 5), kimiUsage(91, 61, 22, 20))?.short)
        assertEquals("Kimi monthly limit at 95%", raised(kimiUsage(12, 34, 95, 5), kimiUsage(91, 61, 97, 20))?.title)
    }

    // the site before a sign-in

    @Test fun theSitesAreKimisOwn() {
        assertEquals(listOf("mainland-cn" to "kimi.com", "global" to "kimi.ai"), KimiSite.entries.map { it.region to it.domain })
        assertEquals(listOf("Mainland China", "International"), KimiSite.entries.map { it.place })
        assertEquals(KimiSite.GLOBAL, KimiSite.MAINLAND_CN.other)
        assertEquals(KimiSite.MAINLAND_CN, KimiSite.GLOBAL.other)
        assertEquals(KimiSite.GLOBAL, KimiSite.of("global"))
        assertNull(KimiSite.of("eu"))
        // The device page's own address says which site it is on.
        assertEquals(KimiSite.GLOBAL, KimiSite.ofUrl("https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86"))
        assertEquals(KimiSite.MAINLAND_CN, KimiSite.ofUrl("https://www.kimi.com/code/authorize_device?user_code=SHG3-0DSI"))
        assertEquals(KimiSite.MAINLAND_CN, KimiSite.ofUrl("https://AUTH.KIMI.COM/verify"))
        assertNull(KimiSite.ofUrl("https://notkimi.ai"))
        assertNull(KimiSite.ofUrl("https://kimi.ai.example.test"))
        assertNull(KimiSite.ofUrl("not a url"))
        assertNull(KimiSite.ofUrl(null))
    }

    /** kimi.ai is always named; kimi.com only to a runner that can be told a site — an older one signs in where its CLI decides,
     * which is kimi.com on an install Orbit made, and the server refuses it kimi.ai in words that say to update it. */
    @Test fun aRunnerTooOldToBeToldASiteGetsKimiComUnnamed() {
        val current = oneKimi()
        assertTrue(KimiSite.choosable(current))
        assertEquals(KimiSite.MAINLAND_CN, KimiSite.named(KimiSite.MAINLAND_CN, current))
        assertEquals(KimiSite.GLOBAL, KimiSite.named(KimiSite.GLOBAL, current))
        val older = oneKimi(capabilities = "", accounts = null)
        assertFalse(KimiSite.choosable(older))
        assertNull(KimiSite.named(KimiSite.MAINLAND_CN, older))
        assertEquals(KimiSite.GLOBAL, KimiSite.named(KimiSite.GLOBAL, older))
    }

    /** Current is the site of the login a card signs in again: the account's own (Work's kimi.com), Default's the engine's;
     * a card adding an account has none. */
    @Test fun currentIsTheSiteOfTheAccountSignedInAgain() {
        val runner = twoKimi()
        assertEquals(KimiSite.MAINLAND_CN, KimiSite.current(runner, "5c2e91a0", adding = false))
        assertEquals(KimiSite.GLOBAL, KimiSite.current(runner, "default", adding = false))
        assertEquals(KimiSite.GLOBAL, KimiSite.current(runner, null, adding = false))
        assertNull(KimiSite.current(runner, null, adding = true))
        assertNull("an account not signed in yet", KimiSite.current(runner, "deadbeef", adding = false))
    }

    // the web's words

    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/components").isDirectory }
    private fun source(relative: String) = File(root, relative).readText().replace(Regex("\\s+"), " ")

    /** Kimi's sign-in says what the web's RunnerSignIn says, word for word, with the web's expression where a site is named. */
    @Test fun theSignInSaysWhatTheWebSays() {
        val card = source("src/web/src/components/RunnerSignIn.tsx")
        val site = KimiSite.GLOBAL
        for (literal in listOf(KimiSite.QUESTION, KimiSite.SEPARATE_ACCOUNTS, ">${KimiSite.CURRENT}<",
            "'mainland-cn': { domain: '${KimiSite.MAINLAND_CN.domain}', where: '${KimiSite.MAINLAND_CN.place}' }",
            "global: { domain: '${KimiSite.GLOBAL.domain}', where: '${KimiSite.GLOBAL.place}' }",
            site.openPage.replace(site.domain, "\${KIMI_SITE[site].domain}"),
            site.copyCodeAndOpen.replace(site.domain, "\${KIMI_SITE[site].domain}"),
            site.enterCode.replace(site.domain, "<b>{KIMI_SITE[site].domain}</b>"),
            site.enterCodeAdding.replace(site.domain, "<b>{KIMI_SITE[site].domain}</b>"),
            site.useInstead.replace(site.domain, "{KIMI_SITE[other].domain}"))) {
            assertTrue("RunnerSignIn.tsx no longer says $literal", card.contains(literal))
        }
        assertTrue(source("src/shared/src/dto.ts").contains("KIMI_LOGIN_REGION_V1 = '${KimiSite.LOGIN_REGION}'"))
    }
}
