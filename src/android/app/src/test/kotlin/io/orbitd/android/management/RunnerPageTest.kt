package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.ZoneId

/**
 * The web's runner-attention rule (src/web/src/lib/runnerAttention.cases.json), run case by case on the
 * Android port, as OrbitKit's RunnerAttentionCasesTests runs it on iOS's. Missing file is a failure.
 */
class RunnerPageTest {
    private val cases: List<JsonObject> by lazy {
        var dir: File? = File("").absoluteFile
        repeat(8) {
            val candidate = File(dir, "src/web/src/lib/runnerAttention.cases.json")
            if (candidate.isFile) return@lazy Json.parseToJsonElement(candidate.readText()).jsonArray.map { it.jsonObject }
            dir = dir?.parentFile
        }
        fail("runnerAttention.cases.json not found above ${File("").absolutePath}"); emptyList()
    }

    private fun input(name: String) = cases.first { it.text("name") == name }["input"]!!.jsonObject
    private fun items(input: JsonObject) = RunnerPage.attention(input["runner"]!!.jsonObject, input.list("workspaces"),
        input["nowMs"]!!.jsonPrimitive.long, input.str("latestVersion"))

    @Test fun everyCaseSaysWhatTheWebRuleSays() {
        assertTrue("the case file holds no cases", cases.size >= 60)
        assertEquals(cases.size, cases.map { it.text("name") }.toSet().size)
        for (case in cases) {
            val name = case.text("name")
            val input = case["input"]!!.jsonObject
            val expected = case["expected"]!!.jsonObject
            val found = items(input)
            assertEquals(name, expected.list("items").map {
                listOf(it.str("kind"), it.str("tone"), it.str("short"), it.str("title"), it.str("actionKind"))
            }, found.map { listOf(it.kind, it.tone, it.short, it.title, it.action?.kind) })
            assertEquals(name, expected.str("listLine"), RunnerPage.listAttentionLine(found))
            assertEquals(name, expected.str("subtitle"), RunnerPage.listSubtitle(input["runner"]!!.jsonObject, input["nowMs"]!!.jsonPrimitive.long))
            val disk = expected.obj("disk")
            assertEquals(name, disk?.let { RunnerDisk(it.long("freeBytes")!!, it.long("totalBytes")!!, it.int("usedPercent")!!) },
                RunnerPage.runnerDisk(input.list("workspaces")))
        }
    }

    // OrbitKit RunnerSelfUpdateTests: what the case file can't carry about the selfUpdate machines.
    private fun case(prefix: String) = cases.single { it.text("name").startsWith(prefix) }["input"]!!.jsonObject
    /** That case with its runner's report replaced; null takes it out, as an older runner sends it. */
    private fun reporting(prefix: String, report: JsonObject?): JsonObject {
        val input = case(prefix)
        val runner = input["runner"]!!.jsonObject
        return JsonObject(input + ("runner" to JsonObject(if (report == null) runner - "selfUpdate" else runner + ("selfUpdate" to report))))
    }
    private fun report(state: String, reason: String? = null) = buildJsonObject { put("state", state); reason?.let { put("reason", it) } }
    private fun card(input: JsonObject) = items(input).single { it.kind != "offline" }
    private fun runnerOf(input: JsonObject) = input["runner"]!!.jsonObject

