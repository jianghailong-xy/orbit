package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * OrbitKit InfrastructureTests (iOS 5e75edbde), case for case: the top of the Infrastructure page — what needs a person — out of the same
 * three machines and pool as the web's own cases; then a key's row, a machine's row in the list, and what an engine's page offers to
 * install.
 */
class InfrastructureTest {
    private val now = Instant.parse("2026-10-07T09:00:00.000Z").toEpochMilli()
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject

    /** Mac Studio: two Claude accounts, Codex signed out, Kimi not installed. */
    private val macStudio = obj("""{"id":"mac","name":"Mac Studio","online":true,"activeSessions":2,"maxConcurrent":4,
        "lastHeartbeatAt":"2026-10-07T08:59:50.000Z","engines":[
         {"engine":"claude","installed":true,"auth":"yes","accounts":[
           {"id":"default","name":"Personal Max","auth":"yes"},{"id":"slot-2","name":"Work","auth":"yes"}]},
         {"engine":"codex","installed":true,"auth":"no"},
         {"engine":"kimi","installed":false,"auth":"unknown"}]}""")

    /** HPC: Claude, two Codex accounts and Kimi, all signed in. */
    private val hpc = obj("""{"id":"hpc","name":"HPC","online":true,"activeSessions":5,"maxConcurrent":8,
        "lastHeartbeatAt":"2026-10-07T08:59:50.000Z","engines":[
         {"engine":"claude","installed":true,"auth":"yes"},
         {"engine":"codex","installed":true,"auth":"yes","accounts":[
           {"id":"default","auth":"yes"},{"id":"slot-2","name":"Team","auth":"yes"}]},
         {"engine":"kimi","installed":true,"auth":"yes"}]}""")

    /** ThinkPad: gone since yesterday, its Codex signed out when it was last seen. */
    private val thinkPad = obj("""{"id":"thinkpad","name":"ThinkPad","online":false,"activeSessions":0,"maxConcurrent":4,
        "lastHeartbeatAt":"2026-10-06T08:00:00.000Z","engines":[
         {"engine":"claude","installed":true,"auth":"yes"},
         {"engine":"codex","installed":true,"auth":"no"}]}""")

    private val fleet get() = listOf(macStudio, hpc, thinkPad)

    /** A key as GET providers/mine lists it, with the engines the server says it runs on, default first. */
    private fun key(label: String, runtime: String = "claude", preset: String? = "anthropic",
                    models: List<Pair<String, String>> = listOf("claude-opus-5" to "Claude Opus 5", "claude-sonnet-5" to "Claude Sonnet 5"),
                    defaultModel: String? = "claude-opus-5", enabled: Boolean = true, engines: List<String> = listOf("claude", "opencode")) =
        buildJsonObject {
            put("slug", label.lowercase()); put("label", label); put("runtime", runtime)
            put("models", JsonArray(models.map { (value, name) -> buildJsonObject { put("value", value); put("label", name) } }))
            defaultModel?.let { put("defaultModel", it) }
            preset?.let { put("presetSlug", it) }
            put("enabled", enabled)
            put("engines", JsonArray(engines.map(::JsonPrimitive)))
        }

    private val anthropicWork = key("Anthropic · Work", defaultModel = "claude-sonnet-5")

    private fun claudePool(unavailable: String? = null) = Pool("pool", "claude-keys", "Claude keys", "claude",
        listOf(PoolMember("m1", "Anthropic (Claude)", "NO_QUOTA", next = true, pausedUntil = null, resetsAt = null, planUsage = null)),
        unavailable, null)
    private fun codexPool(id: String, label: String, unavailable: String? = null) =
        Pool(id, label.lowercase(), label, "codex", emptyList(), unavailable, null)

    private fun attention(runners: List<JsonObject>, own: List<Pool> = emptyList(), member: List<Pool> = emptyList(),
                          workspaces: List<JsonObject> = emptyList()) =
        Infrastructure.attention(runners, workspaces, member, own, now)
    private fun says(line: Infrastructure.Attention) = "${line.line} · ${line.detail}"

    // Needs you

    /** An engine signed out is no line: the web's machine card draws it nothing, and the machine's own page says so and signs it in. Mac
     * Studio's Codex is out, and only ThinkPad, offline, needs a person — no block at all while nothing does. */
    @Test fun anEngineSignedOutIsNoLine() {
        assertEquals(listOf(Infrastructure.Kind.Offline("thinkpad")), attention(fleet, own = listOf(claudePool())).map { it.kind })
        assertEquals("nothing needs a person", emptyList<Infrastructure.Attention>(), attention(listOf(hpc), own = listOf(claudePool())))
    }

