package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A07-19's remainder of the engine-first work (iOS e6295abe7, 6f3083272, cef3c3f83, f93f3fe5e; OrbitKit EngineFirstClientTests
 * `testWhatTheProviderRowSays`, AgentDefaults `livePin`/`newSessionModel`, SessionProviderChoices `keyName`; web
 * `shownProviderValue`, `newSessionModelFor`, `keyName`):
 * (d) the Provider row says a sign-in by the account in use — Automatic while Orbit picks it — and OpenCode's own configuration as its
 * own sign-in; (e) a new session starts on its workspace's lastModel on that workspace's engine and credential, while the runtime
 * still offers it;
 * (b) a key is named in a sentence by its vendor and its own name.
 */
class EngineFirstRemainderTest {
    private fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private val none = JsonObject(emptyMap())
    private val keys = Wire.json.parseToJsonElement("""[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek",
        "engines":["claude","opencode","dsh"]}]""").jsonArray.map { it.jsonObject }

    private fun catalog(capabilities: String = "\"codex-account-move/v1\"", codexAccounts: String =
            """[{"id":"default","auth":"yes"},{"id":"1a2b3c4d","name":"Second account","auth":"yes"}]""") =
        ComposerCatalog(obj("""{"id":"r","capabilities":[$capabilities],"engines":[
            {"engine":"codex","installed":true,"auth":"yes","accounts":$codexAccounts},
            {"engine":"kimi","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"k2","name":"Kimi two","auth":"yes"}]},
            {"engine":"claude","installed":true,"auth":"yes"},{"engine":"opencode","installed":true}]}"""), keys)

    private fun value(catalog: ComposerCatalog, detail: String, held: JsonObject = none, draft: Boolean = false, engine: String = "codex"): String {
        val effective = JsonObject(obj(detail) + held)
        val provider = effective.text("provider")!!
        return catalog.providerValue(catalog.current(engine, provider), engine, effective, held, draft)
    }

    /** A session on its engine's own sign-in, on a runner that moves it between that engine's accounts: Automatic while Orbit picks
     * the account — its workspace leaves it to Orbit, and nobody picked one by hand — else the account it is on. */
    @Test fun theProviderRowSaysAutomaticOrTheAccountInUse() {
        val catalog = catalog()
        assertEquals("Automatic", value(catalog, """{"provider":"codex","codexAccount":"1a2b3c4d","workspace":{"id":"w"}}"""))
        assertEquals("picked by hand", "Second account",
            value(catalog, """{"provider":"codex","codexAccount":"1a2b3c4d","codexAccountPinned":true,"workspace":{"id":"w"}}"""))
        assertEquals("the workspace picked it", "Second account",
            value(catalog, """{"provider":"codex","codexAccount":"1a2b3c4d","workspace":{"id":"w","codexAccount":"1a2b3c4d"}}"""))
        assertEquals("its env picks a CODEX_HOME of its own", "Default",
            value(catalog, """{"provider":"codex","workspace":{"id":"w","env":{"CODEX_HOME":"/srv/codex"}}}"""))
        assertEquals("a blank variable decides nothing", "Automatic",
            value(catalog, """{"provider":"codex","workspace":{"id":"w","env":{"CODEX_HOME":"  "}}}"""))
        assertEquals("a model of its own decides Kimi Code's", "Kimi two", value(catalog, """{"provider":"kimi","kimiAccount":"k2",
            "workspace":{"id":"w","env":{"KIMI_MODEL_NAME":"k","KIMI_MODEL_API_KEY":"x"}}}""", engine = "kimi"))
        assertEquals("an account the runner doesn't list runs on Default", "Default",
            value(catalog, """{"provider":"codex","codexAccount":"gone","codexAccountPinned":true,"workspace":{"id":"w"}}"""))
        // A runner that cannot move it offers no account rows, so the row names the account the session is on.
        assertEquals("Second account", value(catalog(capabilities = ""), """{"provider":"codex","codexAccount":"1a2b3c4d","workspace":{"id":"w"}}"""))
        // One account is the sign-in itself.
        assertEquals("Default", value(catalog(codexAccounts = """[{"id":"default","auth":"yes"}]"""), """{"provider":"codex","workspace":{"id":"w"}}"""))
    }

    /** A draft is on Automatic until an account is picked for it; an ended session's switch onto the sign-in, held for its next turn,
     * starts on Automatic's pick unless it names one. */
    @Test fun aDraftAndAHeldSwitchStartOnAutomaticUntilAnAccountIsPicked() {
        val catalog = catalog(capabilities = "")
        val workspace = """{"id":"w","provider":"codex"}"""
        assertEquals("Automatic", value(catalog, workspace, draft = true))
        assertEquals("Second account", value(catalog, workspace, buildJsonObject { put("account", "1a2b3c4d") }, draft = true))
        assertEquals("Automatic", value(catalog(), workspace, buildJsonObject { put("account", "automatic") }, draft = true))
        val ended = """{"provider":"deepseek","status":"FAILED","workspace":{"id":"w"}}"""
        val held = buildJsonObject { put("provider", "codex"); put("engine", "codex") }
        assertEquals("Automatic", value(catalog(), ended, held))
        assertEquals("Second account", value(catalog(), ended, JsonObject(held + ("account" to JsonPrimitive("1a2b3c4d")))))
        // The row's tick follows the same rule.
        assertEquals(AccountOn(true, "default"), catalog().accountOn("codex", obj(workspace), none, draft = true))
        assertEquals(AccountOn(false, "1a2b3c4d"),
            catalog().accountOn("codex", obj("""{"provider":"codex","codexAccount":"1a2b3c4d","codexAccountPinned":true}"""), none, draft = false))
    }