    @Test fun eachSelfUpdateStateSaysWhatOrbitKitSays() {
        val behind = "still on 0.1.190, latest is 0.1.197"
        val folder = card(case("selfUpdate dirNotWritable and behind"))
        assertEquals("It can’t write to /usr/local/bin, so it can’t replace its own binary — $behind. On that machine, run sudo orbit upgrade once; " +
            "after that it updates itself.", folder.detail)
        assertEquals(AttentionAction("copyCommand", command = "sudo orbit upgrade"), folder.action)
        assertEquals("It can’t write to its install folder, so it can’t replace its own binary — $behind. On that machine, run sudo orbit upgrade " +
            "once; after that it updates itself.", card(reporting("selfUpdate dirNotWritable and behind", report("dirNotWritable"))).detail)

        val off = card(case("selfUpdate disabledByEnv and behind"))
        assertEquals("ORBIT_NO_SELFUPDATE is set, so it doesn’t update itself — $behind. To turn them back on, remove ORBIT_NO_SELFUPDATE from the " +
            "runner’s environment and restart it — on a Mac, opening the latest Orbit app does this.", off.detail)
        assertNull(off.action)
        fun offBecause(reason: String?) = card(reporting("selfUpdate disabledByEnv and behind", report("disabledByEnv", reason))).detail
        assertEquals("Development build, so it doesn’t update itself — $behind.", offBecause("development build"))
        assertEquals("Its updater is switched off, so it doesn’t update itself — $behind.", offBecause(null))

        val failed = card(case("selfUpdate failed and behind"))
        assertEquals("Installing 0.1.197: sha256 mismatch for orbit-linux-amd64.gz. Still on 0.1.190, latest is 0.1.197. It retries every 10 min — " +
            "Update Runner Now tries again right away.", failed.detail)
        assertEquals(AttentionAction("updateRunner"), failed.action)
        fun failedBecause(reason: String?) = card(reporting("selfUpdate failed and behind", report("failed", reason))).detail
        assertEquals("Cannot read the release to install: 502 Bad Gateway. Still on 0.1.190, latest is 0.1.197. It retries every 10 min — " +
            "Update Runner Now tries again right away.", failedBecause("cannot read the release to install: 502 Bad Gateway."))
        assertEquals("Its last update didn’t go through. Still on 0.1.190, latest is 0.1.197. It retries every 10 min — " +
            "Update Runner Now tries again right away.", failedBecause(null))

        // A runner that reports nothing keeps the card it always had; a root one still gets none.
        for (old in listOf(card(reporting("selfUpdate dirNotWritable and behind", null)), card(case("selfUpdate null")))) {
            assertEquals("Can’t update itself", old.title)
            assertEquals(AttentionAction("copyCommand", command = "sudo orbit upgrade"), old.action)
        }
        assertEquals(emptyList<AttentionItem>(), items(reporting("selfUpdate failed and behind", null)))
    }

    @Test fun updateRunnerNowAndAboutFollowTheReport() {
        fun can(prefix: String) = case(prefix).let { RunnerPage.canUpdateNow(runnerOf(it), it["nowMs"]!!.jsonPrimitive.long) }
        assertEquals(listOf(true, true, true, true, false, false, false, false),
            listOf("selfUpdate failed and behind", "selfUpdate enabled and behind", "selfUpdate waitingForIdle and behind", "selfUpdate heldByRollout and behind",
                "selfUpdate dirNotWritable and behind", "selfUpdate disabledByEnv and behind", "selfUpdate failed while offline", "selfUpdate null").map(::can))
        val failed = reporting("selfUpdate failed and behind", null)
        assertFalse("a runner too old to report it", RunnerPage.canUpdateNow(runnerOf(failed), failed["nowMs"]!!.jsonPrimitive.long))

        fun version(prefix: String) = RunnerPage.versionValue(runnerOf(case(prefix)), "0.1.197")
        assertEquals("0.1.190 · 0.1.197 installs when no turn is running", version("selfUpdate waitingForIdle and behind"))
        assertEquals("0.1.190 · 0.1.197 installs when no turn is running", version("selfUpdate enabled and behind"))
        assertEquals("0.1.190 · 0.1.197 not rolled out to it yet", version("selfUpdate heldByRollout and behind"))
        assertEquals("0.1.190", version("selfUpdate failed and behind"))
        assertEquals("0.1.197 · Latest", version("selfUpdate dirNotWritable on the latest release"))
        assertEquals("0.1.190", version("selfUpdate null"))
        assertEquals("0.1.190 · 0.1.197 installs when no turn is running", RunnerPage.versionValue(runnerOf(failed), "0.1.197"))

        val shanghai = ZoneId.of("Asia/Shanghai")
        assertEquals("Sep 20, 4:00 PM · 0.1.189 → 0.1.190", RunnerPage.lastUpdate(runnerOf(case("selfUpdate enabled and behind")), shanghai))
        assertNull(RunnerPage.lastUpdate(runnerOf(case("selfUpdate heldByRollout and behind")), shanghai))
        assertNull(RunnerPage.lastUpdate(runnerOf(case("selfUpdate null")), shanghai))
    }