    /** A machine that is offline: when it was last seen, and that its subscriptions are gone with it. */
    @Test fun aMachineOfflineIsALine() {
        val lines = attention(fleet, own = listOf(claudePool()))
        assertEquals("ThinkPad is offline · Last seen 1d ago · its subscriptions are unavailable until it’s back", says(lines[0]))
        assertEquals(Infrastructure.Kind.Offline("thinkpad"), lines[0].kind)
        val never = obj("""{"id":"new","name":"New box","online":false}""")
        assertEquals("New box is offline · Never checked in · its subscriptions are unavailable until it’s back", says(attention(listOf(never))[0]))
    }

    /** A pool no session can start on: its own reason, and its page — the account's own, or one it is in, which come first. */
    @Test fun aPoolNoSessionCanStartOnIsALine() {
        val lines = attention(fleet, own = listOf(claudePool(unavailable = "No account can run")))
        assertEquals("Claude keys is unavailable · No account can run · no session can start on it", says(lines[1]))
        assertEquals(Infrastructure.Kind.PoolUnavailable("pool", own = true), lines[1].kind)
        val both = attention(emptyList(), own = listOf(claudePool(unavailable = "No account can run")),
            member = listOf(codexPool("shared", "Team Codex", unavailable = "No keys")))
        assertEquals(listOf(Infrastructure.Kind.PoolUnavailable("shared", own = false), Infrastructure.Kind.PoolUnavailable("pool", own = true)),
            both.map { it.kind })
    }

    // A key's row

    /** The model a key starts on, by the name its own list gives it; its first model without a default; the id itself when the list
     * doesn't name it. A Claude subscription token's line says what it is. */
    @Test fun aKeysModelIsNamedAsItsListNamesIt() {
        assertEquals("Claude Sonnet 5", Infrastructure.defaultModel(anthropicWork))
        assertEquals("Claude Opus 5", Infrastructure.defaultModel(key("A", defaultModel = null)))
        assertEquals("Claude Opus 5", Infrastructure.defaultModel(key("A", defaultModel = "")))
        assertEquals("claude-haiku-5", Infrastructure.defaultModel(key("A", defaultModel = "claude-haiku-5")))
        assertNull(Infrastructure.defaultModel(key("A", models = emptyList(), defaultModel = null)))
        assertEquals("Claude Code · subscription token", KeyEngines.line(key("Claude Max", engines = listOf("claude"))))
        assertEquals("Claude Code · OpenCode", KeyEngines.line(anthropicWork))
    }

    // A machine's row (03-ios.png)

    /** "2 / 4 running · 1 of 3 signed in" — Mac Studio's Codex is signed out, and the line says where its engines stand rather than counting
     * that, as the web's card does; "5 / 8 running · All signed in"; offline, where its engines stood: "1 of 3 signed in". */
    @Test fun aMachinesLineSaysItsSlotsAndWhereItsEnginesStand() {
        assertEquals("2 / 4 running · 1 of 3 signed in", Infrastructure.machineLine(macStudio, now))
        assertEquals("5 / 8 running · All signed in", Infrastructure.machineLine(hpc, now))
        assertEquals("1 of 3 signed in", Infrastructure.machineLine(thinkPad, now))
        assertEquals("3 machines · 7 / 12 slots busy", Infrastructure.machinesCount(fleet))
        assertEquals("1 machine · 5 / 8 slots busy", Infrastructure.machinesCount(listOf(hpc)))
        assertNull(Infrastructure.machinesCount(emptyList()))
    }

    /** The web card's folded summary: an install or update under way or failed first, then engines not keeping current on a machine
     * online, then how many of the listed engines are signed in. */
    @Test fun aMachinesSummaryIsTheWebCards() {
        fun relay(status: String, mode: String) =
            obj("""{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"$status","engine":"claude","mode":"$mode"}}""")
        assertEquals("Install failed", Infrastructure.summary(relay("failed", "install"), now))
        assertEquals("Update failed", Infrastructure.summary(relay("failed", "update"), now))
        assertEquals("Installing…", Infrastructure.summary(relay("installing", "install"), now))
        assertEquals("Updating…", Infrastructure.summary(relay("pending", "update"), now))
        assertEquals("Engines not reported", Infrastructure.summary(obj("""{"id":"r","name":"r","online":true}"""), now))
        val behind = obj("""{"id":"r","name":"r","online":true,"engines":[
          {"engine":"claude","installed":true,"auth":"yes","update":{"status":"ok","behindSince":"2026-09-01T00:00:00.000Z","latest":"2.1.300"}}]}""")
        assertEquals("1 engine not updating", Infrastructure.summary(behind, now))
        // An account signed out leaves its engine short of all signed in.
        val half = obj("""{"id":"r","name":"r","online":true,"engines":[
          {"engine":"claude","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"slot-2","auth":"no"}]},
          {"engine":"codex","installed":true,"auth":"yes"},{"engine":"kimi","installed":true,"auth":"yes"}]}""")
        assertEquals("2 of 3 signed in", Infrastructure.summary(half, now))
    }

