package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.ui.OrbitTheme
import java.time.ZoneId
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A blocked account's line and Check again (docs/account-health-owner-surface-contract.md §2; web `AccountHealthBlockLine`). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class)
class AccountHealthTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val utc = ZoneId.of("UTC")
    private val body = Json.parseToJsonElement("""{"blocks":[
        {"id":"h1","runnerId":"r1","engine":"cursor","account":"default","scopeModel":"","kind":"ACCOUNT_ACTION_REQUIRED",
         "said":"Add a payment method to continue","trips":1,"since":"2026-11-22T17:19:00Z","nextTrialAt":"2026-11-22T21:19:00Z","trialRunning":false,"line":""},
        {"id":"h2","runnerId":"r1","engine":"codex","account":"default","scopeModel":"","kind":"UNCLASSIFIED_ADMISSION",
         "said":null,"trips":1,"since":"2026-11-22T17:19:00Z","nextTrialAt":"2026-11-22T21:19:00Z","trialRunning":false,"line":""},
        {"id":"h3","runnerId":"r1","engine":"cursor","account":"default","scopeModel":"gpt-5","kind":"ACCOUNT_ACTION_REQUIRED","trips":1}]}""")

    @Test fun aClassifiedRefusalNamesTheProvidersWordsAndTheTimes() {
        val blocks = AccountHealthBlock.parse(body)
        assertEquals("Needs action · Cursor said \"Add a payment method to continue\" · since Nov 22, 17:19 · tried again at 21:19",
            AccountHealthBlock.text(blocks[0], utc))
    }

    @Test fun theBreakerCountsTheRunsThatFailedToStart() {
        assertEquals("Not used for now · failed to start 2 runs · since Nov 22, 17:19 · tried again at 21:19",
            AccountHealthBlock.text(AccountHealthBlock.parse(body)[1], utc))
    }

    @Test fun onlyTheWholeAccountBlockOfThatSignInIsTheRows() {
        val blocks = AccountHealthBlock.parse(body)
        assertEquals("h1", AccountHealthBlock.forRunnerAccount(blocks, "r1", "cursor", "default")?.id)
        assertNull("a one-model block is not the account's", AccountHealthBlock.forRunnerAccount(blocks.drop(2), "r1", "cursor", "default"))
        assertNull(AccountHealthBlock.forRunnerAccount(blocks, "r2", "cursor", "default"))
    }

    @Test fun checkAgainCallsTheRouteAndAsksForAReread() {
        var checked = 0; var reread = 0
        compose.setContent { OrbitTheme { AccountHealthBlockLine(AccountHealthBlock.parse(body)[0], check = { checked++ }, onChecked = { reread++ }) } }
        compose.onNodeWithTag("account-health:line").assertTextContains("Needs action · Cursor said", substring = true)
        compose.onNodeWithTag("account-health:check").assertTextEquals("Check again").performClick()
        compose.waitUntil(3_000) { reread == 1 }
        assertEquals(1, checked)
        compose.onNodeWithTag("account-health:error").assertDoesNotExist()
    }

    @Test fun aFailedCheckSaysSoButANotFoundIsNothingToClear() {
        var message = "boom"
        var reread = 0
        compose.setContent { OrbitTheme { AccountHealthBlockLine(AccountHealthBlock.parse(body)[0], check = { error(message) }, onChecked = { reread++ }) } }
        compose.onNodeWithTag("account-health:check").performClick()
        compose.waitUntil(3_000) { reread == 1 }
        compose.onNodeWithTag("account-health:error").assertTextEquals("Couldn't check again")
    }
}