    @Test fun detailsActionsAndOfflineWaitMatchOrbitKit() {
        val wikova = items(input("real wikova: Claude weekly 98% and a 95% full disk"))
        assertEquals("wikova-develop runs on this machine’s Claude login — its sessions pause if the limit runs out.", wikova[0].detail)
        assertEquals("2026-10-02T03:59:59Z", wikova[0].resetsAt)
        assertEquals("9.4 GB free of 197 GB. No reserve is set, so task runs keep landing here until the disk fills.", wikova[1].detail)
        val mac = items(input("real longdeMac-mini.local: offline 14 days and can’t update itself; its failing Claude update is not raised while offline"))
        assertEquals("Start the runner on that machine — it reconnects within 30 seconds.", mac[0].detail)
        assertEquals("It runs as a regular user, so it can’t replace its own binary — still on 0.1.155, latest is 0.1.197. On that machine, run sudo orbit upgrade.", mac[1].detail)
        assertEquals(AttentionAction("copyCommand", command = "sudo orbit upgrade"), mac[1].action)
        val offline = input("offline for 5 hours")
        fun waiting(sessions: Int) = items(JsonObject(offline + ("runner" to JsonObject(offline["runner"]!!.jsonObject + ("activeSessions" to JsonPrimitive(sessions)))))).first().detail
        assertEquals("Its 1 session waits until it checks in again. Start the runner on that machine — it reconnects within 30 seconds.", waiting(1))
        assertEquals("Its 3 sessions wait until it checks in again. Start the runner on that machine — it reconnects within 30 seconds.", waiting(3))
        val quota = items(input("all Claude accounts near their limits: the account with most room supplies its own fullest window")).first()
        assertEquals("2026-09-29T03:00:00Z", quota.resetsAt)
        assertEquals("Resets Tue, Sep 29 at 3:00 AM. ${quota.detail}", RunnerPage.attentionDetail(quota, 0L, ZoneId.of("UTC")))
    }

    @Test fun pageFormatsVersionsCapacityAccountsAndCodes() {
        assertTrue(RunnerPage.compareRunnerVersions("0.1.99", "0.1.100") < 0)
        assertEquals("0.1.197", RunnerPage.latestRunnerVersion("0.1.155", listOf("0.1.197", null, "0.1.9")))
        assertEquals("2.1.284", RunnerPage.engineVersion("2.1.284 (Claude Code)"))
        assertEquals("0.158.0", RunnerPage.engineVersion("codex-cli 0.158.0"))
        assertEquals("Off", RunnerPage.keepFreeLabel(0))
        assertEquals(listOf("Off", "10 GB", "20 GB", "50 GB", "15 GB"), RunnerPage.keepFreeChoices(15_360).map { it.second })
        assertEquals("ABCDE-FGH23", RunnerPage.deviceCode("abcde fgh23"))
        assertNull(RunnerPage.deviceCode("abcde-fgh2"))
        assertEquals("~/orbit", RunnerPage.tildePath("/root/orbit"))
        assertEquals("~/src/app", RunnerPage.tildePath("/home/dev/src/app"))
        assertEquals("/srv/app", RunnerPage.tildePath("/srv/app"))
        assertEquals("https://one.example:8443", RunnerPage.origin("https://one.example:8443/orbit/"))
        assertEquals(120, RunnerPage.pauseMinutes("2"))
        assertEquals(90, RunnerPage.pauseMinutes("1.5"))
        assertNull(RunnerPage.pauseMinutes("0.001"))
        assertNull(RunnerPage.pauseMinutes("169"))
        assertNull(RunnerPage.pauseMinutes("0"))
        val accounts = listOf(buildJsonObject { put("id", "default"); put("auth", "yes") },
            buildJsonObject { put("id", "1fda3f43"); put("auth", "no"); put("name", "Work") })
        assertEquals("Account 3", RunnerPage.defaultAccountName(accounts))
        val health = buildJsonObject { put("engine", "claude"); put("installed", true); put("auth", "yes"); put("accounts", JsonArray(accounts)) }
        assertEquals(RunnerCopy.SIGNED_OUT to "warn", RunnerPage.engineStatus(health))
        assertTrue(RunnerPage.needsSignIn(health))
        assertEquals(listOf("Default", "Work"), RunnerPage.accountLines(health).map { it.name })
        assertEquals("1fda3f43", RunnerPage.accountLines(health)[1].signInAccount)
        val single = buildJsonObject { put("engine", "kimi"); put("installed", true); put("auth", "yes") }
        assertNull(RunnerPage.accountLines(single).single().signInAccount)
        assertTrue(RunnerPage.engineUpdateInFlight(buildJsonObject { put("mode", "update"); put("status", "installing") }))
        assertEquals("Nothing to update.", RunnerPage.updateRelayLine(buildJsonObject { put("mode", "update"); put("status", "done") }))
    }

