package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The composer card's toolbar (board docs/mocks/android-composer-parity, iOS ComposerView): the permission mode beside `+`, the model
 * with its effort, the context ring that opens a sheet, and a round Send — and what gives way when the row is full. */
class ComposerToolbarTest : ComposerShellTest() {
    @Test fun aFullRowFoldsOptimizeThenTheEffortThenTheName() {
        // Room for everything: nothing gives way.
        assertEquals(ToolbarFit(compactOptimize = false, showsEffort = true), toolbarFit(room = 300f, chipWithEffort = 120f, optimize = 110f))
        // The chip keeps its effort and Optimize folds to ✦ first (option C: the chip is laid out before Optimize).
        assertEquals(ToolbarFit(compactOptimize = true, showsEffort = true), toolbarFit(room = 200f, chipWithEffort = 120f, optimize = 110f))
        // Then the effort leaves the chip.
        assertEquals(ToolbarFit(compactOptimize = true, showsEffort = false), toolbarFit(room = 150f, chipWithEffort = 120f, optimize = 110f))
        // With no Optimize on the row, the effort goes only when the chip itself does not fit.
        assertEquals(ToolbarFit(compactOptimize = false, showsEffort = true), toolbarFit(room = 120f, chipWithEffort = 120f, optimize = null))
        assertEquals(ToolbarFit(compactOptimize = false, showsEffort = false), toolbarFit(room = 119f, chipWithEffort = 120f, optimize = null))
    }

    @Test fun theToolbarCarriesTheModeTheEffortTheRingAndARoundSend() {
        ComposerShell.session = mapOf("permissionMode" to JsonPrimitive("acceptEdits"), "effort" to JsonPrimitive("high"))
        signIn(); openSession()
        compose.onNodeWithTag("composer-mode").assertTextEquals("Accept Edits")
        compose.onNodeWithTag("composer-model-effort", useUnmergedTree = true).assertTextEquals("High")
        compose.onNodeWithTag("composer-model").assertContentDescriptionEquals("Model Opus 5.5, effort High")
        // No reading yet: the ring says so rather than 0%, and no "Context: … tokens" line is left above the box.
        compose.onNodeWithTag("composer-context").assertContentDescriptionEquals("Context: no reading yet")
        assertFalse(has(hasText("Context:", substring = true)))
        // Nothing typed and nothing to stop: Send, greyed.
        compose.onNodeWithTag("composer-send").assertContentDescriptionEquals("Send").assertIsNotEnabled()
        compose.onNodeWithTag("composer-input").performTextInput("Hello")
        await { has(hasTestTag("composer-send") and isEnabled()) }
    }

    @Test fun theRingOpensTheUsageSheet() {
        signIn(); openSession()
        compose.onNodeWithTag("composer-context").performClick()
        await { has(hasTestTag("composer-context-sheet")) }
        assertTrue(has(hasText("Context and plan usage")))
        assertTrue(has(hasText("Context: 0 tokens", substring = true)))
    }

    @Test fun theModeMenuWritesTheSessionsMode() {
        ComposerShell.session = mapOf("permissionMode" to JsonPrimitive("acceptEdits"))
        signIn(); openSession()
        compose.onNodeWithTag("composer-mode").performClick()
        await { has(hasTestTag("composer-toolbar-mode:plan")) }
        compose.onNodeWithTag("composer-toolbar-mode:acceptEdits").assertTextContains("✓", substring = true)
        compose.onNodeWithTag("composer-toolbar-mode:plan").performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config")?.get("permissionMode") != null }
        assertEquals(JsonPrimitive("plan"), ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config")?.get("permissionMode"))
    }

    private fun stage(id: String, name: String) {
        val handle = (app().session.state.value as AuthState.SignedIn).handle
        val model = app().composer(handle, ComposerShell.SESSION)
        compose.runOnIdle { model.importAttachment(StagedAttachment(id, name, "application/pdf"),
            { StagedAttachment(id, name, "application/pdf", 4) to "data".toByteArray() }, {}) }
    }

    /** As iOS (ConsoleModel.attach): a failed upload drops its chip and the error line above the box says which file and why. */
    @Test fun aFailedUploadDropsItsChipAndSaysWhy() {
        ComposerShell.answers["POST attachments"] = { ApiResponse(413, """{"message":"Attachment too large"}""".encodeToByteArray()) }
        signIn(); openSession()
        stage("f1", "notes.pdf")
        awaitText("Upload failed — notes.pdf: Attachment too large")
        assertFalse(has(hasTestTag("composer-attachment:f1")))
        assertFalse(has(hasText("Retry upload")))
    }

    /** A send waiting on an upload that then fails is not sent without it: the words stay in the box. */
    @Test fun aSendWaitingOnAFailedUploadStops() {
        ComposerShell.answers["POST attachments"] = { Thread.sleep(800); ApiResponse(503, """{"message":"unavailable"}""".encodeToByteArray()) }
        signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput("Here is the file")
        stage("f2", "notes.pdf")
        await { has(hasTestTag("composer-attachment:f2")) }
        compose.onNodeWithTag("composer-send").performClick()
        awaitText("Upload failed — notes.pdf: unavailable")
        assertNull(ComposerShell.body("POST sessions/${ComposerShell.SESSION}/turns"))
        compose.onNodeWithTag("composer-input").assertTextEquals("Here is the file")
    }

    /** A session that names no mode still shows the one it runs in: Auto, the server's floor when the account names no default
     *  (c3dc2aa83e, CursorRuntime.unsetMode). */
    @Test fun aSessionWithNoModeNamedShowsAuto() {
        signIn(); openSession()
        compose.onNodeWithTag("composer-mode").assertTextEquals("Auto")
    }

    /** As iOS's ByteCountFormatter (file style): decimal units. */
    @Test fun aFileSizeReadsAsIosWritesIt() {
        assertEquals("Zero KB", fileSize(0)); assertEquals("512 bytes", fileSize(512)); assertEquals("212 KB", fileSize(212_000))
        assertEquals("1.5 MB", fileSize(1_500_000)); assertEquals("2.00 GB", fileSize(2_000_000_000))
    }

    /** The plan's bar is read with the composer, as iOS reads its runner's plan usage: no menu needs opening first. */
    @Test fun theCatalogueIsReadAsTheComposerOpens() {
        signIn(); openSession()
        await { ComposerShell.calls.any { it.startsWith("GET runners") } }
    }

    /** As iOS: the plan's binding window beside the ring from the start, in one capsule the ring opens; nothing needs opening first. */
    @Test fun thePlanBarSitsBesideTheRingFromTheStart() {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"Fixture runner","online":true,"status":"ONLINE",
            "engines":[{"engine":"codex","installed":true,"auth":"yes"}],"modelCatalog":{"codex":[{"value":"gpt-6","label":"GPT-6"}]},
            "planUsage":{"codex":{"provider":"codex","primary":{"utilization":23,"windowDurationMins":300}}}}""")
        ComposerShell.session = mapOf("provider" to JsonPrimitive("codex"), "model" to JsonPrimitive("gpt-6"))
        signIn(); openSession()
        await { has(hasTestTag("composer-context") and hasContentDescription("23%", substring = true)) }
    }
}
