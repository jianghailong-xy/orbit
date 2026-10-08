package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * OrbitKit's AntigravityGoogleClientTests and AntigravityAccountsTests on the Android port: Antigravity's Google sign-in
 * and its accounts, drawn and weighed the way Claude Code's and Codex's are — the runner page's row and its one window,
 * the engine page's account lines, Add Account's gates, a runner on its own GEMINI_API_KEY, Automatic and Needs Attention.
 * The sign-in payloads are the shared ones web and both native shells read
 * (docs/evidence/antigravity-google-login/clients/fixtures.json); the accounts machine is the mocks' HPC.
 */
class AntigravityAccountsTest {
    private val fixtures: JsonObject by lazy {
        val root = generateSequence(File("").absoluteFile) { it.parentFile }.firstOrNull { File(it, "docs/evidence/antigravity-google-login").isDirectory }
            ?: error("docs/evidence/antigravity-google-login not found above ${File("").absolutePath}")
        Json.parseToJsonElement(File(root, "docs/evidence/antigravity-google-login/clients/fixtures.json").readText()).jsonObject
    }
    private fun fixture(state: String) = fixtures[state]!!.jsonObject
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun agy(runner: JsonObject) = runner.list("engines").first { it.str("engine") == "antigravity" }
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    // MARK: Google sign-in (AntigravityGoogleClientTests)

    @Test fun googleIdentityQuotaAndResetDataAreTheSharedPayloads() {
        val runner = fixture("google")
        val health = agy(runner)
        assertEquals("Signed in", RunnerPage.engineStatus(health)?.first)
        assertTrue(RunnerPage.antigravityCanSignIn(runner))
        // The row carries every bucket, as the engine page does.
        assertEquals(listOf("gemini-weekly", "3p-5h"), RunnerPage.engineWindows(runner, "antigravity").map { it.groupLabel })
        val rows = RunnerPage.accountWindows(runner, "antigravity", "default")
        assertEquals(listOf("Weekly", "5-hour"), rows.map { it.label })
        assertEquals(listOf("gemini-weekly", "3p-5h"), rows.map { it.groupLabel })
        assertEquals(listOf(72, 18), rows.map { it.percent })
        assertTrue(rows.all { it.remaining })
        assertEquals(listOf("2026-10-09T03:00:00Z", "2026-10-04T08:00:00Z"), rows.map { it.window.str("resetsAt") })
    }

    @Test fun loginEntryGatesAndUnknownAuth() {
        for (state in listOf("signed-out", "google", "env-key", "unknown")) assertTrue(state, RunnerPage.antigravityCanSignIn(fixture(state)))
        for (state in listOf("macos", "old")) {
            assertFalse(state, RunnerPage.antigravityCanSignIn(fixture(state)))
            assertNotNull(state, RunnerPage.signInHint(fixture(state), "antigravity"))
        }
        assertEquals("Google sign-in is not supported on macOS runners yet. Use a Gemini API key.", RunnerPage.antigravityLoginHint("unsupported_platform"))
        assertNull(RunnerPage.engineStatus(agy(fixture("unknown"))))
        assertEquals("env key", RunnerPage.engineStatus(agy(fixture("env-key")))?.first)
        // A macOS runner and an old one say so on the row instead of Signed out.
        assertEquals("Not supported yet", RunnerPage.engineStatus(agy(fixture("macos")), fixture("macos"))?.first)
        assertEquals("Update runner", RunnerPage.engineStatus(agy(fixture("old")), fixture("old"))?.first)
        assertEquals("Signed out", RunnerPage.engineStatus(agy(fixture("signed-out")), fixture("signed-out"))?.first)
    }

    @Test fun anOldRunnerWithoutAntigravityHealthKeepsItsUpgradeEntry() {
        for (payload in listOf("""{"id":"old","name":"Older runner"}""", """{"id":"old","name":"Older runner","engines":[]}""",
            """{"id":"old","name":"Older runner","engines":[],"antigravity":{"supported":false,"installed":null,"envKeyAvailable":false,"googleLogin":"needs_update"}}""")) {
            val runner = json(payload)
            val health = RunnerPage.engines(runner).single { it.str("engine") == "antigravity" }
            assertNull(health.bool("installed"))
            assertEquals("Update runner", RunnerPage.engineStatus(health, runner)?.first)
            assertFalse(RunnerPage.antigravityCanSignIn(runner))
            assertEquals("Update this runner to sign in with Google.", RunnerPage.signInHint(runner, "antigravity"))
        }
        assertEquals("Antigravity", RunnerPage.engineName("antigravity"))
    }