    // What an engine's page installs

    /** Install for an engine the machine doesn't have, Retry after a failed install; nothing while one is under way, for one installed,
     * or for an Antigravity the runner can't run. */
    @Test fun anEnginesPageInstallsWhatTheMachineLacks() {
        assertTrue(Infrastructure.installable(macStudio, "kimi"))
        assertFalse(Infrastructure.installable(macStudio, "claude"))
        assertTrue("not reported, and the runner says nothing against it", Infrastructure.installable(macStudio, "antigravity"))
        val installing = obj("""{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"installing","engine":"kimi"}}""")
        assertEquals(Infrastructure.RowKind.INSTALLING,
            Infrastructure.rowKind(Infrastructure.engineHealth(installing, "kimi"), installing.obj("install"), "kimi"))
        assertFalse(Infrastructure.installable(installing, "kimi"))
        val failed = obj("""{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"failed","engine":"kimi"}}""")
        assertEquals(Infrastructure.RowKind.INSTALL_FAILED, Infrastructure.rowKind(Infrastructure.engineHealth(failed, "kimi"), failed.obj("install"), "kimi"))
        assertTrue(Infrastructure.installable(failed, "kimi"))
        val unsupported = obj("""{"id":"r","name":"r","online":true,"antigravity":{"supported":false,"envKeyAvailable":false}}""")
        assertFalse(Infrastructure.installable(unsupported, "antigravity"))
    }

    /** OpenCode signs in nowhere here, so its page's one press is its install (web's OpenCode row): on a machine that reports it missing,
     * and Retry after a failed install — none while one is under way, for one installed, or on a runner that never mentions OpenCode. */
    @Test fun openCodesPageInstallsItWhereTheMachineReportsItMissing() {
        val missing = obj("""{"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}]}""")
        assertTrue(Infrastructure.installsOpenCode(missing))
        val installed = obj("""{"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":true,"auth":"unknown"}]}""")
        assertFalse(Infrastructure.installsOpenCode(installed))
        val silent = obj("""{"id":"r","name":"r","online":true,"engines":[{"engine":"claude","installed":true,"auth":"yes"}]}""")
        assertFalse(Infrastructure.installsOpenCode(silent))
        val installing = obj("""{"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}],
         "install":{"status":"installing","engine":"opencode"}}""")
        assertEquals(Infrastructure.RowKind.INSTALLING, Infrastructure.rowKind(installing.list("engines").first(), installing.obj("install"), "opencode"))
        assertFalse(Infrastructure.installsOpenCode(installing))
        val failed = obj("""{"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}],
         "install":{"status":"failed","engine":"opencode"}}""")
        assertEquals(Infrastructure.RowKind.INSTALL_FAILED, Infrastructure.rowKind(failed.list("engines").first(), failed.obj("install"), "opencode"))
        assertTrue(Infrastructure.installsOpenCode(failed))
    }

    /** A machine's row for an engine it lacks opens that engine's page where the page installs it — Install, Retry, or the install
     * running — as the web's row offers Install itself: never for an Antigravity the runner can't run, OpenCode on a runner that never
     * mentions it, or a DeepSeek Harness that is there. */
    @Test fun aMissingEnginesRowOpensThePageThatInstallsIt() {
        assertTrue(Infrastructure.installsFromPage(macStudio, "kimi"))
        assertFalse(Infrastructure.installsFromPage(macStudio, "claude"))
        assertFalse("a runner that never mentions it", Infrastructure.installsFromPage(macStudio, "opencode"))
        val installing = obj("""{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"installing","engine":"kimi"}}""")
        assertTrue("its page says how the install is going", Infrastructure.installsFromPage(installing, "kimi"))
        val unsupported = obj("""{"id":"r","name":"r","online":true,"antigravity":{"supported":false,"envKeyAvailable":false}}""")
        assertFalse(Infrastructure.installsFromPage(unsupported, "antigravity"))
        val openCode = obj("""{"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}]}""")
        assertTrue(Infrastructure.installsFromPage(openCode, "opencode"))
        fun harness(installed: Boolean) = obj("""{"id":"r","name":"r","online":true,"capabilities":["provider:dsh"],
         "engines":[{"engine":"dsh","installed":$installed,"auth":"unknown"}]}""")
        assertTrue(Infrastructure.installsFromPage(harness(false), "dsh"))
        assertFalse(Infrastructure.installsFromPage(harness(true), "dsh"))
    }