    /** OpenCode's own configuration is its own sign-in; a key, or a pool, by its own name. */
    @Test fun openCodesOwnConfigurationIsItsOwnSignInAndAKeyItsName() {
        val catalog = catalog()
        assertEquals("Own sign-in", value(catalog, """{"provider":"opencode"}""", engine = "opencode"))
        assertEquals("DeepSeek", value(catalog, """{"provider":"deepseek"}""", engine = "claude"))
        assertEquals("DeepSeek", value(catalog, """{"provider":"deepseek"}""", engine = "opencode"))
    }

    /** A workspace whose person-opened session last ran [engine] on [provider] with [model]; its deprecated `provider` alias says
     * something else, which nothing reads. */
    private fun last(engine: String, provider: String, model: String?) = buildJsonObject {
        put("provider", "elsewhere"); put("lastEngine", engine); put("lastProvider", provider); model?.let { put("lastModel", it) }
    }

    /** A draft's model is its workspace's `lastModel` when it runs on that workspace's lastEngine and lastProvider (docs/
     * workspace-default-model-design.md, web `newSessionModelFor`): one key's model on Claude Code is not its model on DeepSeek
     * Harness, and the deprecated `provider` alias is not lastProvider. */
    @Test fun theDraftModelIsTheWorkspacesLastModelOnItsOwnEngineAndCredential() {
        val catalog = EngineFixture.catalog()
        val workspace = last("dsh", "deepseek", "deepseek-v4-flash")
        assertEquals("deepseek-v4-flash", catalog.lastModel("dsh", "deepseek", workspace))
        assertNull("another engine", catalog.lastModel("claude", "deepseek", workspace))
        assertNull("another credential", catalog.lastModel("dsh", "deepseek-2", workspace))
        assertNull("no lastModel yet", catalog.lastModel("dsh", "deepseek", last("dsh", "deepseek", null)))
        assertNull("the provider alias is not lastProvider", catalog.lastModel("claude", "claude",
            obj("""{"provider":"claude","lastEngine":"claude","lastModel":"claude-opus-5-5"}""")))
        assertNull("no workspace", catalog.lastModel("claude", "claude", null))
    }

    /** A new session starts on it while the runtime still offers it, and on the runner's or the key's default otherwise: OpenCode owns
     * its own selection, a key's own list is a document rather than a live probe, a catalogue not reported retires nothing. */
    @Test fun aNewSessionStartsOnItWhileItIsStillOfferedElseOnTheDefault() {
        val catalog = EngineFixture.catalog()
        assertEquals("deepseek-v4-flash", catalog.newSessionModel("dsh", "deepseek", last("dsh", "deepseek", "deepseek-v4-flash")))
        assertEquals("claude-opus-5-5", catalog.newSessionModel("claude", "claude", last("claude", "claude", "claude-opus-5-5")))
        assertEquals("retired: the pair's default", "claude-opus-5-5", catalog.newSessionModel("claude", "claude", last("claude", "claude", "claude-opus-4")))
        assertNull(catalog.liveLastModel("claude", "claude", last("claude", "claude", "claude-opus-4")))
        assertEquals("glm-9", catalog.newSessionModel("claude", "glm", last("claude", "glm", "glm-9")))
        assertEquals("anything/at-all", catalog.newSessionModel("opencode", "opencode", last("opencode", "opencode", "anything/at-all")))
        assertEquals("no lastModel: the runner's default", "deepseek-v4-pro", catalog.newSessionModel("dsh", "deepseek", last("dsh", "deepseek", null)))
        assertEquals("on another engine: its default", "deepseek-v4-pro", catalog.newSessionModel("dsh", "deepseek", last("claude", "deepseek", "deepseek-v4-flash")))
        val unreported = ComposerCatalog(obj("""{"id":"r","engines":[{"engine":"claude","installed":true,"auth":"yes"}]}"""), emptyList())
        assertEquals("claude-opus-4", unreported.newSessionModel("claude", "claude", last("claude", "claude", "claude-opus-4")))
    }

    /** A07-19 (b): a key as a sentence names it, `the DeepSeek key “DeepSeek 2”` — its vendor and its own name, never its slug; a custom
     * endpoint is DeepSeek's when DeepSeek Harness runs it. */
    @Test fun aKeyIsNamedByItsVendorAndItsOwnName() {
        assertEquals("the DeepSeek key “DeepSeek 2”", ProviderEngines.keyName(obj("""{"slug":"deepseek-2","label":"DeepSeek 2","presetSlug":"deepseek"}""")))
        assertEquals("the Moonshot key “Kimi (Moonshot)”", ProviderEngines.keyName(obj("""{"slug":"moonshot","label":"Kimi (Moonshot)","presetSlug":"moonshot"}""")))
        assertEquals("the DeepSeek key “DeepSeek Harness”", ProviderEngines.keyName(obj("""{"label":"DeepSeek Harness","presetSlug":"deepseek-harness"}""")))
        assertEquals("the DeepSeek key “Proxy”", ProviderEngines.keyName(obj("""{"label":"Proxy","presetSlug":null,"engines":["claude","opencode","dsh"]}""")))
        assertEquals("the key “my endpoint”", ProviderEngines.keyName(obj("""{"slug":"my-endpoint","label":"my endpoint"}""")))
    }
}