    @Test fun aMacOSRunnerWithAnEnvironmentKeyKeepsTheKeyAndTheUnsupportedHint() {
        val runner = json("""{"id":"mac","name":"Mac runner","engines":[{"engine":"antigravity","installed":true,"auth":"yes","authSource":"env_key"}],
            "antigravity":{"supported":true,"installed":true,"envKeyAvailable":true,"authSource":"env_key","googleLogin":"unsupported_platform"}}""")
        val health = RunnerPage.engines(runner).first()
        assertEquals("env key", RunnerPage.engineStatus(health, runner)?.first)
        assertFalse(RunnerPage.antigravityCanSignIn(runner))
        assertEquals("Google sign-in is not supported on macOS runners yet. Use a Gemini API key.", RunnerPage.signInHint(runner, "antigravity"))
        assertTrue(RunnerPage.engineWindows(runner, "antigravity").isEmpty())
    }

    @Test fun aMissingCliTakesPrecedenceOverGoogleLoginAvailability() {
        for (login in listOf("available", "unsupported_platform", "needs_update")) {
            val runner = json("""{"id":"missing","name":"Runner without CLI","engines":[{"engine":"antigravity","installed":false,"auth":"unknown"}],
                "antigravity":{"supported":true,"installed":false,"envKeyAvailable":false,"googleLogin":"$login"}}""")
            assertEquals(login, "Not installed", RunnerPage.engineStatus(RunnerPage.engines(runner).first(), runner)?.first)
            assertFalse(login, RunnerPage.antigravityCanSignIn(runner))
        }
    }

    @Test fun zeroRemainingIsSpentAndSignedOutHasNoQuota() {
        val row = usageRows(json("""{"provider":"antigravity","buckets":[{"id":"3p-5h","window":"5h","remainingFraction":0,"resetTime":"2026-10-04T08:00:00Z"}]}""")).single()
        assertEquals(0, row.percent)
        assertEquals(100.0, row.utilization, 0.0001)
        assertTrue(row.nearLimit)
        assertTrue(row.remaining)
        assertTrue(RunnerPage.engineWindows(fixture("expired"), "antigravity").isEmpty())
    }

    @Test fun googleTermsAreIosWords() {
        assertEquals("https://antigravity.google/terms", AccountCopy.GOOGLE_TERMS_URL)
        assertEquals("Google terms restrict personal account sign-in through third-party tools; your account may be suspended.", AccountCopy.GOOGLE_TERMS_WARNING)
    }

    // MARK: several Google accounts (AntigravityAccountsTests: Default, and Work added beside it)

    private val work = "5c2e91a0"
    /** 2026-10-06 13:30 in the mocks' Shanghai time: before every reset below. */
    private val now = ms("2026-10-06T05:30:00Z")

    /** agy's four buckets, what each has left, and when its weekly and 5-hour ones reset. */
    private fun buckets(left: List<Double>, weekly: String, fiveHour: String) = JsonArray(listOf("gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h").zip(left).map { (id, rest) ->
        buildJsonObject {
            put("id", id); put("window", if (id.endsWith("5h")) "5h" else "weekly"); put("remainingFraction", rest)
            put("resetTime", if (id.endsWith("5h")) fiveHour else weekly)
        }
    })
    private val defaultBuckets = buckets(listOf(1.0, 1.0, 0.98, 1.0), "2026-10-10T17:31:00Z", "2026-10-06T14:28:00Z")
    /** Work's: its 5 hours down to 4%. */
    private val workBuckets = buckets(listOf(0.61, 0.04, 1.0, 1.0), "2026-10-10T00:05:00Z", "2026-10-06T11:40:00Z")

    private fun engine(auth: String = "yes", authSource: String? = "google", accounts: List<Triple<String, String?, String>>,
                       defaultBuckets: JsonArray? = null, others: Map<String, JsonArray> = emptyMap()) = buildJsonObject {
        put("engine", "antigravity"); put("installed", true); put("version", "1.3.0"); put("auth", auth)
        authSource?.let { put("authSource", it) }
        put("accounts", JsonArray(accounts.map { (id, name, state) ->
            buildJsonObject {
                put("id", id); put("auth", state)
                put("home", if (id == "default") "/root/.orbit/antigravity/google" else "/root/.orbit/antigravity-accounts/$id")
                name?.let { put("name", it) }
            }
        }))
        if (defaultBuckets != null || others.isNotEmpty()) put("planUsage", buildJsonObject {
            put("provider", "antigravity"); put("fetchedAt", "2026-10-06T05:29:00Z")
            defaultBuckets?.let { put("buckets", it) }
            if (others.isNotEmpty()) put("accounts", buildJsonObject {
                others.forEach { (id, theirs) -> put(id, buildJsonObject { put("provider", "antigravity"); put("fetchedAt", "2026-10-06T05:29:00Z"); put("buckets", theirs) }) }
            })
        })
    }

