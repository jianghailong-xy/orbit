package io.orbitd.android.management

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The account row of a blocked Cursor sign-in on a device: the §8 line and Check again. Screenshot: files/account-health/blocked-row.png. */
@RunWith(AndroidJUnit4::class)
class AccountHealthDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun aBlockedAccountRowShowsItsLineAndCheckAgain() {
        val block = AccountHealthBlock.parse(Json.parseToJsonElement("""{"blocks":[{"id":"h1","runnerId":"r1","engine":"cursor","account":"default",
            "scopeModel":"","kind":"ACCOUNT_ACTION_REQUIRED","said":"Add a payment method to continue","trips":1,
            "since":"2026-11-22T17:19:00Z","nextTrialAt":"2026-11-22T21:19:00Z","trialRunning":false,"line":""}]}""")).single()
        var checked = 0
        // The app's own activity, its content replaced by the row on a plain page.
        compose.runOnUiThread {
            compose.activity.setContentView(ComposeView(compose.activity).apply {
                setContent {
                    OrbitTheme {
                        Column(Modifier.padding(16.dp)) {
                            Text("Default")
                            AccountHealthBlockLine(block, check = { checked++ }, onChecked = {})
                        }
                    }
                }
            })
        }
        compose.onNodeWithTag("account-health:line").assertIsDisplayed()
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "account-health").also { it.mkdirs() }
        File(dir, "blocked-row.png").outputStream().use { compose.onNodeWithTag("account-health").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
        compose.onNodeWithTag("account-health:check").performClick()
        compose.waitUntil(5_000) { checked == 1 }
        assertTrue(checked == 1)
    }

    /** A held task row beside an unheld one, then the task view's block and a relaxed run: files/account-health/held-rows.png. */
    @Test fun aHeldTaskRowIsOneQuietLineBesideAnUnheldOne() {
        val held = Json.parseToJsonElement("""{"id":"t1","title":"Index the repository for the search page","status":"OPEN","accountHold":{
            "kind":"ACCOUNT_NEEDS_ACTION","reason":"Cursor said \"Add a payment method to continue\". Next try at 21:19","until":"2026-11-22T21:19:00Z",
            "setting":"orbit-settings:relaxBlockedPins",
            "accounts":[{"provider":"cursor","engine":"cursor","line":"Cursor said \"Add a payment method to continue\"","until":"2026-11-22T21:19:00Z"}]}}""").jsonObject
        val unheld = Json.parseToJsonElement("""{"id":"t2","title":"Write the release notes","status":"OPEN"}""").jsonObject
        compose.runOnUiThread {
            compose.activity.setContentView(ComposeView(compose.activity).apply {
                setContent {
                    OrbitTheme { androidx.compose.material3.Surface {
                        Column(Modifier.padding(16.dp)) {
                            io.orbitd.android.tasks.TaskRowView(held)
                            io.orbitd.android.tasks.TaskRowView(unheld)
                            io.orbitd.android.tasks.TaskAccountHoldNote(held["accountHold"]!!.jsonObject, {})
                            io.orbitd.android.tasks.RelaxedRunNote("Pinned to cursor, which can't run now (Cursor said \"Add a payment method to continue\"); runs on codex instead, on the same engine, at tier M")
                        }
                    } }
                }
            })
        }
        compose.onNodeWithTag("task-account-hold-line").assertIsDisplayed()
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "account-health").also { it.mkdirs() }
        compose.waitForIdle()
        File(dir, "held-rows.png").outputStream().use { compose.onNodeWithTag("task-account-hold-line").let { _ -> compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) } }
    }
}
