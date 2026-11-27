package io.orbitd.android.tasks

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A held task: one quiet line under an unchanged title on rows, the fuller block on the task view, the relaxed-run sentence under a run
 * (docs/account-health-owner-surface-contract.md §3; web `TaskAccountHold.tsx`). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class)
class TaskAccountHoldTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private fun task(extra: String = "") = Json.parseToJsonElement("""{"id":"t1","title":"Index the repository","status":"OPEN"$extra}""").jsonObject
    private val hold = """"accountHold":{"kind":"ACCOUNT_NEEDS_ACTION","reason":"Cursor said \"Add a payment method to continue\". Next try at 21:19",
        "until":"2026-11-22T21:19:00Z","accounts":[{"provider":"cursor","engine":"cursor","line":"Cursor said \"Add a payment method to continue\"","until":"2026-11-22T21:19:00Z"}]}"""
    private val utc = ZoneId.of("UTC")
    private val now = Instant.parse("2026-11-22T18:00:00Z").toEpochMilli()

    @Test fun theLineIsTheProvidersWordsAndTheNextTry() {
        assertEquals("Held · Cursor said \"Add a payment method to continue\" · Next try 21:19",
            TaskAccountHold.lineText(TaskAccountHold.of(task(",$hold"))!!, now, utc))
        val bare = Json.parseToJsonElement("""{"reason":"Cursor can't run"}""").jsonObject
        assertEquals("with no accounts, the reason", "Held · Cursor can't run", TaskAccountHold.lineText(bare, now, utc))
    }

    @Test fun aRowShowsItOnlyWhileNothingElseSaysWhyTheTaskWaits() {
        assertTrue(TaskAccountHold.showsOnRow(task(",$hold")))
        assertFalse("no hold", TaskAccountHold.showsOnRow(task()))
        assertFalse("running", TaskAccountHold.showsOnRow(task(",$hold,\"running\":true")))
        assertFalse("queued", TaskAccountHold.showsOnRow(task(",$hold,\"queued\":true")))
        assertFalse("the sign-in hold wins", TaskAccountHold.showsOnRow(task(",$hold,\"hold\":{\"kind\":\"SIGN_IN\"}")))
    }

    @Test fun aHeldRowKeepsItsTitleAndAddsOneLineWithOpenAccount() {
        val opened = mutableListOf<OrbitRoute>()
        compose.setContent { OrbitTheme { Column {
            TaskRowView(task(",$hold"), open = { opened += it })
            TaskRowView(task().let { JsonObject(it + ("id" to JsonPrimitive("t2")) + ("title" to JsonPrimitive("Unheld task"))) }, open = { opened += it })
        } } }
        compose.onNodeWithText("Index the repository").assertExists()
        compose.onAllNodesWithTag("task-account-hold-line").assertCountEquals(1)
        compose.onNodeWithTag("task-account-hold-line").assert(hasContentDescription("Held · ", substring = true) and hasContentDescription("· Open account", substring = true))
        compose.onNodeWithTag("task-account-hold-open").performClick()
        assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "machines")), opened)
    }

    @Test fun theTaskViewBlockHasTheReasonAndRunElsewhereOnlyForAPinnedTask() {
        val opened = mutableListOf<OrbitRoute>()
        val pinned = TaskAccountHold.of(task(",$hold".replace("\"accounts\"", "\"setting\":\"orbit-settings:relaxBlockedPins\",\"accounts\"")))!!
        compose.setContent { OrbitTheme { Column {
            TaskAccountHoldNote(pinned, { opened += it })
            RelaxedRunNote("Pinned to cursor, which can't run now; runs on codex instead, on the same engine, at tier M")
        } } }
        compose.onNodeWithTag("task-account-hold:reason").assertTextContains("Add a payment method", substring = true)
        compose.onNodeWithTag("task-account-hold-elsewhere").assertExists().performClick()
        assertEquals(Destination.SETTINGS, opened.single().destination)
        assertEquals("sessions", opened.single().id)
        compose.onNodeWithTag("relaxed-run").assertTextContains("runs on codex instead", substring = true)
    }

    @Test fun anUnpinnedHoldOffersNoRunElsewhere() {
        val plain = TaskAccountHold.of(task(",$hold"))!!
        compose.setContent { OrbitTheme { TaskAccountHoldNote(plain, {}) } }
        compose.onNodeWithTag("task-account-hold-elsewhere").assertDoesNotExist()
    }
}