    private fun runner(engine: JsonObject, googleLogin: String = "available",
                       capabilities: List<String> = listOf(EngineAccounts.ANTIGRAVITY_ACCOUNT_LOGIN, "antigravity-account-remove/v1")) = buildJsonObject {
        put("id", "r1"); put("name", "HPC"); put("online", true); put("status", "ONLINE"); put("version", "0.1.230")
        put("lastHeartbeatAt", "2026-10-06T05:29:50Z")
        put("capabilities", JsonArray(capabilities.map(::JsonPrimitive)))
        put("engines", JsonArray(listOf(engine)))
        put("antigravity", buildJsonObject {
            put("supported", true); put("installed", true); put("version", "1.3.0"); put("envKeyAvailable", true); put("googleLogin", googleLogin)
        })
    }
    private val workspace = json("""{"id":"w1","name":"orbit-develop","lastProvider":"antigravity"}""")

    /** ① One Google account reads like Codex: Signed in, its windows on the row, no Sign In. */
    @Test fun oneGoogleAccountIsSignedInWithItsWindowsOnTheRow() {
        val hpc = runner(engine(accounts = listOf(Triple("default", null, "yes")), defaultBuckets = defaultBuckets))
        val health = agy(hpc)
        assertEquals("Signed in" to "ok", RunnerPage.engineStatus(health, hpc))
        assertFalse(RunnerPage.needsSignIn(health))
        assertNull(RunnerPage.signInHint(hpc, "antigravity"))
        assertEquals(listOf("gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"), RunnerPage.engineWindows(hpc, "antigravity").map { it.groupLabel })
        val rows = RunnerPage.accountWindows(hpc, "antigravity", "default")
        assertEquals(listOf("gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"), rows.map { it.groupLabel })
        assertEquals(listOf("Weekly", "5-hour", "Weekly", "5-hour"), rows.map { it.label })
        assertEquals(listOf(100, 100, 98, 100), rows.map { it.percent })
        assertTrue("still what is left, as agy says it", rows.all { it.remaining })
    }

    /** ③ Several read like Claude Code: "2 accounts signed in"; each account's quota is its own, on the engine page. */
    @Test fun severalGoogleAccountsAreCountedAndEachOnesQuotaIsItsOwn() {
        val hpc = runner(engine(accounts = listOf(Triple("default", null, "yes"), Triple(work, "Work", "yes")),
            defaultBuckets = defaultBuckets, others = mapOf(work to workBuckets)))
        assertEquals("2 accounts signed in" to "ok", RunnerPage.engineStatus(agy(hpc), hpc))
        assertEquals(emptyList<UsageRow>(), RunnerPage.engineWindows(hpc, "antigravity"))
        assertEquals(listOf(100, 100, 98, 100), RunnerPage.accountWindows(hpc, "antigravity", "default").map { it.percent })
        assertEquals(listOf(61, 4, 100, 100), RunnerPage.accountWindows(hpc, "antigravity", work).map { it.percent })
        assertEquals(emptyList<UsageRow>(), RunnerPage.accountWindows(hpc, "antigravity", "gone"))
    }

    /** ④ Any account signed out is the row's to say, with the usual Sign In. */
    @Test fun anAccountSignedOutIsTheRowsToSay() {
        val hpc = runner(engine(accounts = listOf(Triple("default", null, "yes"), Triple(work, "Work", "no")), defaultBuckets = defaultBuckets))
        assertEquals("Signed out" to "warn", RunnerPage.engineStatus(agy(hpc), hpc))
        assertTrue(RunnerPage.needsSignIn(agy(hpc)))
        assertEquals("a signed-out account has no quota", emptyList<UsageRow>(), RunnerPage.accountWindows(hpc, "antigravity", work))
        // Default signed out takes its buckets with it, and the rest are still each one's own.
        val defaultOut = runner(engine(auth = "no", accounts = listOf(Triple("default", null, "no"), Triple(work, "Work", "yes")), others = mapOf(work to workBuckets)))
        assertEquals("Signed out", RunnerPage.engineStatus(agy(defaultOut), defaultOut)?.first)
        assertEquals(emptyList<UsageRow>(), RunnerPage.accountWindows(defaultOut, "antigravity", "default"))
        assertEquals(listOf(61, 4, 100, 100), RunnerPage.accountWindows(defaultOut, "antigravity", work).map { it.percent })
    }

