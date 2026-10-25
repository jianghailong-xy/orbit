package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The composer's account, while a runner's Default is removed from Orbit (the server's accountOnRunner, which never runs a session on it):
 * a session or draft on Default — picked by hand, pinned, set by its workspace — or on an account the runner no longer reports is on
 * Automatic's pick among the accounts that remain, so the Provider row and the account rows never name Default there. A workspace whose
 * env names a directory or a key of its own is the user's setting, and stays as it was.
 */
class ComposerRemovedDefaultTest {
    private fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private val none = JsonObject(emptyMap())

    /** Codex as the server serves it with Default removed: Work (8% of its 5 hours used) and Personal (30%) remain. With [removed] false,
     * Default is in use beside them. */
    private fun catalog(capabilities: String = "\"codex-account-move/v1\"", removed: Boolean = true) = ComposerCatalog(obj("""{"id":"r",
        "capabilities":[$capabilities],"engines":[{"engine":"codex","installed":true,"auth":"yes","accounts":[
        ${if (removed) "" else """{"id":"default","auth":"yes"},"""}{"id":"3fa91c2e","name":"Work","auth":"yes"},{"id":"7c21de40","name":"Personal","auth":"yes"}]
        ${if (removed) ""","removedDefault":{"home":"/root/.codex"}""" else ""}}],
        "planUsage":{"provider":"codex","accounts":{"3fa91c2e":{"provider":"codex","primary":{"utilization":8,"windowDurationMins":300}},
        "7c21de40":{"provider":"codex","primary":{"utilization":30,"windowDurationMins":300}}}}}"""), emptyList())

    private fun value(catalog: ComposerCatalog, detail: String, draft: Boolean = false) =
        catalog.providerValue(catalog.current("codex", "codex"), "codex", obj(detail), none, draft)

    @Test fun aSessionOnARemovedDefaultIsOnAutomaticsPick() {
        val catalog = catalog()
        for (detail in listOf(
            """{"provider":"codex","codexAccount":"default","workspace":{"id":"w"}}""",
            """{"provider":"codex","codexAccount":"default","codexAccountPinned":true,"workspace":{"id":"w"}}""",
            """{"provider":"codex","workspace":{"id":"w","codexAccount":"default"}}""",
            """{"provider":"codex","codexAccount":"gone","codexAccountPinned":true,"workspace":{"id":"w"}}""")) {
            assertEquals(detail, AccountOn(true, "3fa91c2e"), catalog.accountOn("codex", obj(detail), none, draft = false))
            assertEquals(detail, "Automatic", value(catalog, detail))
        }
        // A runner that can't move it lists no account rows, so the row names the account the session runs on: the pick, not Default.
        assertEquals("Work", value(catalog(capabilities = ""), """{"provider":"codex","codexAccount":"default","workspace":{"id":"w"}}"""))
        // A draft whose workspace is set to Default starts on Automatic.
        val draft = """{"id":"w","provider":"codex","codexAccount":"default"}"""
        assertEquals(AccountOn(true, "3fa91c2e"), catalog.accountOn("codex", obj(draft), none, draft = true))
        assertEquals("Automatic", value(catalog, draft, draft = true))
    }

    @Test fun anAccountThatRemainsAndTheWorkspacesOwnSettingStayAsTheyWere() {
        val catalog = catalog()
        assertEquals("Personal", value(catalog, """{"provider":"codex","codexAccount":"7c21de40","codexAccountPinned":true,"workspace":{"id":"w"}}"""))
        assertEquals(AccountOn(false, "default"), catalog.accountOn("codex",
            obj("""{"provider":"codex","codexAccount":"default","workspace":{"id":"w","env":{"CODEX_HOME":"/srv/codex"}}}"""), none, draft = false))
        // Default in use: an account the runner doesn't list runs on Default, as before.
        assertEquals("Default", value(catalog(removed = false), """{"provider":"codex","codexAccount":"gone","codexAccountPinned":true,"workspace":{"id":"w"}}"""))
        assertEquals(AccountOn(false, "default"),
            catalog(removed = false).accountOn("codex", obj("""{"provider":"codex","workspace":{"id":"w","codexAccount":"default"}}"""), none, draft = false))
    }
}