    // Settings' row

    /** orbit@austin on 2026-10-31: online, Claude Code and Codex installed, neither signed in. */
    private fun austin(online: Boolean = true) = obj("""{"id":"austin","name":"orbit@austin","online":$online,"activeSessions":0,
        "maxConcurrent":16,"lastHeartbeatAt":"2026-10-07T08:59:50.000Z","engines":[
         {"engine":"claude","installed":true,"auth":"no"},{"engine":"codex","installed":true,"auth":"no"}]}""")
    private fun workspace(provider: String?, on: String = "austin") = buildJsonObject {
        put("id", "w-$on"); put("name", "app"); put("runnerId", on); provider?.let { put("lastProvider", it) }
    }

    /** OrbitKit testAMachineWithNoCodingCLISignedInIsALine: a machine online where no coding CLI is signed in and no workspace runs on a
     * key — nothing can run there, which its page says (RunnerPage.noCliSignedIn) — is a line after the machines offline, before the pools,
     * that opens its record (docs/mocks/first-workspace-in-conversation, rule 10 of 04). */
    @Test fun aMachineWithNoCodingCliSignedInIsALine() {
        val lines = attention(listOf(thinkPad, austin()), own = listOf(claudePool(unavailable = "No account can run")))
        assertEquals(listOf(Infrastructure.Kind.Offline("thinkpad"), Infrastructure.Kind.NoCliSignedIn("austin"),
            Infrastructure.Kind.PoolUnavailable("pool", true)), lines.map { it.kind })
        assertEquals("orbit@austin has no coding CLI signed in · Nothing can run on this machine until one is. Claude Code and Codex are " +
            "installed here.", says(lines[1]))
        assertEquals(listOf("orbit@austin"), lines[1].names)
        assertEquals("nocli:austin", lines[1].id)
        // With workspaces on those logins, or one that has not run yet, it is the same line.
        assertEquals(listOf(Infrastructure.Kind.NoCliSignedIn("austin")), attention(listOf(austin()), workspaces = listOf(workspace("codex"))).map { it.kind })
        assertEquals(1, attention(listOf(austin()), workspaces = listOf(workspace(null))).size)
    }

    /** OrbitKit testAMachineThatCanRunSomethingIsNoLine: a workspace there on a key or a pool runs without any sign-in, so no line; nor once
     * one CLI is signed in; and an offline machine is the one line it is offline. */
    @Test fun aMachineThatCanRunSomethingIsNoLine() {
        assertEquals(emptyList<Infrastructure.Attention>(), attention(listOf(austin()), workspaces = listOf(workspace("deepseek"))))
        assertEquals(emptyList<Infrastructure.Attention>(), attention(listOf(austin()), workspaces = listOf(workspace("anthropic-2"))))
        assertEquals("another machine's key does nothing for this one", 1,
            attention(listOf(austin()), workspaces = listOf(workspace("deepseek", on = "hpc"))).size)
        assertEquals(listOf(Infrastructure.Kind.Offline("austin")), attention(listOf(austin(online = false))).map { it.kind })
        assertEquals("Claude signed in, Codex out", emptyList<Infrastructure.Attention>(), attention(listOf(macStudio)))
    }

    /** OrbitKit testAMachineWithNoCodingCLISignedInNeedsYou: Settings' row counts that line, as the web's Settings row counts the machine. */
    @Test fun settingsCountsAMachineWithNoCodingCliSignedIn() {
        fun value(runners: List<JsonObject>, workspaces: List<JsonObject>) =
            Infrastructure.settingsValue(attention(runners, workspaces = workspaces).size, runners)
        assertEquals("1 needs you", value(listOf(austin()), emptyList()))
        assertEquals("1 needs you", value(listOf(austin()), listOf(workspace("claude"))))
        assertEquals("1 of 1 online", value(listOf(austin()), listOf(workspace("deepseek"))))
        assertEquals("2 need you", value(listOf(austin(), thinkPad), emptyList()))
    }

    /** SettingsHome.infrastructureValue: "1 needs you", "2 need you"; with none, how many of the machines are online. */
    @Test fun settingsRowSaysWhatNeedsYouElseTheMachinesOnline() {
        assertEquals("1 needs you", Infrastructure.settingsValue(1, fleet))
        assertEquals("2 need you", Infrastructure.settingsValue(2, fleet))
        assertEquals("2 of 3 online", Infrastructure.settingsValue(0, fleet))
        assertEquals("None", Infrastructure.settingsValue(0, emptyList()))
    }
}
