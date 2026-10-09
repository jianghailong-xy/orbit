package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
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
import java.time.Instant

/** A DeepSeek key's account balance on Settings → Providers and on the key's page, over the controlled server (iOS 936ebbd3c,
 * 96e1a1536; A13-16): the row's total or Unavailable, read side by side; the page's balance first, its low and failed states, and
 * where the key runs. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class DeepSeekBalanceTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)
    private val deepseek = ManagementFixture.KEY_DEEPSEEK
    private val harness = ManagementFixture.KEY_HARNESS

    private fun read(balances: String, available: Boolean = true, shared: String = "[]") =
        """{"ok":true,"balances":$balances,"isAvailable":$available,"fetchedAt":"${Instant.now()}","sharedWith":$shared}"""
    private val two = """[{"currency":"CNY","totalBalance":"110.00","grantedBalance":"10.00","toppedUpBalance":"100.00"},
        {"currency":"USD","totalBalance":"5","grantedBalance":"0","toppedUpBalance":"5"}]"""

    @Before fun start() {
        fixture.reset()
        fixture.providerCatalog = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","defaultModel":"deepseek-chat"},
            {"slug":"dsh","label":"DeepSeek Harness","runtime":"dsh"},{"slug":"openai","label":"OpenAI","runtime":"codex","defaultModel":"gpt-5"}]"""
        fixture.providersMine = """[{"id":"$deepseek","slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek",
              "baseUrl":"https://api.deepseek.com/anthropic","hasApiKey":true,"defaultModel":"deepseek-chat"},
            {"id":"$harness","slug":"dsh","label":"DeepSeek Harness","runtime":"dsh","presetSlug":"deepseek-harness","baseUrl":"https://api.deepseek.com/anthropic","hasApiKey":true},
            {"id":"${ManagementFixture.KEY_OPENAI}","slug":"openai","label":"OpenAI","runtime":"codex","presetSlug":"openai","baseUrl":"https://api.openai.com/v1","hasApiKey":true}]"""
        fixture.balances[deepseek] = read(two)
        fixture.balances[harness] = """{"ok":false,"reason":"NETWORK","message":"DeepSeek didn't answer in time.","fetchedAt":"${Instant.now()}"}"""
    }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun providers(record: String?, opened: MutableList<OrbitRoute> = mutableListOf()) {
        val api = api()
        compose.setContent { ProviderManagement(api, revision, record, { opened += it }, {}) }
    }

    @Test fun aDeepSeekKeysRowEndsWithItsBalanceAndOpensItsPage() {
        val opened = mutableListOf<OrbitRoute>()
        providers(null, opened)
        await("¥110.00 · $5.00")
        await("Unavailable")
        compose.onNodeWithText("Runs on DeepSeek Harness", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("gpt-5", useUnmergedTree = true).assertExists()
        assertTrue("both DeepSeek keys' balances are asked", fixture.calls.containsAll(listOf("GET providers/mine/$deepseek/balance", "GET providers/mine/$harness/balance")))
        assertFalse("no balance for a key that isn't DeepSeek's", fixture.calls.any { it.contains(ManagementFixture.KEY_OPENAI) })
        compose.onAllNodes(hasText("OpenAI") and hasClickAction()).assertCountEquals(0)
        compose.onNode(hasText("DeepSeek") and hasClickAction()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "providers", recordId = "key:$deepseek")), opened) }
    }

    /** iOS 96e1a1536: a slow key's read holds up no other key's. */
    @Test fun theBalancesAreReadSideBySide() {
        val held = CompletableDeferred<Unit>()
        fixture.balanceGates[deepseek] = held
        providers(null)
        await("Unavailable")
        compose.onAllNodesWithText("¥110.00", substring = true).assertCountEquals(0)
        held.complete(Unit)
        await("¥110.00 · $5.00")
    }

    @Test fun theKeysPageShowsTheWholeAccountsBalanceFirstThenWhereTheKeyRuns() {
        providers("key:$deepseek")
        await("DeepSeek account balance")
        await("¥110.00")
        compose.onNodeWithText("Total").assertExists()
        compose.onAllNodesWithText("$5.00").assertCountEquals(2) // USD's total, and all of it topped up
        compose.onAllNodesWithText("¥10.00").assertCountEquals(1)
        compose.onAllNodesWithText("¥100.00").assertCountEquals(1)
        compose.onNodeWithText("Just now").assertExists()
        compose.onNodeWithText("Each currency is a separate balance; DeepSeek doesn't convert between them.").assertExists()
        compose.onNodeWithText("The balance of the whole DeepSeek account this key belongs to", substring = true).assertExists()
        compose.onNodeWithText("Top up on DeepSeek ↗").assertExists()
        compose.onNodeWithText("Claude Code").assertExists()
        compose.onNodeWithText("deepseek-chat").assertExists()
        compose.onNodeWithText("api.deepseek.com").assertExists()
        compose.onNodeWithText("Adding or changing a key happens on the web.").assertExists()
        compose.onNode(hasText("Refresh", substring = true) and hasClickAction()).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.queries.contains("GET providers/mine/$deepseek/balance?refresh=1") }
        assertEquals("DeepSeek", settingsTitle("providers", "key:$deepseek"))
    }

    @Test fun aBalanceTooLowSaysCallsWillFailAndOpensTheTopUpInTheBrowser() {
        fixture.balances[deepseek] = read("""[{"currency":"CNY","totalBalance":"0.12","grantedBalance":"0","toppedUpBalance":"0.12"}]""", available = false,
            shared = """[{"id":"$harness","label":"DeepSeek Harness"}]""")
        providers("key:$deepseek")
        await("Balance too low — DeepSeek calls will fail")
        compose.onNodeWithText("Every session using a key on this account will fail at its next request. Orbit can't top up for you.").assertExists()
        compose.onNodeWithText("Opens platform.deepseek.com/top_up in your browser. The balance of the whole", substring = true).assertExists()
        compose.onNodeWithText("Same DeepSeek account as DeepSeek Harness — both show this balance.").assertExists()
        compose.onAllNodesWithText("Safari", substring = true).assertCountEquals(0)
    }

    @Test fun aRejectedKeySaysWhyAndToChangeItOnTheWeb() {
        fixture.balances[deepseek] = """{"ok":false,"reason":"KEY_REJECTED","message":"DeepSeek refused this key (401 Authentication Fails).","fetchedAt":"${Instant.now()}"}"""
        providers("key:$deepseek")
        await("Couldn't get the balance")
        compose.onNodeWithText("DeepSeek refused this key (401 Authentication Fails). Change the key on the web, then retry.").assertExists()
        compose.onNodeWithText("Unknown").assertExists()
        compose.onNodeWithText("Last tried").assertExists()
        compose.onNodeWithText("No amount is shown until DeepSeek answers.").assertExists()
        compose.onNode(hasText("Retry", substring = true) and hasClickAction()).assertExists()
        compose.onAllNodesWithText("¥", substring = true).assertCountEquals(0)
    }

    @Test fun aKeyThatIsGoneSaysSo() {
        providers("key:${ManagementFixture.KEY_OPENAI}")
        await("That provider no longer exists.")
    }
}