    /** A runner on its own GEMINI_API_KEY keeps saying "env key": its Default answers no, yet is neither signed out nor short
     * of quota, so it raises no Sign In and no Needs Attention item. */
    @Test fun aRunnerOnItsGeminiKeyKeepsSayingEnvKey() {
        val keyed = runner(engine(authSource = "env_key", accounts = listOf(Triple("default", null, "no"))))
        val health = agy(keyed)
        assertEquals("env key" to "ok", RunnerPage.engineStatus(health, keyed))
        assertFalse(RunnerPage.needsSignIn(health))
        assertEquals(emptyList<UsageRow>(), RunnerPage.engineWindows(keyed, "antigravity"))
        val line = RunnerPage.accountLines(health).single()
        assertTrue("its line says what it runs on", line.envKey)
        assertNull("neither signed in nor out", line.auth)
        assertNull(RunnerPage.authStatus(line.auth))
        assertEquals("~/.orbit/antigravity/google", line.subtitle)
        val items = RunnerPage.attention(keyed, listOf(workspace), now, null)
        assertFalse(items.any { it.kind == "engineSignedOut" || it.kind == "quotaNearLimit" })
        // One too old to list its accounts says the same of the engine's own answer.
        val older = json("""{"engine":"antigravity","installed":true,"auth":"yes","authSource":"env_key"}""")
        assertEquals("env key", RunnerPage.engineStatus(older)?.first)
        assertEquals(listOf(true), RunnerPage.accountLines(older).map { it.envKey })
        // With a Google account added beside it, the key's Default still counts as in, never as out.
        val both = runner(engine(authSource = "env_key", accounts = listOf(Triple("default", null, "no"), Triple(work, "Work", "yes")), others = mapOf(work to workBuckets)))
        assertEquals("2 accounts signed in", RunnerPage.engineStatus(agy(both), both)?.first)
        assertFalse(RunnerPage.needsSignIn(agy(both)))
        assertEquals(listOf(true, false), RunnerPage.accountLines(agy(both)).map { it.envKey })
        assertEquals(listOf(null, "yes"), RunnerPage.accountLines(agy(both)).map { it.auth })
        val workOut = runner(engine(authSource = "env_key", accounts = listOf(Triple("default", null, "no"), Triple(work, "Work", "no"))))
        assertEquals("Signed out", RunnerPage.engineStatus(agy(workOut), workOut)?.first)
        assertTrue("Work is out, and needs signing in", RunnerPage.needsSignIn(agy(workOut)))
    }

    /** Each Google account is a line of the Accounts section, Default first, and a sign-in on it names it. */
    @Test fun theEnginePageListsEachGoogleAccount() {
        val hpc = runner(engine(accounts = listOf(Triple("default", null, "yes"), Triple(work, "Work", "yes")),
            defaultBuckets = defaultBuckets, others = mapOf(work to workBuckets)))
        val lines = RunnerPage.accountLines(agy(hpc))
        assertEquals(listOf("Default", "Work"), lines.map { it.name })
        assertEquals(listOf("~/.orbit/antigravity/google", "~/.orbit/antigravity-accounts/5c2e91a0"), lines.map { it.subtitle })
        assertEquals(listOf("yes", "yes"), lines.map { it.auth })
        assertEquals(listOf("default", work), lines.map { it.signInAccount })
        assertEquals(listOf(false, false), lines.map { it.envKey })
        assertTrue(RunnerPage.keepsAccounts("antigravity"))
        assertEquals("Account 3", RunnerPage.defaultAccountName(agy(hpc).list("accounts")))
    }

    /** Add Account where the runner relays Google's sign-in and keeps an added account apart; a macOS or old runner says why. */
    @Test fun addAccountNeedsGoogleSignInAndARunnerThatKeepsAccounts() {
        val one = engine(accounts = listOf(Triple("default", null, "yes")), defaultBuckets = defaultBuckets)
        val hpc = runner(one)
        assertTrue(RunnerPage.canAddAccount(hpc, "antigravity"))
        assertTrue(RunnerPage.canSignIn(hpc, "antigravity"))
        val older = runner(one, capabilities = emptyList())
        assertFalse("a runner without antigravity-account-login/v1 would sign Default in again in its place", RunnerPage.canAddAccount(older, "antigravity"))
        assertTrue("Default still signs in again there", RunnerPage.canSignIn(older, "antigravity"))
        val mac = runner(one, googleLogin = "unsupported_platform")
        assertFalse(RunnerPage.canAddAccount(mac, "antigravity"))
        assertFalse(RunnerPage.canSignIn(mac, "antigravity"))
        assertEquals("Google sign-in is not supported on macOS runners yet. Use a Gemini API key.", RunnerPage.signInHint(mac, "antigravity"))
        assertEquals("Update this runner to sign in with Google.", RunnerPage.signInHint(runner(one, googleLogin = "needs_update"), "antigravity"))
        // Every other engine is as it was.
        assertTrue(RunnerPage.canAddAccount(mac, "claude"))
        assertTrue(RunnerPage.canSignIn(mac, "codex"))
        assertNull(RunnerPage.signInHint(mac, "claude"))
        assertFalse(RunnerPage.canAddAccount(hpc, "kimi"))
    }

