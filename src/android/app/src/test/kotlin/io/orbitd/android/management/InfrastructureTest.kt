package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * OrbitKit InfrastructureTests (iOS 5e75edbde), case for case: the top of the Infrastructure page — what needs a person, and what each
 * engine can run on — out of the same three machines, keys and pool as the web's own cases; then a machine's row in the list, and what an
 * engine's page offers to install.
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

    private val anthropic = key("Anthropic (Claude)")
    private val anthropicWork = key("Anthropic · Work", defaultModel = "claude-sonnet-5")
    private fun deepseek(label: String = "DeepSeek") = key(label, preset = "deepseek",
        models = listOf("deepseek-v4-pro" to "DeepSeek V4 Pro", "deepseek-v4-flash" to "DeepSeek V4 Flash"), defaultModel = "deepseek-v4-pro",
        engines = listOf("claude", "opencode", "dsh"))
    private val moonshot = key("Kimi (Moonshot)", runtime = "kimi", preset = "moonshot", models = listOf("kimi-k2.7-code" to "Kimi K2.7 Code"),
        defaultModel = "kimi-k2.7-code", engines = listOf("kimi", "opencode"))
    private val openAIOff = key("OpenAI", runtime = "codex", preset = "openai", models = listOf("gpt-5.6-sol" to "GPT-5.6 Sol"),
        defaultModel = "gpt-5.6-sol", enabled = false, engines = listOf("codex", "opencode"))

    private fun claudePool(unavailable: String? = null) = Pool("pool", "claude-keys", "Claude keys", "claude",
        listOf(PoolMember("m1", "Anthropic (Claude)", "NO_QUOTA", next = true, pausedUntil = null, resetsAt = null, planUsage = null)),
        unavailable, null)
    private fun codexPool(id: String, label: String, unavailable: String? = null) =
        Pool(id, label.lowercase(), label, "codex", emptyList(), unavailable, null)

    private fun attention(runners: List<JsonObject>, own: List<Pool> = emptyList(), member: List<Pool> = emptyList()) =
        Infrastructure.attention(runners, member, own, now)
    private fun says(line: Infrastructure.Attention) = "${line.line} · ${line.detail}"
    private fun card(label: String, model: String?) = Infrastructure.EngineCard.Key(label, model)

    // Needs you

    /** An engine signed out on a machine that is online gets a line, signed in again on its page; the same engine signed out on a machine
     * that is offline doesn't — the machine's line is its line. */
    @Test fun anEngineSignedOutOnAMachineOnlineIsALine() {
        val lines = attention(fleet, own = listOf(claudePool()))
        assertEquals("Codex is signed out on Mac Studio · Sessions there can’t use it", says(lines[0]))
        assertEquals(Infrastructure.Kind.SignedOut("mac", "codex"), lines[0].kind)
        assertEquals("the names the line sets in bold", listOf("Codex", "Mac Studio"), lines[0].names)
        assertEquals(1, lines.count { it.line.contains("signed out") })
        assertEquals("offline: its line says so instead", emptyList<String>(), Infrastructure.signedOutEngines(thinkPad))
    }

    /** Nothing for an engine still signed in on another account, one whose CLI would not say, or one not installed — and no block at all
     * while nothing needs a person. */
    @Test fun nothingForAnEngineStillInOnAnotherAccountOrOneThatWouldNotSay() {
        val box = obj("""{"id":"hpc","name":"HPC","online":true,"engines":[
          {"engine":"claude","installed":true,"auth":"no","accounts":[{"id":"default","auth":"no"},{"id":"slot-2","name":"Work","auth":"yes"}]},
          {"engine":"codex","installed":true,"auth":"unknown"},
          {"engine":"kimi","installed":false,"auth":"no"}]}""")
        assertEquals(emptyList<Infrastructure.Attention>(), attention(listOf(box)))
        assertEquals("nothing needs a person", emptyList<Infrastructure.Attention>(), attention(listOf(hpc), own = listOf(claudePool())))
    }

    /** A machine that is offline: when it was last seen, and that its subscriptions are gone with it. */
    @Test fun aMachineOfflineIsALine() {
        val lines = attention(fleet, own = listOf(claudePool()))
        assertEquals("ThinkPad is offline · Last seen 1d ago · its subscriptions are unavailable until it’s back", says(lines[1]))
        assertEquals(Infrastructure.Kind.Offline("thinkpad"), lines[1].kind)
        val never = obj("""{"id":"new","name":"New box","online":false}""")
        assertEquals("New box is offline · Never checked in · its subscriptions are unavailable until it’s back", says(attention(listOf(never))[0]))
    }

    /** A pool no session can start on: its own reason, and its page — the account's own, or one it is in, which come first. */
    @Test fun aPoolNoSessionCanStartOnIsALine() {
        val lines = attention(fleet, own = listOf(claudePool(unavailable = "No account can run")))
        assertEquals("Claude keys is unavailable · No account can run · no session can start on it", says(lines[2]))
        assertEquals(Infrastructure.Kind.PoolUnavailable("pool", own = true), lines[2].kind)
        val both = attention(emptyList(), own = listOf(claudePool(unavailable = "No account can run")),
            member = listOf(codexPool("shared", "Team Codex", unavailable = "No keys")))
        assertEquals(listOf(Infrastructure.Kind.PoolUnavailable("shared", own = false), Infrastructure.Kind.PoolUnavailable("pool", own = true)),
            both.map { it.kind })
    }

    /** Antigravity is only a line where its Google sign-in can be started — the one way back in. */
    @Test fun antigravitySignedOutIsALineOnlyWhereGoogleSignInCanStart() {
        fun box(login: String) = obj("""{"id":"r","name":"Box","online":true,
            "antigravity":{"supported":true,"installed":true,"envKeyAvailable":false,"googleLogin":"$login"},
            "engines":[{"engine":"antigravity","installed":true,"auth":"no"}]}""")
        assertEquals(listOf("antigravity"), Infrastructure.signedOutEngines(box("available")))
        val line = attention(listOf(box("available")))[0]
        assertEquals("Antigravity CLI is signed out on Box · Sessions there can’t use it", says(line))
        assertEquals("the engine by its CLI's name, as every list names it", listOf("Antigravity CLI", "Box"), line.names)
        assertEquals(emptyList<String>(), Infrastructure.signedOutEngines(box("needs_update")))
        assertEquals(emptyList<String>(), Infrastructure.signedOutEngines(box("unsupported_platform")))
    }

    // What your agents can run on

    /** An engine to a card, each Ready with what can pay for it now — online machines by how many of their accounts, keys beside their
     * models, pools — and Antigravity, with none, Not set up. */
    @Test fun eachEngineIsReadyWithWhatCanPayForItNow() {
        val engines = Infrastructure.engineCards(fleet, listOf(anthropic, anthropicWork, deepseek()), listOf(claudePool()))
        assertEquals(listOf("claude", "codex", "kimi", "antigravity", "opencode", "dsh"), engines.map { it.engine })
        assertEquals(listOf(true, true, true, false, true, true), engines.map { it.ready })
        assertEquals(listOf("Mac Studio ×2", "HPC"), engines[0].machines)
        assertEquals(listOf(card("Anthropic (Claude)", "Claude Opus 5"), card("Anthropic · Work", "Claude Sonnet 5"), card("DeepSeek", "DeepSeek V4 Pro")),
            engines[0].keys)
        assertEquals(listOf("Claude keys"), engines[0].pools)
        // Mac Studio's Codex is signed out, and ThinkPad's is on a machine that is offline.
        assertEquals(listOf("HPC ×2"), engines[1].machines)
        assertEquals(emptyList<Infrastructure.EngineCard.Key>(), engines[1].keys)
        assertEquals(listOf("HPC"), engines[2].machines)
        assertEquals(Infrastructure.EngineCard("antigravity", emptyList(), emptyList(), emptyList()), engines[3])
    }

    /** Every engine a session can run on is a card, by its CLI's name in the pickers' order — the same keys again under each engine they
     * run on: OpenCode runs every one of them, DeepSeek Harness the DeepSeek key. */
    @Test fun everyEngineIsACardWithEveryKeyThatRunsOnIt() {
        val cards = Infrastructure.engineCards(fleet, listOf(anthropic, anthropicWork, deepseek()), listOf(claudePool()))
        assertEquals(listOf("Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"), cards.map { it.name })
        assertEquals(listOf(true, true, true, false, true, true), cards.map { it.ready })
        val three = listOf(card("Anthropic (Claude)", "Claude Opus 5"), card("Anthropic · Work", "Claude Sonnet 5"), card("DeepSeek", "DeepSeek V4 Pro"))
        assertEquals(three, cards[0].keys)
        assertEquals(Infrastructure.EngineCard("opencode", emptyList(), three, emptyList()), cards[4])
        // Harness lists its models on each machine, and none here has reported them: the key, and no model.
        assertEquals(Infrastructure.EngineCard("dsh", emptyList(), listOf(card("DeepSeek", null)), emptyList()), cards[5])
    }

    /** A key is listed under every engine it runs on, beside the model it starts on there; one switched off is nothing any engine can run
     * on. */
    @Test fun aKeyIsUnderEveryEngineItRunsOn() {
        val cards = Infrastructure.engineCards(emptyList(), listOf(deepseek(), moonshot, openAIOff), emptyList())
        assertEquals(listOf(card("DeepSeek", "DeepSeek V4 Pro")), cards[0].keys)
        assertEquals(listOf(card("Kimi (Moonshot)", "Kimi K2.7 Code")), cards[2].keys)
        assertEquals(listOf(card("DeepSeek", "DeepSeek V4 Pro"), card("Kimi (Moonshot)", "Kimi K2.7 Code")), cards[4].keys)
        assertEquals(listOf(card("DeepSeek", null)), cards[5].keys)
        assertFalse("an OpenAI key switched off", cards[1].ready)
    }

    /** A DeepSeek Harness session's model is a machine's Harness catalogue's — the same for every DeepSeek key — where Claude Code and
     * OpenCode start each key on its own list's default. */
    @Test fun aHarnessSessionsModelIsFromAMachinesCatalogue() {
        val box = obj("""{"id":"hpc","name":"HPC","online":true,"capabilities":["provider:dsh"],
         "engines":[{"engine":"dsh","installed":true,"auth":"unknown","version":"0.2.0-rc.2"}],
         "modelCatalog":{"dsh":[{"value":"[\"deepseek\", \"deepseek-v4-pro\"]","label":"DeepSeek V4 Pro"},
                                {"value":"[\"deepseek\", \"deepseek-v4-flash\"]","label":"DeepSeek V4 Flash"}]},
         "runtimeDefaultModels":{"dsh":"[\"deepseek\", \"deepseek-v4-flash\"]"}}""")
        val cards = Infrastructure.engineCards(listOf(box), listOf(deepseek(), deepseek("DeepSeek 2")), emptyList())
        assertEquals(listOf(card("DeepSeek", "DeepSeek V4 Flash"), card("DeepSeek 2", "DeepSeek V4 Flash")), cards[5].keys)
        assertEquals(listOf("DeepSeek V4 Pro", "DeepSeek V4 Pro"), cards[0].keys.map { it.model })
        assertEquals(listOf("DeepSeek V4 Pro", "DeepSeek V4 Pro"), cards[4].keys.map { it.model })
    }

    /** A Claude subscription token is under Claude Code alone, as the server answers for it, and its line says what it is; OpenCode runs
     * the API key beside it. */
    @Test fun aSubscriptionTokenIsUnderClaudeCodeAlone() {
        val max = key("Claude Max", engines = listOf("claude"))
        val cards = Infrastructure.engineCards(emptyList(), listOf(max, anthropicWork), emptyList())
        assertEquals(listOf("Claude Max", "Anthropic · Work"), cards[0].keys.map { it.label })
        assertEquals(listOf("Anthropic · Work"), cards[4].keys.map { it.label })
        assertEquals("Claude Code · subscription token", KeyEngines.line(max))
        assertEquals("Claude Code · OpenCode", KeyEngines.line(anthropicWork))
    }

    /** OpenCode's machines are the ones its own sign-in is set up on, beside the keys it runs. */
    @Test fun openCodesOwnSignInIsWhereItIsSetUp() {
        val on = obj("""{"id":"hpc","name":"HPC","online":true,"engines":[{"engine":"opencode","installed":true,"auth":"yes","version":"1.18.35"}]}""")
        val off = obj("""{"id":"mac","name":"Mac Studio","online":true,"engines":[{"engine":"opencode","installed":true,"auth":"no","version":"1.18.35"}]}""")
        val openCode = Infrastructure.engineCards(listOf(on, off), listOf(moonshot), emptyList())[4]
        assertEquals("Own sign-in", openCode.machinesLabel)
        assertEquals(listOf("HPC"), openCode.machines)
        assertEquals(listOf(card("Kimi (Moonshot)", "Kimi K2.7 Code")), openCode.keys)
    }

    /** Not set up on what cannot be used now: a machine offline, a key switched off, a pool nothing can start on — and with no machine
     * online, Install on a machine has nothing to open but registering one. */
    @Test fun whatCannotBeUsedNowIsNotSetUp() {
        val offline = obj("""{"id":"t","name":"ThinkPad","online":false,"engines":[{"engine":"codex","installed":true,"auth":"yes"}]}""")
        val engines = Infrastructure.engineCards(listOf(offline), listOf(openAIOff), listOf(codexPool("c", "My Codex", unavailable = "Not signed in")))
        assertEquals(Infrastructure.EngineCard("codex", emptyList(), emptyList(), emptyList()), engines[1])
        assertNull(Infrastructure.installTarget(listOf(offline)))
        assertEquals("the first machine online", "mac", Infrastructure.installTarget(fleet)?.text("id"))
    }

    /** A pool is its engine's: a shared or ChatGPT pool Codex's, any other Claude Code's. */
    @Test fun aPoolIsItsEnginesSource() {
        val engines = Infrastructure.engineCards(emptyList(), emptyList(), listOf(claudePool(), codexPool("s", "Team keys")))
        assertEquals(listOf("Claude keys"), engines[0].pools)
        assertEquals(listOf("Team keys"), engines[1].pools)
    }

    /** Antigravity on a machine's own Gemini key: the server's answer stands for its install and its credential, and Default on that key
     * counts as a login. */
    @Test fun antigravityOnTheMachinesOwnKeyIsASubscription() {
        val box = obj("""{"id":"r","name":"Box","online":true,
         "antigravity":{"supported":true,"installed":true,"envKeyAvailable":true,"googleLogin":"available"},
         "engines":[{"engine":"antigravity","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"no"}]}]}""")
        assertEquals(listOf("Box"), Infrastructure.engineCards(listOf(box), emptyList(), emptyList())[3].machines)
        assertEquals(emptyList<String>(), Infrastructure.signedOutEngines(box))
    }

    /** The model a key starts on, by the name its own list gives it; its first model without a default; the id itself when the list
     * doesn't name it. */
    @Test fun aKeysModelIsNamedAsItsListNamesIt() {
        assertEquals("Claude Sonnet 5", Infrastructure.defaultModel(anthropicWork))
        assertEquals("Claude Opus 5", Infrastructure.defaultModel(key("A", defaultModel = null)))
        assertEquals("Claude Opus 5", Infrastructure.defaultModel(key("A", defaultModel = "")))
        assertEquals("claude-haiku-5", Infrastructure.defaultModel(key("A", defaultModel = "claude-haiku-5")))
        assertNull(Infrastructure.defaultModel(key("A", models = emptyList(), defaultModel = null)))
    }

    // A machine's row (03-ios.png)

    /** "2 / 4 running · 1 engine signed out"; "5 / 8 running · All signed in"; offline, where its engines stood: "1 of 3 signed in". */
    @Test fun aMachinesLineSaysItsSlotsAndItsEnginesSignedOut() {
        assertEquals("2 / 4 running · 1 engine signed out", Infrastructure.machineLine(macStudio, now))
        assertEquals("5 / 8 running · All signed in", Infrastructure.machineLine(hpc, now))
        assertEquals("1 of 3 signed in", Infrastructure.machineLine(thinkPad, now))
        assertEquals("2 engines signed out", Infrastructure.signedOutCount(2))
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

    // Settings' row

    /** SettingsHome.infrastructureValue: "1 needs you", "2 need you"; with none, how many of the machines are online. */
    @Test fun settingsRowSaysWhatNeedsYouElseTheMachinesOnline() {
        assertEquals("1 needs you", Infrastructure.settingsValue(1, fleet))
        assertEquals("2 need you", Infrastructure.settingsValue(2, fleet))
        assertEquals("2 of 3 online", Infrastructure.settingsValue(0, fleet))
        assertEquals("None", Infrastructure.settingsValue(0, emptyList()))
    }
}