    @Test fun usageRowsLabelWindowsAsIosDoes() {
        val claude = buildJsonObject {
            put("fiveHour", buildJsonObject { put("utilization", 89.6) })
            put("sevenDay", buildJsonObject { put("utilization", 98) })
        }
        assertEquals(listOf("5-hour limit" to 90, "Weekly · all models" to 98), usageRows(claude).map { it.label to it.percent })
        assertFalse(usageRows(claude).first().nearLimit)
        val codex = buildJsonObject {
            put("provider", "codex")
            put("primary", buildJsonObject { put("utilization", 93); put("windowDurationMins", 300) })
            put("secondary", buildJsonObject { put("utilization", 12); put("windowDurationMins", 10080) })
            put("rateLimits", buildJsonArray {
                add(buildJsonObject { put("limitId", "codex"); put("primary", buildJsonObject { put("utilization", 93); put("windowDurationMins", 300) }) })
                add(buildJsonObject { put("limitId", "gpt-5"); put("limitName", "GPT-5"); put("primary", buildJsonObject { put("utilization", 5); put("windowDurationMins", 1440) }) })
            })
        }
        assertEquals(listOf("5h limit", "GPT-5 Daily limit"), usageRows(codex).map { it.label })
        val nested = buildJsonObject {
            put("claude", buildJsonObject { put("fiveHour", buildJsonObject { put("utilization", 1) })
                put("accounts", buildJsonObject { put("1fda3f43", buildJsonObject { put("sevenDay", buildJsonObject { put("utilization", 40) }) }) }) })
        }
        assertEquals(listOf("5-hour limit"), accountSnapshot(planUsageSnapshot(nested, "claude"), "default")!!.let(::usageRows).map { it.label })
        assertEquals(40, accountSnapshot(planUsageSnapshot(nested, "claude"), "1fda3f43")!!.let(::usageRows).single().percent)
        assertNull(planUsageSnapshot(nested, "kimi"))
        assertNull(planUsageSnapshot(nested, "opencode"))
    }

    @Test fun aDraggedRowTakesTheNextPlaceOncePastHalfOfIt() {
        val heights = mapOf("a" to 100, "b" to 100, "c" to 100)
        val start = RunnerDrag("a", listOf("a", "b", "c"), 0f)
        assertEquals(listOf("a", "b", "c"), start.moved(40f, heights).order)
        start.moved(60f, heights).let { assertEquals(listOf("b", "a", "c"), it.order); assertEquals(-40f, it.offset) }
        start.moved(160f, heights).let { assertEquals(listOf("b", "c", "a"), it.order); assertEquals(-40f, it.offset) }
        RunnerDrag("c", listOf("a", "b", "c"), 0f).moved(-260f, heights).let { assertEquals(listOf("c", "a", "b"), it.order); assertEquals(-60f, it.offset) }
    }

    /** A drag on a row no longer in the order (removed meanwhile) moves nothing: it ran removeAt(-1) once past half a row. */
    @Test fun aDragOnARowNotInTheOrderMovesNothing() {
        val heights = mapOf("gone" to 100, "b" to 100, "c" to 100)
        assertEquals(listOf("b", "c"), RunnerDrag("gone", listOf("b", "c"), 0f).moved(160f, heights).order)
        assertEquals(listOf("b", "c"), RunnerDrag("gone", listOf("b", "c"), 0f).moved(-160f, heights).order)
    }
}