    /** Weighed against other quota, a bucket is the window it names: the share used, its reset, and its length. */
    @Test fun aBucketIsTheWindowItNames() {
        val window = EngineAccounts.bucketWindow(json("""{"id":"gemini-5h","window":"5h","remainingFraction":0.04,"resetTime":"2026-10-06T11:40:00Z"}"""))
        assertEquals(96.0, window.dbl("utilization")!!, 0.0001)
        assertEquals("2026-10-06T11:40:00Z", window.str("resetsAt"))
        assertEquals(300, window.int("windowDurationMins"))
        assertEquals(10080, EngineAccounts.bucketWindow(json("""{"id":"gemini-weekly","window":"weekly","remainingFraction":1}""")).int("windowDurationMins"))
        assertNull(EngineAccounts.bucketWindow(json("""{"id":"x","window":"daily","remainingFraction":1}""")).int("windowDurationMins"))
        val usage = agy(runner(engine(accounts = listOf(Triple("default", null, "yes"), Triple(work, "Work", "yes")),
            defaultBuckets = defaultBuckets, others = mapOf(work to workBuckets)))).obj("planUsage")
        val own = accountSnapshot(usage, "default")!!
        assertEquals(4, EngineAccounts.windows(own).size)
        assertNull(own["accounts"])
    }

    /** A nearly spent Antigravity quota is weighed by what it has used: raised only when every account that can run is near
     * its limit, and said in the share used of the window agy names. */
    @Test fun needsAttentionWeighsGoogleAccountsByWhatTheyHaveUsed() {
        fun quotaItems(runner: JsonObject) = RunnerPage.attention(runner, listOf(workspace), now, null).filter { it.kind == "quotaNearLimit" }
        val workOnly = runner(engine(auth = "no", accounts = listOf(Triple("default", null, "no"), Triple(work, "Work", "yes")), others = mapOf(work to workBuckets)))
        val item = quotaItems(workOnly).single()
        assertEquals("4% left is 96% used", "Antigravity 5-hour limit at 96%", item.title)
        assertEquals("Antigravity 5-hour limit 96%", item.short)
        assertEquals("2026-10-06T11:40:00Z", item.resetsAt)
        val both = runner(engine(accounts = listOf(Triple("default", null, "yes"), Triple(work, "Work", "yes")), defaultBuckets = defaultBuckets, others = mapOf(work to workBuckets)))
        assertEquals("Default has room, so the machine is not short", emptyList<AttentionItem>(), quotaItems(both))
        val keyed = runner(engine(authSource = "env_key", accounts = listOf(Triple("default", null, "no"), Triple(work, "Work", "yes")), others = mapOf(work to workBuckets)))
        assertEquals("Default runs on the key, which no window holds back", emptyList<AttentionItem>(), quotaItems(keyed))
        // Signed out where a workspace runs on it is the row's first item, as for every engine Orbit signs in.
        val out = RunnerPage.attention(runner(engine(auth = "no", accounts = listOf(Triple("default", null, "no")))), listOf(workspace), now, null)
        assertEquals(listOf("Antigravity is signed out"), out.filter { it.kind == "engineSignedOut" }.map { it.title })
        assertEquals("antigravity", out.first().action?.engine)
    }

    /** The Providers page's "N of M signed in" counts Antigravity only where the runner can sign it in with Google. */
    @Test fun providersCountAntigravityOnlyWhereGoogleSignInIsOffered() {
        val google = fixture("google")
        assertEquals("1 of 4 signed in", ProviderPools.runnerSummary(google))
        assertEquals("0 of 3 signed in", ProviderPools.runnerSummary(fixture("macos")))
        assertEquals("0 of 3 signed in", ProviderPools.runnerSummary(fixture("old")))
    }
}
