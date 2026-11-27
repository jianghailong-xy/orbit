package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A blocked key's row on the Providers screen: the line and Check again (contract §4), then the block gone once cleared. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class AccountHealthRowsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)
    private val key = "0198f3a2-cccc-7000-8000-00000000000c"

    @Before fun start() {
        fixture.reset()
        fixture.providersMine = """[{"id":"$key","slug":"cursor-api-2","label":"Cursor 2","runtime":"cursor","presetSlug":"cursor-api",
            "baseUrl":"https://api2.cursor.sh","hasApiKey":true,"enabled":true,"models":[],"defaultModel":"","engines":["cursor"],
            "keyCheckState":null,"keyCheckedAt":null}]"""
        fixture.accountHealth = """{"blocks":[{"id":"h1","runnerId":null,"engine":null,"account":null,"providerId":"$key","poolId":null,"scopeModel":"",
            "kind":"CREDENTIAL_REFUSED","said":"The provided API key is invalid","trips":1,"since":"2026-11-22T17:19:00Z","nextTrialAt":"2026-11-22T21:19:00Z",
            "trialRunning":false,"line":"Needs action · Cursor said \"The provided API key is invalid\""}]}"""
    }

    @Test fun aBlockedKeyRowSaysSoAndCheckAgainClearsIt() {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { MachinesAndModelsSettings(api, revision, null, {}, {}) }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("account-health:line", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("account-health:line", useUnmergedTree = true).assertTextContains("Needs action · Cursor said \"The provided API key is invalid\" · since Nov ", substring = true)
        compose.onNodeWithTag("account-health:check", useUnmergedTree = true).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.calls.contains("POST account-health/h1/check") }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("account-health:line", useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun aPoolMemberAndALoginAreMatchedByTheirOwnIds() {
        val blocks = AccountHealthBlock.parse(Json.parseToJsonElement("""{"blocks":[
            {"id":"k","providerId":"key-1","scopeModel":"","kind":"ACCOUNT_ACTION_REQUIRED"},
            {"id":"l","poolId":"pool-1","account":"fp9","scopeModel":"","kind":"CREDENTIAL_REFUSED"},
            {"id":"m","providerId":"key-1","scopeModel":"gpt-5","kind":"ACCOUNT_ACTION_REQUIRED"}]}"""))
        assertEquals("k", AccountHealthBlock.forProvider(blocks, "key-1")?.id)
        assertNull(AccountHealthBlock.forProvider(blocks, "key-2"))
        assertEquals("l", AccountHealthBlock.forLogin(blocks, "pool-1", "fp9")?.id)
        assertNull("a different pool's login", AccountHealthBlock.forLogin(blocks, "pool-2", "fp9"))
    }
}
